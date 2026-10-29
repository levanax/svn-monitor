export type ProjectStatus = "unknown" | "checking" | "up_to_date" | "behind" | "error";

export interface GroupConfig {
  id: string;
  name: string;
}

export interface ProjectState {
  id: string;
  name: string;
  path: string;
  group_id: string;
  mute_notify: boolean;
  sort_order: number;
  local_rev: number | null;
  remote_rev: number | null;
  status: ProjectStatus;
  error: string | null;
  last_checked: string | null;
}

export type ThemeMode = "system" | "light" | "dark";

export interface AppConfig {
  poll_interval_secs: number;
  notify_enabled: boolean;
  pause_when_locked: boolean;
  autostart: boolean;
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
}
