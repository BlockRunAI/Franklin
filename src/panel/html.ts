/**
 * Franklin Panel — embedded HTML dashboard.
 * Single page, dark theme, zero dependencies.
 * Design language adapted from Multica (oklch palette, sidebar nav).
 * Currency-grade watermark + Inter font.
 */

export function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Franklin Panel</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg width='100' height='100' viewBox='0 0 100 100' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Crect x='30' y='20' width='55' height='60' rx='14' stroke='white' stroke-width='8' fill='none'/%3E%3Cpath d='M15 35 L25 35' stroke='white' stroke-width='6' stroke-linecap='round'/%3E%3Cpath d='M10 50 L25 50' stroke='white' stroke-width='6' stroke-linecap='round'/%3E%3Cpath d='M15 65 L25 65' stroke='white' stroke-width='6' stroke-linecap='round'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root {
  --bg: oklch(0.13 0.006 286);
  --bg-card: oklch(0.19 0.006 286);
  --bg-card-hover: oklch(0.23 0.006 286);
  --bg-sidebar: oklch(0.16 0.005 286);
  --border: oklch(1 0 0 / 8%);
  --border-strong: oklch(1 0 0 / 14%);
  --text: oklch(0.96 0 0);
  --text-dim: oklch(0.50 0.012 286);
  --text-muted: oklch(0.68 0.012 286);
  --brand: oklch(0.68 0.16 260);
  --success: oklch(0.72 0.17 150);
  --warning: oklch(0.78 0.14 85);
  --danger: oklch(0.65 0.20 25);
  --gold: oklch(0.85 0.13 85);
  --gold-dim: oklch(0.45 0.08 85);
  --mono: 'JetBrains Mono','SF Mono','Fira Code','Menlo',monospace;
  --sans: 'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --radius: 10px;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { background:var(--bg); color:var(--text); font-family:var(--sans); font-size:14px; display:flex; height:100vh; overflow:hidden; -webkit-font-smoothing:antialiased; }
a { color:var(--brand); text-decoration:none; }
a:hover { text-decoration:underline; }
::-webkit-scrollbar { width:5px; }
::-webkit-scrollbar-track { background:transparent; }
::-webkit-scrollbar-thumb { background:oklch(1 0 0 / 6%); border-radius:3px; }
::-webkit-scrollbar-thumb:hover { background:oklch(1 0 0 / 14%); }

/* ── Sidebar ── */
.sidebar {
  width:230px; min-width:230px; background:var(--bg-sidebar);
  border-right:1px solid var(--border); display:flex; flex-direction:column;
  padding:20px 0; overflow-y:auto;
}
.sidebar-header { padding:0 20px 24px; }
.sidebar-brand { display:flex; align-items:center; gap:10px; margin-bottom:2px; }
.sidebar-brand .icon {
  width:32px; height:32px; border-radius:50%; overflow:hidden;
  border:1px solid oklch(0.85 0.13 85 / 30%); flex-shrink:0;
}
.sidebar-brand .icon img { width:100%; height:100%; object-fit:cover; object-position:top; }
.sidebar-brand h1 { font-size:16px; font-weight:700; letter-spacing:-0.02em; }
.sidebar-sub { font-size:10px; color:var(--text-dim); margin-left:38px; margin-top:-1px; letter-spacing:0.3px; }
.sidebar-status {
  display:flex; align-items:center; gap:6px; margin-left:38px; margin-top:8px;
  font-size:10px; color:var(--text-dim); font-family:var(--mono);
}
.dot { width:6px; height:6px; border-radius:50%; }
.dot.on { background:var(--success); box-shadow:0 0 8px oklch(0.72 0.17 150 / 60%); }
.dot.off { background:var(--danger); }

.sidebar-label {
  font-size:10px; font-weight:600; color:var(--text-dim);
  text-transform:uppercase; letter-spacing:0.8px;
  padding:20px 20px 8px; user-select:none;
}
.sidebar-nav { display:flex; flex-direction:column; gap:1px; padding:0 10px; }
.nav-item {
  display:flex; align-items:center; gap:10px;
  padding:9px 14px; border-radius:8px;
  cursor:pointer; color:var(--text-muted); font-size:13px; font-weight:500;
  border:none; background:none; width:100%; text-align:left;
  transition:all .15s ease;
}
.nav-item:hover { background:oklch(1 0 0 / 5%); color:var(--text); }
.nav-item.active { background:oklch(1 0 0 / 8%); color:var(--text); }
.nav-item svg { width:16px; height:16px; opacity:0.5; flex-shrink:0; }
.nav-item.active svg { opacity:0.9; }

.sidebar-footer {
  margin-top:auto; padding:16px 20px; border-top:1px solid var(--border);
}
.wallet-mini { font-family:var(--mono); font-size:11px; color:var(--text-dim); }
.wallet-mini .bal { color:var(--gold); font-weight:700; font-size:14px; display:block; margin-bottom:3px; }

/* ── Content ── */
.content { flex:1; overflow-y:auto; padding:32px 36px; position:relative; }
.content > * { position:relative; z-index:1; }

/* ── FRANKLIN watermark ── */
.watermark {
  position:fixed; top:0; right:0; bottom:0; width:calc(100% - 230px);
  pointer-events:none; z-index:0; overflow:hidden;
}
.watermark-text {
  position:absolute; top:50%; left:50%; white-space:nowrap;
  transform:translate(-50%, -50%) rotate(-25deg);
  font-family:var(--sans); font-size:160px; font-weight:900;
  letter-spacing:20px; text-transform:uppercase;
  color:oklch(1 0 0 / 3%);
  text-shadow:0 0 120px oklch(0.85 0.13 85 / 4%);
  user-select:none;
}
.watermark-line2 {
  position:absolute; top:calc(50% + 180px); left:50%; white-space:nowrap;
  transform:translate(-50%, -50%) rotate(-25deg);
  font-family:var(--mono); font-size:40px; font-weight:600;
  letter-spacing:16px; text-transform:uppercase;
  color:oklch(1 0 0 / 2%);
  user-select:none;
}
.watermark-guilloche {
  position:absolute; top:0; left:0; right:0; bottom:0;
  background:
    /* Top-right gold rosette */
    radial-gradient(ellipse 650px 650px at 88% 6%, oklch(0.85 0.13 85 / 5%) 0%, transparent 40%),
    radial-gradient(ellipse 550px 550px at 88% 6%, transparent 14%, oklch(0.85 0.13 85 / 4%) 14.8%, transparent 15.6%),
    radial-gradient(ellipse 550px 550px at 88% 6%, transparent 22%, oklch(0.85 0.13 85 / 3.5%) 22.8%, transparent 23.6%),
    radial-gradient(ellipse 550px 550px at 88% 6%, transparent 30%, oklch(0.85 0.13 85 / 3%) 30.8%, transparent 31.6%),
    radial-gradient(ellipse 550px 550px at 88% 6%, transparent 38%, oklch(0.85 0.13 85 / 2.5%) 38.8%, transparent 39.6%),
    /* Bottom-left green rosette */
    radial-gradient(ellipse 500px 500px at 12% 92%, oklch(0.72 0.17 150 / 4%) 0%, transparent 35%),
    radial-gradient(ellipse 400px 400px at 12% 92%, transparent 18%, oklch(0.72 0.17 150 / 3%) 18.8%, transparent 19.6%),
    radial-gradient(ellipse 400px 400px at 12% 92%, transparent 30%, oklch(0.72 0.17 150 / 2.5%) 30.8%, transparent 31.6%),
    /* Fine engraving lines */
    repeating-linear-gradient(35deg, oklch(1 0 0 / 1.5%) 0px, oklch(1 0 0 / 1.5%) 1px, transparent 1px, transparent 5px),
    repeating-linear-gradient(-55deg, oklch(1 0 0 / 1%) 0px, oklch(1 0 0 / 1%) 1px, transparent 1px, transparent 7px);
}

/* Franklin portrait — right side (same treatment as website hero) */
.watermark-portrait {
  position:absolute; inset:0 0 0 auto; width:55%;
  background:url(/assets/franklin-bill.jpg) top/cover no-repeat;
  opacity:0.5; filter:brightness(1.4);
}
.watermark-portrait-fade {
  position:absolute; inset:0 0 0 auto; width:55%;
  background:linear-gradient(to right, var(--bg), transparent);
}
.watermark-portrait-bottom {
  position:absolute; inset:auto 0 0 0; height:120px;
  background:linear-gradient(to top, var(--bg), transparent);
}

.content-header { margin-bottom:24px; }
.content-header h2 { font-size:22px; font-weight:700; letter-spacing:-0.03em; }
.content-header p { font-size:13px; color:var(--text-dim); margin-top:4px; font-weight:400; }

.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
.grid-4 { grid-template-columns:repeat(4,1fr); }
.card {
  background:oklch(0.19 0.006 286 / 80%); border:1px solid var(--border);
  border-radius:var(--radius); padding:20px;
  backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  transition:border-color .15s, background .15s;
}
.card:hover { border-color:var(--border-strong); }
.card h3 {
  font-size:10px; color:var(--text-dim); text-transform:uppercase;
  letter-spacing:0.8px; font-weight:600; margin-bottom:12px;
}
.metric { font-size:28px; font-weight:700; font-family:var(--mono); line-height:1.1; }
.metric.brand { color:var(--brand); }
.metric.success { color:var(--success); }
.metric.gold { color:var(--gold); }
.metric.warning { color:var(--warning); }
.sub { font-size:11px; color:var(--text-dim); margin-top:6px; font-weight:400; }

/* ── Savings Hero ── */
.savings-hero {
  background:linear-gradient(135deg, oklch(0.22 0.04 150 / 85%), oklch(0.19 0.006 286 / 80%) 70%);
  border:1px solid oklch(0.72 0.17 150 / 12%);
  border-radius:var(--radius); padding:28px; margin-bottom:12px;
  display:flex; align-items:center; gap:28px;
  box-shadow:0 4px 24px oklch(0 0 0 / 20%), inset 0 1px 0 oklch(1 0 0 / 4%);
  backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
}
.savings-amount { font-size:44px; font-weight:800; font-family:var(--mono); color:var(--success); line-height:1; }
.savings-detail { flex:1; }
.savings-detail .label { font-size:10px; text-transform:uppercase; letter-spacing:0.8px; color:var(--text-muted); font-weight:600; margin-bottom:6px; }
.savings-detail .breakdown { font-size:13px; color:var(--text-muted); margin-top:10px; line-height:1.7; }
.savings-detail .breakdown span { color:var(--text); font-family:var(--mono); font-weight:600; }
.savings-pct {
  font-size:56px; font-weight:900; font-family:var(--mono);
  color:oklch(0.72 0.17 150 / 20%); line-height:1;
}

/* ── Bar chart ── */
.bar-chart { display:flex; flex-direction:column; gap:8px; }
.bar-row { display:flex; align-items:center; gap:10px; font-size:12px; }
.bar-label {
  width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--text-muted); font-family:var(--mono); font-size:11px; font-weight:500;
}
.bar-track { flex:1; height:6px; background:oklch(1 0 0 / 4%); border-radius:3px; overflow:hidden; }
.bar-fill {
  height:100%; border-radius:3px; transition:width .5s ease;
  background:linear-gradient(90deg, var(--brand), oklch(0.75 0.14 260));
}
.bar-val { font-family:var(--mono); color:var(--text-dim); font-size:10px; min-width:80px; text-align:right; }

