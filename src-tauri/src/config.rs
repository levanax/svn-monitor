use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const UNGROUPED_ID: &str = "ungrouped";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupConfig {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectConfig {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default = "default_ungrouped_id")]
    pub group_id: String,
    /// 忽略本项目的系统通知（界面仍显示有更新）
    #[serde(default = "default_false")]
    pub mute_notify: bool,
    /// 组内显示顺序（越小越靠前）
    #[serde(default)]
    pub sort_order: u32,
}

fn default_ungrouped_id() -> String {
    UNGROUPED_ID.to_string()
}

fn default_true() -> bool {
    true
}

fn default_false() -> bool {
    false
}

fn default_theme() -> String {
    "system".to_string()
}

pub const MIN_WINDOW_WIDTH: f64 = 720.0;
pub const MIN_WINDOW_HEIGHT: f64 = 520.0;
pub const DEFAULT_WINDOW_WIDTH: f64 = 980.0;
pub const DEFAULT_WINDOW_HEIGHT: f64 = 720.0;

/// 主窗逻辑坐标几何（与 WebviewWindowBuilder 一致）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WindowGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub maximized: bool,
}

impl WindowGeometry {
    pub fn sanitized(self) -> Self {
        Self {
            x: self.x,
            y: self.y,
            width: self.width.max(MIN_WINDOW_WIDTH),
            height: self.height.max(MIN_WINDOW_HEIGHT),
            maximized: self.maximized,
        }
    }
}

/// 判断窗口至少有一个角落在任一显示器矩形内（逻辑坐标 x,y,w,h）。
pub fn window_geometry_on_monitors(geo: &WindowGeometry, monitors: &[(f64, f64, f64, f64)]) -> bool {
    if monitors.is_empty() {
        return true;
    }
    let corners = [
        (geo.x, geo.y),
        (geo.x + geo.width, geo.y),
        (geo.x, geo.y + geo.height),
        (geo.x + geo.width, geo.y + geo.height),
    ];
    for &(mx, my, mw, mh) in monitors {
        for &(cx, cy) in &corners {
            if cx >= mx && cx < mx + mw && cy >= my && cy < my + mh {
                return true;
            }
        }
    }
    false
}

fn monitor_containing_point(
    x: f64,
    y: f64,
    monitors: &[(f64, f64, f64, f64)],
) -> Option<(f64, f64, f64, f64)> {
    monitors
        .iter()
        .copied()
        .find(|&(mx, my, mw, mh)| x >= mx && x < mx + mw && y >= my && y < my + mh)
}

/// 将还原尺寸限制在落点显示器内，避免把「整屏最大化尺寸」带到另一块屏后还原爆大。
pub fn clamp_window_geometry_to_monitors(
    mut geo: WindowGeometry,
    monitors: &[(f64, f64, f64, f64)],
) -> WindowGeometry {
    geo = geo.sanitized();
    if monitors.is_empty() {
        return geo;
    }
    let cx = geo.x + geo.width / 2.0;
    let cy = geo.y + geo.height / 2.0;
    let (mx, my, mw, mh) = monitor_containing_point(cx, cy, monitors)
        .or_else(|| monitor_containing_point(geo.x, geo.y, monitors))
        .unwrap_or(monitors[0]);

    // 留一点边距，避免贴满工作区被当成又一次「伪最大化」
    let max_w = (mw * 0.96).max(MIN_WINDOW_WIDTH);
    let max_h = (mh * 0.96).max(MIN_WINDOW_HEIGHT);
    geo.width = geo.width.clamp(MIN_WINDOW_WIDTH, max_w);
    geo.height = geo.height.clamp(MIN_WINDOW_HEIGHT, max_h);
    geo.x = geo.x.clamp(mx, (mx + mw - geo.width).max(mx));
    geo.y = geo.y.clamp(my, (my + mh - geo.height).max(my));
    geo
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub poll_interval_secs: u64,
    /// 兼容旧配置；运行时固定为 true（界面不再提供开关）
    #[serde(default = "default_true")]
    pub notify_enabled: bool,
    /// 兼容旧配置；运行时固定为 true（界面不再提供开关）
    #[serde(default = "default_true")]
    pub pause_when_locked: bool,
    #[serde(default = "default_false")]
    pub autostart: bool,
    /// system | light | dark | dawn | sky | lilac | mint | dusk | noir
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub groups: Vec<GroupConfig>,
    pub projects: Vec<ProjectConfig>,
    /// 主窗关闭前记住的大小与位置
    #[serde(default)]
    pub window_geometry: Option<WindowGeometry>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            poll_interval_secs: 300,
            notify_enabled: true,
            pause_when_locked: true,
            autostart: false,
            theme: default_theme(),
            groups: vec![default_ungrouped_group()],
            projects: Vec::new(),
            window_geometry: None,
        }
    }
}

