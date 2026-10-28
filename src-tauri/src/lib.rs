mod config;
mod session_lock;
mod svn;

use chrono::{DateTime, Utc};
use config::{AppConfig, GroupConfig, ProjectConfig, UNGROUPED_ID};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProjectStatus {
    Unknown,
    Checking,
    UpToDate,
    Behind,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectState {
    pub id: String,
    pub name: String,
    pub path: String,
    pub group_id: String,
    pub local_rev: Option<u64>,
    pub remote_rev: Option<u64>,
    pub status: ProjectStatus,
    pub error: Option<String>,
    pub last_checked: Option<DateTime<Utc>>,
}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<Mutex<InnerState>>,
}

struct InnerState {
    config: AppConfig,
    projects: HashMap<String, ProjectState>,
    notified_remote: HashMap<String, u64>,
    session_locked: bool,
}

impl AppState {
    fn new() -> Self {
        let config = config::load();
        let mut projects = HashMap::new();
        for p in &config.projects {
            projects.insert(p.id.clone(), ProjectState::from_config(p));
        }
        Self {
            inner: Arc::new(Mutex::new(InnerState {
                config,
                projects,
                notified_remote: HashMap::new(),
                session_locked: false,
            })),
        }
    }
}

impl ProjectState {
    fn from_config(p: &ProjectConfig) -> Self {
        Self {
            id: p.id.clone(),
            name: p.name.clone(),
            path: p.path.clone(),
            group_id: p.group_id.clone(),
            local_rev: None,
            remote_rev: None,
            status: ProjectStatus::Unknown,
            error: None,
            last_checked: None,
        }
    }
}

pub fn set_session_locked(app: &AppHandle, locked: bool) {
    let state = app.state::<AppState>();
    {
        let mut guard = state.inner.lock();
        guard.session_locked = locked;
    }
    let _ = app.emit("session-lock", locked);
}

fn polling_paused(state: &AppState) -> bool {
    let guard = state.inner.lock();
    guard.config.pause_when_locked && guard.session_locked
}

fn persist(state: &AppState) -> Result<(), String> {
    let guard = state.inner.lock();
    config::save(&guard.config)
}

fn emit_project(app: &AppHandle, state: &ProjectState) {
    let _ = app.emit("project-updated", state);
}

fn check_one(app: &AppHandle, state: &AppState, id: &str) -> Result<ProjectState, String> {
    let (path, name) = {
        let mut guard = state.inner.lock();
        let proj = guard
            .projects
            .get_mut(id)
            .ok_or_else(|| "project not found".to_string())?;
        proj.status = ProjectStatus::Checking;
        proj.error = None;
        let snapshot = proj.clone();
        drop(guard);
        emit_project(app, &snapshot);
        (snapshot.path, snapshot.name)
    };

    let result = svn::query_revisions(PathBuf::from(&path).as_path());

    let mut guard = state.inner.lock();
    let proj = guard
        .projects
        .get_mut(id)
        .ok_or_else(|| "project not found".to_string())?;
    proj.last_checked = Some(Utc::now());

    match result {
        Ok(revs) => {
            proj.local_rev = Some(revs.local);
            proj.remote_rev = Some(revs.remote);
            proj.error = None;
            // behind 来自 `svn status -u`，不能用全局 HEAD 与本地 Revision 比大小
            if revs.behind {
                proj.status = ProjectStatus::Behind;
                let already = guard.notified_remote.get(id).copied();
                let should_notify = guard.config.notify_enabled && already != Some(revs.remote);
                if should_notify {
                    guard.notified_remote.insert(id.to_string(), revs.remote);
                    let payload = serde_json::json!({
                        "name": name,
                        "local": revs.local,
                        "remote": revs.remote,
                    });
                    drop(guard);
                    let _ = app.emit("svn-behind", payload);
                    let guard = state.inner.lock();
                    let out = guard.projects.get(id).cloned().unwrap();
                    emit_project(app, &out);
                    return Ok(out);
                }
            } else {
                proj.status = ProjectStatus::UpToDate;
                guard.notified_remote.insert(id.to_string(), revs.remote);
            }
        }
        Err(e) => {
            proj.status = ProjectStatus::Error;
            proj.error = Some(e.to_string());
        }
    }

    let out = guard.projects.get(id).cloned().unwrap();
    drop(guard);
    emit_project(app, &out);
    Ok(out)
}

