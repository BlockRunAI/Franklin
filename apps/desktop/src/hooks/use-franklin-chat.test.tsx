import { useState } from "react";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSelect } from "../components/ModelSelect";
import type { AgentSendPayload, ModelInfo, ServerMsg } from "../lib/wire";

const transport = vi.hoisted(() => ({
  models: [] as ModelInfo[],
  stream: vi.fn((_kind: string, _payload: AgentSendPayload, _handle: (message: ServerMsg) => void) => () => {}),
  emit: vi.fn(),
}));

vi.mock("./use-models", () => ({
  useModels: () => ({ models: transport.models, isLoading: false }),
}));
vi.mock("../lib/ws", () => ({ agent: { stream: transport.stream, emit: transport.emit } }));

const { CHAT_MODELS, DEFAULT_CHAT_MODEL, useFranklinChat } = await import("./use-franklin-chat");
type ChatMessage = import("./use-franklin-chat").ChatMessage;
const setMessages = vi.fn();
const ensureConvId = () => "auto-test-conversation";
const renderChat = () => renderHook(() => useFranklinChat([], setMessages, ensureConvId));
const liveModel: ModelInfo = { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", free: false, group: "Google" };

function finishTurn(index: number, text?: string) {
  const handle = transport.stream.mock.calls[index][2];
  act(() => {
    if (text) handle({ id: "turn", kind: "agent.text", payload: { text } });
    handle({ id: "turn", kind: "agent.done", payload: {} });
  });
}

function Composer() {
  const [messages, updateMessages] = useState<ChatMessage[]>([]);
  const chat = useFranklinChat(messages, updateMessages, ensureConvId);
  return <>
    <ModelSelect models={chat.models} model={chat.model} onChange={chat.setModel} disabled={chat.isBusy} />
    <button onClick={() => chat.send("Explain this market")}>Send test message</button>
    <output>{messages.map(message => message.content).join("\n")}</output>
  </>;
}

beforeEach(() => {
  transport.models = [];
  transport.stream.mockClear();
  transport.emit.mockClear();
  setMessages.mockClear();
});

describe("Desktop Auto model selection", () => {
  it("offers Auto before the catalog is available without changing the user's default", () => {
    const { result } = renderChat();
    expect(CHAT_MODELS.some(model => model.id === "blockrun/auto")).toBe(true);
    expect(result.current.models[0]).toMatchObject({ id: "blockrun/auto", label: "Auto" });
    expect(result.current.models[0].free).not.toBe(true);
    expect(result.current.model).toBe(DEFAULT_CHAT_MODEL);
  });

  it("keeps Auto available when the live catalog replaces the fallback list", () => {
    const { result, rerender } = renderChat();
    act(() => result.current.setModel("blockrun/auto"));
    transport.models = [liveModel];
    rerender();
    expect(result.current.selectedModel?.label).toBe("Auto");
    expect(result.current.models.map(model => model.id)).toEqual(["blockrun/auto", liveModel.id]);
  });

  it("does not duplicate or falsely label Auto as free if a backend also returns it", () => {
    transport.models = [liveModel, { id: "blockrun/auto", label: "Old Auto", group: "Legacy", free: true }];
    const { result } = renderChat();
    const auto = result.current.models.filter(model => model.id === "blockrun/auto");
    expect(auto).toHaveLength(1);
    expect(auto[0].label).toBe("Auto");
    expect(auto[0].free).not.toBe(true);
  });

  it("selects Auto through the real dropdown and preserves it after a routed reply", () => {
    transport.models = [{ id: DEFAULT_CHAT_MODEL, label: "Claude Opus 4.8", free: false, group: "Anthropic" }, liveModel];
    render(<Composer />);
    fireEvent.click(screen.getByRole("button", { name: "Claude Opus 4.8" }));
    fireEvent.click(screen.getByRole("option", { name: /^Auto$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    expect(transport.stream.mock.calls[0][1]).toMatchObject({ model: "blockrun/auto", mode: "chat" });
    finishTurn(0, "Auto → deepseek/deepseek-v4-pro\n\nA routed answer.");
    expect(screen.getByRole("status").textContent).toContain("Auto → deepseek/deepseek-v4-pro");
    expect(screen.getByRole("button", { name: /^Auto$/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    expect(transport.stream.mock.calls[1][1].model).toBe("blockrun/auto");
  });

  it("sends Auto for regeneration and still allows an explicit manual model", () => {
    const { result } = renderChat();
    act(() => result.current.setModel("blockrun/auto"));
    act(() => result.current.send("First prompt"));
    finishTurn(0);
    act(() => result.current.regenerate());
    expect(transport.stream.mock.calls[1][1].model).toBe("blockrun/auto");
    finishTurn(1);
    act(() => result.current.setModel(liveModel.id));
    act(() => result.current.send("Manual prompt"));
    expect(transport.stream.mock.calls[2][1].model).toBe(liveModel.id);
  });

  it("keeps Auto out of media pickers and preserves the selected media model", () => {
    const { result } = renderChat();
    act(() => result.current.setModel("blockrun/auto"));
    act(() => result.current.setMode("image"));
    expect(result.current.models.some(model => model.id === "blockrun/auto")).toBe(false);
    act(() => result.current.setModel("google/nano-banana-pro"));
    act(() => result.current.send("A golden F"));
    const payload = transport.stream.mock.calls[0][1];
    expect(payload.model).toBeUndefined();
    expect(payload.text).toContain("google/nano-banana-pro");
    finishTurn(0);
    act(() => result.current.setMode("chat"));
    expect(result.current.model).toBe("blockrun/auto");
  });
});
