import { useRef, useState } from "react";
import { useAgentSkills } from "../hooks/use-agent-skills";
import { Plus, RefreshCw, PenLine, Languages, Code2, Search, TrendingUp, BarChart3 } from "lucide-react";
import { useTryLang } from "../lib/i18n";

const TOOL_MODEL = "google/gemini-2.5-flash";

interface Skill {
  icon: React.ReactNode;
  name: string;
  desc: string;
  template: string;
  model?: string; // tool-capable model for skills that need live tools
}

const SKILLS: Skill[] = [
  { icon: <PenLine />, name: "Write", desc: "Draft posts, emails, copy.", template: "Help me write " },
  { icon: <Languages />, name: "Translate", desc: "Translate text to any language.", template: "Translate the following into English:\n\n" },
  { icon: <Code2 />, name: "Code", desc: "Write or explain code.", template: "Write code that " },
  { icon: <Search />, name: "Research", desc: "Look up current info on the web.", template: "Research and summarize: ", model: TOOL_MODEL },
  { icon: <TrendingUp />, name: "Trading signal", desc: "Live prices + a read.", template: "Give me a trading read on ", model: TOOL_MODEL },
  { icon: <BarChart3 />, name: "Prediction odds", desc: "Live prediction-market odds.", template: "What are the prediction-market odds for ", model: TOOL_MODEL },
];

export function SkillsPanel({ onPick }: { onPick: (template: string, model?: string) => void }) {
  const { lang, t } = useTryLang();
  const zh = lang === "zh";
  const { skills, loading, error, refresh, upload, toggle, remove } = useAgentSkills();
  const [adding, setAdding] = useState(false);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [fileError, setFileError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const readGeneration = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setNotice("");
    try { await action(); } finally { setBusy(false); }
  };
  const add = () => perform(async () => {
    const result = await upload(content);
    if (result) {
      setNotice(zh ? `已添加 /${result.name}，下一条消息即可使用。` : `Added /${result.name}. Available on your next message.`);
      readGeneration.current++; setAdding(false); setContent("");
    }
  });
  return (
    <div className="try-tools-panel">
      <div className="try-tools-inner">
        <div className="skill-panel-heading">
          <h2 className="try-tools-h">{t.skillsTitle}</h2>
          <div className="skill-actions">
            <button className="skill-button" onClick={() => void refresh()} disabled={loading || busy}><RefreshCw size={15} />{zh ? "刷新" : "Refresh skills"}</button>
            <button className="skill-button is-primary" disabled={busy} onClick={() => { readGeneration.current++; setAdding(true); setNotice(""); }}><Plus size={16} />{zh ? "添加 Skill" : "Add skill"}</button>
          </div>
        </div>
        <p className="try-tools-sub">{zh ? "导入 SKILL.md，在对话中用 /名称 调用。API 说明与 curl 示例均可导入。" : "Import a SKILL.md, then use /name in chat. API instructions and curl examples are supported."}</p>
        {(error || fileError) && <p role="alert" className="skill-error">{fileError || error}</p>}
        {notice && <p role="status" className="skill-notice">{notice}</p>}
        {adding && <section className="skill-import" aria-label={zh ? "导入 Skill" : "Import skill"}>
          <label htmlFor="skill-content">{zh ? "粘贴完整 SKILL.md，或选择文件" : "Paste the complete SKILL.md or choose a file"}</label>
          <textarea id="skill-content" value={content} onChange={(e) => { readGeneration.current++; setContent(e.target.value); setFileError(""); }} spellCheck={false} placeholder={"---\nname: my-skill\ndescription: What this skill does\n---\nInstructions…"} />
          <input ref={fileRef} type="file" accept=".md,.markdown,text/markdown" aria-label="SKILL.md file" hidden onChange={(e) => {
            const read = ++readGeneration.current;
            const file = e.target.files?.[0]; e.target.value = "";
            if (!file) return;
            if (file.size > 256 * 1024) { setFileError(zh ? "文件上限为 256 KiB。" : "File exceeds the 256 KiB limit."); return; }
            void file.text().then((text) => { if (read === readGeneration.current) { setContent(text); setFileError(""); } }).catch(() => { if (read === readGeneration.current) setFileError(zh ? "读取文件失败。" : "Couldn't read the file."); });
          }} />
          <p className="try-tool-card-desc">{zh ? "仅保存说明，不执行安装或调用 API。附带脚本需另行提供；运行时仍需可用工具、凭据及相应权限。" : "Saves instructions only. No install commands or API calls run on import. Supporting files, tools, credentials and execution permissions are still required when used."}</p>
          <div className="skill-actions">
            <button className="skill-button" onClick={() => fileRef.current?.click()} disabled={busy}>{zh ? "选择 SKILL.md" : "Choose SKILL.md"}</button>
            <button className="skill-button" onClick={() => { readGeneration.current++; setAdding(false); }} disabled={busy}>{zh ? "取消" : "Cancel"}</button>
            <button className="skill-button is-primary" onClick={() => void add()} disabled={busy || !content.trim()}>{busy ? (zh ? "导入中…" : "Importing…") : (zh ? "导入" : "Import skill")}</button>
          </div>
        </section>}
        <h3 className="skill-section-title">{zh ? "已安装 Skills" : "Installed skills"}</h3>
        {loading && <p role="status">{zh ? "正在读取…" : "Loading skills…"}</p>}
        {!loading && !skills.length && !error && <p className="try-tool-card-desc">{zh ? "尚未安装 Skill。" : "No skills installed."}</p>}
        <div className="skill-installed-list">
          {skills.map((skill) => <article className="skill-installed" key={skill.name} data-skill={skill.name}>
            <div className="skill-panel-heading"><strong>/{skill.name}</strong><span className="skill-source">{skill.source}</span></div>
            <p className="try-tool-card-desc">{skill.description}</p>
            {skill.notes?.map((note) => <p key={note} className="skill-note">{note}</p>)}
            <div className="skill-actions">
              <button className="skill-button is-primary" disabled={!skill.enabled || busy} onClick={() => onPick(`/${skill.name} `)}>{zh ? "在对话中使用" : "Use in chat"}</button>
              <button className="skill-button" role="switch" aria-checked={skill.enabled} aria-label={`${zh ? "启用" : "Enable"} /${skill.name}`} disabled={busy} onClick={() => void perform(() => toggle(skill.name, !skill.enabled))}>{skill.enabled ? (zh ? "已启用" : "Enabled") : (zh ? "已停用" : "Disabled")}</button>
              {skill.removable && (confirmRemove === skill.name ? <>
                <button className="skill-button" disabled={busy} onClick={() => void perform(async () => { await remove(skill.name); setConfirmRemove(null); })}>{zh ? "确认移除" : "Confirm remove"}</button>
                <button className="skill-button" disabled={busy} onClick={() => setConfirmRemove(null)}>{zh ? "取消" : "Cancel"}</button>
              </> : <button className="skill-button" disabled={busy} onClick={() => setConfirmRemove(skill.name)}>{zh ? "移除" : "Remove"}</button>)}
            </div>
          </article>)}
        </div>
        <h3 className="skill-section-title">{zh ? "快捷提示词" : "Prompt starters"}</h3>
        <p className="try-tools-sub">{t.skillsSub}</p>
        <div className="try-tools-grid">
          {SKILLS.map((s) => (
            <button key={s.name} className="try-tool-card try-skill-card" onClick={() => onPick(s.template, s.model)}>
              <span className="try-tool-card-icon">{s.icon}</span>
              <div className="try-tool-card-body">
                <div className="try-tool-card-name">{s.name}</div>
                <p className="try-tool-card-desc">{s.desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