fn check_all_inner(app: &AppHandle, state: &AppState) {
    if polling_paused(state) {
        return;
    }
    let ids: Vec<String> = {
        let guard = state.inner.lock();
        guard.projects.keys().cloned().collect()
    };
    for id in ids {
        if polling_paused(state) {
            break;
        }
        let _ = check_one(app, state, &id);
    }
}

fn spawn_poller(app: AppHandle, state: AppState) {
    thread::spawn(move || loop {
        let interval = {
            let guard = state.inner.lock();
            guard.config.poll_interval_secs.max(10)
        };
        thread::sleep(Duration::from_secs(interval));
        if polling_paused(&state) {
            continue;
        }
        check_all_inner(&app, &state);
    });
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> AppConfig {
    state.inner.lock().config.clone()
}

#[tauri::command]
fn list_projects(state: State<'_, AppState>) -> Vec<ProjectState> {
    let guard = state.inner.lock();
    let mut list: Vec<_> = guard.projects.values().cloned().collect();
    list.sort_by(|a, b| {
        a.group_id
            .cmp(&b.group_id)
            .then_with(|| a.name.cmp(&b.name))
    });
    list
}

#[tauri::command]
fn list_groups(state: State<'_, AppState>) -> Vec<GroupConfig> {
    state.inner.lock().config.groups.clone()
}

#[tauri::command]
fn add_group(state: State<'_, AppState>, name: String) -> Result<GroupConfig, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("分组名称不能为空".into());
    }
    let group = config::new_group(name);
    {
        let mut guard = state.inner.lock();
        if guard.config.groups.iter().any(|g| g.name == group.name) {
            return Err("已存在同名分组".into());
        }
        guard.config.groups.push(group.clone());
    }
    persist(&state)?;
    Ok(group)
}

#[tauri::command]
fn rename_group(state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("分组名称不能为空".into());
    }
    {
        let mut guard = state.inner.lock();
        let g = guard
            .config
            .groups
            .iter_mut()
            .find(|g| g.id == id)
            .ok_or_else(|| "分组不存在".to_string())?;
        g.name = name;
    }
    persist(&state)
}

#[tauri::command]
fn remove_group(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if id == UNGROUPED_ID {
        return Err("不能删除「未分组」".into());
    }
    {
        let mut guard = state.inner.lock();
        if !guard.config.groups.iter().any(|g| g.id == id) {
            return Err("分组不存在".into());
        }
        guard.config.groups.retain(|g| g.id != id);
        for p in &mut guard.config.projects {
            if p.group_id == id {
                p.group_id = UNGROUPED_ID.to_string();
            }
        }
        for p in guard.projects.values_mut() {
            if p.group_id == id {
                p.group_id = UNGROUPED_ID.to_string();
            }
        }
    }
    persist(&state)
}

#[tauri::command]
fn set_project_group(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    group_id: String,
) -> Result<ProjectState, String> {
    let out = {
        let mut guard = state.inner.lock();
        if !guard.config.groups.iter().any(|g| g.id == group_id) {
            return Err("目标分组不存在".into());
        }
        let cfg = guard
            .config
            .projects
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| "project not found".to_string())?;
        cfg.group_id = group_id.clone();
        let proj = guard
            .projects
            .get_mut(&id)
            .ok_or_else(|| "project not found".to_string())?;
        proj.group_id = group_id;
        proj.clone()
    };
    persist(&state)?;
    emit_project(&app, &out);
    Ok(out)
}