/* ── Daily chart ── */
.daily-chart { display:flex; align-items:flex-end; gap:3px; height:100px; padding-top:8px; }
.daily-bar {
  flex:1; border-radius:3px 3px 0 0; min-height:2px;
  transition:height .4s ease, opacity .15s; opacity:.4; position:relative; cursor:crosshair;
  background:linear-gradient(180deg, var(--brand), oklch(0.55 0.16 260));
}
.daily-bar:hover { opacity:1; }
.daily-bar:hover::after {
  content:attr(data-tip); position:absolute; bottom:calc(100% + 8px); left:50%;
  transform:translateX(-50%); background:oklch(0.22 0.006 286); color:var(--text);
  font-size:10px; font-family:var(--mono); padding:4px 8px; border-radius:5px;
  white-space:nowrap; pointer-events:none; border:1px solid var(--border-strong);
  box-shadow:0 4px 12px oklch(0 0 0 / 30%);
}

/* ── Sessions ── */
.session-list { display:flex; flex-direction:column; gap:6px; }
.session-item {
  background:oklch(0.19 0.006 286 / 75%); border:1px solid var(--border); border-radius:8px;
  padding:14px 18px; cursor:pointer; transition:all .15s ease;
  backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);
}
.session-item:hover { background:var(--bg-card-hover); border-color:var(--border-strong); transform:translateY(-1px); }
.session-item .title { font-size:13px; font-weight:500; }
.session-item .meta { font-size:10px; color:var(--text-dim); font-family:var(--mono); margin-top:5px; font-weight:400; }
.session-detail {
  background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius);
  padding:20px; margin-top:14px; max-height:60vh; overflow-y:auto;
}
.msg { margin-bottom:14px; }
.msg.user .role { color:var(--brand); }
.msg.assistant .role { color:var(--success); }
.msg .role { font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:0.8px; margin-bottom:4px; }
.msg pre { font-family:var(--mono); font-size:12px; white-space:pre-wrap; line-height:1.6; color:var(--text-muted); }

/* ── Learnings ── */
.learning-item {
  padding:12px 0; border-bottom:1px solid var(--border);
  display:flex; gap:12px; align-items:center;
}
.learning-item:last-child { border:none; }
.badge {
  font-size:9px; font-family:var(--mono); font-weight:700;
  padding:3px 8px; border-radius:5px; white-space:nowrap;
}
.badge.high { background:oklch(0.72 0.17 150 / 12%); color:var(--success); }
.badge.mid { background:oklch(0.78 0.14 85 / 12%); color:var(--warning); }
.badge.low { background:oklch(1 0 0 / 5%); color:var(--text-dim); }
.learning-text { flex:1; font-size:13px; color:var(--text-muted); line-height:1.5; }
.learning-count { font-size:10px; font-family:var(--mono); color:var(--text-dim); font-weight:500; }

/* ── Search ── */
.search-box {
  width:100%; padding:10px 14px; background:oklch(1 0 0 / 3%); border:1px solid var(--border);
  border-radius:8px; color:var(--text); font-size:13px; font-family:var(--sans);
  margin-bottom:16px; outline:none; transition:border-color .2s, box-shadow .2s;
}
.search-box::placeholder { color:var(--text-dim); }
.search-box:focus { border-color:var(--brand); box-shadow:0 0 0 3px oklch(0.68 0.16 260 / 12%); }

.tab { display:none; }
.tab.active { display:block; }
.empty { color:var(--text-dim); text-align:center; padding:56px 24px; font-size:13px; }

/* ── Tasks ── */
.tasks-toolbar { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
.tasks-table {
  display:flex; flex-direction:column; gap:4px;
}
.task-row {
  display:grid; grid-template-columns:140px 1fr 110px 90px 92px;
  gap:12px; align-items:center;
  background:oklch(0.19 0.006 286 / 75%); border:1px solid var(--border); border-radius:8px;
  padding:11px 14px; cursor:pointer; transition:all .15s ease;
  backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);
}
.task-row:hover { background:var(--bg-card-hover); border-color:var(--border-strong); }
.task-row .runid { font-family:var(--mono); font-size:11px; color:var(--text-muted); }
.task-row .label { font-size:13px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.task-row .age { font-family:var(--mono); font-size:11px; color:var(--text-dim); }
.task-row .actions { text-align:right; }
.task-row .cancel-err { grid-column:1 / -1; color:var(--danger); font-size:11px; font-family:var(--mono); padding-top:4px; }
.task-status {
  display:inline-block; font-size:9px; font-family:var(--mono); font-weight:700;
  padding:3px 8px; border-radius:5px; text-transform:uppercase; letter-spacing:0.6px;
}
.task-status.succeeded { background:oklch(0.72 0.17 150 / 14%); color:var(--success); }
.task-status.running   { background:oklch(0.68 0.16 260 / 16%); color:var(--brand); }
.task-status.queued    { background:oklch(1 0 0 / 6%); color:var(--text-dim); }
.task-status.failed,
.task-status.lost      { background:oklch(0.65 0.20 25 / 16%); color:var(--danger); }
.task-status.cancelled { background:oklch(0.78 0.14 85 / 14%); color:var(--warning); }
.task-status.timed_out { background:oklch(0.65 0.20 25 / 16%); color:var(--danger); }

.task-detail {
  background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius);
  padding:18px; margin-bottom:14px;
}
.task-detail h4 { font-size:11px; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.8px; font-weight:600; margin:14px 0 6px; }
.task-detail .top { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px; }
.task-detail .top .title { font-size:14px; font-weight:600; }
.task-detail-meta {
  display:grid; grid-template-columns:max-content 1fr; column-gap:14px; row-gap:4px;
  font-family:var(--mono); font-size:11.5px; color:var(--text-muted);
}
.task-detail-meta .k { color:var(--text-dim); }
.task-detail-meta .v { word-break:break-all; }
.task-events { display:flex; flex-direction:column; gap:4px; font-family:var(--mono); font-size:11.5px; }
.task-event { display:grid; grid-template-columns:90px 130px 1fr; gap:10px; padding:3px 0; color:var(--text-muted); border-bottom:1px solid var(--border); }
.task-event:last-child { border:none; }
.task-event .kind { font-weight:600; color:var(--text); }
.task-log-footer { font-size:11px; color:var(--warning); margin:8px 0 4px; font-family:var(--mono); }
.task-log {
  font-family:var(--mono); font-size:11.5px; color:var(--text-muted);
  background:oklch(0 0 0 / 35%); border:1px solid var(--border);
  border-radius:8px; padding:10px 12px; max-height:400px;
  overflow-y:auto; white-space:pre-wrap; word-break:break-all;
  line-height:1.5;
}
.task-detail-actions { display:flex; gap:8px; margin-top:14px; }

