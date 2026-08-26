import {
  ArrowRight,
  BookOpen,
  Cloud,
  FolderKanban,
  LockKeyhole,
  MessageSquareText,
  ShieldCheck,
  UsersRound,
  Workflow,
} from "lucide-react";
import { useTryLang } from "../lib/i18n";

const COPY = {
  en: {
    eyebrow: "Team workspace",
    title: "One Franklin, shared with your team.",
    body: "A shared place for conversations, files, knowledge, and repeatable agent workflows. The cloud workspace is still being prepared.",
    preview: "Product preview",
    localOnly: "Nothing is uploaded in this beta",
    agent: "Team Agent",
    agentBody: "A group conversation where teammates and Franklin work from the same context.",
    composer: "Team conversations are coming soon",
    personal: "Continue in Personal",
    sharedChats: "Shared conversations",
    sharedChatsBody: "Discuss, assign, and continue agent work together.",
    files: "Shared files",
    filesBody: "A permission-aware cloud workspace for team artifacts.",
    knowledge: "Team knowledge",
    knowledgeBody: "Reusable project context that Franklin can reference.",
    workflows: "Team workflows",
    workflowsBody: "Save and run repeatable agent processes with your team.",
    comingSoon: "Coming soon",
  },
  zh: {
    eyebrow: "团队工作区",
    title: "一个 Franklin，和整个团队一起使用。",
    body: "共享对话、文件、知识和可复用 Agent 工作流。云端团队空间仍在准备中。",
    preview: "产品预览",
    localOnly: "当前 Beta 不会上传任何内容",
    agent: "Team Agent",
    agentBody: "团队成员与 Franklin 在同一上下文中协作的群聊。",
    composer: "团队对话即将开放",
    personal: "继续使用个人模式",
    sharedChats: "共享对话",
    sharedChatsBody: "共同讨论、分配并继续 Agent 任务。",
    files: "共享文件",
    filesBody: "带权限管理的团队云端文件空间。",
    knowledge: "团队知识",
    knowledgeBody: "让 Franklin 可复用的项目背景和知识。",
    workflows: "团队工作流",
    workflowsBody: "保存并与团队运行可复用的 Agent 流程。",
    comingSoon: "即将开放",
  },
  es: {
    eyebrow: "Espacio de equipo",
    title: "Un Franklin, compartido con todo tu equipo.",
    body: "Conversaciones, archivos, conocimiento y flujos de agentes compartidos. El espacio en la nube sigue en preparación.",
    preview: "Vista previa",
    localOnly: "Nada se sube durante esta beta",
    agent: "Agente del equipo",
    agentBody: "Una conversación grupal donde el equipo y Franklin comparten el mismo contexto.",
    composer: "Las conversaciones de equipo llegarán pronto",
    personal: "Continuar en Personal",
    sharedChats: "Conversaciones compartidas",
    sharedChatsBody: "Comenta, asigna y continúa el trabajo del agente en equipo.",
    files: "Archivos compartidos",
    filesBody: "Un espacio en la nube con permisos para los archivos del equipo.",
    knowledge: "Conocimiento del equipo",
    knowledgeBody: "Contexto reutilizable que Franklin puede consultar.",
    workflows: "Flujos de equipo",
    workflowsBody: "Guarda y ejecuta procesos de agentes con tu equipo.",
    comingSoon: "Próximamente",
  },
} as const;

export function TeamPanel({ onPersonal }: { onPersonal: () => void }) {
  const { lang } = useTryLang();
  const c = COPY[lang] ?? COPY.en;
  const features = [
    { icon: <MessageSquareText />, title: c.sharedChats, body: c.sharedChatsBody },
    { icon: <FolderKanban />, title: c.files, body: c.filesBody },
    { icon: <BookOpen />, title: c.knowledge, body: c.knowledgeBody },
    { icon: <Workflow />, title: c.workflows, body: c.workflowsBody },
  ];

  return (
    <main className="try-team-panel">
      <div className="try-team-inner">
        <div className="try-team-hero">
          <div className="try-team-eyebrow">
            <UsersRound className="h-4 w-4" />
            {c.eyebrow}
            <span className="try-team-beta">Beta</span>
          </div>
          <h1>{c.title}</h1>
          <p>{c.body}</p>
          <div className="try-team-trust">
            <ShieldCheck className="h-4 w-4" />
            <span>{c.preview}</span>
            <span className="try-team-trust-dot" />
            <LockKeyhole className="h-4 w-4" />
            <span>{c.localOnly}</span>
          </div>
        </div>

        <section className="try-team-agent-preview">
          <div className="try-team-agent-head">
            <div className="try-team-avatar-stack" aria-hidden="true">
              <span>F</span><span>A</span><span>M</span>
            </div>
            <div>
              <h2>{c.agent}</h2>
              <p>{c.agentBody}</p>
            </div>
            <span className="try-team-soon"><Cloud className="h-3.5 w-3.5" />{c.comingSoon}</span>
          </div>
          <div className="try-team-composer" aria-disabled="true">
            <MessageSquareText className="h-4 w-4" />
            <span>{c.composer}</span>
            <button disabled aria-label={c.comingSoon}><ArrowRight className="h-4 w-4" /></button>
          </div>
        </section>

        <section className="try-team-feature-grid">
          {features.map((feature) => (
            <article key={feature.title} className="try-team-feature">
              <div className="try-team-feature-icon">{feature.icon}</div>
              <div>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </div>
              <span>{c.comingSoon}</span>
            </article>
          ))}
        </section>

        <button className="try-team-personal" onClick={onPersonal}>
          {c.personal}<ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </main>
  );
}
