# SVN Monitor

本机多 SVN 工作副本轮询监控桌面应用（Rust + Tauri 2）。有人提交后 Toast 提醒，并在 UI 里手动刷新 / `svn update`。

## 功能

- 添加 / 移除多个工作副本目录（可选多个分组）；可从**资源管理器拖文件夹**进分组列
- 卡片展示 **SVN 仓库相对路径**（`svn info` 的 Relative URL，如 `trunk` / `branches/...`），便于区分主干与分支；本地目录路径仍保留
- **Trello 式**分组列；空分组也会显示；组内卡片 / 分组列用拖动手柄排序；分组操作收在标题栏右上 **⋯**
- 尚无自定义分组时，添加/拖入会提示先「新建分组」；移到分组用点选对话框（无需手打字）
- 定时轮询远端 revision（间隔以**分钟**为单位，默认 5 分钟）
- **锁屏时自动暂停**轮询（固定开启）
- **开机启动**（可关）
- **主题**：Edge 风格渐变色（晨曦 / 晴空 / 丁香 / 薄荷 / 暮色 / 静夜），界面精简无大标题
- 有更新时**固定发系统通知**（每个更高的远端 revision 提醒一次；关窗/前台均可；单项目可「忽略提醒」）；通知含 **SVN 提交说明**
- Toast 优先走可靠通道；若显示为 PowerShell 来源属正常回退，不影响提醒
- 卡片常显：**文件夹**、**日志**、**Cursor**；有更新时才显 **更新**（TortoiseSVN）；右上角 **⋯** 收纳：检查更新 / 移到分组 / 忽略提醒 / 移除监控
- 关闭窗口**销毁 WebView** 以省内存；托盘可再打开主界面并继续后台轮询

## 前置

- Windows + 已安装 `svn` 命令行
- Node.js 18+、Rust（cargo）

## 开发

```bash
npm install
npm run tauri dev
```

## 构建

```bash
npm run tauri build
```

安装包输出示例：`src-tauri/target/release/bundle/nsis/SVN Monitor_<version>_x64-setup.exe`。

### 改版本号

安装包文件名与产物版本**不读**根目录 `package.json`，要以 Tauri / Rust 配置为准。发版时请三处一起改成同一版本（例如 `0.1.1`）：

| 文件 | 字段 | 作用 |
|------|------|------|
| `src-tauri/tauri.conf.json` | `"version"` | **决定** NSIS/MSI 安装包文件名与安装包版本 |
| `src-tauri/Cargo.toml` | `version` | Rust crate / 可执行文件侧版本，建议同步 |
| `package.json` | `"version"` | 仅前端 npm 包版本，**不影响**安装包文件名 |

改完后重新执行 `npm run tauri build`。

## 测试

```bash
npm run test:unit-rust
npm run test:dnd-webview
npm run test:e2e
```

Windows 上 `dragDropEnabled: true` 以支持从资源管理器拖入；应用内排序使用指针拖拽，不依赖 HTML5 DnD。

E2E 截图与录像输出到 `test-artifacts/`。

## 配置位置

`%APPDATA%\svn-monitor\config.json`
