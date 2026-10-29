import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { createMockApi, isTauriRuntime } from "./mock-api";
import type { AppConfig, GroupConfig, ProjectState } from "./types";

export type { AppConfig, GroupConfig, ProjectState, ProjectStatus } from "./types";

const mock = createMockApi();
const useMock = !isTauriRuntime();

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (useMock) return mock.invoke<T>(cmd, args);
  return tauriInvoke<T>(cmd, args);
}

const listEl = document.querySelector<HTMLDivElement>("#project-list")!;
const emptyEl = document.querySelector<HTMLParagraphElement>("#empty")!;
const statusLine = document.querySelector<HTMLParagraphElement>("#status-line")!;
const intervalInput = document.querySelector<HTMLInputElement>("#interval")!;
const notifyInput = document.querySelector<HTMLInputElement>("#notify-enabled")!;
const pauseLockedInput = document.querySelector<HTMLInputElement>("#pause-locked")!;
const autostartInput = document.querySelector<HTMLInputElement>("#autostart")!;
const themeSelect = document.querySelector<HTMLSelectElement>("#theme")!;

type ThemePreference = "system" | "light" | "dark";
let themePreference: ThemePreference = "system";
let systemThemeMql: MediaQueryList | null = null;

function resolveTheme(pref: ThemePreference): "light" | "dark" {
  if (pref === "light" || pref === "dark") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(pref: ThemePreference) {
  themePreference = pref;
  document.documentElement.dataset.theme = resolveTheme(pref);
}

function bindSystemThemeListener() {
  if (!systemThemeMql) {
    systemThemeMql = window.matchMedia("(prefers-color-scheme: dark)");
    systemThemeMql.addEventListener("change", () => {
      if (themePreference === "system") applyTheme("system");
    });
  }
}

let projects: ProjectState[] = [];
let groups: GroupConfig[] = [];
let sessionLocked = false;
let boardEnterPending = true;
let statusFadeTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(msg: string) {
  const apply = () => {
    statusLine.textContent = msg;
    statusLine.classList.toggle("locked", sessionLocked && pauseLockedInput.checked);
    statusLine.classList.remove("is-updating");
  };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || !statusLine.textContent) {
    apply();
    return;
  }
  statusLine.classList.add("is-updating");
  if (statusFadeTimer) clearTimeout(statusFadeTimer);
  statusFadeTimer = setTimeout(apply, 90);
}

function badgeFor(p: ProjectState): { cls: string; text: string } {
  switch (p.status) {
    case "behind":
      return { cls: "behind", text: "有更新" };
    case "up_to_date":
      return { cls: "ok", text: "已同步" };
    case "checking":
      return { cls: "checking", text: "检查中" };
    case "error":
      return { cls: "error", text: "错误" };
    default:
      return { cls: "checking", text: "未检查" };
  }
}

async function pickGroupId(currentId: string): Promise<string | null> {
  const lines = groups.map((g, i) => `${i + 1}. ${g.name}`).join("\n");
  const cur = groups.find((g) => g.id === currentId)?.name ?? "";
  const answer = prompt(`移到分组（输入序号或名称）\n${lines}`, cur);
  if (answer == null) return null;
  const trimmed = answer.trim();
  if (!trimmed) return null;
  const byIndex = Number(trimmed);
  if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= groups.length) {
    return groups[byIndex - 1].id;
  }
  const byName = groups.find((g) => g.name === trimmed);
  return byName?.id ?? null;
}

