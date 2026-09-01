export interface TeamWorkspaceNavItem {
  id: string;
  name: string;
  role: "owner" | "admin" | "member" | "viewer";
  memberCount: number;
  version: number;
}

export interface TeamWorkspaceNavState {
  items: TeamWorkspaceNavItem[];
  activeId: string | null;
  loading: boolean;
}

const NAV_EVENT = "franklin:team-workspaces";
const SELECT_EVENT = "franklin:team-workspace-select";

export function publishTeamWorkspaceNav(state: TeamWorkspaceNavState) {
  window.dispatchEvent(new CustomEvent<TeamWorkspaceNavState>(NAV_EVENT, { detail: state }));
}

export function subscribeTeamWorkspaceNav(listener: (state: TeamWorkspaceNavState) => void) {
  const handler = (event: Event) => listener((event as CustomEvent<TeamWorkspaceNavState>).detail);
  window.addEventListener(NAV_EVENT, handler);
  return () => window.removeEventListener(NAV_EVENT, handler);
}

export function requestTeamWorkspace(id: string | null) {
  window.dispatchEvent(new CustomEvent<string | null>(SELECT_EVENT, { detail: id }));
}

export function subscribeTeamWorkspaceRequest(listener: (id: string | null) => void) {
  const handler = (event: Event) => listener((event as CustomEvent<string | null>).detail);
  window.addEventListener(SELECT_EVENT, handler);
  return () => window.removeEventListener(SELECT_EVENT, handler);
}
