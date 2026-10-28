import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
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

const COLLAPSE_KEY = "svn-monitor:collapsed-groups";

let projects: ProjectState[] = [];
let groups: GroupConfig[] = [];
let sessionLocked = false;
let collapsedGroups = loadCollapsed();

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed() {
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedGroups]));
}

function toggleGroupCollapsed(groupId: string) {
  if (collapsedGroups.has(groupId)) collapsedGroups.delete(groupId);
  else collapsedGroups.add(groupId);
  saveCollapsed();
}

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

  for (const g of groups) {
    const items = byGroup.get(g.id) ?? [];
    // 未分组为空时隐藏；自定义空分组仍显示便于管理
    if (g.id === "ungrouped" && items.length === 0) continue;
    if (items.length === 0 && g.id !== "ungrouped" && projects.length === 0) continue;

    const collapsed = collapsedGroups.has(g.id);
    const block = document.createElement("section");
    block.className = `group-block${collapsed ? " collapsed" : ""}`;
    block.dataset.groupId = g.id;

    const head = document.createElement("div");
    head.className = "group-head";
    head.innerHTML = `
      <button type="button" class="group-toggle" data-gact="toggle" aria-expanded="${collapsed ? "false" : "true"}" title="${collapsed ? "展开" : "折叠"}">
        <span class="chevron" aria-hidden="true"></span>
      </button>
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
        const act = (btn as HTMLButtonElement).dataset.gact!;
        if (act === "toggle") {
          toggleGroupCollapsed(g.id);
          render();
          return;
        }
        onGroupAction(g, act);
      });
    });
    head.addEventListener("click", (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest("button") || t.closest("select")) return;
      toggleGroupCollapsed(g.id);
      render();
    });
    block.appendChild(head);

    const ul = document.createElement("ul");
    ul.className = "group-body";
    ul.hidden = collapsed;

    if (items.length === 0) {
      const empty = document.createElement("li");
      empty.className = "card";
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

function renderCard(p: ProjectState): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `card ${p.status === "behind" ? "behind" : ""} ${p.status === "error" ? "error" : ""} ${p.mute_notify ? "muted" : ""}`;
  li.dataset.id = p.id;

  const badge = badgeFor(p);
  const local = p.local_rev ?? "—";
  const remote = p.remote_rev ?? "—";
  const checked = p.last_checked ? new Date(p.last_checked).toLocaleTimeString() : "—";
  const muteLabel = p.mute_notify ? "恢复提醒" : "忽略提醒";

  li.innerHTML = `
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
      <button type="button" class="btn warn tiny" data-act="update" ${p.status === "behind" ? "" : "disabled"}>Update</button>
      <button type="button" class="btn ghost tiny" data-act="open">打开</button>
      <button type="button" class="btn danger tiny" data-act="remove">移除</button>
    </div>
  `;

  li.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => onAction(p, (btn as HTMLButtonElement).dataset.act!));
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
  let granted = await isPermissionGranted();
  if (!granted) {
    const perm = await requestPermission();
    granted = perm === "granted";
  }
  return granted;
}

async function loadConfig() {
  const cfg = await invoke<AppConfig>("get_config");
  intervalInput.value = String(cfg.poll_interval_secs);
  notifyInput.checked = cfg.notify_enabled;
  pauseLockedInput.checked = cfg.pause_when_locked;
  autostartInput.checked = !!cfg.autostart;
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
      setStatus(`已重命名分组`);
    } else if (act === "remove") {
      if (!confirm(`删除分组「${g.name}」？组内项目将移到「未分组」。`)) return;
      await invoke("remove_group", { id: g.id });
      await refreshAll();
      setStatus(`已删除分组 ${g.name}`);
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
      setStatus(next ? `已忽略「${p.name}」提醒` : `已恢复「${p.name}」提醒`);
    } else if (act === "move") {
      const groupId = await pickGroupId(p.group_id);
      if (!groupId || groupId === p.group_id) return;
      await invoke("set_project_group", { id: p.id, groupId });
      await refreshAll();
      setStatus(`已移动 ${p.name}`);
    } else if (act === "refresh") {
      setStatus(`正在检查 ${p.name}…`);
      await invoke("check_project", { id: p.id });
      await refreshAll();
      setStatus(`${p.name} 已检查`);
    } else if (act === "update") {
      if (!confirm(`确认对「${p.name}」执行 svn update？\n${p.path}`)) return;
      setStatus(`正在 update ${p.name}…`);
      await invoke("update_project", { id: p.id });
      await refreshAll();
      setStatus(`${p.name} update 完成`);
    } else if (act === "open") {
      await invoke("open_project_folder", { id: p.id });
      setStatus(useMock ? `（演示）打开 ${p.path}` : `已打开 ${p.name}`);
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
    setStatus(`已创建分组 ${name}`);
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
    setStatus(`已添加：${selected}`);
  } catch (e) {
    setStatus(String(e));
  }
});

document.querySelector("#btn-refresh")!.addEventListener("click", async () => {
  setStatus("正在刷新全部…");
  try {
    await invoke("check_all");
    await refreshAll();
    setStatus("全部刷新完成");
  } catch (e) {
    setStatus(String(e));
  }
});

let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function persistSettings(quiet = false) {
  const secs = Number(intervalInput.value);
  if (!Number.isFinite(secs) || secs < 10) {
    setStatus("间隔至少 10 秒");
    return;
  }
  try {
    await invoke("save_settings", {
      pollIntervalSecs: secs,
      notifyEnabled: notifyInput.checked,
      pauseWhenLocked: pauseLockedInput.checked,
      autostart: autostartInput.checked,
    });
    if (notifyInput.checked) await ensureNotifyPermission();
    if (!quiet) setStatus("设置已自动保存");
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

async function boot() {
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

    await listen<{ name: string; local: number; remote: number }>("svn-behind", async (ev) => {
      const { name, local, remote } = ev.payload;
      setStatus(`「${name}」有更新：r${local} → r${remote}`);
      if (notifyInput.checked && (await ensureNotifyPermission())) {
        sendNotification({
          title: "SVN 有更新",
          body: `${name}：本地 r${local}，远端 r${remote}`,
        });
      }
    });

    await listen<boolean>("session-lock", (ev) => {
      sessionLocked = ev.payload;
      setStatus(
        sessionLocked && pauseLockedInput.checked
          ? "锁屏中，已暂停轮询"
          : "已解锁，恢复轮询",
      );
    });
  }

  setStatus(
    useMock
      ? "演示模式就绪（非 Tauri）"
      : sessionLocked && pauseLockedInput.checked
        ? "锁屏中，已暂停轮询"
        : "就绪",
  );
}

boot().catch((e) => setStatus(String(e)));