/* ── Wallet page ── */
.chain-switcher {
  display:inline-flex; padding:3px; gap:2px;
  background:oklch(0 0 0 / 35%); border:1px solid var(--border);
  border-radius:10px; margin-bottom:14px;
}
.chain-switcher button {
  font-family:var(--mono); font-size:12px; font-weight:600;
  letter-spacing:0.6px; text-transform:uppercase;
  padding:7px 18px; border-radius:7px;
  background:transparent; border:none; color:var(--text-muted);
  cursor:pointer; transition:all .15s ease;
}
.chain-switcher button:hover:not(.active):not(:disabled) {
  color:var(--text); background:oklch(1 0 0 / 5%);
}
.chain-switcher button.active {
  background:var(--brand); color:#fff;
}
.chain-switcher button:disabled { opacity:0.5; cursor:wait; }
.chain-switcher-note {
  margin-left:10px; font-size:12px; color:var(--text-dim);
  font-style:italic;
}
.wallet-grid { display:grid; grid-template-columns:1.1fr 1fr; gap:14px; }
.wallet-grid .card { display:flex; flex-direction:column; gap:10px; }
.wallet-receive { grid-row:span 2; align-items:flex-start; }
.wallet-address-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; width:100%; }
.wallet-chain-pill {
  font-size:10px; font-weight:700; letter-spacing:0.8px; text-transform:uppercase;
  padding:3px 8px; border-radius:6px; background:oklch(0.68 0.16 260 / 18%); color:var(--brand);
}
.wallet-address {
  font-family:var(--mono); font-size:12px; color:var(--text);
  background:oklch(0 0 0 / 35%); padding:8px 10px; border-radius:8px;
  border:1px solid var(--border); word-break:break-all; flex:1; min-width:0;
}
.wallet-balance-big { font-family:var(--mono); font-size:28px; font-weight:700; color:var(--gold); letter-spacing:-0.02em; }
.wallet-qr {
  background:#fff; padding:14px; border-radius:12px; display:inline-block;
  box-shadow:0 10px 40px oklch(0 0 0 / 35%); min-width:220px; min-height:220px;
}
.wallet-qr svg { display:block; width:200px; height:200px; }
.wallet-hint { font-size:12.5px; color:var(--text-muted); line-height:1.55; }
.wallet-hint code { font-family:var(--mono); font-size:11.5px; color:var(--text); background:oklch(0 0 0 / 30%); padding:1px 5px; border-radius:4px; }
.wallet-secret { position:relative; }
.wallet-secret .wallet-key-value {
  font-family:var(--mono); font-size:11.5px; color:var(--text);
  background:oklch(0 0 0 / 35%); padding:10px; border-radius:8px;
  border:1px solid var(--border-strong); word-break:break-all; display:block;
  user-select:all;
}
.wallet-secret-actions { display:flex; gap:8px; margin-top:8px; }
.wallet-import-input {
  width:100%; min-height:70px; background:oklch(0 0 0 / 35%); color:var(--text);
  border:1px solid var(--border); border-radius:8px; padding:10px;
  font-family:var(--mono); font-size:12px; resize:vertical;
}
.wallet-import-input:focus { border-color:var(--brand); outline:none; box-shadow:0 0 0 3px oklch(0.68 0.16 260 / 14%); }
.wallet-actions { display:flex; align-items:center; gap:10px; margin-top:4px; }
.wallet-import-status { font-size:12px; color:var(--text-muted); }
.wallet-import-status.ok { color:var(--success); }
.wallet-import-status.err { color:var(--danger); }
.wallet-steps { margin:6px 0 0 18px; color:var(--text-muted); font-size:12.5px; line-height:1.7; }
.wallet-steps em { color:var(--text); font-style:normal; font-weight:600; }

.btn {
  font-family:var(--sans); font-size:12px; font-weight:600;
  padding:7px 12px; border-radius:7px; border:1px solid var(--border);
  background:oklch(1 0 0 / 4%); color:var(--text); cursor:pointer;
  transition:background 0.15s, border-color 0.15s, transform 0.05s;
}
.btn:hover { background:oklch(1 0 0 / 10%); }
.btn:active { transform:translateY(1px); }
.btn-ghost { background:transparent; }
.btn-warn { background:oklch(0.78 0.14 85 / 18%); color:var(--gold); border-color:oklch(0.78 0.14 85 / 35%); }
.btn-warn:hover { background:oklch(0.78 0.14 85 / 30%); }
.btn-danger { background:oklch(0.65 0.20 25 / 18%); color:var(--danger); border-color:oklch(0.65 0.20 25 / 35%); }
.btn-danger:hover { background:oklch(0.65 0.20 25 / 30%); }

@media (max-width:768px) {
  body { flex-direction:column; }
  .sidebar { width:100%; min-width:100%; flex-direction:row; padding:8px; overflow-x:auto; border-right:none; border-bottom:1px solid var(--border); }
  .sidebar-header, .sidebar-label, .sidebar-footer { display:none; }
  .sidebar-nav { flex-direction:row; gap:4px; padding:0; }
  .content { padding:16px; }
  .grid-4 { grid-template-columns:repeat(2,1fr); }
  .wallet-grid { grid-template-columns:1fr; }
  .wallet-receive { grid-row:auto; }
  .savings-hero { flex-direction:column; gap:12px; text-align:center; }
  .savings-pct { display:none; }
  .watermark { width:100%; }
}
</style>
</head>
<body>

<!-- Sidebar -->
<aside class="sidebar">
  <div class="sidebar-header">
    <div class="sidebar-brand">
      <div class="icon"><img src="/assets/franklin-portrait.jpg" alt="F"></div>
      <h1>Franklin</h1>
    </div>
    <div class="sidebar-sub">by <span style="color:var(--success)">BlockRun.ai</span></div>
    <div class="sidebar-status">
      <span class="dot off" id="dot"></span>
      <span id="status">connecting</span>
    </div>
  </div>

  <div class="sidebar-label">Dashboard</div>
  <div class="sidebar-nav">
    <button class="nav-item active" data-tab="overview">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
      Overview
    </button>
    <button class="nav-item" data-tab="wallet">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></svg>
      Wallet
    </button>
    <button class="nav-item" data-tab="markets">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
      Markets
    </button>
    <button class="nav-item" data-tab="sessions">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      Sessions
    </button>
    <button class="nav-item" data-tab="tasks">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
      Tasks
    </button>
    <button class="nav-item" data-tab="learnings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
      Learnings
    </button>
    <button class="nav-item" data-tab="audit">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M11 8v3l2 1"/></svg>
      Audit Log
    </button>
  </div>

  <div class="sidebar-footer">
    <a href="https://franklin.run" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:8px;padding:8px 0 12px;color:var(--text-dim);font-size:12px;text-decoration:none;transition:color 0.15s;">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      franklin.run
    </a>
    <div class="wallet-mini">
      <span class="bal" id="sidebar-balance">&mdash;</span>
      <span id="sidebar-addr">Loading wallet...</span>
    </div>
  </div>
</aside>

<!-- Watermark layer -->
<div class="watermark" aria-hidden="true">
  <div class="watermark-guilloche"></div>
  <div class="watermark-text">FRANKLIN</div>
  <div class="watermark-line2">THE AI AGENT WITH A WALLET</div>
  <div class="watermark-portrait"></div>
  <div class="watermark-portrait-fade"></div>
  <div class="watermark-portrait-bottom"></div>
</div>