#[tauri::command]
fn add_project(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    name: Option<String>,
    group_id: Option<String>,
) -> Result<ProjectState, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_dir() {
        return Err("path is not a directory".into());
    }
    if !path_buf.join(".svn").exists() {
        return Err("所选目录不是 SVN 工作副本（缺少 .svn）".into());
    }

    let gid = {
        let guard = state.inner.lock();
        let candidate = group_id.unwrap_or_else(|| UNGROUPED_ID.to_string());
        if guard.config.groups.iter().any(|g| g.id == candidate) {
            candidate
        } else {
            UNGROUPED_ID.to_string()
        }
    };

    let project = config::new_project(path, name, Some(gid));
    let snapshot = {
        let mut guard = state.inner.lock();
        if guard
            .config
            .projects
            .iter()
            .any(|p| p.path.eq_ignore_ascii_case(&project.path))
        {
            return Err("该路径已在监控列表中".into());
        }
        guard.config.projects.push(project.clone());
        let ps = ProjectState::from_config(&project);
        guard.projects.insert(project.id.clone(), ps.clone());
        ps
    };
    persist(&state)?;
    emit_project(&app, &snapshot);
    if !polling_paused(&state) {
        let _ = check_one(&app, &state, &snapshot.id);
    }
    Ok(snapshot)
}

#[tauri::command]
fn remove_project(state: State<'_, AppState>, id: String) -> Result<(), String> {
    {
        let mut guard = state.inner.lock();
        guard.config.projects.retain(|p| p.id != id);
        guard.projects.remove(&id);
        guard.notified_remote.remove(&id);
    }
    persist(&state)
}

#[tauri::command]
fn save_settings(
    state: State<'_, AppState>,
    poll_interval_secs: u64,
    notify_enabled: bool,
    pause_when_locked: bool,
) -> Result<(), String> {
    if poll_interval_secs < 10 {
        return Err("poll interval must be >= 10 seconds".into());
    }
    {
        let mut guard = state.inner.lock();
        guard.config.poll_interval_secs = poll_interval_secs;
        guard.config.notify_enabled = notify_enabled;
        guard.config.pause_when_locked = pause_when_locked;
    }
    persist(&state)
}

#[tauri::command]
fn check_project(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<ProjectState, String> {
    if polling_paused(&state) {
        return Err("锁屏中，已暂停检查".into());
    }
    check_one(&app, &state, &id)
}

#[tauri::command]
fn check_all(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if polling_paused(&state) {
        return Err("锁屏中，已暂停检查".into());
    }
    check_all_inner(&app, &state);
    Ok(())
}

#[tauri::command]
fn update_project(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<ProjectState, String> {
    if polling_paused(&state) {
        return Err("锁屏中，已暂停操作".into());
    }
    let path = {
        let guard = state.inner.lock();
        guard
            .projects
            .get(&id)
            .map(|p| p.path.clone())
            .ok_or_else(|| "project not found".to_string())?
    };
    svn::update(PathBuf::from(&path).as_path()).map_err(|e| e.to_string())?;
    {
        let mut guard = state.inner.lock();
        guard.notified_remote.remove(&id);
    }
    check_one(&app, &state, &id)
}

#[tauri::command]
fn open_project_folder(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let path = {
        let guard = state.inner.lock();
        guard
            .projects
            .get(&id)
            .map(|p| p.path.clone())
            .ok_or_else(|| "project not found".to_string())?
    };
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn is_session_locked(state: State<'_, AppState>) -> bool {
    let guard = state.inner.lock();
    guard.config.pause_when_locked && guard.session_locked
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("SVN Monitor")
        .icon(app.default_window_icon().unwrap().clone())
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            get_config,
            list_projects,
            list_groups,
            add_group,
            rename_group,
            remove_group,
            set_project_group,
            add_project,
            remove_project,
            save_settings,
            check_project,
            check_all,
            update_project,
            open_project_folder,
            is_session_locked,
        ])
        .setup(move |app| {
            setup_tray(app.handle())?;
            session_lock::start_session_watch(app.handle().clone());
            spawn_poller(app.handle().clone(), state.clone());
            let app_handle = app.handle().clone();
            let state2 = state.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(2));
                check_all_inner(&app_handle, &state2);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
