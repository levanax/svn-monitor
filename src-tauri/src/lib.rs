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
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_notification::NotificationExt;

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
    /// 仓库内相对路径，如 trunk / branches/xxx；检查成功后填充
    pub svn_rel_path: Option<String>,
    pub group_id: String,
    pub mute_notify: bool,
    pub sort_order: u32,
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
            svn_rel_path: None,
            group_id: p.group_id.clone(),
            mute_notify: p.mute_notify,
            sort_order: p.sort_order,
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
    // 锁屏时始终暂停轮询（不再提供开关）
    state.inner.lock().session_locked
}

fn persist(state: &AppState) -> Result<(), String> {
    let guard = state.inner.lock();
    config::save(&guard.config)
}

fn emit_project(app: &AppHandle, state: &ProjectState) {
    let _ = app.emit("project-updated", state);
}

fn truncate_notify_text(s: &str, max_chars: usize) -> String {
    let count = s.chars().count();
    if count <= max_chars {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// 每个更高的远端 revision 提醒一次（窗口是否在前台无关）。
fn should_notify_for_remote(
    notify_on: bool,
    muted: bool,
    already: Option<u64>,
    remote: u64,
) -> bool {
    if !notify_on || muted {
        return false;
    }
    match already {
        Some(prev) => remote > prev,
        None => true,
    }
}

/// 返回是否成功发出系统通知。失败时不记「已通知」，以便下次轮询重试。
fn show_update_notification(app: &AppHandle, name: &str, local: u64, remote: u64, log_summary: &str) -> bool {
    let title = "SVN 有更新";
    let headline = format!("{name}：本地 r{local} → 远端 r{remote}");
    let first_log = log_summary.lines().next().unwrap_or("").trim();
    let body = if first_log.is_empty() {
        headline.clone()
    } else {
        format!("{headline}\n{first_log}")
    };
    // Windows Toast 正文过长易失败；截断到合理长度
    let body = truncate_notify_text(&body, 180);

    #[cfg(windows)]
    {
        if show_windows_toast(app, title, &headline, first_log) {
            return true;
        }
        eprintln!("windows toast failed, falling back to notification plugin");
    }

    match app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show()
    {
        Ok(()) => true,
        Err(e) => {
            eprintln!("notification plugin show failed: {e}");
            false
        }
    }
}

#[cfg(windows)]
fn show_windows_toast(app: &AppHandle, title: &str, line1: &str, line2: &str) -> bool {
    use tauri_winrt_notification::{Duration, Sound, Toast};

    let line1 = truncate_notify_text(line1, 120);
    let line2 = truncate_notify_text(line2, 120);
    let identifier = app.config().identifier.clone();

    // PowerShell AUMID 不依赖安装快捷方式，前台/关窗都能弹出；再尝试应用自身 AUMID 以显示「SVN Monitor」
    let app_ids: Vec<&str> = vec![Toast::POWERSHELL_APP_ID, identifier.as_str()];

    for app_id in app_ids {
        let mut toast = Toast::new(app_id)
            .title(title)
            .text1(&line1)
            .duration(Duration::Long)
            .sound(Some(Sound::Default));
        if !line2.is_empty() {
            toast = toast.text2(&line2);
        }
        match toast.show() {
            Ok(()) => {
                eprintln!("toast shown via {app_id}");
                return true;
            }
            Err(e) => eprintln!("toast via {app_id} failed: {e}"),
        }
    }
    false
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
            if revs.rel_path.is_some() {
                proj.svn_rel_path = revs.rel_path;
            }
            proj.error = None;
            // behind 来自 `svn status -u`，不能用全局 HEAD 与本地 Revision 比大小
            if revs.behind {
                proj.status = ProjectStatus::Behind;
                let muted = proj.mute_notify;
                let already = guard.notified_remote.get(id).copied();
                // 系统通知始终开启；每个更高的远端 revision 提醒一次
                let should_notify = should_notify_for_remote(true, muted, already, revs.remote);
                if should_notify {
                    drop(guard);
                    let log_summary = svn::fetch_incoming_log_summary(
                        PathBuf::from(&path).as_path(),
                        revs.local,
                        revs.remote,
                    );
                    // 仅在真正发出通知后记录，避免失败后本会话再也不提醒
                    if show_update_notification(app, &name, revs.local, revs.remote, &log_summary) {
                        let mut guard = state.inner.lock();
                        guard.notified_remote.insert(id.to_string(), revs.remote);
                    } else {
                        eprintln!(
                            "notify failed for {name} r{}→r{}; will retry next poll",
                            revs.local, revs.remote
                        );
                    }
                    let payload = serde_json::json!({
                        "name": name,
                        "local": revs.local,
                        "remote": revs.remote,
                        "log": log_summary,
                    });
                    let _ = app.emit("svn-behind", payload);
                    let guard = state.inner.lock();
                    let out = guard.projects.get(id).cloned().unwrap();
                    emit_project(app, &out);
                    return Ok(out);
                }
            } else {
                proj.status = ProjectStatus::UpToDate;
                // 已同步：把水位记到当前本地，之后只有更高远端 revision 才再提醒
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
            guard.config.poll_interval_secs.max(60)
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
            .then_with(|| a.sort_order.cmp(&b.sort_order))
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
        let order = config::next_sort_order(&guard.config, &group_id);
        {
            let cfg = guard
                .config
                .projects
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or_else(|| "project not found".to_string())?;
            cfg.group_id = group_id.clone();
            cfg.sort_order = order;
        }
        let proj = guard
            .projects
            .get_mut(&id)
            .ok_or_else(|| "project not found".to_string())?;
        proj.group_id = group_id;
        proj.sort_order = order;
        proj.clone()
    };
    persist(&state)?;
    emit_project(&app, &out);
    Ok(out)
}

#[tauri::command]
fn reorder_projects(
    state: State<'_, AppState>,
    group_id: String,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    {
        let mut guard = state.inner.lock();
        if !guard.config.groups.iter().any(|g| g.id == group_id) {
            return Err("分组不存在".into());
        }
        let in_group: std::collections::HashSet<_> = guard
            .config
            .projects
            .iter()
            .filter(|p| p.group_id == group_id)
            .map(|p| p.id.clone())
            .collect();
        if ordered_ids.len() != in_group.len()
            || ordered_ids.iter().any(|id| !in_group.contains(id))
        {
            return Err("排序列表与组内项目不匹配".into());
        }
        for (order, id) in ordered_ids.iter().enumerate() {
            if let Some(cfg) = guard.config.projects.iter_mut().find(|p| p.id == *id) {
                cfg.sort_order = order as u32;
            }
            if let Some(proj) = guard.projects.get_mut(id) {
                proj.sort_order = order as u32;
            }
        }
    }
    persist(&state)
}

#[tauri::command]
fn reorder_groups(state: State<'_, AppState>, ordered_ids: Vec<String>) -> Result<(), String> {
    {
        let mut guard = state.inner.lock();
        let known: std::collections::HashSet<_> =
            guard.config.groups.iter().map(|g| g.id.clone()).collect();
        if ordered_ids.len() != known.len() || ordered_ids.iter().any(|id| !known.contains(id)) {
            return Err("分组排序列表与现有分组不匹配".into());
        }
        let mut by_id: std::collections::HashMap<_, _> = guard
            .config
            .groups
            .drain(..)
            .map(|g| (g.id.clone(), g))
            .collect();
        guard.config.groups = ordered_ids
            .into_iter()
            .filter_map(|id| by_id.remove(&id))
            .collect();
    }
    persist(&state)
}

#[tauri::command]
fn set_project_mute(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    mute_notify: bool,
) -> Result<ProjectState, String> {
    let out = {
        let mut guard = state.inner.lock();
        {
            let cfg = guard
                .config
                .projects
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or_else(|| "project not found".to_string())?;
            cfg.mute_notify = mute_notify;
        }
        {
            let proj = guard
                .projects
                .get_mut(&id)
                .ok_or_else(|| "project not found".to_string())?;
            proj.mute_notify = mute_notify;
        }
        // 重新开启提醒后允许再次通知当前远端 revision
        if !mute_notify {
            guard.notified_remote.remove(&id);
        }
        guard
            .projects
            .get(&id)
            .cloned()
            .ok_or_else(|| "project not found".to_string())?
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

    let (gid, order) = {
        let guard = state.inner.lock();
        let candidate = group_id.unwrap_or_else(|| UNGROUPED_ID.to_string());
        let gid = if guard.config.groups.iter().any(|g| g.id == candidate) {
            candidate
        } else {
            UNGROUPED_ID.to_string()
        };
        let order = config::next_sort_order(&guard.config, &gid);
        (gid, order)
    };

    let project = config::new_project(path, name, Some(gid), order);
    let snapshot = {
        let mut guard = state.inner.lock();
        if guard.config.projects.iter().any(|p| {
            p.path.eq_ignore_ascii_case(&project.path) && p.group_id == project.group_id
        }) {
            return Err("该路径已在此分组中".into());
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

fn sync_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        manager.disable().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    poll_interval_secs: u64,
    autostart: bool,
    theme: String,
) -> Result<(), String> {
    if poll_interval_secs < 60 {
        return Err("poll interval must be >= 1 minute".into());
    }
    {
        let mut guard = state.inner.lock();
        guard.config.poll_interval_secs = poll_interval_secs;
        // 系统通知 / 锁屏暂停：产品固定启用，不再由设置项控制
        guard.config.notify_enabled = true;
        guard.config.pause_when_locked = true;
        guard.config.autostart = autostart;
        guard.config.theme = config::normalize_theme(&theme);
    }
    persist(&state)?;
    sync_autostart(&app, autostart)
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
    // 优先打开 TortoiseSVN Update UI；未安装时回退到 svn update
    let wc = PathBuf::from(&path);
    if svn::find_tortoise_proc().is_some() {
        svn::open_tortoise_update(wc.as_path()).map_err(|e| e.to_string())?;
    } else {
        svn::update(wc.as_path()).map_err(|e| e.to_string())?;
    }
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

fn find_cursor_cli() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = std::process::Command::new("where");
        cmd.arg("cursor.cmd").creation_flags(CREATE_NO_WINDOW);
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Some(first) = text.lines().next().map(str::trim).filter(|s| !s.is_empty()) {
                    let p = PathBuf::from(first);
                    if p.is_file() {
                        return Some(p);
                    }
                }
            }
        }
    }

    let mut candidates = Vec::new();
    if let Ok(pf) = std::env::var("ProgramFiles") {
        let root = PathBuf::from(pf).join("cursor");
        candidates.push(root.join(r"resources\app\bin\cursor.cmd"));
        candidates.push(root.join("Cursor.exe"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let root = PathBuf::from(local).join(r"Programs\cursor");
        candidates.push(root.join(r"resources\app\bin\cursor.cmd"));
        candidates.push(root.join("Cursor.exe"));
    }
    candidates.push(PathBuf::from(r"C:\Program Files\cursor\resources\app\bin\cursor.cmd"));
    candidates.push(PathBuf::from(r"C:\Program Files\cursor\Cursor.exe"));

    candidates.into_iter().find(|p| p.is_file())
}

#[tauri::command]
fn open_in_cursor(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let path = {
        let guard = state.inner.lock();
        guard
            .projects
            .get(&id)
            .map(|p| p.path.clone())
            .ok_or_else(|| "project not found".to_string())?
    };
    let cursor = find_cursor_cli().ok_or_else(|| {
        "未找到 Cursor。请确认已安装，并把 cursor 加入 PATH（Cursor → Command Palette → Shell Command: Install）。"
            .to_string()
    })?;
    let mut cmd = std::process::Command::new(&cursor);
    cmd.arg(&path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("启动 Cursor 失败: {e}"))
}

#[tauri::command]
fn open_tortoise_log(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let path = {
        let guard = state.inner.lock();
        guard
            .projects
            .get(&id)
            .map(|p| p.path.clone())
            .ok_or_else(|| "project not found".to_string())?
    };
    svn::open_tortoise_show_log(PathBuf::from(&path).as_path()).map_err(|e| e.to_string())
}

#[tauri::command]
fn is_session_locked(state: State<'_, AppState>) -> bool {
    state.inner.lock().session_locked
}

/// Windows：关闭后重建 WebView 时，系统偶发把光标卡在 IDC_APPSTARTING（loading）。
/// 强制切回箭头，并用 SetCursorPos 触发 WM_SETCURSOR 刷新。
#[cfg(windows)]
fn reset_busy_cursor() {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, LoadCursorW, SetCursor, SetCursorPos, IDC_ARROW,
    };
    unsafe {
        if let Ok(arrow) = LoadCursorW(None, IDC_ARROW) {
            let _ = SetCursor(Some(arrow));
        }
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_ok() {
            let _ = SetCursorPos(pt.x, pt.y);
        }
    }
}

#[cfg(not(windows))]
fn reset_busy_cursor() {}

fn schedule_cursor_reset() {
    thread::spawn(|| {
        for ms in [50u64, 200, 600, 1200] {
            thread::sleep(Duration::from_millis(ms));
            reset_busy_cursor();
        }
    });
}

#[tauri::command]
fn notify_ui_ready() {
    reset_busy_cursor();
    schedule_cursor_reset();
}

fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        reset_busy_cursor();
        return;
    }
    // 关闭界面时已销毁 WebView，这里按需重建以降低常驻内存
    match WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("SVN Monitor")
        .inner_size(980.0, 720.0)
        .min_inner_size(720.0, 520.0)
        .resizable(true)
        .center()
        // dragDropEnabled=true：允许从资源管理器拖文件夹进分组（组内排序改用指针拖拽）
        .build()
    {
        Ok(w) => {
            let _ = w.show();
            let _ = w.set_focus();
            reset_busy_cursor();
            // WebView 导航完成前系统可能再次设成 loading，延迟再清几次
            schedule_cursor_reset();
        }
        Err(e) => eprintln!("failed to recreate main window: {e}"),
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        // 左键打开主界面；右键才弹出菜单
        .show_menu_on_left_click(false)
        .tooltip("SVN Monitor")
        .icon(app.default_window_icon().unwrap().clone())
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
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
                show_main_window(tray.app_handle());
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
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            get_config,
            list_projects,
            list_groups,
            add_group,
            rename_group,
            remove_group,
            set_project_group,
            set_project_mute,
            reorder_projects,
            reorder_groups,
            add_project,
            remove_project,
            save_settings,
            check_project,
            check_all,
            update_project,
            open_project_folder,
            open_in_cursor,
            open_tortoise_log,
            is_session_locked,
            notify_ui_ready,
        ])
        .setup(move |app| {
            setup_tray(app.handle())?;
            session_lock::start_session_watch(app.handle().clone());
            spawn_poller(app.handle().clone(), state.clone());
            let autostart = state.inner.lock().config.autostart;
            let _ = sync_autostart(app.handle(), autostart);
            let app_handle = app.handle().clone();
            let state2 = state.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(2));
                check_all_inner(&app_handle, &state2);
            });
            reset_busy_cursor();
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        api.prevent_close();
                        let _ = window.destroy();
                    }
                }
                WindowEvent::Focused(true) if window.label() == "main" => {
                    reset_busy_cursor();
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod notify_tests {
    use super::should_notify_for_remote;

    #[test]
    fn notifies_first_behind_when_never_notified() {
        assert!(should_notify_for_remote(true, false, None, 101));
    }

    #[test]
    fn notifies_only_when_remote_increases() {
        assert!(!should_notify_for_remote(true, false, Some(101), 101));
        assert!(should_notify_for_remote(true, false, Some(101), 102));
    }

    #[test]
    fn respects_global_and_per_project_mute() {
        assert!(!should_notify_for_remote(false, false, None, 101));
        assert!(!should_notify_for_remote(true, true, None, 101));
    }
}
