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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub poll_interval_secs: u64,
    pub notify_enabled: bool,
    #[serde(default = "default_true")]
    pub pause_when_locked: bool,
    #[serde(default = "default_false")]
    pub autostart: bool,
    #[serde(default)]
    pub groups: Vec<GroupConfig>,
    pub projects: Vec<ProjectConfig>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            poll_interval_secs: 60,
            notify_enabled: true,
            pause_when_locked: true,
            autostart: false,
            groups: vec![default_ungrouped_group()],
            projects: Vec::new(),
        }
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

/// Ensure ungrouped exists and every project points at a known group.
pub fn normalize(mut cfg: AppConfig) -> AppConfig {
    if !cfg.groups.iter().any(|g| g.id == UNGROUPED_ID) {
        cfg.groups.insert(0, default_ungrouped_group());
    }
    let known: std::collections::HashSet<_> = cfg.groups.iter().map(|g| g.id.clone()).collect();
    for p in &mut cfg.projects {
        if p.group_id.is_empty() || !known.contains(&p.group_id) {
            p.group_id = UNGROUPED_ID.to_string();
        }
    }
    cfg
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

pub fn new_project(path: String, name: Option<String>, group_id: Option<String>) -> ProjectConfig {
    let p = PathBuf::from(&path);
    ProjectConfig {
        id: Uuid::new_v4().to_string(),
        name: name.unwrap_or_else(|| default_name_for(&p)),
        path,
        group_id: group_id.unwrap_or_else(default_ungrouped_id),
        mute_notify: false,
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
            poll_interval_secs: 60,
            notify_enabled: true,
            pause_when_locked: true,
            autostart: false,
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
            }],
        };
        let n = normalize(cfg);
        assert!(n.groups.iter().any(|g| g.id == UNGROUPED_ID));
        assert_eq!(n.projects[0].group_id, UNGROUPED_ID);
    }

    #[test]
    fn deserialize_legacy_without_groups() {
        let raw = r#"{"poll_interval_secs":30,"notify_enabled":true,"projects":[{"id":"1","name":"a","path":"C:\\a"}]}"#;
        let cfg: AppConfig = serde_json::from_str(raw).unwrap();
        let n = normalize(cfg);
        assert_eq!(n.projects[0].group_id, UNGROUPED_ID);
        assert!(!n.projects[0].mute_notify);
        assert!(n.pause_when_locked);
    }
}
