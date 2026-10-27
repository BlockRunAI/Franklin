import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadTradingMode, saveTradingMode } from "./trading-mode";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());
it("defaults to normal Franklin and restores only an explicit trading preference", () => {
  expect(loadTradingMode()).toBe(false);
  saveTradingMode(true);
  expect(loadTradingMode()).toBe(true);
  saveTradingMode(false);
  expect(loadTradingMode()).toBe(false);
  localStorage.setItem("franklin-desktop-trading-mode-v1", "unknown");
  expect(loadTradingMode()).toBe(false);
});
it("does not block mode switching when optional local storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
  expect(loadTradingMode()).toBe(false);
  expect(() => saveTradingMode(true)).not.toThrow();
});
