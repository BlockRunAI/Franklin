import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentQuestionDialog } from "./AgentQuestionDialog";
vi.mock("../lib/i18n", () => ({ useTryLang: () => ({ lang: "en" }) }));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
const question = { askId: "q1", question: "Which market should I analyze?", options: ["Market A", "Market B"] };
it("shows the actual choices and submits the user's edited answer", () => {
  const answer = vi.fn();
  render(<AgentQuestionDialog question={question} onAnswer={answer} />);
  expect((screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Market B" }));
  expect((screen.getByLabelText("Your answer") as HTMLTextAreaElement).value).toBe("Market B");
  expect(answer).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "Market B, only the last 7 days." } });
  fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
  expect(answer).toHaveBeenCalledWith("Market B, only the last 7 days.");
});
it("skipping and Escape do not select an affirmative option", () => {
  const answer = vi.fn();
  render(<AgentQuestionDialog question={question} onAnswer={answer} />);
  fireEvent.click(screen.getByRole("button", { name: "Skip question" }));
  expect(answer).toHaveBeenCalledWith("");
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true, cancelable: true }));
  expect(answer).toHaveBeenLastCalledWith("");
});
