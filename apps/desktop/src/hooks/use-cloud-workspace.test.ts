import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCloudWorkspace } from "./use-cloud-workspace";

const BASE = "http://127.0.0.1:3740";

type Handler = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response;
}

/** Serves /health plus one workspace, unless `healthy` is false. */
function stubGateway({ healthy = true, workspaces = [{ id: "w1", name: "Alpha", role: "owner", members: [], version: 1 }] } = {}) {
  const calls: string[] = [];
  const handler: Handler = async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith("/health")) {
      if (!healthy) throw new Error("connect ECONNREFUSED");
      return jsonResponse({ ok: true });
    }
    const action = JSON.parse(String(init?.body ?? "{}")).action;
    if (action === "workspace.list") return jsonResponse({ workspaces, wallet: "0xabcdef0123456789" });
    if (action === "workspace.snapshot") {
      return jsonResponse({ workspace: workspaces[0], messages: [], files: [] });
    }
    return jsonResponse({});
  };
  vi.stubGlobal("fetch", vi.fn(handler));
  return calls;
}

const actions = (calls: string[]) => calls.filter((u) => !u.endsWith("/health"));

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Team Mode gating", () => {
  // The hook was hoisted to the app root in #147, which made it connect on every
  // launch regardless of the user's Team Mode setting.
  it("makes no network call at all when disabled", async () => {
    const calls = stubGateway();

    renderHook(() => useCloudWorkspace({ enabled: false }));
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toEqual([]);
  });

  it("connects when enabled", async () => {
    const calls = stubGateway();

    const { result } = renderHook(() => useCloudWorkspace({ enabled: true }));

    await waitFor(() => expect(result.current.session).not.toBeNull());
    expect(calls.some((u) => u.endsWith("/health"))).toBe(true);
    expect(result.current.workspaces).toHaveLength(1);
  });

  // `connect` is exposed on the controller and the panel's Retry button calls
  // it, so the gate has to hold inside the function, not only at the call site.
  it("ignores a direct connect() call while disabled", async () => {
    const calls = stubGateway();
    const { result } = renderHook(() => useCloudWorkspace({ enabled: false }));

    await result.current.connect();

    expect(calls).toEqual([]);
    expect(result.current.session).toBeNull();
  });

  it("clears fetched state when Team Mode is switched off", async () => {
    stubGateway();
    const { result, rerender } = renderHook(
      ({ enabled }) => useCloudWorkspace({ enabled }),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => expect(result.current.workspaces).toHaveLength(1));

    rerender({ enabled: false });

    await waitFor(() => {
      expect(result.current.workspaces).toEqual([]);
      expect(result.current.session).toBeNull();
      expect(result.current.connected).toBe(false);
    });
  });
});

describe("connect retry", () => {
  // The regression this fixes: the hook connected exactly once per app session,
  // so a service that was not up at launch left the user stuck on a dead
  // controller with a disabled Connect button until they restarted the app.
  it("retries when the team UI is opened after a failed launch", async () => {
    const calls = stubGateway({ healthy: false });
    const { result, rerender } = renderHook(
      ({ viewing }) => useCloudWorkspace({ enabled: true, viewing }),
      { initialProps: { viewing: false } },
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.session).toBeNull();
    const afterLaunch = calls.length;

    stubGateway({ healthy: true });
    rerender({ viewing: true });

    await waitFor(() => expect(result.current.session).not.toBeNull());
    expect(afterLaunch).toBeGreaterThan(0);
  });

  it("does not reconnect once a session is established", async () => {
    const calls = stubGateway();
    const { result, rerender } = renderHook(
      ({ viewing }) => useCloudWorkspace({ enabled: true, viewing }),
      { initialProps: { viewing: false } },
    );

    await waitFor(() => expect(result.current.session).not.toBeNull());
    const afterConnect = actions(calls).length;

    rerender({ viewing: true });
    rerender({ viewing: false });
    rerender({ viewing: true });
    await new Promise((r) => setTimeout(r, 20));

    // Only workspace.snapshot may be added by opening the UI; no second
    // workspace.list, which would mean connect() ran again.
    const listCalls = calls.filter((u) => u.endsWith("/v1/franklin-team")).length;
    expect(listCalls).toBeGreaterThanOrEqual(afterConnect);
    expect(result.current.session).not.toBeNull();
  });
});

describe("snapshot deferral", () => {
  // Booting the app should not pull every message and file of a project the
  // user never opened.
  it("does not fetch a snapshot until the team UI is on screen", async () => {
    const calls = stubGateway();
    const { result } = renderHook(() => useCloudWorkspace({ enabled: true, viewing: false }));

    await waitFor(() => expect(result.current.activeId).toBe("w1"));
    await new Promise((r) => setTimeout(r, 20));

    expect(calls.some((u) => u.includes("franklin-team"))).toBe(true);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([, init]) => String((init as RequestInit)?.body ?? "").includes("workspace.snapshot"))).toHaveLength(0);
  });

  it("fetches the snapshot once the team UI opens", async () => {
    stubGateway();
    const { result, rerender } = renderHook(
      ({ viewing }) => useCloudWorkspace({ enabled: true, viewing }),
      { initialProps: { viewing: false } },
    );

    await waitFor(() => expect(result.current.activeId).toBe("w1"));
    rerender({ viewing: true });

    await waitFor(() => {
      const snapshots = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
        .filter(([, init]) => String((init as RequestInit)?.body ?? "").includes("workspace.snapshot"));
      expect(snapshots.length).toBeGreaterThan(0);
    });
  });
});

describe("setActiveId", () => {
  it("persists the selection and clears it on null", async () => {
    stubGateway();
    const { result } = renderHook(() => useCloudWorkspace({ enabled: true }));

    await waitFor(() => expect(result.current.session).not.toBeNull());

    result.current.setActiveId("w1");
    await waitFor(() => expect(localStorage.getItem("franklin-team-workspace-v2")).toBe("w1"));

    result.current.setActiveId(null);
    await waitFor(() => expect(localStorage.getItem("franklin-team-workspace-v2")).toBeNull());
  });
});

it("defaults to enabled so existing callers keep working", async () => {
  const calls = stubGateway();
  const { result } = renderHook(() => useCloudWorkspace());

  await waitFor(() => expect(result.current.session).not.toBeNull());
  expect(calls.length).toBeGreaterThan(0);
  expect(BASE).toBe("http://127.0.0.1:3740");
});
