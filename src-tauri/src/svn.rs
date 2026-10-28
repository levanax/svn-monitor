use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SvnCheck {
    pub local: u64,
    /// 用于展示的远端修订；已同步时与 local 相同，避免全局 HEAD 造成误导
    pub remote: u64,
    /// 是否对本工作副本有可更新内容（基于 `svn status -u`）
    pub behind: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SvnError {
    #[error("not a working copy: {0}")]
    NotWorkingCopy(String),
    #[error("svn failed: {0}")]
    Command(String),
    #[error("parse error: {0}")]
    Parse(String),
}

pub fn parse_revision(info_output: &str) -> Result<u64, SvnError> {
    for line in info_output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Revision:") {
            let rev = rest
                .trim()
                .parse::<u64>()
                .map_err(|e| SvnError::Parse(e.to_string()))?;
            return Ok(rev);
        }
    }
    Err(SvnError::Parse("Revision field not found".into()))
}

/// 解析 `svn status -u`：第九列 `*` 表示该路径相对服务器落后；
/// `Status against revision` 为对照的仓库修订号。
pub fn parse_status_u(status_output: &str) -> (bool, Option<u64>) {
    let mut behind = false;
    let mut against = None;

    for line in status_output.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Status against revision:") {
            against = rest.trim().parse().ok();
            continue;
        }
        // svn status 第九列（0-based index 8）为 out-of-date 标记
        let bytes = line.as_bytes();
        if bytes.len() > 8 && bytes[8] == b'*' {
            behind = true;
        }
    }

    (behind, against)
}

fn run_svn(args: &[&str], cwd: &Path) -> Result<String, SvnError> {
    let output = Command::new("svn")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| SvnError::Command(format!("failed to spawn svn: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let msg = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            stdout.trim().to_string()
        };
        if msg.to_lowercase().contains("not a working copy") {
            return Err(SvnError::NotWorkingCopy(cwd.display().to_string()));
        }
        return Err(SvnError::Command(if msg.is_empty() {
            format!("exit {}", output.status)
        } else {
            msg
        }));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub fn query_revisions(wc: &Path) -> Result<SvnCheck, SvnError> {
    if !wc.join(".svn").exists() {
        return Err(SvnError::NotWorkingCopy(wc.display().to_string()));
    }
    let local_out = run_svn(&["info"], wc)?;
    let local = parse_revision(&local_out)?;

    // -u：对照服务器；不要用 info -r HEAD 的 Revision（那是仓库全局修订，会误报）
    let status_out = run_svn(&["status", "-u"], wc)?;
    let (behind, against) = parse_status_u(&status_out);

    let remote = if behind {
        against.unwrap_or(local).max(local)
    } else {
        // 已同步：展示上与本地一致，避免「远端数字更大却无更新」
        local
    };

    Ok(SvnCheck {
        local,
        remote,
        behind,
    })
}

pub fn update(wc: &Path) -> Result<String, SvnError> {
    run_svn(&["update"], wc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_revision_from_info() {
        let sample = "Path: .\nWorking Copy Root Path: C:\\repo\nURL: https://svn.example/trunk\nRelative URL: ^/trunk\nRepository Root: https://svn.example\nRepository UUID: abc\nRevision: 18497\nNode Kind: directory\n";
        assert_eq!(parse_revision(sample).unwrap(), 18497);
    }

    #[test]
    fn parse_revision_missing() {
        assert!(parse_revision("Path: .\n").is_err());
    }

    #[test]
    fn status_u_no_star_means_not_behind_even_if_head_higher() {
        // 仓库 HEAD 已到 71，但本路径无 * → 不应判定为有更新
        let out = "\
M                70   local-only.txt\n\
Status against revision:     71\n";
        let (behind, against) = parse_status_u(out);
        assert!(!behind);
        assert_eq!(against, Some(71));
    }

    #[test]
    fn status_u_star_means_behind() {
        let out = "\
        *        70   README\n\
M       *        70   foo.c\n\
Status against revision:     70\n";
        let (behind, against) = parse_status_u(out);
        assert!(behind);
        assert_eq!(against, Some(70));
    }

    #[test]
    fn status_u_empty_is_up_to_date() {
        let out = "Status against revision:     65\n";
        let (behind, against) = parse_status_u(out);
        assert!(!behind);
        assert_eq!(against, Some(65));
    }
}
