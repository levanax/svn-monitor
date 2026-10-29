# SVN Monitor

本机多 SVN 工作副本轮询监控桌面应用（Rust + Tauri 2）。有人提交后 Toast 提醒，并在 UI 里手动刷新 / `svn update`。

## 功能

- 添加 / 移除多个工作副本目录；**Trello 式**分组列布局；组内卡片可拖排序，**分组列可左右拖排序**（分组不再折叠）
- 定时轮询远端 revision（间隔以**分钟**为单位，默认 5 分钟）
- **锁屏时自动暂停**轮询（可关）
- **开机启动**（可关）
- **主题**：默认跟随系统，可选浅色 / 深色
- 有更新时**由后端强制发系统通知**（关窗也能收到；可关全局/单项目忽略）；通知含 **SVN 提交说明**（`svn log --xml` UTF-8；其它输出兼容 GBK）
- 建议用安装包运行以保证 Toast 显示为「SVN Monitor」；直接跑 `target/release` 时通知可能显示为 PowerShell 来源
- 手动刷新、**Update 打开 TortoiseSVN Update UI**、打开文件夹、**TortoiseSVN 日志（Show Log）**
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

## 测试

```bash
npm run test:unit-rust
npm run test:dnd-webview
npm run test:e2e
```

Windows 上组内拖排序依赖 `tauri.conf.json` 的 `dragDropEnabled: false`（否则 Tauri 会劫持 WebView2 拖放，HTML5 DnD 失效）。

E2E 截图与录像输出到 `test-artifacts/`。

## 配置位置

`%APPDATA%\svn-monitor\config.json`
