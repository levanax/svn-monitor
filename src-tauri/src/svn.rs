use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SvnCheck {
    pub local: u64,
    /// 用于展示的远端修订；已同步时与 local 相同，避免全局 HEAD 造成误导
    pub remote: u64,
    /// 是否对本工作副本有可更新内容（基于 `svn status -u`）
    pub behind: bool,
    /// 仓库内相对路径，如 `trunk` / `branches/feature-x`（来自 Relative URL 或 URL）
    pub rel_path: Option<String>,
}

/// 解码 svn 子进程输出：优先 UTF-8；Windows 中文环境常为系统代码页（GB18030/GBK）。
pub fn decode_svn_output(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_owned();
    }
    // GB18030 是 GBK 超集，覆盖简体中文 Windows 上 svn 控制台输出
    let (cow, _, _) = encoding_rs::GB18030.decode(bytes);
    cow.into_owned()
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

fn field_after_prefix(info_output: &str, prefix: &str) -> Option<String> {
    for line in info_output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(prefix) {
            let v = rest.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// 从 `svn info` 得到仓库内相对路径（去掉 `^/`），便于识别 trunk / branches。
pub fn parse_rel_path(info_output: &str) -> Option<String> {
    if let Some(rel) = field_after_prefix(info_output, "Relative URL:") {
        let trimmed = rel.trim_start_matches('^').trim_start_matches('/');
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let url = field_after_prefix(info_output, "URL:")?;
    let root = field_after_prefix(info_output, "Repository Root:")?;
    let url = url.trim_end_matches('/');
    let root = root.trim_end_matches('/');
    if let Some(rest) = url.strip_prefix(root) {
        let trimmed = rest.trim_start_matches('/');
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
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
    let mut cmd = Command::new("svn");
    cmd.args(args).current_dir(cwd);
    // Windows：避免每次调用 svn 时黑框窗口闪一下
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .map_err(|e| SvnError::Command(format!("failed to spawn svn: {e}")))?;

    if !output.status.success() {
        let stderr = decode_svn_output(&output.stderr);
        let stdout = decode_svn_output(&output.stdout);
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

    Ok(decode_svn_output(&output.stdout))
}

/// 从 `svn log` 文本提取「rN: message」摘要（最多 max 条）。
pub fn summarize_log(log_output: &str, max: usize) -> String {
    let mut items: Vec<String> = Vec::new();
    let mut current_rev: Option<u64> = None;
    let mut expecting_msg = false;
    let mut msg_buf = String::new();

    let flush = |rev: &mut Option<u64>, buf: &mut String, out: &mut Vec<String>| {
        if let Some(r) = rev.take() {
            let msg = buf.trim().replace('\n', " ");
            let msg = if msg.is_empty() {
                "(无说明)".to_string()
            } else {
                msg
            };
            out.push(format!("r{r}: {msg}"));
            buf.clear();
        }
    };

    for line in log_output.lines() {
        if line.starts_with("-----") {
            if expecting_msg || current_rev.is_some() {
                flush(&mut current_rev, &mut msg_buf, &mut items);
                expecting_msg = false;
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix('r') {
            // r18497 | author | date | N lines
            if let Some((num, _)) = rest.split_once(" | ") {
                if num.chars().all(|c| c.is_ascii_digit()) {
                    flush(&mut current_rev, &mut msg_buf, &mut items);
                    if items.len() >= max {
                        break;
                    }
                    current_rev = num.parse().ok();
                    expecting_msg = true;
                    continue;
                }
            }
        }
        if expecting_msg {
            if line.trim().is_empty() && msg_buf.is_empty() {
                continue;
            }
            if !msg_buf.is_empty() {
                msg_buf.push(' ');
            }
            msg_buf.push_str(line.trim());
        }
    }
    flush(&mut current_rev, &mut msg_buf, &mut items);

    items.join("\n")
}

/// 从 `svn log --xml`（始终 UTF-8）提取「rN: message」摘要。
pub fn summarize_log_xml(xml: &str, max: usize) -> String {
    let mut items: Vec<String> = Vec::new();
    let mut rest = xml;
    while items.len() < max {
        let Some(entry_start) = rest.find("<logentry") else {
            break;
        };
        let after_tag = &rest[entry_start..];
        let Some(rev_attr) = after_tag.find("revision=\"") else {
            break;
        };
        let rev_src = &after_tag[rev_attr + "revision=\"".len()..];
        let Some(rev_end) = rev_src.find('"') else {
            break;
        };
        let rev = &rev_src[..rev_end];
        let Some(msg_start) = after_tag.find("<msg>") else {
            rest = &after_tag[1..];
            continue;
        };
        let msg_body = &after_tag[msg_start + "<msg>".len()..];
        let Some(msg_end) = msg_body.find("</msg>") else {
            break;
        };
        let msg = decode_xml_text(&msg_body[..msg_end])
            .replace('\n', " ")
            .trim()
            .to_string();
        let msg = if msg.is_empty() {
            "(无说明)".to_string()
        } else {
            msg
        };
        items.push(format!("r{rev}: {msg}"));
        if let Some(entry_end) = after_tag.find("</logentry>") {
            rest = &after_tag[entry_end + "</logentry>".len()..];
        } else {
            break;
        }
    }
    items.join("\n")
}

fn decode_xml_text(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

/// 拉取本地之后到远端之间的提交说明（用于通知正文）。
pub fn fetch_incoming_log_summary(wc: &Path, local: u64, remote: u64) -> String {
    if !wc.join(".svn").exists() || remote <= local {
        return String::new();
    }
    let range = format!("{}:{}", local.saturating_add(1), remote);
    let limit = "5";
    // --xml 输出固定为 UTF-8，避免中文 Windows 控制台乱码
    if let Ok(out) = run_svn(&["log", "--xml", "-r", &range, "-l", limit], wc) {
        let s = summarize_log_xml(&out, 5);
        if !s.is_empty() {
            return s;
        }
    }
    if let Ok(out) = run_svn(&["log", "--xml", "-r", "BASE:HEAD", "-l", limit], wc) {
        let s = summarize_log_xml(&out, 5);
        if !s.is_empty() {
            return s;
        }
    }
    // 文本格式回退（仍走 GB18030/UTF-8 解码）
    if let Ok(out) = run_svn(&["log", "-r", &range, "-l", limit], wc) {
        return summarize_log(&out, 5);
    }
    String::new()
}

pub fn query_revisions(wc: &Path) -> Result<SvnCheck, SvnError> {
    if !wc.join(".svn").exists() {
        return Err(SvnError::NotWorkingCopy(wc.display().to_string()));
    }
    let local_out = run_svn(&["info"], wc)?;
    let local = parse_revision(&local_out)?;
    let rel_path = parse_rel_path(&local_out);

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
        rel_path,
    })
}

pub fn update(wc: &Path) -> Result<String, SvnError> {
    run_svn(&["update"], wc)
}

/// 查找本机 TortoiseProc.exe（PATH 或常见安装目录）。
pub fn find_tortoise_proc() -> Option<PathBuf> {
    if let Ok(found) = which_tortoise() {
        return Some(found);
    }

    let candidates = [
        r"C:\Program Files\TortoiseSVN\bin\TortoiseProc.exe",
        r"C:\Program Files (x86)\TortoiseSVN\bin\TortoiseProc.exe",
    ];
    for c in candidates {
        let p = PathBuf::from(c);
        if p.is_file() {
            return Some(p);
        }
    }

    if let Ok(root) = std::env::var("TORTOISESVN") {
        let p = PathBuf::from(root).join("bin").join("TortoiseProc.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn which_tortoise() -> Result<PathBuf, ()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = Command::new("where");
        cmd.arg("TortoiseProc.exe").creation_flags(CREATE_NO_WINDOW);
        let out = cmd.output().map_err(|_| ())?;
        if !out.status.success() {
            return Err(());
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let first = text.lines().next().unwrap_or("").trim();
        if first.is_empty() {
            return Err(());
        }
        let p = PathBuf::from(first);
        if p.is_file() {
            return Ok(p);
        }
    }
    Err(())
}

fn tortoise_wc_path(wc: &Path) -> String {
    wc.canonicalize()
        .unwrap_or_else(|_| wc.to_path_buf())
        .display()
        .to_string()
}

fn tortoise_command(command: &str, wc: &Path) -> Result<Command, SvnError> {
    let proc = find_tortoise_proc().ok_or_else(|| {
        SvnError::Command("未找到 TortoiseProc.exe，请确认已安装 TortoiseSVN".into())
    })?;
    let path = tortoise_wc_path(wc);
    let mut cmd = Command::new(&proc);
    cmd.arg(format!("/command:{command}"))
        .arg(format!("/path:{path}"));
    // 注意：不要对 TortoiseProc 使用 CREATE_NO_WINDOW，否则 GUI 可能异常或无法正常展示
    Ok(cmd)
}

/// 调用 TortoiseSVN Show Log UI（不等待关闭）。
pub fn open_tortoise_show_log(wc: &Path) -> Result<(), SvnError> {
    tortoise_command("log", wc)?
        .spawn()
        .map_err(|e| SvnError::Command(format!("启动 TortoiseSVN 失败: {e}")))?;
    Ok(())
}

/// 调用 TortoiseSVN Update UI，并等待用户关闭对话框后再返回。
pub fn open_tortoise_update(wc: &Path) -> Result<(), SvnError> {
    // /closeonend:0 不自动关；用户关窗后进程结束，便于随后重新检查状态
    let mut cmd = tortoise_command("update", wc)?;
    cmd.arg("/closeonend:0");
    let status = cmd
        .status()
        .map_err(|e| SvnError::Command(format!("启动 TortoiseSVN Update 失败: {e}")))?;
    if !status.success() {
        // 用户取消也可能非 0，不视为硬错误；仍返回 Ok 以便刷新状态
        let code = status.code().unwrap_or(-1);
        if code != 0 {
            eprintln!("TortoiseSVN update exited with code {code}");
        }
    }
    Ok(())
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
    fn parse_rel_path_from_relative_url() {
        let sample = "URL: https://svn.example/proj/branches/feat-a\nRelative URL: ^/branches/feat-a\nRepository Root: https://svn.example/proj\nRevision: 10\n";
        assert_eq!(
            parse_rel_path(sample).as_deref(),
            Some("branches/feat-a")
        );
        assert_eq!(
            parse_rel_path("Relative URL: ^/trunk\nRevision: 1\n").as_deref(),
            Some("trunk")
        );
    }

    #[test]
    fn parse_rel_path_fallback_url_minus_root() {
        let sample = "URL: https://svn.example/proj/trunk\nRepository Root: https://svn.example/proj\nRevision: 1\n";
        assert_eq!(parse_rel_path(sample).as_deref(), Some("trunk"));
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

    #[test]
    fn summarize_log_extracts_messages() {
        let log = "\
------------------------------------------------------------------------
r18497 | alice | 2026-10-28 10:00:00 +0800 (Tue, 28 Oct 2026) | 1 line

#19270 - 加密币阶段二调整开发
------------------------------------------------------------------------
r18496 | bob | 2026-10-27 09:00:00 +0800 (Mon, 27 Oct 2026) | 2 lines

fix login
and logout
------------------------------------------------------------------------
";
        let s = summarize_log(log, 5);
        assert!(s.contains("r18497: #19270 - 加密币阶段二调整开发"));
        assert!(s.contains("r18496: fix login and logout"));
    }

    #[test]
    fn summarize_log_xml_utf8_messages() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<log>
<logentry revision="18497">
<author>alice</author>
<msg>#19270 - 加密币阶段二调整开发</msg>
</logentry>
<logentry revision="18496">
<author>bob</author>
<msg>fix login &amp; logout</msg>
</logentry>
</log>"#;
        let s = summarize_log_xml(xml, 5);
        assert!(s.contains("r18497: #19270 - 加密币阶段二调整开发"));
        assert!(s.contains("r18496: fix login & logout"));
    }

    #[test]
    fn decode_prefers_utf8_then_gb18030() {
        let utf8 = "加密币".as_bytes();
        assert_eq!(decode_svn_output(utf8), "加密币");
        // 「更新」的 GBK 字节（非合法 UTF-8 序列）
        let gbk: Vec<u8> = vec![0xB8, 0xFC, 0xD0, 0xC2];
        assert!(String::from_utf8(gbk.clone()).is_err());
        assert_eq!(decode_svn_output(&gbk), "更新");
    }
}
