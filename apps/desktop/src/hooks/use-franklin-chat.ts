// Chat engine — run-shaped API, WebSocket-backed.
//
// This exposes the SAME surface franklin-run's useFranklinChat does (mode,
// media jobs, focus tools, regenerate, …) so run's FranklinChat + panels drop
// in unchanged. But where run runs the agent loop INSIDE the browser (HTTP
// /v1/messages + wagmi-signed x402), this streams a single turn over the agent
// WebSocket to the local Franklin CLI, which owns tools, routing and signing.
//
// The history store (messages/setMessages/ensureConvId) is passed in from
// useChatHistory, exactly like run, so this hook only drives one turn at a time.

import { useCallback, useRef, useState } from "react";
import { agent } from "../lib/ws";
import { useModels } from "./use-models";
import type { AgentSendPayload, AgentStep, ServerMsg } from "../lib/wire";

export type ChatMode = "chat" | "image" | "video" | "music";

// Model selected by default when the app opens.
export const DEFAULT_CHAT_MODEL = "anthropic/claude-opus-4.8";

export interface ChatModel {
  id: string;
  label: string;
  free?: boolean;
  group?: string;
  contextWindow?: number;
}

// Curated fallback lineup (mirrors Franklin's /model picker) used until the CLI
// returns its live catalog over models.list.
export const CHAT_MODELS: ChatModel[] = [
  { id: "nvidia/nemotron-nano-9b-v2", label: "Nemotron Nano 9B v2", free: true, group: "Free" },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", label: "Nemotron 3 Nano Omni", free: true, group: "Free" },
  { id: "nvidia/mistral-nemotron", label: "Mistral Nemotron", free: true, group: "Free" },
  { id: "anthropic/claude-opus-4.8", label: "Claude Opus 4.8", group: "Premium frontier" },
  { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", group: "Premium frontier" },
  { id: "qwen/qwen3.7-max", label: "Qwen3.7 Max", group: "Premium frontier", contextWindow: 1_000_000 },
  { id: "openai/gpt-5.5", label: "GPT-5.5", group: "Premium frontier" },
  { id: "google/gemini-3.1-pro", label: "Gemini 3.1 Pro", group: "Premium frontier" },
  { id: "openai/o3", label: "OpenAI O3", group: "Reasoning" },
  { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", group: "Reasoning" },
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", group: "Budget" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", group: "Budget" },
  { id: "moonshot/kimi-k3", label: "Kimi K3", group: "Premium frontier", contextWindow: 1_048_576 },
];

// GPT Image 2 leads — the only one here that supports non-square ratios, so it
// lines up with the aspect-ratio picker. (Mirrors franklin-run.)
export const IMAGE_MODELS: ChatModel[] = [
  { id: "openai/gpt-image-2", label: "GPT Image 2" },
  { id: "google/nano-banana-pro", label: "Nano Banana Pro" },
  { id: "google/nano-banana", label: "Nano Banana" },
  { id: "xai/grok-imagine-image", label: "Grok Imagine" },
];

// Per-model aspect-ratio whitelist (gateway rejects sizes outside the list).
// Single-ratio models skip the picker. First entry is the default.
export const IMAGE_MODEL_SIZES: Record<string, { ratio: string; size: string }[]> = {
  "openai/gpt-image-1": [
    { ratio: "1:1", size: "1024x1024" },
    { ratio: "3:2", size: "1536x1024" },
    { ratio: "2:3", size: "1024x1536" },
  ],
  "openai/gpt-image-2": [
    { ratio: "1:1", size: "1024x1024" },
    { ratio: "3:2", size: "1536x1024" },
    { ratio: "2:3", size: "1024x1536" },
  ],
  "google/nano-banana": [{ ratio: "1:1", size: "1024x1024" }],
  "google/nano-banana-pro": [{ ratio: "1:1", size: "1024x1024" }],
  "xai/grok-imagine-image": [{ ratio: "1:1", size: "1024x1024" }],
};
function defaultSizeFor(modelId: string): string {
  return IMAGE_MODEL_SIZES[modelId]?.[0]?.size ?? "1024x1024";
}

export const VIDEO_MODELS: ChatModel[] = [
  { id: "bytedance/seedance-2.0-fast", label: "Seedance 2.0 Fast" },
  { id: "bytedance/seedance-2.0", label: "Seedance 2.0 Pro" },
  { id: "xai/grok-imagine-video", label: "Grok Imagine Video" },
  { id: "azure/sora-2", label: "Sora 2" },
];

// Only Seedance accepts aspect_ratio / resolution; others ignore them, so the
// UI hides the pickers for those models.
export const VIDEO_MODEL_RATIOS: Record<string, string[]> = {
  "bytedance/seedance-2.0-fast": ["16:9", "9:16", "1:1", "4:3", "3:4"],
  "bytedance/seedance-2.0": ["16:9", "9:16", "1:1", "4:3", "3:4"],
  "bytedance/seedance-1.5-pro": ["16:9", "9:16", "1:1", "4:3", "3:4"],
};
function defaultVideoRatioFor(modelId: string): string {
  return VIDEO_MODEL_RATIOS[modelId]?.[0] ?? "16:9";
}
export const VIDEO_MODEL_RESOLUTIONS: Record<string, string[]> = {
  "bytedance/seedance-2.0-fast": ["480p", "720p", "1080p"],
  "bytedance/seedance-2.0": ["480p", "720p", "1080p"],
  "bytedance/seedance-1.5-pro": ["480p", "720p", "1080p"],
};
function defaultVideoResolutionFor(modelId: string): string {
  return VIDEO_MODEL_RESOLUTIONS[modelId]?.includes("720p") ? "720p" : VIDEO_MODEL_RESOLUTIONS[modelId]?.[0] ?? "720p";
}

export const MUSIC_MODELS: ChatModel[] = [
  { id: "minimax/music-2.5+", label: "MiniMax Music 2.5+" },
];

export interface ChatActivity {
  queries: string[];
  sources: { title: string; url: string }[];
  tools: string[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** "tools" is a tool-call activity segment rendered inline, in order, between
   *  the narration and the answer (Codex / Vercel AI SDK / assistant-ui style). */
  kind?: "text" | "image" | "video" | "music" | "tools";
  image?: string;
  video?: string;
  music?: string;
  reasoning?: string;
  activity?: ChatActivity;
  /** Set when kind === "tools". */
  tools?: ToolStep[];
}

export type ChatStatus = "idle" | "signing" | "thinking" | "generating" | "error";

export interface ToolStep {
  id: number;
  label: string;
  /** The tool's key argument (query/prompt/symbol/url…), shown as small text. */
  detail?: string;
  state: "run" | "sign" | "done";
}

export interface MediaJob {
  kind: "image" | "video" | "music";
  phase: "signing" | "generating";
}

export interface PendingPermission {
  askId: string;
  toolName: string;
  description: string;
}

type Setter = ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]);