<!-- Content -->
<div class="content">
  <!-- Overview -->
  <div class="tab active" id="tab-overview">
    <div class="content-header">
      <h2>Overview</h2>
      <p>Usage stats and cost breakdown</p>
    </div>

    <div class="savings-hero" id="savings-hero" style="display:none">
      <div>
        <div class="savings-detail">
          <div class="label">Saved vs Opus tier</div>
        </div>
        <div class="savings-amount" id="savings-amount">&mdash;</div>
        <div class="savings-detail">
          <div class="breakdown">
            You spent <span id="savings-actual">&mdash;</span> instead of <span id="savings-opus">&mdash;</span>
          </div>
        </div>
      </div>
      <div class="savings-pct" id="savings-pct">&mdash;</div>
    </div>

    <div class="grid grid-4">
      <div class="card">
        <h3>Balance</h3>
        <div class="metric gold" id="balance">&mdash;</div>
        <div class="sub" id="wallet-chain">&mdash;</div>
      </div>
      <div class="card">
        <h3>Total Spent</h3>
        <div class="metric brand" id="total-cost">&mdash;</div>
        <div class="sub" id="total-requests">&mdash;</div>
      </div>
      <div class="card">
        <h3>Requests</h3>
        <div class="metric" id="request-count">&mdash;</div>
        <div class="sub" id="avg-cost">&mdash;</div>
      </div>
      <div class="card">
        <h3>Models Used</h3>
        <div class="metric" id="model-count">&mdash;</div>
        <div class="sub" id="period-info">&mdash;</div>
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <h3>Daily Spend (30 days)</h3>
      <div class="daily-chart" id="daily-chart"></div>
    </div>
    <div class="card" style="margin-top:12px">
      <h3>Cost by Model</h3>
      <div class="bar-chart" id="model-chart"></div>
    </div>
  </div>

  <!-- Wallet -->
  <div class="tab" id="tab-wallet">
    <div class="content-header">
      <h2>Wallet</h2>
      <p>Receive USDC, back up your key, or switch chains</p>
    </div>

    <div class="chain-switcher" role="tablist" aria-label="Payment chain">
      <button type="button" data-chain="base" id="chain-btn-base" role="tab">Base</button>
      <button type="button" data-chain="solana" id="chain-btn-solana" role="tab">Solana</button>
    </div>
    <span class="chain-switcher-note" id="chain-switcher-note"></span>

    <div class="wallet-grid">
      <div class="card wallet-receive">
        <h3>Receive USDC</h3>
        <div class="wallet-address-row">
          <span class="wallet-chain-pill" id="wallet-chain-pill">—</span>
          <code class="wallet-address" id="wallet-address-full">—</code>
          <button class="btn btn-ghost" id="wallet-copy-btn" title="Copy address">Copy</button>
        </div>
        <div class="wallet-balance-big" id="wallet-balance-big">—</div>
        <div class="wallet-qr" id="wallet-qr"></div>
        <p class="wallet-hint" id="wallet-qr-hint">Scan to send USDC to this wallet.</p>
      </div>

      <div class="card">
        <h3>Back up your key</h3>
        <p class="wallet-hint">
          Your private key is the only way to access this wallet.
          Save it somewhere safe — a password manager, encrypted note, or hardware token.
          <strong>Never</strong> share it; anyone with the key can drain the wallet.
        </p>
        <div class="wallet-secret" id="wallet-secret">
          <button class="btn btn-warn" id="wallet-reveal-btn">Reveal private key</button>
        </div>
        <div id="wallet-file-hint" class="wallet-hint" style="margin-top:10px"></div>
      </div>

      <div class="card">
        <h3>Import an existing wallet</h3>
        <p class="wallet-hint">
          Paste a private key below to replace the current wallet.
          <strong>This overwrites your existing wallet file.</strong>
          Make sure the current key is backed up first, or you will lose access to any funds still on it.
        </p>
        <textarea id="wallet-import-input" class="wallet-import-input" placeholder="0x… (Base) or base58 key (Solana)"></textarea>
        <div class="wallet-actions">
          <button class="btn btn-danger" id="wallet-import-btn">Import &amp; replace</button>
          <span class="wallet-import-status" id="wallet-import-status"></span>
        </div>
      </div>

      <div class="card">
        <h3>Export to another tool</h3>
        <p class="wallet-hint">
          Franklin stores your key in <code id="wallet-file-path">~/.blockrun/</code>.
          To use the same wallet in MetaMask / Phantom / a hardware wallet:
        </p>
        <ol class="wallet-steps">
          <li>Click <em>Reveal private key</em> above and copy it.</li>
          <li>In your destination wallet, choose <em>Import account</em> / <em>Import private key</em>.</li>
          <li>Paste the key. The wallet will derive the same address.</li>
          <li>Consider deleting the local file once imported if you no longer want Franklin to spend from it.</li>
        </ol>
      </div>

      <div class="card">
        <h3>Security check</h3>
        <p class="wallet-hint">
          Scan your wallet for compromise indicators: file permissions, address mismatches,
          and other security issues that could indicate your private key has been exposed.
        </p>
        <div class="wallet-actions">
          <button class="btn" id="wallet-check-btn">Run security check</button>
          <span class="wallet-import-status" id="wallet-check-status"></span>
        </div>
        <div id="wallet-check-results" style="display:none; margin-top:14px;">
          <div id="wallet-check-summary" style="margin-bottom:10px; font-weight:600;"></div>
          <div id="wallet-check-items"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Sessions -->
  <div class="tab" id="tab-sessions">
    <div class="content-header">
      <h2>Sessions</h2>
      <p>Browse past conversations</p>
    </div>
    <input class="search-box" id="session-search" placeholder="Search sessions..." />
    <div class="session-detail" id="session-detail" style="display:none"></div>
    <div class="session-list" id="session-list"></div>
  </div>

  <!-- Tasks -->
  <div class="tab" id="tab-tasks">
    <div class="content-header">
      <h2>Tasks</h2>
      <p>Detached background work — long builds, runs, jobs.</p>
    </div>
    <div class="tasks-toolbar">
      <button class="btn" id="tasks-refresh-btn">Refresh</button>
      <span id="tasks-summary" style="font-size:12px;color:var(--text-dim);"></span>
    </div>
    <div class="task-detail" id="task-detail" style="display:none"></div>
    <div class="tasks-table" id="tasks-list"></div>
  </div>

  <!-- Markets -->
  <div class="tab" id="tab-markets">
    <div class="content-header">
      <h2>Markets</h2>
      <p>How Franklin gets trading + prediction-market data — and what it costs.</p>
    </div>

    <div class="grid grid-4">
      <div class="card"><h3>Calls today</h3><div class="metric" id="mk-calls">&mdash;</div></div>
      <div class="card"><h3>Spend today</h3><div class="metric gold" id="mk-spend">&mdash;</div></div>
      <div class="card"><h3>p50 latency</h3><div class="metric" id="mk-p50">&mdash;</div></div>
      <div class="card"><h3>Payment chain</h3><div class="metric" id="mk-chain">&mdash;</div></div>
    </div>

    <div style="display:grid;grid-template-columns:1.1fr 1fr;gap:14px;margin-top:14px">
      <div class="card">
        <h3>Data pipeline</h3>
        <p style="color:var(--text-dim);font-size:12px;margin:4px 0 14px">
          Each asset class routes through the provider registry to the active upstream.
        </p>
        <div id="mk-pipeline" style="font-family:var(--mono);font-size:12px;line-height:1.75"></div>
      </div>
      <div class="card">
        <h3>Providers</h3>
        <div id="mk-providers" style="margin-top:6px"></div>
        <h3 style="margin-top:18px">Recent paid calls</h3>
        <div id="mk-paid" class="empty" style="margin-top:6px">No paid calls yet</div>
      </div>
    </div>
  </div>

  <!-- Learnings -->
  <div class="tab" id="tab-learnings">
    <div class="content-header">
      <h2>Learnings</h2>
      <p>Preferences Franklin has learned over time</p>
    </div>
    <div id="learnings-list"></div>
  </div>

  <!-- Audit Log -->
  <div class="tab" id="tab-audit">
    <div class="content-header">
      <h2>Audit Log</h2>
      <p>Every LLM call: prompt, model, tokens, cost. Where the money actually went.</p>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-dim);cursor:pointer;">
        <input type="checkbox" id="audit-paid-only" style="margin:0;" /> Paid only
      </label>
      <select id="audit-since" style="padding:4px 8px;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:13px;">
        <option value="0">All time</option>
        <option value="3600000">Last hour</option>
        <option value="86400000" selected>Last 24h</option>
        <option value="604800000">Last 7 days</option>
        <option value="2592000000">Last 30 days</option>
      </select>
      <input id="audit-model" placeholder="Filter by model…" style="padding:4px 8px;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:13px;width:180px;" />
      <input id="audit-session" placeholder="Filter by session prefix…" style="padding:4px 8px;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:13px;width:180px;" />
      <button id="audit-refresh" style="padding:4px 10px;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:13px;cursor:pointer;">Refresh</button>
      <span id="audit-summary" style="margin-left:auto;font-size:13px;color:var(--text-dim);"></span>
    </div>
    <div id="audit-list" style="font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;"></div>
  </div>

</div>

