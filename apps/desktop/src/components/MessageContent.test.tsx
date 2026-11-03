import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageContent } from "./MessageContent";

afterEach(() => vi.unstubAllGlobals());

it("copies code verbatim through the native bridge, including expanded blocks, when browser clipboard access is denied", async () => {
  const nativeCopy = vi.fn(() => true);
  vi.stubGlobal("__FRANKLIN__", { copy: nativeCopy });
  const browserCopy = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: browserCopy } });
  const code = 'const text = "你好";\n  console.log(text);';
  render(<MessageContent content={'```js\n' + code + '\n```'} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Copy code" }).textContent).toBe("Copied"));
  expect(nativeCopy).toHaveBeenCalledWith(code);
  expect(browserCopy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Expand code" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  await waitFor(() => expect(nativeCopy).toHaveBeenCalledTimes(2));
});

it("copies table markdown through the same native clipboard path", async () => {
  const copy = vi.fn(() => true);
  vi.stubGlobal("__FRANKLIN__", { copy });
  render(<MessageContent content={'| Name | Value |\n| --- | --- |\n| alpha | 42 |'} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy table as markdown" }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith('| Name | Value |\n| --- | --- |\n| alpha | 42 |'));
});

it("does not report success or reject the click when all clipboard methods fail", async () => {
  vi.stubGlobal("__FRANKLIN__", { copy: () => false });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  render(<MessageContent content={'```js\nhello\n```'} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "Copy code" }).textContent).toBe("Copy");
});
