import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SkillsPanel } from "./SkillsPanel";

const backend = vi.hoisted(() => ({
  skills: [] as { name: string; description: string; source: string; enabled: boolean; removable: boolean; notes: string[] }[],
  request: vi.fn(),
}));
vi.mock("../lib/ws", () => ({ agent: { state: "open", onState: (fn: (state: string) => void) => { fn("open"); return () => {}; }, request: backend.request } }));

it("imports into the registry, shows duplicate errors and prepares a slash draft without sending", async () => {
  backend.skills = [];
  backend.request.mockImplementation(async (kind: string, payload?: { content?: string; name?: string; enabled?: boolean }) => {
    if (kind === "skills.list") return { skills: [...backend.skills] };
    if (kind === "skills.upload") {
      if (backend.skills.length) throw new Error("/weather already exists");
      expect(payload?.content).toContain("curl");
      backend.skills.push({ name: "weather", description: "Public API", source: "user", enabled: true, removable: true, notes: [] });
      return { name: "weather" };
    }
    if (kind === "skills.toggle") { backend.skills[0].enabled = payload?.enabled ?? false; return { ok: true }; }
    if (kind === "skills.remove") { backend.skills = []; return { ok: true }; }
    throw new Error("Unexpected RPC: " + kind);
  });
  const pick = vi.fn(); render(<SkillsPanel onPick={pick} />);
  await waitFor(() => expect(screen.getByText("No skills installed.")).toBeTruthy());
  const open = () => fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
  const input = () => screen.getByRole("textbox", { name: "Paste the complete SKILL.md or choose a file" });
  open(); fireEvent.change(input(), { target: { value: "---\nname: weather\ndescription: API\n---\ncurl https://example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Import skill" }));
  await waitFor(() => expect(screen.getByText("/weather")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Use in chat" })); expect(pick).toHaveBeenCalledWith("/weather ");
  open(); fireEvent.change(input(), { target: { value: "curl" } }); fireEvent.click(screen.getByRole("button", { name: "Import skill" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("already exists"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("switch", { name: "Enable /weather" }));
  await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"));
  expect((screen.getByRole("button", { name: "Use in chat" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(backend.skills).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
  await waitFor(() => expect(screen.getByText("No skills installed.")).toBeTruthy());
  expect(backend.request.mock.calls.every(([kind]) => kind !== "agent.send")).toBe(true);
});

it("does not let a delayed file read replace a newer pasted draft or cancelled import", async () => {
  backend.request.mockImplementation(async () => ({ skills: [] }));
  render(<SkillsPanel onPick={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
  let complete!: (value: string) => void;
  const text = new Promise<string>((resolve) => { complete = resolve; });
  fireEvent.change(screen.getByLabelText("SKILL.md file"), { target: { files: [{ size: 10, text: () => text }] } });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "new pasted draft" } });
  complete("old file content");
  await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("new pasted draft"));
  let late!: (value: string) => void;
  fireEvent.change(screen.getByLabelText("SKILL.md file"), { target: { files: [{ size: 10, text: () => new Promise<string>((resolve) => { late = resolve; }) }] } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
  late("cancelled file");
  await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("new pasted draft"));
});
