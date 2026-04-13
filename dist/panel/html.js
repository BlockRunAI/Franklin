/**
 * Franklin Panel — embedded HTML dashboard.
 * Single page, dark theme, zero dependencies.
 * Design language adapted from Multica (oklch palette, sidebar nav).
 * Currency-grade watermark + Inter font.
 */
export function getHTML() {
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

@media (max-width:768px) {
  body { flex-direction:column; }
  .sidebar { width:100%; min-width:100%; flex-direction:row; padding:8px; overflow-x:auto; border-right:none; border-bottom:1px solid var(--border); }
  .sidebar-header, .sidebar-label, .sidebar-footer { display:none; }
  .sidebar-nav { flex-direction:row; gap:4px; padding:0; }
  .content { padding:16px; }
  .grid-4 { grid-template-columns:repeat(2,1fr); }
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
    <button class="nav-item" data-tab="sessions">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      Sessions
    </button>
    <button class="nav-item" data-tab="social">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l11.733 16h4.267l-11.733-16z"/><path d="M4 20l6.768-6.768M15.232 11.232L20 4"/></svg>
      Social
    </button>
    <button class="nav-item" data-tab="learnings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
      Learnings
    </button>
  </div>

  <div class="sidebar-footer">
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
          <div class="label">Saved vs Claude Opus</div>
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

  <!-- Sessions -->
  <div class="tab" id="tab-sessions">
    <div class="content-header">
      <h2>Sessions</h2>
      <p>Browse past conversations</p>
    </div>
    <input class="search-box" id="session-search" placeholder="Search sessions..." />
    <div class="session-list" id="session-list"></div>
    <div class="session-detail" id="session-detail" style="display:none"></div>
  </div>

  <!-- Social -->
  <div class="tab" id="tab-social">
    <div class="content-header">
      <h2>Social</h2>
      <p>X/Twitter engagement stats</p>
    </div>
    <div class="grid grid-4" id="social-stats"></div>
    <div class="card" style="margin-top:12px">
      <h3>Recent Activity</h3>
      <div id="social-feed" class="empty">No social activity yet</div>
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
</div>

<script>
// Tab switching
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

const api = (path) => fetch('/api/' + path).then(r => r.json()).catch(() => null);
const usd = (n) => '$' + (n || 0).toFixed(4);
const usdBig = (n) => '$' + (n || 0).toFixed(2);
const esc = (s) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function loadOverview() {
  const [wallet, stats, insights] = await Promise.all([
    api('wallet'), api('stats'), api('insights?days=30')
  ]);

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
      const saved = stats.saved || (stats.opusCost - stats.totalCostUsd);
      const pct = stats.savedPct || ((1 - stats.totalCostUsd / stats.opusCost) * 100);
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

  if (insights && insights.dailyCosts) {
    const days = insights.dailyCosts.slice(-30);
    const maxDay = Math.max(...days.map(d => d.cost), 0.001);
    document.getElementById('daily-chart').innerHTML = days.map(d =>
      '<div class="daily-bar" data-tip="' + d.date + ': ' + usd(d.cost) + '" style="height:' + Math.max(d.cost/maxDay*100, 2) + '%"></div>'
    ).join('');
  }
}

async function loadSessions() {
  const sessions = await api('sessions');
  if (!sessions || sessions.length === 0) {
    document.getElementById('session-list').innerHTML = '<div class="empty">No sessions yet</div>';
    return;
  }
  document.getElementById('session-list').innerHTML = sessions.slice(0, 50).map(s =>
    '<div class="session-item" data-id="' + esc(s.id) + '">' +
      '<div class="title">' + esc(s.model || 'unknown') + ' &mdash; ' + s.messageCount + ' messages</div>' +
      '<div class="meta">' + new Date(s.createdAt).toLocaleString() + ' &middot; ' + esc((s.workDir || '').split('/').pop()) + '</div>' +
    '</div>'
  ).join('');
  document.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', async () => {
      const history = await api('sessions/' + encodeURIComponent(el.dataset.id));
      if (!history) return;
      const detail = document.getElementById('session-detail');
      detail.style.display = 'block';
      detail.innerHTML = history.map(m => {
        const role = m.role || 'system';
        let text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content).slice(0, 500);
        return '<div class="msg ' + role + '"><div class="role">' + role + '</div><pre>' + esc(text) + '</pre></div>';
      }).join('');
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
    if (!results || results.length === 0) {
      document.getElementById('session-list').innerHTML = '<div class="empty">No results</div>';
      return;
    }
    document.getElementById('session-list').innerHTML = results.map(r =>
      '<div class="session-item">' +
        '<div class="title">' + esc(r.snippet) + '</div>' +
        '<div class="meta">' + esc(r.sessionId) + ' &middot; score: ' + r.score.toFixed(2) + '</div>' +
      '</div>'
    ).join('');
  }, 300);
});

async function loadSocial() {
  const social = await api('social');
  if (!social) return;
  document.getElementById('social-stats').innerHTML =
    '<div class="card"><h3>Posted</h3><div class="metric success">' + (social.posted || 0) + '</div></div>' +
    '<div class="card"><h3>Drafted</h3><div class="metric">' + (social.drafted || 0) + '</div></div>' +
    '<div class="card"><h3>Skipped</h3><div class="metric">' + (social.skipped || 0) + '</div></div>' +
    '<div class="card"><h3>Social Cost</h3><div class="metric gold">' + usd(social.totalCost || 0) + '</div></div>';
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

const es = new EventSource('/api/events');
const dot = document.getElementById('dot');
const statusEl = document.getElementById('status');
es.onopen = () => { dot.className = 'dot on'; statusEl.textContent = 'live'; };
es.onerror = () => { dot.className = 'dot off'; statusEl.textContent = 'offline'; };
es.onmessage = (e) => {
  try { if (JSON.parse(e.data).type === 'stats.updated') loadOverview(); } catch {}
};

loadOverview();
loadSessions();
loadSocial();
loadLearnings();
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
