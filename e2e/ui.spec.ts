import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test-artifacts");

test.beforeAll(() => {
  fs.mkdirSync(outDir, { recursive: true });
});

test("分组展示与紧凑操作", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "SVN Monitor" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Mobile 1" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /未分组/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "mobile-trunk 有更新" })).toBeVisible();
  await expect(page.locator("#pause-locked")).toBeVisible();

  // 折叠 Mobile 后卡片隐藏，再展开
  await page.locator('.group-block[data-group-id="g-mobile"] .group-toggle').click();
  await expect(page.getByRole("heading", { name: "mobile-trunk 有更新" })).toBeHidden();
  await page.locator('.group-block[data-group-id="g-mobile"] .group-toggle').click();
  await expect(page.getByRole("heading", { name: "mobile-trunk 有更新" })).toBeVisible();

  await page.screenshot({ path: path.join(outDir, "ui-main.png"), fullPage: true });

  page.once("dialog", (d) => d.accept("API"));
  await page.locator("#btn-add-group").click();
  await expect(page.getByText("已创建分组 API")).toBeVisible();

  // 空「未分组」在无项目时不应出现；先把 tools 移走后再断言隐藏逻辑在 mock 里 tools 在未分组
  // 新建空分组 API 可见；把 tools 挪到 API 后「未分组」应消失
  await page
    .locator('.card:has-text("tools") select[data-act="move"]')
    .selectOption({ label: "API" });
  await expect(page.getByRole("heading", { name: /未分组/ })).toHaveCount(0);

  page.once("dialog", (d) => d.accept());
  await page.locator('.card:has-text("mobile-trunk") button[data-act="update"]').click();
  await expect(page.getByText("update 完成")).toBeVisible({ timeout: 5000 });

  await page.locator("#interval").fill("30");
  await page.locator("#interval").dispatchEvent("change");
  await expect(page.getByText("设置已自动保存")).toBeVisible();

  await page.locator("#btn-add").click();
  await expect(page.getByText(/已添加/)).toBeVisible();
  // 添加后默认进未分组，应重新出现
  await expect(page.getByRole("heading", { name: /未分组/ })).toBeVisible();

  await page.screenshot({ path: path.join(outDir, "ui-after-actions.png"), fullPage: true });
});
