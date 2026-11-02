import { afterEach, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

afterEach(() => vi.unstubAllGlobals());

it("waits for native clipboard settlement before reporting success", async () => {
  let resolve!: (ok: boolean) => void;
  vi.stubGlobal("__FRANKLIN__", { copy: () => new Promise<boolean>(r => { resolve = r; }) });
  const settled = vi.fn();
  const result = copyText("hello").then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  resolve(true);
  await result;
  expect(settled).toHaveBeenCalledWith(true);
});

it("falls back after an asynchronous native failure", async () => {
  vi.stubGlobal("__FRANKLIN__", { copy: async () => { throw new Error("native failure"); } });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  expect(await copyText("hello")).toBe(true);
  expect(writeText).toHaveBeenCalledWith("hello");
});