<script>
// Tab switching — supports URL hash (e.g. #tasks) for deep links.
// Emits a 'tab:activated' / 'tab:deactivated' event so per-tab modules
// can start/stop their pollers without coupling to the dispatcher.
let _activeTab = 'overview';
function activateTab(name) {
  if (!document.getElementById('tab-' + name)) name = 'overview';
  if (name === _activeTab) return;
  const prev = _activeTab;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  _activeTab = name;
  document.dispatchEvent(new CustomEvent('tab:deactivated', { detail: { name: prev } }));
  document.dispatchEvent(new CustomEvent('tab:activated', { detail: { name } }));
}
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.tab;
    if (history.replaceState) history.replaceState(null, '', '#' + name);
    activateTab(name);
  });
});
window.addEventListener('hashchange', () => {
  const name = (location.hash || '').replace(/^#/, '');
  if (name) activateTab(name);
});

const api = (path) => fetch('/api/' + path).then(r => r.json()).catch(() => null);
const usd = (n) => '$' + (n || 0).toFixed(4);
const usdBig = (n) => '$' + (n || 0).toFixed(2);
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

async function loadOverview() {
  const [wallet, stats, insights] = await Promise.all([
    api('wallet'), api('stats'), api('insights?days=30')
  ]);

  // Surface API errors so users see "offline" instead of silent "—"
  if (!wallet && !stats) {
    const err = document.getElementById('total-cost');
    if (err) err.textContent = 'API offline';
    return;
  }

  if (wallet) {
    document.getElementById('balance').textContent = usdBig(wallet.balance) + ' USDC';
    document.getElementById('wallet-chain').textContent = wallet.chain;
    document.getElementById('sidebar-balance').textContent = usdBig(wallet.balance) + ' USDC';
    const addr = wallet.address || '';
    document.getElementById('sidebar-addr').textContent = addr.slice(0, 6) + '...' + addr.slice(-4);
  }

  if (stats) {
    document.getElementById('total-cost').textContent = usd(stats.totalCostUsd);
    document.getElementById('total-requests').textContent = stats.totalRequests.toLocaleString() + ' requests';
    document.getElementById('request-count').textContent = stats.totalRequests.toLocaleString();
    document.getElementById('avg-cost').textContent = usd(stats.avgCostPerRequest) + ' avg/req';
    document.getElementById('model-count').textContent = Object.keys(stats.byModel || {}).length;
    document.getElementById('period-info').textContent = stats.period || '';

    if (stats.opusCost > 0) {
      // tracker.ts now returns saved already clamped to >= 0 and opusCost
      // already inclusive of media (so comparing to totalCostUsd is
      // apples-to-apples). Older summaries — or the rare path where saved
      // is undefined — get the same Math.max clamp here so the panel
      // never shows a negative dollar amount.
      const saved = Math.max(0, stats.saved != null ? stats.saved : (stats.opusCost - stats.totalCostUsd));
      const pct = stats.savedPct != null
        ? Math.max(0, stats.savedPct)
        : (stats.opusCost > 0 ? Math.max(0, (saved / stats.opusCost) * 100) : 0);
      document.getElementById('savings-hero').style.display = 'flex';
      document.getElementById('savings-amount').textContent = usdBig(saved);
      document.getElementById('savings-pct').textContent = pct.toFixed(0) + '%';
      document.getElementById('savings-actual').textContent = usd(stats.totalCostUsd);
      document.getElementById('savings-opus').textContent = usdBig(stats.opusCost);
    }

    const models = Object.entries(stats.byModel || {})
      .map(([name, d]) => ({ name, cost: d.costUsd || 0, reqs: d.requests || 0 }))
      .sort((a, b) => b.cost - a.cost).slice(0, 10);
    const maxCost = Math.max(...models.map(m => m.cost), 0.001);
    document.getElementById('model-chart').innerHTML = models.map(m =>
      '<div class="bar-row">' +
        '<span class="bar-label">' + esc(m.name.split('/').pop()) + '</span>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + (m.cost/maxCost*100) + '%"></div></div>' +
        '<span class="bar-val">' + usd(m.cost) + ' (' + m.reqs + ')</span>' +
      '</div>'
    ).join('');
  }

  // Backend returns insights.daily with [{date, requests, costUsd}]
  const dailyData = insights && (insights.daily || insights.dailyCosts);
  if (dailyData && dailyData.length) {
    const days = dailyData.slice(-30);
    const getCost = (d) => d.costUsd !== undefined ? d.costUsd : d.cost || 0;
    const maxDay = Math.max(...days.map(getCost), 0.001);
    document.getElementById('daily-chart').innerHTML = days.map(d =>
      '<div class="daily-bar" data-tip="' + d.date + ': ' + usd(getCost(d)) + '" style="height:' + Math.max(getCost(d)/maxDay*100, 2) + '%"></div>'
    ).join('');
  }
}

async function loadSessions() {
  const sessions = await api('sessions');
  clearSessionDetail();
  if (!sessions || sessions.length === 0) {
    document.getElementById('session-list').innerHTML = '<div class="empty">No sessions yet</div>';
    return;
  }
  document.getElementById('session-list').innerHTML = sessions.slice(0, 50).map(renderSessionRow).join('');
  attachSessionClickHandlers();
}

function renderSessionRow(s) {
  return (
    '<div class="session-item" data-id="' + esc(s.id) + '">' +
      '<div class="title">' + esc(s.model || 'unknown') + ' &mdash; ' + s.messageCount + ' messages</div>' +
      '<div class="meta">' + new Date(s.createdAt).toLocaleString() + ' &middot; ' + esc((s.workDir || '').split('/').pop()) + '</div>' +
    '</div>'
  );
}

function renderSessionSearchRow(r) {
  const s = r.session || {};
  const id = s.id || r.sessionId || '';
  const model = s.model || 'unknown';
  const score = Number.isFinite(r.score) ? r.score.toFixed(2) : '0.00';
  return (
    '<div class="session-item" data-id="' + esc(id) + '">' +
      '<div class="title">' + esc(r.snippet || '(no snippet)') + '</div>' +
      '<div class="meta">' + esc(model) + ' &middot; ' + esc(id) + ' &middot; score: ' + score + '</div>' +
    '</div>'
  );
}

function clearSessionDetail() {
  const detail = document.getElementById('session-detail');
  detail.style.display = 'none';
  detail.innerHTML = '';
}

function attachSessionClickHandlers() {
  document.querySelectorAll('.session-item[data-id]').forEach(el => {
    el.addEventListener('click', async () => {
      if (!el.dataset.id) return;
      const history = await api('sessions/' + encodeURIComponent(el.dataset.id));
      if (!history) return;
      const detail = document.getElementById('session-detail');
      detail.style.display = 'block';
      detail.innerHTML = history.map(m => {
        const role = m.role || 'system';
        let text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null).slice(0, 500);
        return '<div class="msg ' + role + '"><div class="role">' + role + '</div><pre>' + esc(text) + '</pre></div>';
      }).join('');
      detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

let searchTimeout;
document.getElementById('session-search').addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    const q = e.target.value.trim();
    if (!q) { loadSessions(); return; }
    const results = await api('sessions/search?q=' + encodeURIComponent(q));
    clearSessionDetail();
    if (!results || results.length === 0) {
      document.getElementById('session-list').innerHTML = '<div class="empty">No results</div>';
      return;
    }
    document.getElementById('session-list').innerHTML = results.map(renderSessionSearchRow).join('');
    attachSessionClickHandlers();
  }, 300);
});

async function loadMarkets() {
  const data = await api('markets');
  if (!data) return;

  const calls = (data.totals && data.totals.callsToday) || 0;
  const spend = (data.totals && data.totals.spendUsdToday) || 0;
  const p50 = data.totals && data.totals.p50LatencyMs;
  document.getElementById('mk-calls').textContent = String(calls);
  document.getElementById('mk-spend').textContent = usd(spend);
  document.getElementById('mk-p50').textContent = (p50 == null) ? '—' : (p50 + ' ms');
  document.getElementById('mk-chain').textContent = (data.chain || 'base').toUpperCase();

  // Pipeline: Franklin → registry → per-asset-class provider → endpoint
  const rows = (data.wiring || []).filter(function(r){ return r.kind === 'price'; });
  const singletonRows = (data.wiring || []).filter(function(r){ return r.kind !== 'price'; });
  const providerLabel = function(name) {
    if (name === 'coingecko') return '<span style="color:var(--success)">CoinGecko</span>';
    if (name === 'blockrun') return '<span style="color:var(--gold)">BlockRun Gateway</span>';
    return esc(name);
  };
  const pipeLines = [
    '<div>Franklin agent</div>',
    '<div style="color:var(--text-dim);padding-left:8px">↓</div>',
    '<div>Provider registry</div>',
    '<div style="color:var(--text-dim);padding-left:8px">↓</div>',
  ];
  rows.forEach(function(r, i){
    const last = i === rows.length - 1;
    const branch = last ? '└' : '├';
    const paid = r.paid ? ' <span style="color:var(--gold);font-size:10px">◆ x402</span>' : '';
    pipeLines.push(
      '<div>&nbsp;' + branch + '─ ' + esc(r.assetClass).padEnd(9, ' ') +
      ' → ' + providerLabel(r.provider) + paid + '</div>'
    );
  });
  pipeLines.push('<div style="margin-top:10px;color:var(--text-dim);font-size:11px">Other singleton kinds:</div>');
  singletonRows.forEach(function(r){
    pipeLines.push(
      '<div style="color:var(--text-dim);font-size:11px">&nbsp;&nbsp;' +
      esc(r.kind) + ' → ' + providerLabel(r.provider) + '</div>'
    );
  });
  document.getElementById('mk-pipeline').innerHTML = pipeLines.join('');

  // Providers health
  const statusChip = function(s){
    if (s === 'ok')       return '<span class="dot on"></span> <span style="color:var(--success)">OK</span>';
    if (s === 'degraded') return '<span class="dot off"></span> <span style="color:var(--danger)">degraded</span>';
    return '<span class="dot" style="background:var(--text-dim)"></span> <span style="color:var(--text-dim)">cold</span>';
  };
  const providers = data.providers || [];
  document.getElementById('mk-providers').innerHTML = providers.length === 0 ? '<div class="empty">No calls recorded yet.</div>' : providers.map(function(p){
    const since = p.lastOkAt ? Math.round((Date.now() - p.lastOkAt) / 1000) + 's ago' : '—';
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-size:12px">' +
      '<span>' + statusChip(p.status) + ' &nbsp;<strong>' + esc(p.name) + '</strong></span>' +
      '<span style="color:var(--text-dim);font-family:var(--mono);font-size:11px">' +
        p.calls + ' calls · p50 ' + (p.p50LatencyMs == null ? '—' : p.p50LatencyMs + 'ms') + ' · last ' + since +
      '</span>' +
    '</div>';
  }).join('');

  // Recent paid calls
  const paid = data.recentPaidCalls || [];
  const paidBox = document.getElementById('mk-paid');
  if (paid.length === 0) {
    paidBox.className = 'empty';
    paidBox.textContent = 'No paid calls yet — stocks ship in the next release.';
  } else {
    paidBox.className = '';
    paidBox.innerHTML = paid.map(function(r){
      const age = Math.round((Date.now() - r.ts) / 1000) + 's ago';
      return '<div style="display:flex;justify-content:space-between;padding:4px 0;font-family:var(--mono);font-size:12px">' +
        '<span>' + esc(r.endpoint) + '</span>' +
        '<span class="gold">' + usd(r.costUsd) + '</span>' +
        '<span style="color:var(--text-dim)">' + age + '</span>' +
      '</div>';
    }).join('');
  }
}

async function loadLearnings() {
  const learnings = await api('learnings');
  if (!learnings || learnings.length === 0) {
    document.getElementById('learnings-list').innerHTML = '<div class="empty">No learnings yet. Franklin learns your preferences over time.</div>';
    return;
  }
  document.getElementById('learnings-list').innerHTML = learnings
    .sort((a, b) => (b.confidence * b.times_confirmed) - (a.confidence * a.times_confirmed))
    .map(l => {
      const cls = l.confidence >= 0.8 ? 'high' : l.confidence >= 0.5 ? 'mid' : 'low';
      return '<div class="learning-item">' +
        '<span class="badge ' + cls + '">' + (l.confidence * 100).toFixed(0) + '%</span>' +
        '<span class="learning-text">' + esc(l.learning) + '</span>' +
        '<span class="learning-count">&times;' + l.times_confirmed + '</span>' +
      '</div>';
    }).join('');
}

async function loadWallet() {
  const w = await api('wallet');
  if (!w) return;
  const addr = w.address || '';
  document.getElementById('wallet-address-full').textContent = addr || 'not set';
  document.getElementById('wallet-balance-big').textContent = usdBig(w.balance) + ' USDC';
  document.getElementById('wallet-chain-pill').textContent = w.chain || '—';

  // Chain switcher — highlight active button
  const baseBtn = document.getElementById('chain-btn-base');
  const solanaBtn = document.getElementById('chain-btn-solana');
  if (baseBtn && solanaBtn) {
    baseBtn.classList.toggle('active', w.chain === 'base');
    solanaBtn.classList.toggle('active', w.chain === 'solana');
  }

  // QR via server — never leak address to third parties.
  // Encode chain + USDC token in the QR payload so wallet apps land
  // directly on the right network/token instead of a bare address:
  //   Base   → EIP-681:  ethereum:<USDC>@8453/transfer?address=<addr>
  //   Solana → Solana Pay: solana:<addr>?spl-token=<USDC mint>
  const qrBox = document.getElementById('wallet-qr');
  const hint = document.getElementById('wallet-qr-hint');
  if (addr && addr !== 'not set') {
    const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const USDC_SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const payload = w.chain === 'solana'
      ? 'solana:' + addr + '?spl-token=' + USDC_SOL_MINT
      : 'ethereum:' + USDC_BASE + '@8453/transfer?address=' + addr;
    const svg = await fetch('/api/wallet/qr?data=' + encodeURIComponent(payload)).then(r => r.ok ? r.text() : null);
    qrBox.innerHTML = svg || '';
    hint.textContent = w.chain === 'solana'
      ? 'Scan with a Solana wallet (Phantom, Solflare) to send USDC SPL.'
      : 'Scan with an EVM wallet (MetaMask, Coinbase) to send USDC on Base.';
  } else {
    qrBox.innerHTML = '';
    hint.textContent = 'No wallet set yet — run: franklin setup';
  }
}

// Chain switcher — click "Base" or "Solana" to flip payment chain.
// Creates a wallet on the target chain if one does not exist yet.
// Note: a currently-running franklin agent reads its chain at startup,
// so a mid-session switch only affects the next agent invocation.
['chain-btn-base', 'chain-btn-solana'].forEach((id) => {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const target = btn.getAttribute('data-chain');
    const note = document.getElementById('chain-switcher-note');
    const baseBtn = document.getElementById('chain-btn-base');
    const solanaBtn = document.getElementById('chain-btn-solana');
    // Skip if already active
    if (btn.classList.contains('active')) return;
    baseBtn.disabled = true;
    solanaBtn.disabled = true;
    note.textContent = 'Switching to ' + target + '…';
    try {
      const r = await fetch('/api/chain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chain: target }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        note.textContent = 'Error: ' + (data.error || r.statusText);
        return;
      }
      note.textContent = 'Switched to ' + target + ' · restart Franklin to use this chain';
      await loadWallet();
      // Sidebar balance + address also refresh
      document.getElementById('sidebar-balance').textContent = usdBig(data.balance) + ' USDC';
      document.getElementById('sidebar-addr').textContent = (data.address || '').slice(0, 6) + '…' + (data.address || '').slice(-4);
    } catch (err) {
      note.textContent = 'Error: ' + (err && err.message ? err.message : 'network error');
    } finally {
      baseBtn.disabled = false;
      solanaBtn.disabled = false;
    }
  });
});