function render() {
  listEl.innerHTML = "";
  listEl.classList.toggle("board-enter", boardEnterPending);
  emptyEl.classList.toggle("hidden", projects.length > 0);

  const byGroup = new Map<string, ProjectState[]>();
  for (const g of groups) byGroup.set(g.id, []);
  for (const p of projects) {
    const gid = byGroup.has(p.group_id) ? p.group_id : "ungrouped";
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid)!.push(p);
  }
  for (const [, items] of byGroup) {
    items.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  }

  for (const g of groups) {
    const items = byGroup.get(g.id) ?? [];
    // 未分组为空时隐藏；自定义空分组仍显示便于管理
    if (g.id === "ungrouped" && items.length === 0) continue;
    if (items.length === 0 && g.id !== "ungrouped" && projects.length === 0) continue;

    const block = document.createElement("section");
    block.className = "group-block";
    block.dataset.groupId = g.id;

    const head = document.createElement("div");
    head.className = "group-head";
    head.title = "拖动调整分组左右顺序";
    head.innerHTML = `
      <span class="group-grip" aria-hidden="true"></span>
      <h2 class="group-title">${escapeHtml(g.name)} <span class="group-count">${items.length}</span></h2>
      <div class="group-tools">
        ${
          g.id === "ungrouped"
            ? ""
            : `<div class="more-wrap">
                <button type="button" class="more-toggle" aria-label="分组操作" aria-haspopup="menu" aria-expanded="false" title="分组操作">⋯</button>
                <div class="more-menu" role="menu" hidden>
                  <button type="button" class="more-item" role="menuitem" data-gact="rename">重命名</button>
                  <button type="button" class="more-item danger" role="menuitem" data-gact="remove">删除分组</button>
                </div>
              </div>`
        }
      </div>
    `;
    const moreWrap = head.querySelector<HTMLElement>(".more-wrap");
    const moreToggle = head.querySelector<HTMLButtonElement>(".more-toggle");
    const moreMenu = head.querySelector<HTMLElement>(".more-menu");
    if (moreWrap && moreToggle && moreMenu) {
      moreToggle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const willOpen = moreMenu.hasAttribute("hidden");
        closeAllMoreMenus();
        if (willOpen) {
          moreMenu.removeAttribute("hidden");
          moreWrap.classList.add("open");
          moreToggle.setAttribute("aria-expanded", "true");
        }
      });
    }
    head.querySelectorAll<HTMLButtonElement>("button[data-gact]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeAllMoreMenus();
        void onGroupAction(g, btn.dataset.gact!);
      });
    });
    bindColumnPointerDrag(block, head, g.id);
    block.appendChild(head);

    const ul = document.createElement("ul");
    ul.className = "group-body";
    ul.dataset.groupId = g.id;

    if (items.length === 0) {
      const empty = document.createElement("li");
      empty.className = "card card-empty";
      empty.innerHTML = `<div class="card-main"><p class="path">本组暂无项目 · 可从资源管理器拖入</p></div>`;
      ul.appendChild(empty);
    } else {
      for (const p of items) {
        ul.appendChild(renderCard(p));
      }
    }

    block.appendChild(ul);
    listEl.appendChild(block);
  }

  if (boardEnterPending) {
    boardEnterPending = false;
    // 入场动画播完后去掉 class，避免后续刷新重复闪动
    window.setTimeout(() => listEl.classList.remove("board-enter"), 700);
  }
}

/** 指针拖拽（不依赖 HTML5 DnD，以便开启资源管理器文件拖入） */
type CardPtr = { id: string; groupId: string; el: HTMLLIElement; pointerId: number };
type ColPtr = { id: string; el: HTMLElement; pointerId: number };
let cardPtr: CardPtr | null = null;
let colPtr: ColPtr | null = null;

function clearCardDragTargets(root: ParentNode = document) {
  root.querySelectorAll(".card.drag-target").forEach((el) => el.classList.remove("drag-target"));
}

function clearColumnDragTargets() {
  listEl.querySelectorAll(".group-block.column-target").forEach((el) => {
    el.classList.remove("column-target");
    delete (el as HTMLElement).dataset.dropSide;
  });
  listEl.classList.remove("column-dragging");
}

function clearFileDropTargets() {
  listEl.querySelectorAll(".group-block.file-drop-target").forEach((el) => {
    el.classList.remove("file-drop-target");
  });
}

