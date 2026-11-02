# Plan: 玻璃透明度 / 托盘恢复 / 日志文案

**当前模型：** Auto（Composer）

## 文件变更清单

### 修改
- `src/styles.css` — 液态玻璃 `--glass` / `--panel` 透明度改为 20%（0.20）
- `src-tauri/src/lib.rs` — `show_main_window`：最小化在任务栏时先 `unminimize` 再显示并聚焦
- `src/main.ts` — 按钮与状态文案「日志」→「log」
- `README.md` — 同步文案
- `e2e/ui.spec.ts` — 断言按钮文案为 log；跑通截图与 video

### 新增 / 删除
- 无

## 执行边界

- **范围内**：玻璃 alpha=0.20；托盘点击可从任务栏最小化恢复；UI「日志」改为「log」；自动化测试产物
- **范围外**：关闭窗口 destroy 策略、托盘图标美术、其它按钮中英混排全面英文化
- **验证**：`cargo test` + Playwright（截图 + video 保存到 `test-artifacts/`）
