import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopUpdateMenuItem, DesktopUpdateSidebarButton, DesktopUpdateNotice, DesktopUpdateProvider } from "./DesktopUpdates";
import { TryLangProvider } from "../lib/i18n";
import type { DesktopUpdateState } from "../lib/desktop-updates";
let state: DesktopUpdateState;
let emit: (value: DesktopUpdateState) => void;
const unsubscribe = vi.fn();
function next(patch: Partial<DesktopUpdateState>) { state = { ...state, ...patch }; emit(state); return state; }
function draw(busy = false, compact = false) {
  return <TryLangProvider><DesktopUpdateProvider><textarea aria-label="Draft" defaultValue="Keep my draft" /><DesktopUpdateMenuItem onSelect={() => {}} /><DesktopUpdateSidebarButton compact={compact} /><DesktopUpdateNotice busy={busy} /></DesktopUpdateProvider></TryLangProvider>;
}
beforeEach(() => {
  localStorage.clear();
  state = { status: "idle", currentVersion: "0.2.0-beta.6", platform: "darwin", installMode: "automatic" };
  window.__FRANKLIN__ = { agentUrl: "ws://127.0.0.1:1/agent", getUpdateState: vi.fn(async () => state),
    onUpdateState: vi.fn((callback) => { emit = callback; return unsubscribe; }),
    checkForUpdates: vi.fn(async () => next({ status: "available", version: "0.2.0-beta.7" })),
    downloadUpdate: vi.fn(async () => next({ status: "downloading", progress: 1 })),
    openUpdateInstaller: vi.fn(async () => next({ status: "downloaded", openedAt: 1 })),
    installDesktopUpdate: vi.fn(async () => next({ status: "installing" })),
    setUpdateTaskActive: vi.fn(async () => {}),
    cancelUpdateDownload: vi.fn(async () => { next({ status: "available", progress: undefined }); }),
  };
});
afterEach(() => { delete window.__FRANKLIN__; });
it("keeps Desktop update controls out of the browser preview", () => {
  delete window.__FRANKLIN__; render(draw()); expect(screen.queryByRole("menuitem")).toBeNull(); expect(screen.queryByRole("button")).toBeNull();
});
it("settings checks manually and shows the installed Desktop version", async () => {
  const view = render(draw()); const menu = await screen.findByRole("menuitem");
  expect(menu.textContent).toContain("0.2.0-beta.6"); fireEvent.click(menu);
  const dialog = await screen.findByRole("dialog"); await within(dialog).findByRole("button", { name: "Download update" });
  expect(window.__FRANKLIN__!.checkForUpdates).toHaveBeenCalledOnce(); expect(window.__FRANKLIN__!.downloadUpdate).not.toHaveBeenCalled();
  view.unmount(); expect(unsubscribe).toHaveBeenCalled();
});
it("new releases add a sidebar button without opening a modal or stealing draft focus", async () => {
  render(draw()); await screen.findByRole("menuitem"); const draft = screen.getByRole("textbox"); draft.focus();
  act(() => { next({ status: "available", version: "0.2.0-beta.7" }); });
  expect(screen.getByRole("button", { name: "Update Franklin" })).toBeTruthy(); expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(draft); expect((draft as HTMLTextAreaElement).value).toBe("Keep my draft");
});
it("one sidebar click downloads, progress stays in the sidebar, and restart is a separate action", async () => {
  render(draw()); await screen.findByRole("menuitem"); act(() => { next({ status: "available", version: "0.2.0-beta.7" }); });
  fireEvent.click(screen.getByRole("button", { name: "Update Franklin" }));
  await screen.findByRole("button", { name: "Downloading update… 1%" });
  expect(window.__FRANKLIN__!.downloadUpdate).toHaveBeenCalledOnce(); expect(window.__FRANKLIN__!.installDesktopUpdate).not.toHaveBeenCalled(); expect(screen.queryByRole("dialog")).toBeNull();
  act(() => { next({ status: "downloaded", progress: 100 }); });
  fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
  await waitFor(() => expect(window.__FRANKLIN__!.installDesktopUpdate).toHaveBeenCalledOnce());
  expect(window.__FRANKLIN__!.openUpdateInstaller).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Restarting to update…" }) as HTMLButtonElement).disabled).toBe(true);
});
it("active tasks allow downloads and block restart in both sidebar and settings", async () => {
  const view = render(draw(true)); await screen.findByRole("menuitem"); act(() => { next({ status: "available", version: "0.2.0-beta.7" }); });
  fireEvent.click(screen.getByRole("button", { name: "Update Franklin" })); await waitFor(() => expect(window.__FRANKLIN__!.downloadUpdate).toHaveBeenCalledOnce());
  act(() => { next({ status: "downloaded", progress: 100 }); });
  expect((screen.getByRole("button", { name: "Restart to update" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("menuitem"));
  expect((within(screen.getByRole("dialog")).getByRole("button", { name: "Restart to update" }) as HTMLButtonElement).disabled).toBe(true);
  expect(window.__FRANKLIN__!.setUpdateTaskActive).toHaveBeenCalledWith(true);
  fireEvent.keyDown(document, { key: "Escape" }); view.rerender(draw(false));
  expect((screen.getByRole("button", { name: "Restart to update" }) as HTMLButtonElement).disabled).toBe(false);
});
it("sidebar details support cancelling a download and Later preserves the update button", async () => {
  render(draw()); await screen.findByRole("menuitem"); act(() => { next({ status: "downloading", version: "0.2.0-beta.7", progress: 42 }); });
  fireEvent.click(screen.getByRole("button", { name: "Downloading update… 42%" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel download" }));
  await within(screen.getByRole("dialog")).findByRole("button", { name: "Download update" });
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Later" }));
  expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.getByRole("button", { name: "Update Franklin" })).toBeTruthy();
});
it("a legacy unsigned release keeps the installer label instead of promising automatic installation", async () => {
  render(draw()); await screen.findByRole("menuitem"); act(() => { next({ status: "downloaded", version: "0.2.0-beta.7", installMode: "manual" }); });
  fireEvent.click(screen.getByRole("button", { name: "Open installer" }));
  await waitFor(() => expect(window.__FRANKLIN__!.openUpdateInstaller).toHaveBeenCalledOnce()); expect(window.__FRANKLIN__!.installDesktopUpdate).not.toHaveBeenCalled();
});
it("compact rails preserve an accessible update action", async () => {
  render(draw(false, true)); await screen.findByRole("menuitem"); act(() => { next({ status: "available", version: "0.2.0-beta.7" }); });
  const button = screen.getByRole("button", { name: "Update Franklin" }); expect(button.textContent).toBe(""); fireEvent.click(button);
  await waitFor(() => expect(window.__FRANKLIN__!.downloadUpdate).toHaveBeenCalledOnce());
});
it("new push events win over a late initial state read", async () => {
  let resolve: (state: DesktopUpdateState) => void = () => {};
  window.__FRANKLIN__!.getUpdateState = () => new Promise((r) => { resolve = r; }); render(draw());
  act(() => { next({ status: "available", version: "0.2.0-beta.7" }); });
  await act(async () => resolve({ status: "idle", currentVersion: "0.2.0-beta.6", platform: "darwin" }));
  expect(screen.getByRole("button", { name: "Update Franklin" })).toBeTruthy();
});
it("verification failures offer retry instead of restart", async () => {
  render(draw()); await screen.findByRole("menuitem"); act(() => { next({ status: "error", version: "0.2.0-beta.7", error: "verification" }); });
  fireEvent.click(screen.getByRole("button", { name: "Update Franklin" }));
  expect(screen.getByRole("alert").textContent).toContain("couldn't be verified"); expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull();
});
