import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test-artifacts");

test.beforeAll(() => {
  fs.mkdirSync(outDir, { recursive: true });
});

async function openOpsMenu(page: import("@playwright/test").Page) {
  await page.locator("#menu-ops-btn").click();
  await expect(page.locator("#menu-ops")).toBeVisible();
}

async function openSettingsMenu(page: import("@playwright/test").Page) {
  await page.locator("#menu-settings-btn").click();
  await expect(page.locator("#menu-settings")).toBeVisible();
}

test("分组展示与紧凑操作", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "SVN Monitor" })).toHaveCount(0);
  await expect(page.locator("#menu-ops-btn")).toBeVisible();
  await openOpsMenu(page);
  await expect(page.locator("#btn-add")).toBeVisible();
  await openSettingsMenu(page);
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
  await expect(page.locator("#notify-enabled")).toHaveCount(0);
  await expect(page.locator("#pause-locked")).toHaveCount(0);
  await expect(page.locator("#autostart")).toBeVisible();
  await expect(page.locator("#open-hotkey")).toBeVisible();
  await expect(page.locator("#open-hotkey")).toHaveValue("");
  await page.locator("#open-hotkey").focus();
  await page.keyboard.press("Control+Shift+KeyM");
  await expect(page.locator("#open-hotkey")).toHaveValue("Ctrl+Shift+M");
  await expect(page.getByText("已保存")).toBeVisible();
  await page.locator("#open-hotkey").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#open-hotkey")).toHaveValue("");
  await expect(page.locator("#theme")).toBeVisible();
  await expect(page.locator("#theme")).toHaveValue("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme-pref", "system");
  await expect(page.locator("#theme option[value='light']")).toHaveCount(1);
  await expect(page.locator("#theme option[value='dark']")).toHaveCount(1);
  await page.locator("#theme").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "light");
  await expect(page.locator("#theme option").first()).toHaveCSS("color", "rgb(31, 45, 68)");
  await expect(page.locator("#theme option").first()).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await page.locator("#theme").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
  await expect(page.locator("#theme option").first()).toHaveCSS("color", "rgb(232, 236, 248)");
  await expect(page.locator("#theme option").first()).toHaveCSS(
    "background-color",
    "rgb(26, 30, 40)",
  );
  await page.locator("#theme").selectOption("sky");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sky");
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "light");
  await page.locator("#theme").selectOption("dusk");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dusk");
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
  await page.locator("#theme").selectOption("dawn");
  await expect(page.locator("#theme option").first()).toHaveCSS("color", "rgb(31, 45, 68)");
  await expect(page.locator("#default-group")).toHaveCount(0);
  // Trello 横向列
  await expect(page.locator(".project-list")).toHaveCSS("flex-direction", "row");

  // 收起设置菜单，避免挡住看板拖拽
  await page.locator("main").click({ position: { x: 8, y: 8 } });

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

  // 看板右击应屏蔽浏览器默认菜单（返回/刷新）；输入框仍允许
  const ctxBoard = await page.evaluate(() => {
    const target = document.querySelector(".project-list") ?? document.body;
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(ctxBoard).toBe(true);
  const ctxInput = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("#interval");
    if (!input) return false;
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    input.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(ctxInput).toBe(false);

  await openOpsMenu(page);
  await page.locator("#btn-add-group").click();
  await expect(page.locator("#prompt-dialog")).toBeVisible();
  await expect(page.locator("#prompt-title")).toHaveText("新建分组");
  await expect
    .poll(() => page.locator("#prompt-dialog").evaluate((el) => (el as HTMLDialogElement).matches(":modal")))
    .toBe(true);
  await page.locator("#prompt-input").fill("API");
  await page.screenshot({ path: path.join(outDir, "ui-prompt-dialog.png") });
  await page.locator("#prompt-ok").click();
  await expect(page.getByText("已建组 API")).toBeVisible();
  // 空分组也要显示列
  await expect(page.getByRole("heading", { name: "API 0" })).toBeVisible();
  const apiBlock = page.locator('.group-block:has(.group-title:has-text("API"))');
  await expect(apiBlock.locator(".card-empty")).toBeVisible();
  await expect(apiBlock).toHaveAttribute("data-span", "1");

  // 自定义分组可切换列宽（⋯ → 悬停「列宽」展开子菜单）
  await apiBlock.locator(".more-toggle").click();
  await apiBlock.locator(".more-submenu-trigger").hover();
  await expect(apiBlock.locator(".more-submenu")).toBeVisible();
  await apiBlock.locator('button[data-gact="span-2"]').click();
  await expect(page.getByText("已设为 2 列宽")).toBeVisible();
  await expect(apiBlock).toHaveAttribute("data-span", "2");
  await apiBlock.locator(".more-toggle").click();
  await apiBlock.locator(".more-submenu-trigger").hover();
  await expect(apiBlock.locator('button[data-gact="span-2"]')).toHaveAttribute("aria-checked", "true");
  await apiBlock.locator('button[data-gact="span-1"]').click();
  await expect(page.getByText("已设为 1 列宽")).toBeVisible();
  await expect(apiBlock).toHaveAttribute("data-span", "1");

  // 重命名贴在分组菜单旁，非模态、无全屏遮罩
  await page.locator('.group-block:has(.group-title:has-text("API")) .more-toggle').click();
  await page.locator('.group-block:has(.group-title:has-text("API")) button[data-gact="rename"]').click();
  await expect(page.locator("#prompt-dialog")).toBeVisible();
  await expect(page.locator("#prompt-dialog")).toHaveClass(/anchored/);
  await expect
    .poll(() => page.locator("#prompt-dialog").evaluate((el) => (el as HTMLDialogElement).matches(":modal")))
    .toBe(false);
  await expect(page.locator("#prompt-title")).toHaveText("重命名分组");
  await expect(page.locator("#prompt-input")).toHaveValue("API");
  await page.locator("#prompt-input").fill("API-Renamed");
  await page.locator("#prompt-ok").click();
  await expect(page.getByText("已重命名")).toBeVisible();
  await expect(page.getByRole("heading", { name: "API-Renamed 0" })).toBeVisible();

  const syncedCard = page.locator('.card:has-text("mobile-branch")');
  const behindCard = page.locator('.card:has-text("mobile-trunk")');
  await expect(syncedCard.locator('button[data-act="open"]')).toHaveText("文件夹");
  await expect(syncedCard.locator('button[data-act="log"]')).toHaveText("log");
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

  await openSettingsMenu(page);
  await page.locator("#interval").fill("5");
  await page.locator("#interval").dispatchEvent("change");
  await expect(page.getByText("已保存")).toBeVisible();
  await expect(page.locator("#interval")).toHaveValue("5");
  await page.locator("main").click({ position: { x: 8, y: 8 } });

  await openOpsMenu(page);
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
  await page.locator('.group-block:has(.group-title:has-text("API-Renamed")) .more-toggle').click();
  await page
    .locator('.group-block:has(.group-title:has-text("API-Renamed")) button[data-gact="remove"]')
    .click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await expect(page.locator("#confirm-title")).toHaveText("删除分组");
  await page.locator("#confirm-cancel").click();
  await expect(page.getByRole("heading", { name: "API-Renamed 0" })).toBeVisible();

  await page.screenshot({ path: path.join(outDir, "ui-after-actions.png"), fullPage: true });
});
