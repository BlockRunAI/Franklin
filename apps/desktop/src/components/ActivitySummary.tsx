import { useState } from "react";
import { ChevronDown, Search, Globe } from "lucide-react";
import type { ChatActivity } from "../hooks/use-franklin-chat";
import { useTryLang } from "../lib/i18n";

// Collapsed recap of a finished tool run — "searched N keywords · M sources",
// expandable to show the queries and the pages Franklin referenced.
export function ActivitySummary({ activity }: { activity: ChatActivity }) {
  const { t } = useTryLang();
  const [open, setOpen] = useState(false);

  const nq = activity.queries.length;
  const ns = activity.sources.length;
  const headline =
    nq > 0 || ns > 0
      ? t.activitySearched(nq, ns)
      : t.activityUsed(activity.tools.length);

  return (
    <div className={`try-activity${open ? " is-open" : ""}`}>
      <button className="try-activity-head" onClick={() => setOpen((o) => !o)}>
        <Search className="h-3.5 w-3.5" />
        <span className="try-activity-headline">{headline}</span>
        <ChevronDown className="try-activity-chevron h-4 w-4" />
      </button>
      {open && (
        <div className="try-activity-body">
          {activity.queries.length > 0 && (
            <div className="try-activity-queries">
              {activity.queries.map((q) => (
                <span key={q} className="try-activity-query">{q}</span>
              ))}
            </div>
          )}
          {activity.sources.length > 0 && (
            <div className="try-activity-sources">
              {activity.sources.map((s) => (
                <a key={s.url} className="try-activity-source" href={s.url} target="_blank" rel="noreferrer">
                  <Globe className="h-3.5 w-3.5" />
                  <span className="try-activity-source-title">{s.title}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
