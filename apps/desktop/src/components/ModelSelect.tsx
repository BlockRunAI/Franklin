import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import type { ChatModel } from "../hooks/use-franklin-chat";

// Group consecutive models by their `group` label, preserving order.
function groupModels(models: ChatModel[]): { name?: string; items: ChatModel[] }[] {
  const groups: { name?: string; items: ChatModel[] }[] = [];
  for (const m of models) {
    const last = groups[groups.length - 1];
    if (!last || last.name !== m.group) groups.push({ name: m.group, items: [m] });
    else last.items.push(m);
  }
  return groups;
}

interface Props {
  models: ChatModel[];
  model: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

// Custom model dropdown — replaces the native <select> with a styled popover
// that matches the warm-minimal + gold look.
export function ModelSelect({ models, model, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = models.find((m) => m.id === model);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="try-select" ref={ref}>
      <button
        type="button"
        className="try-select-btn"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="try-select-current">{selected?.label}</span>
        <ChevronDown className={`try-select-chev${open ? " is-open" : ""}`} />
      </button>

      {open && (
        <ul className="try-select-menu" role="listbox">
          {groupModels(models).map((g, gi) => (
            <li key={g.name ?? gi} role="presentation">
              {g.name && <div className="try-select-group">{g.name}</div>}
              {g.items.map((m) => {
                const active = m.id === model;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`try-select-option${active ? " is-active" : ""}`}
                    onClick={() => {
                      onChange(m.id);
                      setOpen(false);
                    }}
                  >
                    <span className="try-select-option-label">{m.label}</span>
                    {m.contextWindow ? <span className="try-select-ctx">{Math.round(m.contextWindow / 1000)}K</span> : null}
                    {m.free && <span className="try-badge-free">Free</span>}
                    {active && <Check className="try-select-check" />}
                  </button>
                );
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