pub fn normalize_theme(theme: &str) -> String {
    match theme {
        "system" | "light" | "dark" | "dawn" | "sky" | "lilac" | "mint" | "dusk" | "noir" => {
            theme.to_string()
        }
        _ => default_theme(),
    }
}

pub fn default_ungrouped_group() -> GroupConfig {
    GroupConfig {
        id: UNGROUPED_ID.to_string(),
        name: "未分组".to_string(),
    }
}

pub fn config_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("svn-monitor").join("config.json")
}

/// Ensure ungrouped exists, every project points at a known group, and sort_order is dense per group.
pub fn normalize(mut cfg: AppConfig) -> AppConfig {
    cfg.theme = normalize_theme(&cfg.theme);
    cfg.notify_enabled = true;
    cfg.pause_when_locked = true;
    if let Some(geo) = cfg.window_geometry.take() {
        let geo = geo.sanitized();
        if geo.width.is_finite() && geo.height.is_finite() && geo.x.is_finite() && geo.y.is_finite() {
            cfg.window_geometry = Some(geo);
        }
    }
    if !cfg.groups.iter().any(|g| g.id == UNGROUPED_ID) {
        cfg.groups.insert(0, default_ungrouped_group());
    }
    let known: std::collections::HashSet<_> = cfg.groups.iter().map(|g| g.id.clone()).collect();
    for p in &mut cfg.projects {
        if p.group_id.is_empty() || !known.contains(&p.group_id) {
            p.group_id = UNGROUPED_ID.to_string();
        }
    }
    reindex_sort_orders(&mut cfg);
    cfg
}

fn reindex_sort_orders(cfg: &mut AppConfig) {
    use std::collections::HashMap;
    let mut by_group: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, p) in cfg.projects.iter().enumerate() {
        by_group.entry(p.group_id.clone()).or_default().push(i);
    }
    for indices in by_group.values_mut() {
        indices.sort_by(|&a, &b| {
            cfg.projects[a]
                .sort_order
                .cmp(&cfg.projects[b].sort_order)
                .then_with(|| cfg.projects[a].name.cmp(&cfg.projects[b].name))
        });
        for (order, &idx) in indices.iter().enumerate() {
            cfg.projects[idx].sort_order = order as u32;
        }
    }
}

pub fn next_sort_order(cfg: &AppConfig, group_id: &str) -> u32 {
    cfg.projects
        .iter()
        .filter(|p| p.group_id == group_id)
        .map(|p| p.sort_order)
        .max()
        .map(|m| m + 1)
        .unwrap_or(0)
}

pub fn load() -> AppConfig {
    let path = config_path();
    let cfg = match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => AppConfig::default(),
    };
    normalize(cfg)
}

pub fn save(cfg: &AppConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}

pub fn default_name_for(path: &Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unnamed")
        .to_string()
}

pub fn new_project(
    path: String,
    name: Option<String>,
    group_id: Option<String>,
    sort_order: u32,
) -> ProjectConfig {
    let p = PathBuf::from(&path);
    ProjectConfig {
        id: Uuid::new_v4().to_string(),
        name: name.unwrap_or_else(|| default_name_for(&p)),
        path,
        group_id: group_id.unwrap_or_else(default_ungrouped_id),
        mute_notify: false,
        sort_order,
    }
}

