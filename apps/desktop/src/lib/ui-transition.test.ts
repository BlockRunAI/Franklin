import { afterEach, describe, expect, it, vi } from "vitest";
import { transitionUi } from "./ui-transition";

afterEach(() => vi.unstubAllGlobals());
describe("navigation motion", () => {
  it("applies navigation without waiting when motion is reduced or unsupported", () => {
    const animate = vi.fn();
    vi.stubGlobal("document", { startViewTransition: animate, visibilityState: "visible" });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const update = vi.fn();
    transitionUi(update);
    expect(update).toHaveBeenCalledOnce();
    expect(animate).not.toHaveBeenCalled();
    vi.stubGlobal("document", {});
    transitionUi(update);
    expect(update).toHaveBeenCalledTimes(2);
  });
  it("retargets rapid navigation without losing an intermediate state update", async () => {
    const callbacks: (() => void)[] = [];
    const skips: ReturnType<typeof vi.fn>[] = [];
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("document", { visibilityState: "visible", startViewTransition: (callback: () => void) => {
      callbacks.push(callback);
      const skipTransition = vi.fn(); skips.push(skipTransition);
      return { ready: Promise.reject(new Error("superseded snapshot")), finished: Promise.resolve(), skipTransition };
    } });
    const state: string[] = [];
    transitionUi(() => state.push("open market"));
    transitionUi(() => state.push("open sidebar"));
    transitionUi(() => state.push("conversation"));
    callbacks.forEach((callback) => callback());
    await Promise.resolve();
    expect(state).toEqual(["open market", "open sidebar", "conversation"]);
    expect(skips[0]).toHaveBeenCalledOnce();
    expect(skips[1]).toHaveBeenCalledOnce();
  });
  it("moves focus only after the updated layout has committed", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("document", { visibilityState: "visible", startViewTransition: (callback: () => void) => {
      callback();
      return { ready: Promise.resolve(), finished: Promise.resolve(), skipTransition: vi.fn() };
    } });
    let visible = false;
    const focus = vi.fn(() => expect(visible).toBe(true));
    transitionUi(() => { visible = true; }, focus);
    expect(focus).toHaveBeenCalledOnce();
  });
});
