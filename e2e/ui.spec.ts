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
  await expect(page.getByText("mobile-trunk", { exact: true })).toBeVisible();
  await expect(page.getByText("有更新").first()).toBeVisible();
  await expect(page.locator("#pause-locked")).toBeVisible();
  await expect(page.locator("#autostart")).toBeVisible();
  await expect(page.locator("#default-group")).toHaveCount(0);

  await page.locator('.group-block[data-group-id="g-mobile"] .group-toggle').click();
  await expect(page.getByText("mobile-trunk", { exact: true })).toBeHidden();
  await page.locator('.group-block[data-group-id="g-mobile"] .group-toggle').click();
  await expect(page.getByText("mobile-trunk", { exact: true })).toBeVisible();

  await page.screenshot({ path: path.join(outDir, "ui-main.png"), fullPage: true });

  page.once("dialog", (d) => d.accept("API"));
  await page.locator("#btn-add-group").click();
  await expect(page.getByText("已创建分组 API")).toBeVisible();

  page.once("dialog", (d) => d.accept("API"));
  await page.locator('.card:has-text("tools") button[data-act="move"]').click();
  await expect(page.getByText("已移动 tools")).toBeVisible();
  await expect(page.getByRole("heading", { name: /未分组/ })).toHaveCount(0);

  page.once("dialog", (d) => d.accept());
  await page.locator('.card:has-text("mobile-trunk") button[data-act="update"]').click();
  await expect(page.getByText("update 完成")).toBeVisible({ timeout: 5000 });

  await page.locator("#interval").fill("30");
  await page.locator("#interval").dispatchEvent("change");
  await expect(page.getByText("设置已自动保存")).toBeVisible();

  await page.locator("#btn-add").click();
  await expect(page.getByText(/已添加/)).toBeVisible();
  await expect(page.getByRole("heading", { name: /未分组/ })).toBeVisible();

  await page.locator('.card:has-text("mobile-trunk") button[data-act="mute"]').click();
  await expect(page.getByText("已忽略「mobile-trunk」提醒")).toBeVisible();
  await expect(page.getByText("已忽略提醒")).toBeVisible();

  await page.screenshot({ path: path.join(outDir, "ui-after-actions.png"), fullPage: true });
});
