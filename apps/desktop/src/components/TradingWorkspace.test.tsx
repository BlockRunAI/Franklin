import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TradingWorkspace } from "./TradingWorkspace";
import { TryLangProvider } from "../lib/i18n";

const KEY = "franklin-trading-layout-v1";
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());
function draw(request = 0, active = true) {
  return <TryLangProvider><TradingWorkspace active={active} market={<div>Market content</div>} conversationRequest={request} onClose={() => {}}><textarea aria-label="Draft" defaultValue="Keep this draft" /></TradingWorkspace></TryLangProvider>;
}
describe("chart and conversation workspace", () => {
  it("keeps the same conversation and draft mounted across all layout switches", () => {
    const { container } = render(draw());
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "An unsent question" } });
    for (const name of ["Market", "Conversation", "Side by side"]) fireEvent.click(screen.getByRole("button", { name }));
    expect(screen.getByRole("textbox")).toBe(input);
    expect((input as HTMLTextAreaElement).value).toBe("An unsent question");
    expect(container.querySelector(".trading-workspace")?.getAttribute("data-layout")).toBe("split");
  });
  it("opens the conversation and focuses the existing draft when market context is referenced", () => {
    const { rerender, container } = render(draw());
    fireEvent.click(screen.getByRole("button", { name: "Market" }));
    rerender(draw(1));
    expect(container.querySelector(".trading-workspace")?.getAttribute("data-layout")).toBe("split");
    expect(container.querySelector(".trading-workspace")?.getAttribute("data-mobile-pane")).toBe("chat");
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });
  it("provides keyboard resizing with bounded conversation widths", () => {
    render(draw());
    const separator = screen.getByRole("separator");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator.getAttribute("aria-valuenow")).toBe("42");
    fireEvent.keyDown(separator, { key: "End" });
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator.getAttribute("aria-valuenow")).toBe("60");
    fireEvent.keyDown(separator, { key: "Home" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator.getAttribute("aria-valuenow")).toBe("32");
  });
  it("ignores corrupt stored layout settings and clamps oversized panels", () => {
    localStorage.setItem(KEY, JSON.stringify({ layout: "unknown", width: 999 }));
    const { container } = render(draw());
    expect(container.querySelector(".trading-workspace")?.getAttribute("data-layout")).toBe("split");
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("60");
  });
});