// Copy button
document.getElementById('wallet-copy-btn').addEventListener('click', async () => {
  const addr = document.getElementById('wallet-address-full').textContent;
  try {
    await navigator.clipboard.writeText(addr);
    const btn = document.getElementById('wallet-copy-btn');
    const orig = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = orig; }, 1400);
  } catch { /* clipboard may be blocked — user can select manually */ }
});

// Reveal private key
document.getElementById('wallet-reveal-btn').addEventListener('click', async () => {
  if (!confirm('Show the private key on screen?\\n\\nAnyone who sees or records the key can drain this wallet. Make sure nobody is looking over your shoulder or recording your screen.')) return;
  const box = document.getElementById('wallet-secret');
  box.innerHTML = '<div class="wallet-hint">Loading…</div>';
  try {
    const r = await fetch('/api/wallet/secret');
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: 'unknown' }));
      box.innerHTML = '<div class="wallet-hint err">Error: ' + esc(err.error || r.statusText) + '</div>';
      return;
    }
    const d = await r.json();
    box.innerHTML =
      '<code class="wallet-key-value" id="wallet-key-value">' + esc(d.privateKey) + '</code>' +
      '<div class="wallet-secret-actions">' +
        '<button class="btn" id="wallet-key-copy">Copy key</button>' +
        '<button class="btn btn-ghost" id="wallet-key-hide">Hide</button>' +
      '</div>';
    document.getElementById('wallet-file-hint').textContent = 'Stored at: ' + d.walletFile;
    document.getElementById('wallet-file-path').textContent = d.walletFile;
    document.getElementById('wallet-key-copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(d.privateKey);
      const btn = document.getElementById('wallet-key-copy');
      btn.textContent = 'Copied ✓';
      setTimeout(() => { btn.textContent = 'Copy key'; }, 1400);
    });
    document.getElementById('wallet-key-hide').addEventListener('click', () => {
      box.innerHTML = '<button class="btn btn-warn" id="wallet-reveal-btn-2">Reveal private key</button>';
      document.getElementById('wallet-reveal-btn-2').addEventListener('click',
        () => document.getElementById('wallet-reveal-btn').click());
    });
  } catch (err) {
    box.innerHTML = '<div class="wallet-hint err">Error: ' + esc(err.message) + '</div>';
  }
});

// Import
document.getElementById('wallet-import-btn').addEventListener('click', async () => {
  const pk = document.getElementById('wallet-import-input').value.trim();
  const status = document.getElementById('wallet-import-status');
  status.className = 'wallet-import-status';
  if (!pk) { status.textContent = 'Paste a private key first.'; return; }
  if (!confirm('Replace the current wallet with this key?\\n\\nThis OVERWRITES your existing wallet file. Any funds on the current wallet will be inaccessible unless you already backed up its key.')) return;
  status.textContent = 'Importing…';
  try {
    const r = await fetch('/api/wallet/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ privateKey: pk }),
    });
    const d = await r.json();
    if (!r.ok) {
      status.textContent = 'Error: ' + (d.error || r.statusText);
      status.className = 'wallet-import-status err';
      return;
    }
    status.textContent = 'Imported ✓  New address: ' + d.address;
    status.className = 'wallet-import-status ok';
    document.getElementById('wallet-import-input').value = '';
    loadWallet();
    loadOverview();
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    status.className = 'wallet-import-status err';
  }
});

