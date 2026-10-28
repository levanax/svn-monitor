# SVN Monitor

本机多 SVN 工作副本轮询监控桌面应用（Rust + Tauri 2）。有人提交后 Toast 提醒，并在 UI 里手动刷新 / `svn update`。

## 功能

- 添加 / 移除多个工作副本目录，支持**分组**管理
- 定时轮询远端 revision（可调间隔）
- **锁屏时自动暂停**轮询（可关）
- 有更新时系统通知（可关）
- 手动刷新、确认后执行 `svn update`、打开文件夹
- 关闭窗口缩到系统托盘，继续后台轮询

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
npm run test:e2e
```

E2E 截图与录像输出到 `test-artifacts/`。

## 配置位置

`%APPDATA%\svn-monitor\config.json`