function bindColumnPointerDrag(block: HTMLElement, head: HTMLElement, groupId: string) {
  head.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    if ((ev.target as HTMLElement).closest("button, .group-tools")) return;
    ev.preventDefault();
    head.setPointerCapture(ev.pointerId);
    colPtr = { id: groupId, el: block, pointerId: ev.pointerId };
    block.classList.add("column-dragging");
    listEl.classList.add("column-dragging");
  });
  head.addEventListener("pointermove", (ev) => {
    if (!colPtr || colPtr.id !== groupId || colPtr.pointerId !== ev.pointerId) return;
    clearColumnDragTargets();
    listEl.classList.add("column-dragging");
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".group-block") as HTMLElement | null;
    if (target && target.dataset.groupId !== groupId) {
      const rect = target.getBoundingClientRect();
      const before = ev.clientX < rect.left + rect.width / 2;
      target.classList.add("column-target");
      target.dataset.dropSide = before ? "before" : "after";
    }
  });
  const endColumnDrag = async (ev: PointerEvent) => {
    if (!colPtr || colPtr.id !== groupId || colPtr.pointerId !== ev.pointerId) return;
    const movedId = colPtr.id;
    const target = listEl.querySelector<HTMLElement>(".group-block.column-target");
    const side = target?.dataset.dropSide === "after" ? "after" : "before";
    colPtr = null;
    block.classList.remove("column-dragging");
    clearColumnDragTargets();
    if (!target?.dataset.groupId || target.dataset.groupId === movedId) return;

    let ordered = groups.map((g) => g.id).filter((id) => id !== movedId);
    const idx = ordered.indexOf(target.dataset.groupId);
    if (idx >= 0) ordered.splice(side === "before" ? idx : idx + 1, 0, movedId);
    else ordered.push(movedId);
    try {
      await invoke("reorder_groups", { orderedIds: ordered });
      await refreshAll();
      setStatus("已调组序");
    } catch (e) {
      setStatus(String(e));
    }
  };
  head.addEventListener("pointerup", (ev) => void endColumnDrag(ev));
  head.addEventListener("pointercancel", (ev) => {
    if (!colPtr || colPtr.id !== groupId || colPtr.pointerId !== ev.pointerId) return;
    colPtr = null;
    block.classList.remove("column-dragging");
    clearColumnDragTargets();
  });
}

function bindCardPointerDrag(li: HTMLLIElement, handle: HTMLElement, p: ProjectState) {
  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    handle.setPointerCapture(ev.pointerId);
    cardPtr = { id: p.id, groupId: p.group_id, el: li, pointerId: ev.pointerId };
    li.classList.add("dragging");
  });
  handle.addEventListener("pointermove", (ev) => {
    if (!cardPtr || cardPtr.id !== p.id || cardPtr.pointerId !== ev.pointerId) return;
    const ul = li.parentElement;
    if (!ul) return;
    clearCardDragTargets(ul);
    ul.classList.add("drag-over");
    const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("li.card[data-id]") as HTMLLIElement | null;
    if (under && under.dataset.id !== p.id && under.dataset.groupId === p.group_id) {
      under.classList.add("drag-target");
    }
  });
  const endCardDrag = async (ev: PointerEvent) => {
    if (!cardPtr || cardPtr.id !== p.id || cardPtr.pointerId !== ev.pointerId) return;
    const ul = li.parentElement as HTMLUListElement | null;
    const target = ul?.querySelector<HTMLLIElement>("li.card.drag-target") ?? null;
    const id = cardPtr.id;
    const groupId = cardPtr.groupId;
    cardPtr = null;
    li.classList.remove("dragging");
    ul?.classList.remove("drag-over");
    clearCardDragTargets(ul ?? document);
    if (!ul || !target?.dataset.id || target.dataset.id === id) return;

    let ordered = [...ul.querySelectorAll<HTMLLIElement>("li.card[data-id]")].map((c) => c.dataset.id!).filter(Boolean);
    ordered = ordered.filter((x) => x !== id);
    const rect = target.getBoundingClientRect();
    const before = ev.clientY < rect.top + rect.height / 2;
    const idx = ordered.indexOf(target.dataset.id);
    ordered.splice(before ? idx : idx + 1, 0, id);
    try {
      await invoke("reorder_projects", { groupId, orderedIds: ordered });
      await refreshAll();
      setStatus("已排序");
    } catch (e) {
      setStatus(String(e));
    }
  };
  handle.addEventListener("pointerup", (ev) => void endCardDrag(ev));
  handle.addEventListener("pointercancel", (ev) => {
    if (!cardPtr || cardPtr.id !== p.id || cardPtr.pointerId !== ev.pointerId) return;
    cardPtr = null;
    li.classList.remove("dragging");
    li.parentElement?.classList.remove("drag-over");
    clearCardDragTargets();
  });
}

