import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopUpdateMenuItem, DesktopUpdateNotice, DesktopUpdateProvider } from "./DesktopUpdates";
import { TryLangProvider } from "../lib/i18n";
import type { DesktopUpdateState } from "../lib/desktop-updates";

let state: DesktopUpdateState;
let emit: (value: DesktopUpdateState) => void;
const unsubscribe = vi.fn();
function next(patch: Partial<DesktopUpdateState>) { state = { ...state, ...patch }; emit(state); return state; }
function draw(busy = false) {
  return <TryLangProvider><DesktopUpdateProvider><DesktopUpdateMenuItem onSelect={() => {}} /><DesktopUpdateNotice busy={busy} /></DesktopUpdateProvider></TryLangProvider>;
}
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  state = { status: "idle", currentVersion: "0.2.0-beta.6", platform: "darwin" };
  window.__FRANKLIN__ = { agentUrl: "ws://127.0.0.1:1/agent", getUpdateState: vi.fn(async () => state),
    onUpdateState: vi.fn((callback) => { emit = callback; return unsubscribe; }),
    checkForUpdates: vi.fn(async () => next({ status: "available", version: "0.2.0-beta.7" })),
    downloadUpdate: vi.fn(async () => next({ status: "downloading", progress: 1 })),
    openUpdateInstaller: vi.fn(async () => next({ status: "downloaded", openedAt: 1 })),
    cancelUpdateDownload: vi.fn(async () => { next({ status: "available", progress: undefined }); }),
  };
});
afterEach(() => { delete window.__FRANKLIN__; });

it("keeps Desktop updates out of the browser preview", () => {
  delete window.__FRANKLIN__; render(draw()); expect(screen.queryByRole("menuitem")).toBeNull();
});

it("settings shows the actual Desktop version, checks manually and requires an explicit download click", async () => {
  const view = render(draw());
  const menu = await screen.findByRole("menuitem"); expect(menu.textContent).toContain("0.2.0-beta.6");
  fireEvent.click(menu);
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("button", { name: "Download update" });
  expect(window.__FRANKLIN__!.checkForUpdates).toHaveBeenCalledOnce();
  expect(window.__FRANKLIN__!.downloadUpdate).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Download update" }));
  await within(dialog).findByRole("button", { name: "Cancel download" });
  expect(window.__FRANKLIN__!.openUpdateInstaller).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel download" }));
  await within(dialog).findByRole("button", { name: "Download update" });
  expect(window.__FRANKLIN__!.cancelUpdateDownload).toHaveBeenCalledOnce();
  view.unmount(); expect(unsubscribe).toHaveBeenCalled();
});

it("defers automatic prompts during tasks and remembers Later while keeping settings available", async () => {
  const view = render(draw(true)); await screen.findByRole("menuitem");
  act(() => { next({ status: "available", version: "0.2.0-beta.7" }); });
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(draw(false));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Later" }));
  expect(localStorage.getItem("franklin-dismissed-update-v1")).toBe("0.2.0-beta.7");
  act(() => { next({ status: "checking" }); next({ status: "available" }); });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("menuitem")); expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull();
  act(() => { next({ version: "0.2.0-beta.8" }); });
  expect(await screen.findByRole("dialog")).toBeTruthy();
});

it("does not interrupt hidden windows and prompts when the app becomes visible", async () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  render(draw()); await screen.findByRole("menuitem");
  act(() => { next({ status: "available", version: "0.2.0-beta.7" }); });
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(await screen.findByRole("dialog")).toBeTruthy();
});

it("download completion never opens an installer automatically and active tasks disable opening", async () => {
  const view = render(draw(true)); await screen.findByRole("menuitem");
  act(() => { next({ status: "downloaded", version: "0.2.0-beta.7", progress: 100 }); });
  fireEvent.click(screen.getByRole("menuitem"));
  const button = within(screen.getByRole("dialog")).getByRole("button", { name: "Open installer" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true); expect(window.__FRANKLIN__!.openUpdateInstaller).not.toHaveBeenCalled();
  view.rerender(draw(false)); expect(button.disabled).toBe(false);
  fireEvent.click(button); await waitFor(() => expect(window.__FRANKLIN__!.openUpdateInstaller).toHaveBeenCalledOnce());
  expect(screen.getByText(/The installer has been opened/)).toBeTruthy();
});

it("newer push events win over a late initial state read", async () => {
  let resolve: (state: DesktopUpdateState) => void = () => {};
  window.__FRANKLIN__!.getUpdateState = () => new Promise((r) => { resolve = r; });
  render(draw());
  act(() => { next({ status: "available", version: "0.2.0-beta.7" }); });
  await act(async () => resolve({ status: "idle", currentVersion: "0.2.0-beta.6", platform: "darwin" }));
  expect(screen.getByRole("dialog").textContent).toContain("0.2.0-beta.7");
});

it("verification failures show a retry action instead of offering to execute the installer", async () => {
  render(draw()); await screen.findByRole("menuitem");
  act(() => { next({ status: "error", version: "0.2.0-beta.7", error: "verification" }); });
  fireEvent.click(screen.getByRole("menuitem"));
  await waitFor(() => expect(window.__FRANKLIN__!.checkForUpdates).toHaveBeenCalledOnce());
  act(() => { next({ status: "error", error: "verification" }); });
  expect(screen.getByRole("alert").textContent).toContain("couldn't be verified");
  expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Open installer" })).toBeNull();
});
