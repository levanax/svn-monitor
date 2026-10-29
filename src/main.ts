import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

function setStatus(msg: string) {
  statusLine.textContent = msg;
  statusLine.classList.toggle("locked", sessionLocked && pauseLockedInput.checked);
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
    block.draggable = false;

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
            : `<button type="button" class="btn ghost tiny" data-gact="rename">重命名</button>
               <button type="button" class="btn danger tiny" data-gact="remove">删除组</button>`
        }
      </div>
    `;
    head.querySelectorAll("button[data-gact]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onGroupAction(g, (btn as HTMLButtonElement).dataset.gact!);
      });
    });
    bindColumnDrag(block, head, g.id);
    block.appendChild(head);

    const ul = document.createElement("ul");
    ul.className = "group-body";
    ul.dataset.groupId = g.id;
    bindProjectDropZone(ul, g.id);

    if (items.length === 0) {
      const empty = document.createElement("li");
      empty.className = "card card-empty";
      empty.draggable = false;
      empty.innerHTML = `<div class="card-main"><p class="path">本组暂无项目</p></div>`;
      ul.appendChild(empty);
    } else {
      for (const p of items) {
        ul.appendChild(renderCard(p));
      }
    }

    block.appendChild(ul);
    listEl.appendChild(block);
  }
}

let draggingId: string | null = null;
let draggingGroupId: string | null = null;
let draggingColumnId: string | null = null;

function clearCardDragTargets(root: ParentNode = document) {
  root.querySelectorAll(".card.drag-target").forEach((el) => el.classList.remove("drag-target"));
}

function clearColumnDragTargets() {
  listEl.querySelectorAll(".group-block.column-target").forEach((el) => el.classList.remove("column-target"));
  listEl.classList.remove("column-dragging");
}

function bindProjectDropZone(ul: HTMLUListElement, groupId: string) {
  const canDropHere = () => !!draggingId && !draggingColumnId && draggingGroupId === groupId;

  ul.addEventListener("dragover", (ev) => {
    if (!canDropHere()) return;
    ev.preventDefault();
    ev.stopPropagation();
    ul.classList.add("drag-over");
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";

    const target = (ev.target as HTMLElement).closest("li.card[data-id]") as HTMLLIElement | null;
    clearCardDragTargets(ul);
    if (target && target.dataset.id !== draggingId) {
      target.classList.add("drag-target");
    }
  });
  ul.addEventListener("dragleave", (ev) => {
    if (!ul.contains(ev.relatedTarget as Node)) {
      ul.classList.remove("drag-over");
      clearCardDragTargets(ul);
    }
  });
  ul.addEventListener("drop", async (ev) => {
    if (draggingColumnId) return;
    ev.preventDefault();
    ev.stopPropagation();
    ul.classList.remove("drag-over");
    clearCardDragTargets(ul);
    const id = draggingId || ev.dataTransfer?.getData("text/plain") || null;
    const fromGroup = draggingGroupId;
    if (!id || !fromGroup || fromGroup !== groupId) return;

    const cards = [...ul.querySelectorAll<HTMLLIElement>("li.card[data-id]")];
    const target = (ev.target as HTMLElement).closest("li.card[data-id]") as HTMLLIElement | null;
    let ordered = cards.map((c) => c.dataset.id!).filter(Boolean);
    ordered = ordered.filter((x) => x !== id);
    if (target && target.dataset.id && target.dataset.id !== id) {
      const rect = target.getBoundingClientRect();
      const before = ev.clientY < rect.top + rect.height / 2;
      const idx = ordered.indexOf(target.dataset.id);
      ordered.splice(before ? idx : idx + 1, 0, id);
    } else {
      ordered.push(id);
    }
    try {
      await invoke("reorder_projects", { groupId, orderedIds: ordered });
      await refreshAll();
      setStatus("已排序");
    } catch (e) {
      setStatus(String(e));
    }
  });
}

function bindColumnDrag(block: HTMLElement, head: HTMLElement, groupId: string) {
  const armColumnDrag = (ev: Event) => {
    if ((ev.target as HTMLElement).closest("button, .group-tools")) return;
    block.draggable = true;
  };
  head.addEventListener("pointerdown", armColumnDrag);
  head.addEventListener("mousedown", armColumnDrag);
  const endGate = () => {
    if (!draggingColumnId) block.draggable = false;
  };
  head.addEventListener("pointerup", endGate);
  head.addEventListener("mouseup", endGate);
  head.addEventListener("pointercancel", endGate);

  block.addEventListener("dragstart", (ev) => {
    // 卡片拖拽也会冒泡到这里；切勿 preventDefault，否则会取消组内排序
    if (!block.draggable) return;
    if ((ev.target as HTMLElement).closest(".card, .group-body, .card-drag")) {
      block.draggable = false;
      return;
    }
    ev.stopPropagation();
    draggingColumnId = groupId;
    draggingId = null;
    draggingGroupId = null;
    block.classList.add("column-dragging");
    listEl.classList.add("column-dragging");
    ev.dataTransfer?.setData("text/plain", `column:${groupId}`);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
  });
  block.addEventListener("dragend", () => {
    draggingColumnId = null;
    block.draggable = false;
    block.classList.remove("column-dragging");
    clearColumnDragTargets();
  });
}

function bindBoardColumnDropZone() {
  listEl.addEventListener("dragover", (ev) => {
    if (!draggingColumnId) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    clearColumnDragTargets();
    listEl.classList.add("column-dragging");
    const target = (ev.target as HTMLElement).closest(".group-block") as HTMLElement | null;
    if (target && target.dataset.groupId !== draggingColumnId) {
      const rect = target.getBoundingClientRect();
      const before = ev.clientX < rect.left + rect.width / 2;
      target.classList.add("column-target");
      target.dataset.dropSide = before ? "before" : "after";
    }
  });
  listEl.addEventListener("dragleave", (ev) => {
    if (!listEl.contains(ev.relatedTarget as Node)) clearColumnDragTargets();
  });
  listEl.addEventListener("drop", async (ev) => {
    if (!draggingColumnId) return;
    ev.preventDefault();
    ev.stopPropagation();
    const movedId = draggingColumnId;
    const target = (ev.target as HTMLElement).closest(".group-block") as HTMLElement | null;
    const side = target?.dataset.dropSide === "after" ? "after" : "before";
    clearColumnDragTargets();

    // 配置里全部组都要参与排序（含当前隐藏的空「未分组」）
    let ordered = groups.map((g) => g.id);
    ordered = ordered.filter((id) => id !== movedId);
    if (target?.dataset.groupId && target.dataset.groupId !== movedId) {
      const idx = ordered.indexOf(target.dataset.groupId);
      if (idx >= 0) ordered.splice(side === "before" ? idx : idx + 1, 0, movedId);
      else ordered.push(movedId);
    } else {
      ordered.push(movedId);
    }
    try {
      await invoke("reorder_groups", { orderedIds: ordered });
      await refreshAll();
      setStatus("已调组序");
    } catch (e) {
      setStatus(String(e));
    }
  });
}

bindBoardColumnDropZone();

function renderCard(p: ProjectState): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `card ${p.status === "behind" ? "behind" : ""} ${p.status === "error" ? "error" : ""} ${p.mute_notify ? "muted" : ""}`;
  li.dataset.id = p.id;
  li.dataset.groupId = p.group_id;
  // 默认不可拖；仅按住左侧手柄时临时开启，避免误拖与 WebView 丢事件
  li.draggable = false;

  const badge = badgeFor(p);
  const local = p.local_rev ?? "—";
  const remote = p.remote_rev ?? "—";
  const checked = p.last_checked ? new Date(p.last_checked).toLocaleTimeString() : "—";
  const muteLabel = p.mute_notify ? "恢复提醒" : "忽略提醒";

  li.innerHTML = `
    <div class="card-drag" title="拖动调整顺序" role="button" tabindex="0" aria-label="拖动调整顺序">
      <span class="grip" aria-hidden="true"></span>
    </div>
    <div class="card-main">
      <h2>
        <span class="name">${escapeHtml(p.name)}</span>
        <span class="badge ${badge.cls}">${badge.text}</span>
        ${p.mute_notify ? `<span class="badge muted-badge">已忽略提醒</span>` : ""}
      </h2>
      <p class="path">${escapeHtml(p.path)}</p>
      <div class="meta">
        <span>本地 r${local}</span>
        <span>远端 r${remote}</span>
        <span title="上次检查">${escapeHtml(checked)}</span>
        ${p.error ? `<span title="${escapeAttr(p.error)}">${escapeHtml(p.error)}</span>` : ""}
      </div>
    </div>
    <div class="card-actions">
      <button type="button" class="btn ghost tiny" data-act="mute">${muteLabel}</button>
      <button type="button" class="btn ghost tiny" data-act="move">移组</button>
      <button type="button" class="btn ghost tiny" data-act="refresh">刷新</button>
      <button type="button" class="btn warn tiny" data-act="update" title="TortoiseSVN Update" ${p.status === "behind" ? "" : "disabled"}>Update</button>
      <button type="button" class="btn ghost tiny" data-act="open">打开</button>
      <button type="button" class="btn ghost tiny" data-act="log" title="TortoiseSVN Show Log">日志</button>
      <button type="button" class="btn danger tiny" data-act="remove">移除</button>
    </div>
  `;

  const handle = li.querySelector<HTMLElement>(".card-drag")!;
  // 仅从手柄按下时允许拖；避免整卡误拖（同时听 pointer/mouse，兼容 Playwright）
  const armCardDrag = () => {
    li.draggable = true;
  };
  handle.addEventListener("pointerdown", armCardDrag);
  handle.addEventListener("mousedown", armCardDrag);
  const endDragGate = () => {
    if (!draggingId) li.draggable = false;
  };
  handle.addEventListener("pointerup", endDragGate);
  handle.addEventListener("mouseup", endDragGate);
  handle.addEventListener("pointercancel", endDragGate);

  li.addEventListener("dragstart", (ev) => {
    if (!li.draggable) {
      ev.preventDefault();
      return;
    }
    draggingId = p.id;
    draggingGroupId = p.group_id;
    draggingColumnId = null;
    li.classList.add("dragging");
    ev.dataTransfer?.setData("text/plain", p.id);
    ev.dataTransfer?.setData("text/project-id", p.id);
    ev.dataTransfer?.setData("text/group-id", p.group_id);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
  });
  li.addEventListener("dragend", () => {
    draggingId = null;
    draggingGroupId = null;
    li.draggable = false;
    li.classList.remove("dragging");
    clearCardDragTargets();
    document.querySelectorAll(".group-body.drag-over").forEach((el) => el.classList.remove("drag-over"));
  });

  li.querySelectorAll(".card-actions button[data-act]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onAction(p, (btn as HTMLButtonElement).dataset.act!);
    });
  });

  return li;
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
      setStatus(useMock ? "演示：已打开" : `已打开 ${p.name}`);
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
    let selected: string | null = null;
    if (useMock) {
      selected = `C:\\work\\demo-project-${Date.now()}`;
    } else {
      const picked = await open({
        directory: true,
        multiple: false,
        title: "选择 SVN 工作副本目录",
      });
      if (!picked || Array.isArray(picked)) return;
      selected = picked;
    }
    await invoke("add_project", {
      path: selected,
      name: null,
      groupId: "ungrouped",
    });
    await refreshAll();
    setStatus("已添加");
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
  bindSystemThemeListener();
  applyTheme("system");
  await loadConfig();
  await refreshAll();
  if (!useMock && notifyInput.checked) await ensureNotifyPermission();

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
}

boot().catch((e) => setStatus(String(e)));
