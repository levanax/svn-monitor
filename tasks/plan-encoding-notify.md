# Plan: UTF-8 解码 + 系统通知修复

## 文件变更清单

### 修改
- `src-tauri/Cargo.toml` — 增加 `encoding_rs`、Windows 下 `tauri-winrt-notification`
- `src-tauri/src/svn.rs` — GB18030/UTF-8 解码；`svn log --xml` 摘要
- `src-tauri/src/lib.rs` — WinRT Toast（安装包 AUMID / 开发机 PowerShell 回退）；成功后才记已通知

### 新增 / 删除
- 无代码文件新增删除；本计划文档新增

## 执行边界

- **范围内**：乱码修复、通知可靠性、单元测试与既有 E2E
- **范围外**：改轮询策略、改 UI 布局、推送安装包到远端

## Verification

- `cargo test`
- Playwright E2E（截图 + video）