function renderCard(p: ProjectState): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `card ${p.status === "behind" ? "behind" : ""} ${p.status === "error" ? "error" : ""} ${p.mute_notify ? "muted" : ""}`;
  li.dataset.id = p.id;
  li.dataset.groupId = p.group_id;

  const badge = badgeFor(p);
  const local = p.local_rev ?? "—";
  const remote = p.remote_rev ?? "—";
  const checked = p.last_checked ? new Date(p.last_checked).toLocaleTimeString() : "—";
  const muteLabel = p.mute_notify ? "恢复提醒" : "忽略提醒";
  const svnRel = (p.svn_rel_path ?? "").trim();
  const svnKind =
    !svnRel ? "" : svnRel === "trunk" || svnRel.startsWith("trunk/")
      ? "trunk"
      : svnRel.startsWith("branches/") || svnRel.startsWith("branch/")
        ? "branch"
        : svnRel.startsWith("tags/") || svnRel.startsWith("tag/")
          ? "tag"
          : "other";
  const svnKindLabel =
    svnKind === "trunk"
      ? "TRUNK"
      : svnKind === "branch"
        ? "分支"
        : svnKind === "tag"
          ? "TAG"
          : svnKind
            ? "SVN"
            : "";
  const svnLine = svnRel
    ? `<p class="svn-path ${svnKind}" title="SVN 仓库路径"><span class="svn-kind">${escapeHtml(
        svnKindLabel,
      )}</span><span class="svn-rel">${escapeHtml(svnRel)}</span></p>`
    : "";

  const updateBtn =
    p.status === "behind"
      ? `<button type="button" class="btn warn tiny" data-act="update" title="用 TortoiseSVN 更新">更新</button>`
      : "";

  li.innerHTML = `
    <div class="card-drag" title="拖动调整顺序" role="button" tabindex="0" aria-label="拖动调整顺序">
      <span class="grip" aria-hidden="true"></span>
    </div>
    <div class="card-main">
      <div class="card-head">
        <h2>
          <span class="name">${escapeHtml(p.name)}</span>
          <span class="badge ${badge.cls}">${badge.text}</span>
          ${p.mute_notify ? `<span class="badge muted-badge">已忽略提醒</span>` : ""}
        </h2>
        <div class="more-wrap">
          <button type="button" class="more-toggle" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false" title="更多操作">⋯</button>
          <div class="more-menu" role="menu" hidden>
            <button type="button" class="more-item" role="menuitem" data-act="refresh">检查更新</button>
            <button type="button" class="more-item" role="menuitem" data-act="move">移到分组</button>
            <button type="button" class="more-item" role="menuitem" data-act="mute">${muteLabel}</button>
            <button type="button" class="more-item danger" role="menuitem" data-act="remove">移除监控</button>
          </div>
        </div>
      </div>
      ${svnLine}
      <p class="path" title="本地目录">${escapeHtml(p.path)}</p>
      <div class="meta">
        <span>本地 r${local}</span>
        <span>远端 r${remote}</span>
        <span title="上次检查">${escapeHtml(checked)}</span>
        ${p.error ? `<span title="${escapeAttr(p.error)}">${escapeHtml(p.error)}</span>` : ""}
      </div>
    </div>
    <div class="card-actions">
      <button type="button" class="btn ghost tiny" data-act="open" title="在资源管理器中打开">文件夹</button>
      <button type="button" class="btn ghost tiny" data-act="log" title="TortoiseSVN 日志">日志</button>
      <button type="button" class="btn ghost tiny" data-act="cursor" title="用 Cursor 打开此目录">Cursor</button>
      ${updateBtn}
    </div>
  `;

  bindCardPointerDrag(li, li.querySelector<HTMLElement>(".card-drag")!, p);

  const moreWrap = li.querySelector<HTMLElement>(".more-wrap")!;
  const moreToggle = li.querySelector<HTMLButtonElement>(".more-toggle")!;
  const moreMenu = li.querySelector<HTMLElement>(".more-menu")!;

  moreToggle.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const willOpen = moreMenu.hasAttribute("hidden");
    closeAllMoreMenus();
    if (willOpen) {
      moreMenu.removeAttribute("hidden");
      moreWrap.classList.add("open");
      moreToggle.setAttribute("aria-expanded", "true");
    }
  });

  li.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeAllMoreMenus();
      void onAction(p, btn.dataset.act!);
    });
  });

  return li;
}

function closeAllMoreMenus() {
  document.querySelectorAll<HTMLElement>(".more-menu:not([hidden])").forEach((menu) => {
    menu.setAttribute("hidden", "");
    menu.closest(".more-wrap")?.classList.remove("open");
    menu
      .closest(".more-wrap")
      ?.querySelector(".more-toggle")
      ?.setAttribute("aria-expanded", "false");
  });
}

