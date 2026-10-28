# Implementation Plan: 分组 / 锁屏暂停 / 紧凑 UI

## Overview

在现有 SVN Monitor（Tauri）上增加：项目分组管理；Windows 锁屏期间暂停轮询与自动检查；主界面更紧凑。

## 文件变更清单

### 新增

- `src-tauri/src/session_lock.rs` — WTS 会话锁监听

### 修改

- `src-tauri/src/config.rs` — groups、project.group_id、pause_when_locked
- `src-tauri/src/lib.rs` — 分组命令、锁屏标志、轮询跳过
- `src-tauri/Cargo.toml` — windows 依赖
- `src/types.ts` / `src/mock-api.ts` / `src/main.ts` / `src/styles.css` / `index.html`
- `e2e/ui.spec.ts` — 覆盖分组与紧凑视图截图
- `tasks/todo.md` / `README.md`

### 删除

- 无

## 执行边界

- **范围内**：分组 CRUD、项目归属组、锁屏暂停轮询、紧凑布局、测试制品
- **范围外**：拖拽排序、云同步分组、非 Windows 锁屏（非 Windows 视为不暂停）
- **行为**：锁屏仅暂停自动轮询；解锁后按间隔继续；手动刷新在未锁屏时可用

## Verification

- `cargo test` 通过
- Playwright 截图 + video 更新到 `test-artifacts/`
