"use client";

import { Fragment, useState } from "react";
import { Copy, Check, Maximize2, X, Download } from "lucide-react";

// Lightweight Markdown renderer for assistant replies (no external deps):
// splits fenced ``` code blocks out, renders the rest with minimal inline
// markdown (headings, lists, bold, inline code). Code blocks get a header
// with copy + expand (fullscreen) controls.

interface Segment {
  type: "code" | "text";
  text: string;
  lang?: string;
}

function parse(md: string): Segment[] {
  const segs: Segment[] = [];
  const re = /```([\w+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    if (m.index > last) segs.push({ type: "text", text: md.slice(last, m.index) });
    segs.push({ type: "code", lang: m[1] || "", text: m[2].replace(/\n$/, "") });
    last = re.lastIndex;
  }
  if (last < md.length) segs.push({ type: "text", text: md.slice(last) });
  return segs;
}

// Inline markdown for one line: **bold**, `code`, [links](url), and bare URLs.
function renderInline(line: string, key: string) {
  const nodes: React.ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(line))) {
    if (m.index > last) nodes.push(line.slice(last, m.index));
    if (m[2] !== undefined) {
      nodes.push(<strong key={`${key}-b${i}`}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      nodes.push(<code key={`${key}-c${i}`} className="try-inline-code">{m[3]}</code>);
    } else if (m[4] !== undefined && m[5] !== undefined) {
      nodes.push(
        <a key={`${key}-l${i}`} className="try-md-link" href={m[5]} target="_blank" rel="noreferrer">
          {m[4]}
        </a>,
      );
    } else if (m[6] !== undefined) {
      nodes.push(
        <a key={`${key}-u${i}`} className="try-md-link" href={m[6]} target="_blank" rel="noreferrer">
          {m[6].replace(/^https?:\/\//, "")}
        </a>,
      );
    }
    last = re.lastIndex;
    i++;
  }
  if (last < line.length) nodes.push(line.slice(last));
  return nodes;
}

// Split a `| a | b | c |` row into trimmed cell strings.
// Leading/trailing pipes are optional in GFM — strip both.
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

// Try to parse a GFM-style table starting at `lines[idx]`. Requires a header
// row + a `|---|---|` separator row immediately after. Body rows continue
// until a non-pipe line. Returns null if it's not a table.
function parseTableAt(
  lines: string[],
  idx: number,
): { headers: string[]; rows: string[][]; aligns: ("left" | "right" | "center" | null)[]; advance: number } | null {
  const header = (lines[idx] ?? "").trim();
  const sep = (lines[idx + 1] ?? "").trim();
  if (!header.includes("|") || !sep.includes("|")) return null;
  // Separator cells: optional leading/trailing colon for alignment, dashes in
  // between. Must match every cell.
  const sepCells = splitTableRow(sep);
  if (sepCells.length < 1 || !sepCells.every((c) => /^:?-{2,}:?$/.test(c))) return null;
  const headers = splitTableRow(header);
  if (headers.length !== sepCells.length) return null;
  const aligns = sepCells.map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    if (l && r) return "center" as const;
    if (r) return "right" as const;
    if (l) return "left" as const;
    return null;
  });
  const rows: string[][] = [];
  let i = idx + 2;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t.includes("|")) break;
    const cells = splitTableRow(t);
    // Normalize: pad/truncate to header width so the grid stays consistent.
    while (cells.length < headers.length) cells.push("");
    rows.push(cells.slice(0, headers.length));
    i++;
  }
  return { headers, rows, aligns, advance: i - idx };
}

// Re-serialize a parsed table to GFM markdown — for the Copy button. Round-
// trips back to what the model emitted so the user can paste it into Notion,
// Slack, a README, etc.
function tableToMarkdown(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return `${head}\n${sep}${body ? `\n${body}` : ""}`;
}

// Serialize as CSV for the Download button — properly quoting cells that
// contain commas, double-quotes, or newlines (RFC 4180).
function tableToCsv(headers: string[], rows: string[][]): string {
  const esc = (cell: string) =>
    /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  return [headers, ...rows].map((r) => r.map(esc).join(",")).join("\n");
}

function TableBlock({
  headers,
  rows,
  aligns,
  k,
}: {
  headers: string[];
  rows: string[][];
  aligns: ("left" | "right" | "center" | null)[];
  k: string;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const copy = () => {
    navigator.clipboard?.writeText(tableToMarkdown(headers, rows)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const download = () => {
    const csv = tableToCsv(headers, rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `table-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const block = (
    <div className={`try-md-table-card${expanded ? " is-expanded" : ""}`}>
      <div className="try-md-table-head">
        <span className="try-md-table-label">Table</span>
        <div className="try-md-table-actions">
          <button onClick={copy} aria-label="Copy table as markdown" title="Copy as Markdown">
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <button onClick={download} aria-label="Download as CSV" title="Download CSV">
            <Download className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => setExpanded((e) => !e)} aria-label={expanded ? "Close" : "Expand table"} title={expanded ? "Close" : "Expand"}>
            {expanded ? <X className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      <div className="try-md-table-wrap">
        <table className="try-md-table">
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i} style={aligns[i] ? { textAlign: aligns[i] as "left" | "right" | "center" } : undefined}>
                  {renderInline(h, `${k}-th${i}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci} style={aligns[ci] ? { textAlign: aligns[ci] as "left" | "right" | "center" } : undefined}>
                    {renderInline(c, `${k}-r${ri}c${ci}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  if (expanded) {
    return (
      <div className="try-code-overlay" onClick={() => setExpanded(false)}>
        <div onClick={(e) => e.stopPropagation()} style={{ width: "min(1100px, 94vw)" }}>
          {block}
        </div>
      </div>
    );
  }
  return block;
}

function TextBlock({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let list: React.ReactNode[] = [];
  const flushList = (k: string) => {
    if (list.length) {
      out.push(<ul key={`ul-${k}`} className="try-md-ul">{list}</ul>);
      list = [];
    }
  };
  let idx = 0;
  while (idx < lines.length) {
    const raw = lines[idx];
    // Table — header + separator + body rows. Detect before list/heading so
    // a pipe-prefixed line doesn't get mis-rendered as a paragraph.
    const tbl = parseTableAt(lines, idx);
    if (tbl) {
      flushList(`tbl-${idx}`);
      out.push(<TableBlock key={`tbl-${idx}`} k={`tbl-${idx}`} headers={tbl.headers} rows={tbl.rows} aligns={tbl.aligns} />);
      idx += tbl.advance;
      continue;
    }
    const line = raw.trimEnd();
    // Thematic break — a line of 3+ of -, * or _ renders as a divider (<hr>),
    // not literal dashes. (Table separators are already consumed above.)
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushList(`hr-${idx}`);
      out.push(<hr key={`hr-${idx}`} className="try-md-hr" />);
      idx++;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      list.push(<li key={`li-${idx}`}>{renderInline(li[1], `li-${idx}`)}</li>);
      idx++;
      continue;
    }
    flushList(String(idx));
    if (h) {
      const lvl = h[1].length;
      out.push(
        <p key={`h-${idx}`} className={`try-md-h try-md-h${lvl}`}>
          {renderInline(h[2], `h-${idx}`)}
        </p>,
      );
    } else if (line === "") {
      out.push(<div key={`sp-${idx}`} className="try-md-gap" />);
    } else {
      out.push(<p key={`p-${idx}`} className="try-md-p">{renderInline(line, `p-${idx}`)}</p>);
    }
    idx++;
  }
  flushList("end");
  return <>{out}</>;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const block = (
    <div className={`try-code${expanded ? " is-expanded" : ""}`}>
      <div className="try-code-head">
        <span className="try-code-lang">{lang || "code"}</span>
        <div className="try-code-actions">
          <button onClick={copy} aria-label="Copy code">
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button onClick={() => setExpanded((e) => !e)} aria-label="Expand code">
            {expanded ? <X className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      <pre className="try-code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );

  if (expanded) {
    return (
      <div className="try-code-overlay" onClick={() => setExpanded(false)}>
        <div onClick={(e) => e.stopPropagation()} style={{ width: "min(900px, 92vw)" }}>
          {block}
        </div>
      </div>
    );
  }
  return block;
}

export function MessageContent({ content }: { content: string }) {
  const segs = parse(content);
  return (
    <div className="try-md">
      {segs.map((s, i) =>
        s.type === "code" ? (
          <CodeBlock key={i} lang={s.lang || ""} code={s.text} />
        ) : (
          <Fragment key={i}>
            <TextBlock text={s.text} />
          </Fragment>
        ),
      )}
    </div>
  );
}