export function useFranklinChat(
  _messages: ChatMessage[],
  setMessages: (next: Setter, targetId?: string) => void,
  ensureConvId: () => string,
  recordSpend?: (model: string, usd: number) => void,
) {
  const { models: liveModels } = useModels();

  const [mode, setMode] = useState<ChatMode>("chat");
  const [chatModel, setChatModel] = useState(DEFAULT_CHAT_MODEL);
  const [imageModel, setImageModel] = useState(IMAGE_MODELS[0].id);
  const [videoModel, setVideoModel] = useState(VIDEO_MODELS[0].id);
  const [musicModel, setMusicModel] = useState(MUSIC_MODELS[0].id);
  const [imageSize, setImageSize] = useState<string>(defaultSizeFor(IMAGE_MODELS[0].id));
  const [videoRatio, setVideoRatio] = useState<string>(defaultVideoRatioFor(VIDEO_MODELS[0].id));
  const [videoResolution, setVideoResolution] = useState<string>(defaultVideoResolutionFor(VIDEO_MODELS[0].id));
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [genConvId, setGenConvId] = useState<string | null>(null);
  const [mediaJobs, setMediaJobs] = useState<Record<string, MediaJob>>({});
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);

  const cancelRef = useRef<(() => void) | null>(null);
  const recordRef = useRef(recordSpend);
  recordRef.current = recordSpend;
  const lastTurnRef = useRef<{ text: string; attachment?: string; mode: ChatMode; model: string | undefined; forceTool?: string; displayText?: string } | null>(null);

  // Prefer the CLI's live catalog for chat; fall back to the curated list.
  const chatModels: ChatModel[] = liveModels.length
    ? liveModels.map((m) => ({ id: m.id, label: m.label, free: m.free, group: m.group, contextWindow: m.contextWindow }))
    : CHAT_MODELS;

  const models = mode === "image" ? IMAGE_MODELS : mode === "video" ? VIDEO_MODELS : mode === "music" ? MUSIC_MODELS : chatModels;
  const model = mode === "image" ? imageModel : mode === "video" ? videoModel : mode === "music" ? musicModel : chatModel;
  // Changing the media model resets its size/ratio/resolution to that model's
  // defaults (whitelists differ per model).
  const selectImageModel = useCallback((id: string) => { setImageModel(id); setImageSize(defaultSizeFor(id)); }, []);
  const selectVideoModel = useCallback((id: string) => {
    setVideoModel(id);
    setVideoRatio(defaultVideoRatioFor(id));
    setVideoResolution(defaultVideoResolutionFor(id));
  }, []);
  const setModel = mode === "image" ? selectImageModel : mode === "video" ? selectVideoModel : mode === "music" ? setMusicModel : setChatModel;

  // Per-model option lists for the composer pickers (empty → hide the picker).
  const imageSizes = IMAGE_MODEL_SIZES[imageModel] ?? [];
  const videoRatios = VIDEO_MODEL_RATIOS[videoModel] ?? [];
  const videoResolutions = VIDEO_MODEL_RESOLUTIONS[videoModel] ?? [];
  const selectedModel = models.find((m) => m.id === model);

  const isBusy = status === "signing" || status === "thinking" || status === "generating";
  // Local wallet: the CLI signs from ~/.blockrun/, so there's nothing to connect
  // and no per-tool wallet gate.
  const isConnected = true;
  const needsToolWallet = false;

  const clearMediaJob = useCallback((convId: string) => {
    setMediaJobs((p) => {
      if (!(convId in p)) return p;
      const n = { ...p };
      delete n[convId];
      return n;
    });
  }, []);

  const runTurn = useCallback(
    (
      text: string,
      attachment: string | undefined,
      m: ChatMode,
      modelId: string | undefined,
      forceTool: string | undefined,
      appendUser: boolean,
      displayText?: string,
    ) => {
      const convId = ensureConvId();
      setError(null);
      setActiveTool(null);
      lastTurnRef.current = { text, attachment, mode: m, model: modelId, forceTool, displayText };

      if (appendUser) {
        // The chat bubble shows what the user typed (displayText); the agent may
        // receive a richer instruction (e.g. media-gen directives) via `text`.
        const userMsg: ChatMessage = { role: "user", content: displayText ?? text, kind: "text", ...(attachment ? { image: attachment } : {}) };
        setMessages((prev) => [...prev, userMsg], convId);
      }
      setGenConvId(convId);

      const media = m === "image" || m === "video" || m === "music";
      let streamedChars = 0;
      const maxStreamChars = 1_000_000;
      if (media) {
        setMediaJobs((p) => ({ ...p, [convId]: { kind: m, phase: "generating" } }));
        setStatus("generating");
      } else {
        setStatus("thinking");
      }

      const handle = (msg: ServerMsg) => {
        switch (msg.kind) {
          case "agent.text": {
            const p = msg.payload as { text: string };
            const incoming = String(p.text || "");
            const remaining = maxStreamChars - streamedChars;
            if (remaining <= 0) break;
            const chunk = incoming.slice(0, remaining);
            streamedChars += chunk.length;
            // Append to the current assistant text bubble, OR start a fresh one
            // if the previous segment was a tool group — that keeps the order
            // narration → tools → answer (Codex-style ordered parts).
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === "assistant" && last.kind === "text") {
                return [...prev.slice(0, -1), { ...last, content: last.content + chunk }];
              }
              return [...prev, { role: "assistant", content: chunk, kind: "text" }];
            }, convId);
            if (incoming.length > remaining) {
              cancelRef.current?.();
              cancelRef.current = null;
              setError("Franklin response exceeded the 1,000,000-character display limit");
              setStatus("error");
              setGenConvId(null);
              break;
            }
            if (!media) setStatus("thinking");
            break;
          }
          case "agent.step": {
            const p = msg.payload as AgentStep;
            const label = String(p.label || "Tool").slice(0, 500);
            const st: ToolStep["state"] = p.state === "done" ? "done" : p.state === "sign" ? "sign" : "run";
            setStatus(p.state === "sign" ? "signing" : media ? "generating" : "thinking");
            if (p.state === "run") setActiveTool(label);
            else if (p.state === "done") setActiveTool(null);
            // Upsert into a trailing "tools" segment, creating one inline if the
            // last item isn't already a tool group.
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              const detail = p.detail?.trim().slice(0, 2_000) || undefined;
              if (last && last.kind === "tools" && last.tools) {
                const prior = last.tools.find((s) => s.id === p.stepId);
                // Keep the detail from the start event if a later done event
                // arrives without one.
                const step: ToolStep = { id: p.stepId, label, detail: detail ?? prior?.detail, state: st };
                const tools = prior
                  ? last.tools.map((s) => (s.id === p.stepId ? step : s))
                  : [...last.tools, step];
                return [...prev.slice(0, -1), { ...last, tools }];
              }
              return [...prev, { role: "assistant", content: "", kind: "tools", tools: [{ id: p.stepId, label, detail, state: st }] }];
            }, convId);
            break;
          }
          case "agent.tool_result": {
            const p = msg.payload as { artifacts?: Array<{ path: string; mediaType: string }>; isError?: boolean; preview?: string };
            if (p.isError && p.preview) setError(String(p.preview).slice(0, 4_000));
            if (p.artifacts) {
              for (const a of p.artifacts.slice(0, 20)) {
                if (typeof a.path !== "string" || a.path.length > 5_500_000 || typeof a.mediaType !== "string") continue;
                if (a.mediaType.startsWith("image/")) {
                  setMessages((prev) => [...prev, { role: "assistant", content: text, kind: "image", image: a.path }], convId);
                } else if (a.mediaType.startsWith("video/")) {
                  setMessages((prev) => [...prev, { role: "assistant", content: text, kind: "video", video: a.path }], convId);
                } else if (a.mediaType.startsWith("audio/")) {
                  setMessages((prev) => [...prev, { role: "assistant", content: text, kind: "music", music: a.path }], convId);
                }
              }
              clearMediaJob(convId);
            }
            break;
          }
          case "agent.payment": {
            const p = msg.payload as { model?: string; usd?: number };
            if (p.usd) recordRef.current?.(p.model || modelId || "", p.usd);
            break;
          }
          case "agent.permissionAsk": {
            const p = msg.payload as PendingPermission;
            if (p.askId && p.toolName) setPendingPermission({
              askId: String(p.askId),
              toolName: String(p.toolName),
              description: String(p.description || "Franklin requested permission to continue."),
            });
            break;
          }
          case "agent.done": {
            const p = msg.payload as { costUsd?: number };
            if (p.costUsd) recordRef.current?.(modelId ?? "", p.costUsd);
            setStatus("idle");
            setActiveTool(null);
            setGenConvId(null);
            // Mark any still-spinning steps in the trailing tool group as done.
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.kind === "tools" && last.tools) {
                return [...prev.slice(0, -1), { ...last, tools: last.tools.map((s) => (s.state === "done" ? s : { ...s, state: "done" })) }];
              }
              return prev;
            }, convId);
            clearMediaJob(convId);
            cancelRef.current = null;
            setPendingPermission(null);
            break;
          }
          case "agent.error": {
            const p = msg.payload as { message: string };
            setError(p.message);
            setStatus("error");
            setGenConvId(null);
            clearMediaJob(convId);
            cancelRef.current = null;
            setPendingPermission(null);
            break;
          }
          default:
            break;
        }
      };

      try {
        const payload: AgentSendPayload = {
          sessionId: null,
          text,
          attachments: attachment ? [{ path: attachment }] : undefined,
          model: modelId || undefined,
          forceTool,
          mode: m,
          convId, // server resets agent history when this changes (no cross-chat bleed)
        };
        cancelRef.current = agent.stream<AgentSendPayload>("agent.send", payload, handle);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to send");
        setStatus("error");
        setGenConvId(null);
        clearMediaJob(convId);
      }
    },
    [ensureConvId, setMessages, clearMediaJob],
  );

  const send = useCallback(
    (text: string, attachment?: string, modeOverride?: ChatMode, modelOverride?: string, forceTool?: string) => {
      const trimmed = text.trim();
      if (trimmed.length > 100_000) {
        setError("Message is too large (maximum 100,000 characters)");
        return;
      }
      if (!trimmed && !attachment) return;
      if (isBusy) return;
      const m = modeOverride ?? mode;
      if (modeOverride && modeOverride !== mode) setMode(modeOverride);

      if (m === "image" || m === "video" || m === "music") {
        // Media generation runs through the agent's ImageGen/VideoGen/MusicGen
        // tool. The picked media model is a TOOL parameter (baked into the
        // instruction), NOT the chat model — so we send no chat-model override
        // and keep the current chat model. The bubble shows the original prompt.
        const mediaModel = modelOverride ?? (m === "image" ? imageModel : m === "video" ? videoModel : musicModel);
        if (modelOverride) {
          if (m === "image") selectImageModel(modelOverride);
          else if (m === "video") selectVideoModel(modelOverride);
          else setMusicModel(modelOverride);
        }
        const verb = m === "image" ? "Generate an image" : m === "video" ? "Generate a video" : "Generate music";
        const specs =
          m === "image" ? `, size ${imageSize}` :
          m === "video" ? `, aspect ratio ${videoRatio}, resolution ${videoResolution}` : "";
        const instructed = `${verb} with the ${mediaModel} model${specs} from this prompt:\n\n${trimmed}`;
        runTurn(instructed, attachment, m, undefined, undefined, true, trimmed);
        return;
      }

      const modelId = modelOverride ?? chatModel;
      if (modelOverride) setChatModel(modelOverride);
      runTurn(trimmed, attachment, m, modelId, forceTool, true);
    },
    [isBusy, mode, imageModel, videoModel, musicModel, chatModel, imageSize, videoRatio, videoResolution, selectImageModel, selectVideoModel, runTurn],
  );

  const stop = useCallback(() => {
    if (pendingPermission) agent.emit("agent.permissionResponse", { askId: pendingPermission.askId, decision: "n" });
    cancelRef.current?.();
    cancelRef.current = null;
    setStatus("idle");
    setGenConvId(null);
    setPendingPermission(null);
  }, [pendingPermission]);

  const respondToPermission = useCallback((decision: "y" | "n") => {
    if (!pendingPermission) return;
    agent.emit("agent.permissionResponse", { askId: pendingPermission.askId, decision });
    setPendingPermission(null);
  }, [pendingPermission]);

  const stopMedia = useCallback(
    (convId: string) => {
      if (pendingPermission) agent.emit("agent.permissionResponse", { askId: pendingPermission.askId, decision: "n" });
      cancelRef.current?.();
      cancelRef.current = null;
      clearMediaJob(convId);
      setStatus("idle");
      setGenConvId(null);
      setPendingPermission(null);
    },
    [clearMediaJob, pendingPermission],
  );

  const regenerate = useCallback(() => {
    const l = lastTurnRef.current;
    if (!l || isBusy) return;
    // Drop the trailing assistant message, then re-run the same user turn
    // without appending a duplicate user bubble.
    setMessages((prev) => {
      const next = [...prev];
      if (next.length && next[next.length - 1].role === "assistant") next.pop();
      return next;
    });
    runTurn(l.text, l.attachment, l.mode, l.model, l.forceTool, false, l.displayText);
  }, [isBusy, runTurn, setMessages]);

  return {
    isConnected,
    mode,
    setMode,
    model,
    setModel,
    models,
    selectedModel,
    status,
    activeTool,
    needsToolWallet,
    genConvId,
    mediaJobs,
    error,
    pendingPermission,
    respondToPermission,
    isBusy,
    send,
    stop,
    stopMedia,
    regenerate,
    imageSize,
    setImageSize,
    imageSizes,
    videoRatio,
    setVideoRatio,
    videoRatios,
    videoResolution,
    setVideoResolution,
    videoResolutions,
  };
}
