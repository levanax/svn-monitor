import type { AppConfig, GroupConfig, ProjectState } from "./types";

const UNGROUPED = "ungrouped";

/** Browser / Playwright mock backend when not running inside Tauri. */
export function createMockApi() {
  const groups: GroupConfig[] = [
    { id: UNGROUPED, name: "未分组" },
    { id: "g-mobile", name: "Mobile" },
  ];

  const cfg: AppConfig = {
    poll_interval_secs: 300,
    notify_enabled: true,
    pause_when_locked: true,
    autostart: false,
    theme: "system",
    groups,
    projects: [],
  };

  let projects: ProjectState[] = [
    {
      id: "demo-1",
      name: "mobile-trunk",
      path: "C:\\work\\mobile\\trunk",
      svn_rel_path: "trunk",
      group_id: "g-mobile",
      mute_notify: false,
      sort_order: 0,
      local_rev: 18490,
      remote_rev: 18497,
      status: "behind",
      error: null,
      last_checked: new Date().toISOString(),
    },
    {
      id: "demo-3",
      name: "mobile-branch",
      path: "C:\\work\\mobile\\branch",
      svn_rel_path: "branches/release-2.1",
      group_id: "g-mobile",
      mute_notify: false,
      sort_order: 1,
      local_rev: 100,
      remote_rev: 100,
      status: "up_to_date",
      error: null,
      last_checked: new Date().toISOString(),
    },
    {
      id: "demo-2",
      name: "tools",
      path: "C:\\work\\tools",
      svn_rel_path: "trunk/tools",
      group_id: UNGROUPED,
      mute_notify: false,
      sort_order: 0,
      local_rev: 220,
      remote_rev: 220,
      status: "up_to_date",
      error: null,
      last_checked: new Date().toISOString(),
    },
  ];

  const syncCfgProjects = () => {
    cfg.projects = projects.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
      group_id: p.group_id,
      mute_notify: p.mute_notify,
      sort_order: p.sort_order,
    }));
  };
  syncCfgProjects();

  return {
    async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
      switch (cmd) {
        case "get_config":
          return cfg as T;
        case "list_projects":
          return [...projects].sort(
            (a, b) =>
              a.group_id.localeCompare(b.group_id) ||
              a.sort_order - b.sort_order ||
              a.name.localeCompare(b.name),
          ) as T;
        case "list_groups":
          return groups as T;
        case "add_group": {
          const name = String(args?.name ?? "").trim();
          if (!name) throw new Error("分组名称不能为空");
          const g = { id: `g-${Date.now()}`, name };
          groups.push(g);
          cfg.groups = [...groups];
          return g as T;
        }
        case "rename_group": {
          const id = String(args?.id ?? "");
          const name = String(args?.name ?? "").trim();
          const g = groups.find((x) => x.id === id);
          if (!g) throw new Error("分组不存在");
          g.name = name;
          return undefined as T;
        }
        case "remove_group": {
          const id = String(args?.id ?? "");
          if (id === UNGROUPED) throw new Error("不能删除「未分组」");
          const idx = groups.findIndex((g) => g.id === id);
          if (idx < 0) throw new Error("分组不存在");
          groups.splice(idx, 1);
          for (const p of projects) {
            if (p.group_id === id) p.group_id = UNGROUPED;
          }
          cfg.groups = [...groups];
          syncCfgProjects();
          return undefined as T;
        }
        case "set_project_group": {
          const id = String(args?.id ?? "");
          const groupId = String(args?.groupId ?? UNGROUPED);
          const found = projects.find((p) => p.id === id);
          if (!found) throw new Error("project not found");
          const max = projects
            .filter((p) => p.group_id === groupId)
            .reduce((m, p) => Math.max(m, p.sort_order), -1);
          found.group_id = groupId;
          found.sort_order = max + 1;
          syncCfgProjects();
          return found as T;
        }
        case "set_project_mute": {
          const id = String(args?.id ?? "");
          const mute = Boolean(args?.muteNotify);
          const found = projects.find((p) => p.id === id);
          if (!found) throw new Error("project not found");
          found.mute_notify = mute;
          syncCfgProjects();
          return found as T;
        }
        case "reorder_projects": {
          const groupId = String(args?.groupId ?? "");
          const orderedIds = (args?.orderedIds as string[]) ?? [];
          orderedIds.forEach((id, order) => {
            const found = projects.find((p) => p.id === id && p.group_id === groupId);
            if (found) found.sort_order = order;
          });
          syncCfgProjects();
          return undefined as T;
        }
        case "reorder_groups": {
          const orderedIds = (args?.orderedIds as string[]) ?? [];
          const byId = new Map(groups.map((g) => [g.id, g]));
          if (orderedIds.length !== groups.length || orderedIds.some((id) => !byId.has(id))) {
            throw new Error("分组排序列表与现有分组不匹配");
          }
          groups.splice(0, groups.length, ...orderedIds.map((id) => byId.get(id)!));
          cfg.groups = [...groups];
          return undefined as T;
        }
        case "add_project": {
          const path = String(args?.path ?? "");
          const groupId = String(args?.groupId ?? UNGROUPED);
          if (
            projects.some(
              (p) => p.path.toLowerCase() === path.toLowerCase() && p.group_id === groupId,
            )
          ) {
            throw new Error("该路径已在此分组中");
          }
          const id = `demo-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
          const name = path.split(/[/\\]/).filter(Boolean).pop() ?? "new";
          const max = projects
            .filter((p) => p.group_id === groupId)
            .reduce((m, p) => Math.max(m, p.sort_order), -1);
          const p: ProjectState = {
            id,
            name,
            path,
            svn_rel_path: null,
            group_id: groupId,
            mute_notify: false,
            sort_order: max + 1,
            local_rev: 1,
            remote_rev: 1,
            status: "up_to_date",
            error: null,
            last_checked: new Date().toISOString(),
          };
          projects = [...projects, p];
          syncCfgProjects();
          return p as T;
        }
        case "remove_project": {
          const id = String(args?.id ?? "");
          projects = projects.filter((p) => p.id !== id);
          syncCfgProjects();
          return undefined as T;
        }
        case "save_settings": {
          cfg.poll_interval_secs = Number(args?.pollIntervalSecs ?? cfg.poll_interval_secs);
          cfg.notify_enabled = Boolean(args?.notifyEnabled);
          cfg.pause_when_locked = Boolean(args?.pauseWhenLocked);
          cfg.autostart = Boolean(args?.autostart);
          cfg.theme = String(args?.theme ?? cfg.theme);
          return undefined as T;
        }
        case "check_project":
        case "update_project": {
          const id = String(args?.id ?? "");
          const found = projects.find((p) => p.id === id);
          if (!found) throw new Error("project not found");
          if (cmd === "update_project") {
            found.local_rev = found.remote_rev;
            found.status = "up_to_date";
          }
          found.last_checked = new Date().toISOString();
          return found as T;
        }
        case "check_all":
        case "open_project_folder":
        case "open_tortoise_log":
          return undefined as T;
        case "is_session_locked":
          return false as T;
        default:
          throw new Error(`mock: unknown command ${cmd}`);
      }
    },
  };
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