// Security check
document.getElementById('wallet-check-btn').addEventListener('click', async () => {
  const status = document.getElementById('wallet-check-status');
  const results = document.getElementById('wallet-check-results');
  const summary = document.getElementById('wallet-check-summary');
  const items = document.getElementById('wallet-check-items');

  status.className = 'wallet-import-status';
  status.textContent = 'Checking…';
  results.style.display = 'none';

  try {
    const r = await fetch('/api/wallet/check');
    const report = await r.json();
    if (!r.ok) {
      status.textContent = 'Error: ' + (report.error || r.statusText);
      status.className = 'wallet-import-status err';
      return;
    }

    // Determine overall status
    const hasErrors = report.items.some(item => item.status === 'error');
    const hasWarnings = report.items.some(item => item.status === 'warning');

    let summaryText = '✅ No security issues found';
    let summaryClass = 'ok';

    if (hasErrors) {
      summaryText = '❌ Security issues detected — action required';
      summaryClass = 'err';
    } else if (hasWarnings) {
      summaryText = '⚠️ Potential security concerns found';
      summaryClass = 'warn';
    }

    summary.textContent = summaryText;
    summary.className = `wallet-import-status ${summaryClass}`;

    // Render items
    items.innerHTML = report.items.map(item => {
      const marker = item.status === 'ok' ? '✅' : item.status === 'warning' ? '⚠️' : '❌';
      const detail = item.detail ? ` — ${esc(item.detail)}` : '';
      return `<div style="margin-bottom:8px; padding:8px; border-radius:6px; background:oklch(0 0 0 / 20%);">
        ${marker} ${esc(item.description)}${detail}
      </div>`;
    }).join('');

    results.style.display = 'block';
    status.textContent = 'Check completed';
    status.className = 'wallet-import-status ok';

  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    status.className = 'wallet-import-status err';
  }
});

const es = new EventSource('/api/events');
const dot = document.getElementById('dot');
const statusEl = document.getElementById('status');
es.onopen = () => { dot.className = 'dot on'; statusEl.textContent = 'live'; };
es.onerror = () => { dot.className = 'dot off'; statusEl.textContent = 'offline'; };
es.onmessage = (e) => {
  try { if (JSON.parse(e.data).type === 'stats.updated') loadOverview(); } catch {}
};

async function loadAudit() {
  const list = document.getElementById('audit-list');
  const summary = document.getElementById('audit-summary');
  if (!list) return;
  const params = new URLSearchParams({ limit: '300' });
  if (document.getElementById('audit-paid-only').checked) params.set('paidOnly', '1');
  const sinceMs = parseInt(document.getElementById('audit-since').value, 10);
  if (sinceMs > 0) params.set('since', String(Date.now() - sinceMs));
  const model = document.getElementById('audit-model').value.trim();
  if (model) params.set('model', model);
  const session = document.getElementById('audit-session').value.trim();
  if (session) params.set('session', session);

  list.innerHTML = '<div style="color:var(--text-dim);padding:12px;">Loading…</div>';
  const data = await fetch('/api/audit?' + params.toString()).then(r => r.json()).catch(() => null);
  if (!data) { list.innerHTML = '<div style="color:var(--text-dim);padding:12px;">API offline</div>'; return; }
  if (!data.entries.length) {
    list.innerHTML = '<div style="color:var(--text-dim);padding:12px;">No audit entries match these filters. Run franklin and make a request.</div>';
    summary.textContent = '0 calls';
    return;
  }
  summary.textContent = data.returned + ' / ' + data.total + ' calls · $' + data.totalCostUsd.toFixed(4) + ' · ' +
    (data.totalInputTokens/1000).toFixed(1) + 'k in / ' + (data.totalOutputTokens/1000).toFixed(1) + 'k out';

  list.innerHTML = data.entries.map(e => {
    const ts = new Date(e.ts).toLocaleString('en-US', { hour12: false });
    const cost = e.costUsd > 0
      ? '<span style="color:#fbbf24;">$' + e.costUsd.toFixed(4) + '</span>'
      : '<span style="color:#10b981;">FREE</span>';
    const fb = e.fallback ? ' <span style="color:#f97316;">·fb</span>' : '';
    const sid = e.sessionId ? ' <span style="color:var(--text-dim);">' + esc(e.sessionId.slice(0,8)) + '</span>' : '';
    const prompt = e.prompt
      ? '<div style="color:var(--text-dim);padding:2px 0 4px 16px;white-space:pre-wrap;word-break:break-word;">"' + esc(e.prompt) + '"</div>'
      : '';
    const dir = e.workDir ? '<div style="color:var(--text-dim);padding:0 0 0 16px;font-size:11px;">📁 ' + esc(e.workDir) + '</div>' : '';
    return '<div style="padding:8px 12px;border-bottom:1px solid var(--border);">' +
      '<div><span style="color:var(--text-dim);">' + ts + '</span>  ' + cost + '  <span style="color:#60a5fa;">' + esc(e.model) + '</span>  ' +
      '<span style="color:var(--text-dim);">in=' + e.inputTokens + ' out=' + e.outputTokens + '</span>  ' +
      '<span style="color:var(--text-dim);">[' + esc(e.source) + ']' + fb + '</span>' + sid + '</div>' +
      prompt + dir +
      '</div>';
  }).join('');
}

['audit-paid-only','audit-since','audit-model','audit-session'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener(el.tagName === 'INPUT' && el.type === 'text' ? 'input' : 'change', () => loadAudit());
});
document.getElementById('audit-refresh')?.addEventListener('click', loadAudit);
document.querySelector('[data-tab="audit"]')?.addEventListener('click', loadAudit);

// ─── Tasks tab ───────────────────────────────────────────────────────────
// Polls /api/tasks every 10s while the Tasks tab is active AND the page is
// visible. Detail view layers a 2s log-tail poll using Range: bytes=N- on
// top, stopping itself once the task hits a terminal status. No SSE — keeps
// the panel server stateless and the wire format trivial.
const TASK_TERMINAL = new Set(['succeeded', 'failed', 'timed_out', 'cancelled', 'lost']);
const tasks = {
  pollTimer: null,
  logTimer: null,
  selected: null,        // runId of currently-open detail
  logBytesShown: 0,
  cache: [],             // last list snapshot (for finding the selected meta)
  finalLogFetched: false // ensures one final 200 fetch after task terminates
};

function fmtAge(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 48) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}
function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

async function fetchTasks() {
  const data = await api('tasks');
  if (!data) {
    document.getElementById('tasks-list').innerHTML = '<div class="empty">API offline</div>';
    return;
  }
  const list = (data.tasks || []).slice().sort((a, b) => {
    const at = a.lastEventAt || a.createdAt || 0;
    const bt = b.lastEventAt || b.createdAt || 0;
    return bt - at;
  });
  tasks.cache = list;
  document.getElementById('tasks-summary').textContent = list.length + ' task' + (list.length === 1 ? '' : 's');
  if (list.length === 0) {
    document.getElementById('tasks-list').innerHTML =
      '<div class="empty">No tasks. Start one via the Detach agent tool, or manually with <code>franklin task ...</code>.</div>';
  } else {
    document.getElementById('tasks-list').innerHTML = list.map(renderTaskRow).join('');
    attachTaskRowHandlers();
  }
  // If a detail view is open, refresh its meta panel from the new snapshot
  if (tasks.selected) {
    const meta = list.find(t => t.runId === tasks.selected);
    if (meta) refreshTaskDetailMeta(meta);
  }
}

function renderTaskRow(t) {
  const shortId = t.runId.slice(0, 12) + '…';
  const age = fmtAge(t.lastEventAt || t.createdAt);
  const showCancel = t.status === 'running' || t.status === 'queued';
  const cancelBtn = showCancel
    ? '<button class="btn btn-warn" data-cancel="' + esc(t.runId) + '">Cancel</button>'
    : '';
  return (
    '<div class="task-row" data-runid="' + esc(t.runId) + '">' +
      '<span class="runid">' + esc(shortId) + '</span>' +
      '<span class="label">' + esc(t.label || '(no label)') + '</span>' +
      '<span><span class="task-status ' + esc(t.status) + '">' + esc(t.status) + '</span></span>' +
      '<span class="age">' + esc(age) + '</span>' +
      '<span class="actions">' + cancelBtn + '</span>' +
    '</div>'
  );
}

function attachTaskRowHandlers() {
  document.querySelectorAll('.task-row[data-runid]').forEach(el => {
    el.addEventListener('click', (ev) => {
      // Cancel button: handle and stop propagation so the row doesn't open detail
      const target = ev.target;
      if (target instanceof HTMLElement && target.dataset.cancel) {
        ev.stopPropagation();
        cancelTask(target.dataset.cancel, el);
        return;
      }
      openTaskDetail(el.dataset.runid);
    });
  });
}

