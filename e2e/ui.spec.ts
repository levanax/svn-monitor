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
  await expect(page.locator(".card:has-text('mobile-trunk') .svn-rel")).toHaveText("trunk");
  await expect(page.locator(".card:has-text('mobile-branch') .svn-rel")).toHaveText(
    "branches/release-2.1",
  );
  await expect(page.locator(".card:has-text('mobile-branch') .svn-path.branch")).toBeVisible();
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
  // 指针拖拽（非 HTML5 DnD）
  const fromHandle = page.locator('.card:has-text("mobile-branch") .card-drag');
  const toCard = page.locator('.card:has-text("mobile-trunk")');
  const fromBox = await fromHandle.boundingBox();
  const toBox = await toCard.boundingBox();
  expect(fromBox && toBox).toBeTruthy();
  await page.mouse.move(fromBox!.x + fromBox!.width / 2, fromBox!.y + fromBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(toBox!.x + toBox!.width / 2, toBox!.y + 8, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByText("已排序")).toBeVisible();
  const firstAfter = await mobileBody.locator(".card .name").first().textContent();
  expect(firstAfter).not.toBe(firstBefore);

  // 分组不再折叠
  await expect(page.locator(".group-toggle")).toHaveCount(0);

  await expect(page.locator(".group-block").first()).toHaveAttribute("data-group-id", "ungrouped");
  const colFrom = page.locator('.group-block[data-group-id="g-mobile"] .group-head');
  const colTo = page.locator('.group-block[data-group-id="ungrouped"] .group-head');
  const cf = await colFrom.boundingBox();
  const ct = await colTo.boundingBox();
  expect(cf && ct).toBeTruthy();
  await page.mouse.move(cf!.x + 24, cf!.y + cf!.height / 2);
  await page.mouse.down();
  await page.mouse.move(ct!.x + 8, ct!.y + ct!.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByText("已调组序")).toBeVisible();
  await expect(page.locator(".group-block").first()).toHaveAttribute("data-group-id", "g-mobile");

  await page.screenshot({ path: path.join(outDir, "ui-main.png"), fullPage: true });

  page.once("dialog", (d) => d.accept("API"));
  await page.locator("#btn-add-group").click();
  await expect(page.getByText("已建组 API")).toBeVisible();
  // 空分组也要显示列
  await expect(page.getByRole("heading", { name: "API 0" })).toBeVisible();
  await expect(page.locator('.group-block:has(.group-title:has-text("API")) .card-empty')).toBeVisible();

  const syncedCard = page.locator('.card:has-text("mobile-branch")');
  const behindCard = page.locator('.card:has-text("mobile-trunk")');
  await expect(syncedCard.locator('button[data-act="open"]')).toHaveText("文件夹");
  await expect(syncedCard.locator('button[data-act="log"]')).toBeVisible();
  await expect(syncedCard.locator('button[data-act="cursor"]')).toHaveText("Cursor");
  await expect(syncedCard.locator(".more-toggle")).toBeVisible();
  await expect(syncedCard.locator('button[data-act="update"]')).toHaveCount(0);
  await expect(behindCard.locator('button[data-act="update"]')).toHaveText("更新");
  await expect(syncedCard.locator('button[data-act="move"]')).toBeHidden();

  await page.locator('.card:has-text("tools") .more-toggle').click();
  await page.locator('.card:has-text("tools") button[data-act="move"]').click();
  await expect(page.locator("#group-picker")).toBeVisible();
  await expect(page.getByRole("heading", { name: "移到分组" })).toBeVisible();
  await page.locator('#group-picker-list input[value="g-mobile"]').check();
  await page.locator("#group-picker-ok").click();
  await expect(page.getByText("已移动 tools")).toBeVisible();
  await expect(page.getByRole("heading", { name: /未分组/ })).toHaveCount(0);

  await behindCard.locator('button[data-act="update"]').click();
  await expect(page.getByText("update 完成")).toBeVisible({ timeout: 5000 });

  await behindCard.locator('button[data-act="cursor"]').click();
  await expect(page.locator("#status-line")).toContainText("Cursor");

  await page.locator("#interval").fill("5");
  await page.locator("#interval").dispatchEvent("change");
  await expect(page.getByText("已保存")).toBeVisible();
  await expect(page.locator("#interval")).toHaveValue("5");

  await page.locator("#btn-add").click();
  await expect(page.locator("#group-picker")).toBeVisible();
  await expect(page.locator('#group-picker-list input[value="ungrouped"]')).not.toBeChecked();
  await page.locator('#group-picker-list input[value="g-mobile"]').check();
  await page.locator("#group-picker-ok").click();
  await expect(page.getByText(/已添加/)).toBeVisible();
  await expect(page.getByRole("heading", { name: /Mobile/ })).toBeVisible();

  await behindCard.locator(".more-toggle").click();
  await behindCard.locator('button[data-act="mute"]').click();
  await expect(page.getByText("已忽略 mobile-trunk")).toBeVisible();
  await expect(page.getByText("已忽略提醒")).toBeVisible();

  // 确认框须先于删除弹出（不用 window.confirm）
  await page.locator('.group-block:has(.group-title:has-text("API")) .more-toggle').click();
  await page.locator('.group-block:has(.group-title:has-text("API")) button[data-gact="remove"]').click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await expect(page.locator("#confirm-title")).toHaveText("删除分组");
  await page.locator("#confirm-cancel").click();
  await expect(page.getByRole("heading", { name: "API 0" })).toBeVisible();

  await page.screenshot({ path: path.join(outDir, "ui-after-actions.png"), fullPage: true });
});