document.addEventListener("click", () => closeAllMoreMenus());
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeAllMoreMenus();
});

const groupPicker = document.querySelector<HTMLDialogElement>("#group-picker")!;
const groupPickerList = document.querySelector<HTMLDivElement>("#group-picker-list")!;
const groupPickerHint = document.querySelector<HTMLParagraphElement>("#group-picker-hint")!;
const groupPickerForm = document.querySelector<HTMLFormElement>("#group-picker-form")!;

function pickGroupsMulti(opts?: {
  titleHint?: string;
  preselected?: string[];
}): Promise<string[] | null> {
  const pre = new Set(opts?.preselected ?? []);
  groupPickerHint.textContent = opts?.titleHint ?? "请勾选至少一个分组（可多选；「未分组」默认不勾选）。";
  groupPickerList.innerHTML = groups
    .map(
      (g) => `
      <label class="group-picker-item">
        <input type="checkbox" name="group" value="${escapeAttr(g.id)}" ${pre.has(g.id) ? "checked" : ""} />
        <span>${escapeHtml(g.name)}</span>
      </label>`,
    )
    .join("");

  return new Promise((resolve) => {
    const onClose = () => {
      groupPicker.removeEventListener("close", onClose);
      if (groupPicker.returnValue !== "ok") {
        resolve(null);
        return;
      }
      const ids = [...groupPickerList.querySelectorAll<HTMLInputElement>('input[name="group"]:checked')].map(
        (el) => el.value,
      );
      resolve(ids.length ? ids : null);
    };
    groupPicker.addEventListener("close", onClose);
    if (typeof groupPicker.showModal === "function") groupPicker.showModal();
    else {
      // 无 dialog 时回退
      onClose();
    }
  });
}

groupPickerForm.addEventListener("submit", (ev) => {
  const submitter = (ev as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value === "ok") {
    const n = groupPickerList.querySelectorAll('input[name="group"]:checked').length;
    if (!n) {
      ev.preventDefault();
      setStatus("请至少选择一个分组");
    }
  }
});

async function addPathsToGroups(paths: string[], groupIds: string[]) {
  let ok = 0;
  const errors: string[] = [];
  for (const path of paths) {
    for (const groupId of groupIds) {
      try {
        await invoke("add_project", { path, name: null, groupId });
        ok += 1;
      } catch (e) {
        errors.push(`${path} → ${groups.find((g) => g.id === groupId)?.name ?? groupId}: ${String(e)}`);
      }
    }
  }
  await refreshAll();
  if (ok && !errors.length) setStatus(`已添加 ${ok} 项`);
  else if (ok) setStatus(`已添加 ${ok} 项，部分跳过`);
  else setStatus(errors[0] ?? "添加失败");
}

function cssPointFromPhysical(pos: { x: number; y: number }): { x: number; y: number } {
  const dpr = window.devicePixelRatio || 1;
  return { x: pos.x / dpr, y: pos.y / dpr };
}

function groupIdAtCssPoint(x: number, y: number): string | null {
  const blocks = [...listEl.querySelectorAll<HTMLElement>(".group-block")];
  for (const block of blocks) {
    const r = block.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return block.dataset.groupId ?? null;
    }
  }
  // 落在看板空白处：按水平位置取最近列
  let best: { id: string; dist: number } | null = null;
  for (const block of blocks) {
    const r = block.getBoundingClientRect();
    const cx = (r.left + r.right) / 2;
    const dist = Math.abs(x - cx);
    if (!best || dist < best.dist) best = { id: block.dataset.groupId!, dist };
  }
  return best?.id ?? null;
}

function highlightFileDropGroup(groupId: string | null) {
  clearFileDropTargets();
  if (!groupId) return;
  listEl.querySelector(`.group-block[data-group-id="${CSS.escape(groupId)}"]`)?.classList.add("file-drop-target");
}

async function bindExplorerFileDrop() {
  if (useMock) return;
  const webview = getCurrentWebview();
  await webview.onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "leave") {
      clearFileDropTargets();
      return;
    }
    if (payload.type === "enter" || payload.type === "over") {
      const { x, y } = cssPointFromPhysical(payload.position);
      highlightFileDropGroup(groupIdAtCssPoint(x, y));
      return;
    }
    if (payload.type === "drop") {
      const { x, y } = cssPointFromPhysical(payload.position);
      const groupId = groupIdAtCssPoint(x, y) ?? "ungrouped";
      clearFileDropTargets();
      const paths = payload.paths.filter(Boolean);
      if (!paths.length) return;
      void addPathsToGroups(paths, [groupId]);
    }
  });
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replaceAll("'", "&#39;");
}

