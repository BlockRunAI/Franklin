import { PenLine, Languages, Code2, Search, TrendingUp, BarChart3 } from "lucide-react";
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
  const { t } = useTryLang();
  return (
    <div className="try-tools-panel">
      <div className="try-tools-inner">
        <h2 className="try-tools-h">{t.skillsTitle}</h2>
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
