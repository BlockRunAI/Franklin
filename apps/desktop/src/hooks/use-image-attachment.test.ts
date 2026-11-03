import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useImageAttachment } from "./use-image-attachment";
import { prepareImageForUpload } from "../lib/image-compress";
vi.mock("../lib/image-compress", () => ({ prepareImageForUpload: vi.fn() }));
const file = new File(["png"], "screenshot.png", { type: "image/png" });

it("ignores stale image reads after removal or a newer paste", async () => {
  let finishOld!: (value: string) => void;
  vi.mocked(prepareImageForUpload).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const { result } = renderHook(useImageAttachment);
  let old!: Promise<void>;
  act(() => { old = result.current.attach(file); });
  expect(result.current.preparing).toBe(true);
  act(() => result.current.clear());
  await act(async () => { finishOld("old-image"); await old; });
  expect(result.current.attachment).toBeNull();
  expect(result.current.preparing).toBe(false);
  vi.mocked(prepareImageForUpload).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValueOnce("new-image");
  act(() => { old = result.current.attach(file); });
  await act(async () => { await result.current.attach(file); });
  await act(async () => { finishOld("stale-image"); await old; });
  expect(result.current.attachment).toBe("new-image");
});

it("shows preparation failures and permits a subsequent successful attachment", async () => {
  vi.mocked(prepareImageForUpload).mockRejectedValueOnce(new Error("Image is too large")).mockResolvedValueOnce("data:image/png;base64,ok");
  const { result } = renderHook(useImageAttachment);
  await act(async () => { await result.current.attach(file); });
  expect(result.current.error).toBe("Image is too large");
  expect(result.current.preparing).toBe(false);
  await act(async () => { await result.current.attach(file); });
  expect(result.current.error).toBeNull();
  expect(result.current.attachment).toBe("data:image/png;base64,ok");
});