async function ensureNotifyPermission(): Promise<boolean> {
  if (useMock) return false;
  // Windows WebView 启动时可能误报 denied；系统通知实际由 Rust/WinRT 发出
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const perm = await requestPermission();
      granted = perm === "granted";
    }
    return granted;
  } catch {
    return true;
  }
}

function secsToMinutes(secs: number): number {
  const m = Math.round(secs / 60);
  return Math.min(120, Math.max(1, Number.isFinite(m) && m > 0 ? m : 5));
}

async function loadConfig() {
  const cfg = await invoke<AppConfig>("get_config");
  intervalInput.value = String(secsToMinutes(cfg.poll_interval_secs));
  notifyInput.checked = cfg.notify_enabled;
  pauseLockedInput.checked = cfg.pause_when_locked;
  autostartInput.checked = !!cfg.autostart;
  const theme = (cfg.theme === "light" || cfg.theme === "dark" || cfg.theme === "system"
    ? cfg.theme
    : "system") as ThemePreference;
  themeSelect.value = theme;
  bindSystemThemeListener();
  applyTheme(theme);
  groups = cfg.groups?.length ? cfg.groups : await invoke<GroupConfig[]>("list_groups");
}

async function refreshAll() {
  groups = await invoke<GroupConfig[]>("list_groups");
  projects = await invoke<ProjectState[]>("list_projects");
  render();
}

async function onGroupAction(g: GroupConfig, act: string) {
  try {
    if (act === "rename") {
      const name = prompt("新的分组名称", g.name);
      if (!name) return;
      await invoke("rename_group", { id: g.id, name });
      await refreshAll();
      setStatus("已重命名");
    } else if (act === "remove") {
      if (!confirm(`删除分组「${g.name}」？组内项目将移到「未分组」。`)) return;
      await invoke("remove_group", { id: g.id });
      await refreshAll();
      setStatus("已删组");
    }
  } catch (e) {
    setStatus(String(e));
  }
}

async function onAction(p: ProjectState, act: string) {
  try {
    if (act === "mute") {
      const next = !p.mute_notify;
      await invoke("set_project_mute", { id: p.id, muteNotify: next });
      await refreshAll();
      setStatus(next ? `已忽略 ${p.name}` : `已恢复 ${p.name}`);
    } else if (act === "move") {
      const groupId = await pickGroupId(p.group_id);
      if (!groupId || groupId === p.group_id) return;
      await invoke("set_project_group", { id: p.id, groupId });
      await refreshAll();
      setStatus(`已移动 ${p.name}`);
    } else if (act === "refresh") {
      setStatus(`检查 ${p.name}…`);
      await invoke("check_project", { id: p.id });
      await refreshAll();
      setStatus(`${p.name} 已检查`);
    } else if (act === "update") {
      // 不再用 window.confirm：WebView 里常被拖到 Tortoise 关闭之后才弹出。
      // 直接打开 TortoiseSVN Update UI，取消/关闭由 Tortoise 对话框处理。
      setStatus(`Update ${p.name}…`);
      await invoke("update_project", { id: p.id });
      await refreshAll();
      setStatus(`${p.name} update 完成`);
    } else if (act === "open") {
      await invoke("open_project_folder", { id: p.id });
      setStatus(useMock ? "演示：已打开文件夹" : `已打开 ${p.name}`);
    } else if (act === "cursor") {
      await invoke("open_in_cursor", { id: p.id });
      setStatus(useMock ? "演示：已用 Cursor 打开" : `Cursor 打开 ${p.name}`);
    } else if (act === "log") {
      await invoke("open_tortoise_log", { id: p.id });
      setStatus(useMock ? "演示：日志" : `日志 ${p.name}`);
    } else if (act === "remove") {
      if (!confirm(`移除监控「${p.name}」？不会删除本地文件。`)) return;
      await invoke("remove_project", { id: p.id });
      await refreshAll();
      setStatus(`已移除 ${p.name}`);
    }
  } catch (e) {
    setStatus(String(e));
  }
}