async function cancelTask(runId, rowEl) {
  if (!confirm('Cancel task ' + runId.slice(0, 12) + '…?\\n\\nFranklin will send SIGTERM to the running process.')) return;
  try {
    const r = await fetch('/api/tasks/' + encodeURIComponent(runId) + '/cancel', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (d && d.ok) {
      fetchTasks();
    } else {
      // Show inline error under the row
      const existing = rowEl && rowEl.querySelector('.cancel-err');
      if (existing) existing.remove();
      const err = document.createElement('div');
      err.className = 'cancel-err';
      err.textContent = 'Cancel failed: ' + (d && d.reason ? d.reason : 'unknown');
      if (rowEl) rowEl.appendChild(err);
    }
  } catch (err) {
    alert('Network error: ' + (err && err.message ? err.message : err));
  }
}

async function openTaskDetail(runId) {
  tasks.selected = runId;
  tasks.logBytesShown = 0;
  tasks.finalLogFetched = false;
  const detail = document.getElementById('task-detail');
  detail.style.display = 'block';
  detail.innerHTML = '<div style="color:var(--text-dim);font-size:12px">Loading…</div>';
  detail.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const meta = await api('tasks/' + encodeURIComponent(runId));
  if (!meta) {
    detail.innerHTML = '<div class="empty">Task not found</div>';
    return;
  }
  renderTaskDetail(meta);
  await Promise.all([loadTaskEvents(runId), pollTaskLog(runId, /*initial*/ true)]);
  // Start log polling cadence (only if not terminal and visible)
  startLogPolling();
}

function refreshTaskDetailMeta(meta) {
  // Update only the top metadata fields without resetting the log box.
  const top = document.getElementById('td-top');
  const metaBox = document.getElementById('td-meta');
  const cancelSlot = document.getElementById('td-cancel-slot');
  if (top) top.innerHTML = renderTaskDetailTop(meta);
  if (metaBox) metaBox.innerHTML = renderTaskDetailMetaRows(meta);
  if (cancelSlot) cancelSlot.innerHTML = renderTaskDetailCancelBtn(meta);
  attachTaskDetailButtonHandlers(meta);
  // If the task just hit terminal, surface the footer + stop polling
  if (TASK_TERMINAL.has(meta.status)) {
    const footer = document.getElementById('td-log-footer');
    if (footer && !footer.textContent) {
      footer.textContent = 'Final status: ' + meta.status + ' — log polling stopped.';
    }
  }
}

function renderTaskDetailTop(t) {
  return (
    '<span class="title">' + esc(t.label || '(no label)') + '</span>' +
    '<span class="task-status ' + esc(t.status) + '">' + esc(t.status) + '</span>'
  );
}

function renderTaskDetailMetaRows(t) {
  const rows = [
    ['runId', t.runId],
    ['command', t.command],
    ['workingDir', t.workingDir],
    ['pid', t.pid != null ? String(t.pid) : '—'],
    ['createdAt', fmtTime(t.createdAt)],
    ['startedAt', fmtTime(t.startedAt)],
    ['lastEventAt', fmtTime(t.lastEventAt)],
    ['endedAt', fmtTime(t.endedAt)],
  ];
  if (t.exitCode !== undefined) rows.push(['exitCode', String(t.exitCode)]);
  if (t.terminalSummary) rows.push(['terminalSummary', t.terminalSummary]);
  if (t.error) rows.push(['error', t.error]);
  return rows.map(([k, v]) =>
    '<span class="k">' + esc(k) + '</span><span class="v">' + esc(v == null ? '—' : v) + '</span>'
  ).join('');
}

function renderTaskDetailCancelBtn(t) {
  if (TASK_TERMINAL.has(t.status)) return '';
  return '<button class="btn btn-warn" id="td-cancel-btn" data-runid="' + esc(t.runId) + '">Cancel</button>';
}

function renderTaskDetail(t) {
  const detail = document.getElementById('task-detail');
  detail.innerHTML =
    '<div class="top" id="td-top">' + renderTaskDetailTop(t) + '</div>' +
    '<div class="task-detail-meta" id="td-meta">' + renderTaskDetailMetaRows(t) + '</div>' +
    '<h4>Recent events</h4>' +
    '<div class="task-events" id="td-events"><div style="color:var(--text-dim);font-size:11px">Loading…</div></div>' +
    '<h4>Log tail</h4>' +
    '<div class="task-log-footer" id="td-log-footer"></div>' +
    '<pre class="task-log" id="td-log"></pre>' +
    '<div class="task-detail-actions">' +
      '<span id="td-cancel-slot">' + renderTaskDetailCancelBtn(t) + '</span>' +
      '<button class="btn btn-ghost" id="td-close-btn">Close</button>' +
    '</div>';
  attachTaskDetailButtonHandlers(t);
}

function attachTaskDetailButtonHandlers(t) {
  const closeBtn = document.getElementById('td-close-btn');
  if (closeBtn) closeBtn.onclick = closeTaskDetail;
  const cancelBtn = document.getElementById('td-cancel-btn');
  if (cancelBtn) cancelBtn.onclick = () => cancelTask(t.runId, null);
}

function closeTaskDetail() {
  tasks.selected = null;
  stopLogPolling();
  const detail = document.getElementById('task-detail');
  detail.style.display = 'none';
  detail.innerHTML = '';
}

async function loadTaskEvents(runId) {
  const data = await api('tasks/' + encodeURIComponent(runId) + '/events');
  const box = document.getElementById('td-events');
  if (!box) return;
  const events = (data && data.events ? data.events : [])
    .slice()
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, 10);
  if (events.length === 0) {
    box.innerHTML = '<div style="color:var(--text-dim);font-size:11px">No events recorded.</div>';
    return;
  }
  box.innerHTML = events.map(e =>
    '<div class="task-event">' +
      '<span class="kind">' + esc(e.kind) + '</span>' +
      '<span>' + esc(fmtTime(e.at)) + '</span>' +
      '<span>' + esc(e.summary || '') + '</span>' +
    '</div>'
  ).join('');
}

async function pollTaskLog(runId, initial) {
  const logEl = document.getElementById('td-log');
  if (!logEl) return;
  try {
    const headers = (!initial && tasks.logBytesShown > 0)
      ? { 'Range': 'bytes=' + tasks.logBytesShown + '-' }
      : {};
    const res = await fetch('/api/tasks/' + encodeURIComponent(runId) + '/log', { headers });
    if (res.status === 206) {
      const body = await res.text();
      if (body.length > 0) {
        logEl.textContent += body;
        tasks.logBytesShown += new Blob([body]).size;
        logEl.scrollTop = logEl.scrollHeight;
      }
    } else if (res.status === 200) {
      const body = await res.text();
      logEl.textContent = body;
      tasks.logBytesShown = new Blob([body]).size;
      logEl.scrollTop = logEl.scrollHeight;
    }
  } catch { /* network blip — next tick will retry */ }
}

function startLogPolling() {
  stopLogPolling();
  if (!tasks.selected) return;
  tasks.logTimer = setInterval(async () => {
    if (!tasks.selected) { stopLogPolling(); return; }
    if (document.visibilityState !== 'visible') return;
    const runId = tasks.selected;
    const meta = tasks.cache.find(t => t.runId === runId);
    const status = meta ? meta.status : 'running';
    if (TASK_TERMINAL.has(status)) {
      // One final 200 fetch to flush, then stop.
      if (!tasks.finalLogFetched) {
        tasks.finalLogFetched = true;
        await pollTaskLog(runId, /*initial*/ true);
      }
      const footer = document.getElementById('td-log-footer');
      if (footer && !footer.textContent) footer.textContent = 'Final status: ' + status + ' — log polling stopped.';
      stopLogPolling();
      return;
    }
    pollTaskLog(runId, /*initial*/ false);
  }, 2000);
}

function stopLogPolling() {
  if (tasks.logTimer) {
    clearInterval(tasks.logTimer);
    tasks.logTimer = null;
  }
}

function startTasksPolling() {
  stopTasksPolling();
  fetchTasks();
  tasks.pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') fetchTasks();
  }, 10000);
}

function stopTasksPolling() {
  if (tasks.pollTimer) {
    clearInterval(tasks.pollTimer);
    tasks.pollTimer = null;
  }
}

document.addEventListener('tab:activated', (e) => {
  if (e.detail && e.detail.name === 'tasks') {
    startTasksPolling();
    if (tasks.selected) startLogPolling();
  }
});
document.addEventListener('tab:deactivated', (e) => {
  if (e.detail && e.detail.name === 'tasks') {
    stopTasksPolling();
    stopLogPolling();
  }
});
document.addEventListener('visibilitychange', () => {
  const visible = document.visibilityState === 'visible';
  if (_activeTab === 'tasks') {
    if (visible) {
      startTasksPolling();
      if (tasks.selected) startLogPolling();
    } else {
      stopTasksPolling();
      stopLogPolling();
    }
  }
});

document.getElementById('tasks-refresh-btn')?.addEventListener('click', fetchTasks);

loadOverview();
loadSessions();
loadMarkets();
loadLearnings();
loadWallet();
document.querySelector('[data-tab="markets"]')?.addEventListener('click', loadMarkets);

// Honor URL hash on initial load (e.g. /#tasks deep link)
{
  const initialHash = (location.hash || '').replace(/^#/, '');
  if (initialHash && initialHash !== 'overview' && document.getElementById('tab-' + initialHash)) {
    activateTab(initialHash);
  }
}

setInterval(() => api('wallet').then(w => {
  if (w) {
    document.getElementById('balance').textContent = usdBig(w.balance) + ' USDC';
    document.getElementById('sidebar-balance').textContent = usdBig(w.balance) + ' USDC';
  }
}), 30000);
</script>
</body>
</html>`;
}
