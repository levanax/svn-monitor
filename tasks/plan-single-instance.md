# Plan: 单实例 + 工具栏确认

**当前模型：** Auto（Composer）

## 说明

- **开机启动 / 主题**：已在顶栏 `toolbar-settings`（与间隔同排），无需再加；本次不改布局。
- **单实例**：接入 `tauri-plugin-single-instance`；二次启动时复用 `show_main_window`（unminimize/show/focus，必要时重建）。

## 文件变更清单

### 修改
- `src-tauri/Cargo.toml` — 依赖 `tauri-plugin-single-instance`
- `src-tauri/src/lib.rs` — 插件注册为第一个 plugin；回调唤起主窗
- `README.md` — 注明单实例

### 新增 / 删除
- 无（本计划文件除外）

## 执行边界

- **范围内**：Windows/桌面单实例；二次启动聚焦/恢复主窗
- **范围外**：改工具栏布局、多开白名单、CLI 参数转发业务逻辑
- **验证**：`cargo test` + Playwright 截图/video（UI 无回归）
