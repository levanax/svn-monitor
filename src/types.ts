export type ProjectStatus = "unknown" | "checking" | "up_to_date" | "behind" | "error";

export interface GroupConfig {
  id: string;
  name: string;
  /** 占看板基础列数 1..=3；未分组固定为 1 */
  column_span?: number;
}

export interface ProjectState {
  id: string;
  name: string;
  path: string;
  /** 仓库内相对路径，如 trunk / branches/xxx；检查成功后才有 */
  svn_rel_path: string | null;
  group_id: string;
  mute_notify: boolean;
  sort_order: number;
  local_rev: number | null;
  remote_rev: number | null;
  status: ProjectStatus;
  error: string | null;
  last_checked: string | null;
}

export type ThemeMode =
  | "system"
  | "light"
  | "dark"
  | "dawn"
  | "sky"
  | "lilac"
  | "mint"
  | "dusk"
  | "noir"
  | string;

export interface WindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface AppConfig {
  poll_interval_secs: number;
  notify_enabled: boolean;
  pause_when_locked: boolean;
  autostart: boolean;
  /** 全局快捷键唤起主窗口；空表示关闭 */
  open_hotkey?: string;
  theme: ThemeMode | string;
  groups: GroupConfig[];
  projects: {
    id: string;
    name: string;
    path: string;
    group_id: string;
    mute_notify?: boolean;
    sort_order?: number;
  }[];
  window_geometry?: WindowGeometry | null;
}