pub fn new_group(name: String) -> GroupConfig {
    GroupConfig {
        id: Uuid::new_v4().to_string(),
        name,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_name_uses_folder() {
        assert_eq!(default_name_for(Path::new(r"C:\work\mobile")), "mobile");
    }

    #[test]
    fn normalize_adds_ungrouped_and_repairs_orphan() {
        let cfg = AppConfig {
            poll_interval_secs: 300,
            notify_enabled: true,
            pause_when_locked: true,
            autostart: false,
            theme: "dawn".into(),
            groups: vec![GroupConfig {
                id: "g1".into(),
                name: "A".into(),
            }],
            projects: vec![ProjectConfig {
                id: "p1".into(),
                name: "x".into(),
                path: r"C:\x".into(),
                group_id: "missing".into(),
                mute_notify: false,
                sort_order: 0,
            }],
            window_geometry: None,
        };
        let n = normalize(cfg);
        assert!(n.groups.iter().any(|g| g.id == UNGROUPED_ID));
        assert_eq!(n.projects[0].group_id, UNGROUPED_ID);
        assert_eq!(n.projects[0].sort_order, 0);
    }

    #[test]
    fn window_geometry_sanitized_enforces_min_size() {
        let g = WindowGeometry {
            x: 10.0,
            y: 20.0,
            width: 100.0,
            height: 50.0,
            maximized: false,
        }
        .sanitized();
        assert_eq!(g.width, MIN_WINDOW_WIDTH);
        assert_eq!(g.height, MIN_WINDOW_HEIGHT);
        assert_eq!(g.x, 10.0);
    }

    #[test]
    fn window_geometry_on_monitors_detects_offscreen() {
        let monitors = [(0.0, 0.0, 1920.0, 1080.0)];
        let on = WindowGeometry {
            x: 100.0,
            y: 100.0,
            width: 800.0,
            height: 600.0,
            maximized: false,
        };
        let off = WindowGeometry {
            x: 5000.0,
            y: 5000.0,
            width: 800.0,
            height: 600.0,
            maximized: false,
        };
        assert!(window_geometry_on_monitors(&on, &monitors));
        assert!(!window_geometry_on_monitors(&off, &monitors));
        assert!(window_geometry_on_monitors(&off, &[]));
    }

    #[test]
    fn clamp_prevents_fullscreen_restore_size_on_smaller_monitor() {
        // 主屏 2560x1440 的「伪最大化」尺寸，落到副屏 1920x1080
        let monitors = [(0.0, 0.0, 2560.0, 1440.0), (2560.0, 0.0, 1920.0, 1080.0)];
        let geo = WindowGeometry {
            x: 2600.0,
            y: 40.0,
            width: 2560.0,
            height: 1440.0,
            maximized: true,
        };
        let c = clamp_window_geometry_to_monitors(geo, &monitors);
        assert!(c.width <= 1920.0 * 0.96 + 0.1);
        assert!(c.height <= 1080.0 * 0.96 + 0.1);
        assert!(c.x >= 2560.0);
        assert!(c.x + c.width <= 2560.0 + 1920.0 + 0.1);
    }

    #[test]
    fn normalize_drops_non_finite_window_geometry() {
        let cfg = AppConfig {
            window_geometry: Some(WindowGeometry {
                x: f64::NAN,
                y: 0.0,
                width: 900.0,
                height: 600.0,
                maximized: false,
            }),
            ..AppConfig::default()
        };
        let n = normalize(cfg);
        assert!(n.window_geometry.is_none());
    }

    #[test]
    fn deserialize_legacy_without_window_geometry() {
        let raw = r#"{"poll_interval_secs":30,"notify_enabled":true,"projects":[{"id":"1","name":"a","path":"C:\\a"}]}"#;
        let cfg: AppConfig = serde_json::from_str(raw).unwrap();
        assert!(cfg.window_geometry.is_none());
    }

    #[test]
    fn deserialize_legacy_without_groups() {
        let raw = r#"{"poll_interval_secs":30,"notify_enabled":true,"projects":[{"id":"1","name":"a","path":"C:\\a"}]}"#;
        let cfg: AppConfig = serde_json::from_str(raw).unwrap();
        let n = normalize(cfg);
        assert_eq!(n.projects[0].group_id, UNGROUPED_ID);
        assert!(!n.projects[0].mute_notify);
        assert!(n.pause_when_locked);
        assert_eq!(n.theme, "system");
    }

    #[test]
    fn normalize_theme_keeps_system_light_dark() {
        assert_eq!(normalize_theme("system"), "system");
        assert_eq!(normalize_theme("light"), "light");
        assert_eq!(normalize_theme("dark"), "dark");
        assert_eq!(normalize_theme("dawn"), "dawn");
        assert_eq!(normalize_theme("nope"), "system");
    }
}