document.querySelector("#btn-add-group")!.addEventListener("click", async () => {
  const name = prompt("新分组名称");
  if (!name) return;
  try {
    await invoke("add_group", { name });
    await refreshAll();
    setStatus(`已建组 ${name}`);
  } catch (e) {
    setStatus(String(e));
  }
});

document.querySelector("#btn-add")!.addEventListener("click", async () => {
  try {
    let paths: string[] = [];
    if (useMock) {
      paths = [`C:\\work\\demo-project-${Date.now()}`];
    } else {
      const picked = await open({
        directory: true,
        multiple: true,
        title: "选择 SVN 工作副本目录（可多选）",
      });
      if (!picked) return;
      paths = Array.isArray(picked) ? picked : [picked];
    }
    if (!paths.length) return;
    const groupIds = await pickGroupsMulti({
      titleHint: `将添加 ${paths.length} 个目录，请勾选保存到的分组（可多选，「未分组」默认不选）`,
      preselected: [],
    });
    if (!groupIds?.length) {
      setStatus("已取消");
      return;
    }
    await addPathsToGroups(paths, groupIds);
  } catch (e) {
    setStatus(String(e));
  }
});

document.querySelector("#btn-refresh")!.addEventListener("click", async () => {
  setStatus("刷新中…");
  try {
    await invoke("check_all");
    await refreshAll();
    setStatus("已刷新");
  } catch (e) {
    setStatus(String(e));
  }
});

let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function persistSettings(quiet = false) {
  const mins = Number(intervalInput.value);
  if (!Number.isFinite(mins) || mins < 1) {
    setStatus("间隔至少 1 分钟");
    return;
  }
  const secs = Math.round(mins) * 60;
  try {
    await invoke("save_settings", {
      pollIntervalSecs: secs,
      notifyEnabled: notifyInput.checked,
      pauseWhenLocked: pauseLockedInput.checked,
      autostart: autostartInput.checked,
      theme: themeSelect.value,
    });
    if (notifyInput.checked) await ensureNotifyPermission();
    if (!quiet) setStatus("已保存");
  } catch (e) {
    setStatus(String(e));
  }
}

function schedulePersistSettings() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void persistSettings();
  }, 400);
}

intervalInput.addEventListener("change", () => void persistSettings());
intervalInput.addEventListener("input", () => schedulePersistSettings());
notifyInput.addEventListener("change", () => void persistSettings());
pauseLockedInput.addEventListener("change", () => void persistSettings());
autostartInput.addEventListener("change", () => void persistSettings());
themeSelect.addEventListener("change", () => {
  const pref = themeSelect.value as ThemePreference;
  applyTheme(pref);
  void persistSettings();
});

async function boot() {
  const appEl = document.querySelector("#app");
  bindSystemThemeListener();
  applyTheme("system");
  await loadConfig();
  await refreshAll();
  if (!useMock && notifyInput.checked) await ensureNotifyPermission();
  await bindExplorerFileDrop();

  if (!useMock) {
    sessionLocked = await invoke<boolean>("is_session_locked");

    await listen<ProjectState>("project-updated", (ev) => {
      const next = ev.payload;
      const i = projects.findIndex((p) => p.id === next.id);
      if (i >= 0) projects[i] = next;
      else projects.push(next);
      render();
    });

    // 系统通知由 Rust 发出（关窗后也能提醒）；前端只更新状态栏
    await listen<{ name: string; local: number; remote: number; log?: string }>(
      "svn-behind",
      (ev) => {
        const { name, local, remote } = ev.payload;
        setStatus(`${name} r${local}→r${remote}`);
      },
    );

    await listen<boolean>("session-lock", (ev) => {
      sessionLocked = ev.payload;
      setStatus(sessionLocked && pauseLockedInput.checked ? "锁屏暂停" : "已解锁");
    });
  }

  setStatus(
    useMock
      ? "演示模式"
      : sessionLocked && pauseLockedInput.checked
        ? "锁屏暂停"
        : "就绪",
  );

  // 下一帧再显示，避免首屏闪一下未排版内容
  requestAnimationFrame(() => {
    appEl?.classList.add("is-ready");
    // 关闭后重建窗口时，Windows 可能把光标卡在 loading；通知后端清掉
    if (!useMock) {
      void invoke("notify_ui_ready").catch(() => undefined);
    }
  });
}

boot().catch((e) => {
  document.querySelector("#app")?.classList.add("is-ready");
  setStatus(String(e));
});
