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
  await expect(page.getByRole("button", { name: /添加目录/ })).toBeVisible();
  await expect(page.getByText("间隔(分钟)")).toBeVisible();
  await expect(page.locator("#interval")).toHaveValue("5");
  await expect(page.getByRole("heading", { name: "Mobile 2" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /未分组/ })).toBeVisible();
  await expect(page.getByText("mobile-trunk", { exact: true })).toBeVisible();
  await expect(page.getByText("有更新").first()).toBeVisible();
  await expect(page.locator("#pause-locked")).toBeVisible();
  await expect(page.locator("#autostart")).toBeVisible();
  await expect(page.locator("#theme")).toBeVisible();
  await page.locator("#theme").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.locator("#theme").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#theme").selectOption("system");
  await expect(page.locator("#default-group")).toHaveCount(0);
  // Trello 横向列
  await expect(page.locator(".project-list")).toHaveCSS("flex-direction", "row");

  const mobileBody = page.locator('.group-block[data-group-id="g-mobile"] .group-body');
  const firstBefore = await mobileBody.locator(".card .name").first().textContent();
  await page
    .locator('.card:has-text("mobile-branch") .card-drag')
    .dragTo(page.locator('.card:has-text("mobile-trunk")'));
  await expect(page.getByText("已排序")).toBeVisible();
  const firstAfter = await mobileBody.locator(".card .name").first().textContent();
  expect(firstAfter).not.toBe(firstBefore);

  // 分组不再折叠
  await expect(page.locator(".group-toggle")).toHaveCount(0);

  await expect(page.locator(".group-block").first()).toHaveAttribute("data-group-id", "ungrouped");
  await page
    .locator('.group-block[data-group-id="g-mobile"] .group-head')
    .dragTo(page.locator('.group-block[data-group-id="ungrouped"] .group-head'), {
      targetPosition: { x: 8, y: 12 },
    });
  await expect(page.getByText("已调组序")).toBeVisible();
  await expect(page.locator(".group-block").first()).toHaveAttribute("data-group-id", "g-mobile");

  await page.screenshot({ path: path.join(outDir, "ui-main.png"), fullPage: true });

  page.once("dialog", (d) => d.accept("API"));
  await page.locator("#btn-add-group").click();
  await expect(page.getByText("已建组 API")).toBeVisible();

  page.once("dialog", (d) => d.accept("API"));
  await page.locator('.card:has-text("tools") button[data-act="move"]').click();
  await expect(page.getByText("已移动 tools")).toBeVisible();
  await expect(page.getByRole("heading", { name: /未分组/ })).toHaveCount(0);

  await page.locator('.card:has-text("mobile-trunk") button[data-act="update"]').click();
  await expect(page.getByText("update 完成")).toBeVisible({ timeout: 5000 });

  await page.locator("#interval").fill("5");
  await page.locator("#interval").dispatchEvent("change");
  await expect(page.getByText("已保存")).toBeVisible();
  await expect(page.locator("#interval")).toHaveValue("5");

  await page.locator("#btn-add").click();
  await expect(page.getByText("已添加")).toBeVisible();
  await expect(page.getByRole("heading", { name: /未分组/ })).toBeVisible();

  await page.locator('.card:has-text("mobile-trunk") button[data-act="mute"]').click();
  await expect(page.getByText("已忽略 mobile-trunk")).toBeVisible();
  await expect(page.getByText("已忽略提醒")).toBeVisible();

  await page.screenshot({ path: path.join(outDir, "ui-after-actions.png"), fullPage: true });
});
