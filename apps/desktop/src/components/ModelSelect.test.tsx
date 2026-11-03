import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ModelSelect } from "./ModelSelect";

it("keeps an identifiable selected model when a refreshed catalog omits its entry", () => {
  render(<ModelSelect models={[]} model="provider/previous-model" onChange={() => {}} />);
  expect(screen.getByRole("button", { name: "provider/previous-model" })).toBeTruthy();
});
