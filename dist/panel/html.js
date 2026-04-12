/**
 * Franklin Panel — embedded HTML dashboard.
 * Single page, dark theme, zero dependencies.
 * Design language adapted from Multica (oklch palette, sidebar nav).
 */
export function getHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Franklin Panel</title>
<style>
:root {
  --bg: oklch(0.14 0.005 286);
  --bg-card: oklch(0.21 0.006 286);
  --bg-hover: oklch(0.26 0.006 286);
  --bg-sidebar: oklch(0.18 0.005 286);
  --border: oklch(1 0 0 / 10%);
  --border-strong: oklch(1 0 0 / 15%);
  --text: oklch(0.985 0 0);
  --text-dim: oklch(0.55 0.016 286);
  --text-muted: oklch(0.705 0.015 286);
  --brand: oklch(0.65 0.16 255);
  --success: oklch(0.65 0.15 145);
  --warning: oklch(0.70 0.16 85);
  --danger: oklch(0.70 0.19 22);
  --gold: oklch(0.82 0.15 85);
  --mono: 'SF Mono','Fira Code','Cascadia Code','Menlo',monospace;
  --sans: -apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',sans-serif;
  --radius: 0.625rem;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { background:var(--bg); color:var(--text); font-family:var(--sans); font-size:14px; display:flex; height:100vh; overflow:hidden; }
a { color:var(--brand); text-decoration:none; }
a:hover { text-decoration:underline; }
::-webkit-scrollbar { width:6px; height:6px; }
::-webkit-scrollbar-track { background:transparent; }
::-webkit-scrollbar-thumb { background:oklch(1 0 0 / 8%); border-radius:3px; }
::-webkit-scrollbar-thumb:hover { background:oklch(1 0 0 / 18%); }

/* ── Sidebar ── */
.sidebar {
  width:220px; min-width:220px; background:var(--bg-sidebar);
  border-right:1px solid var(--border); display:flex; flex-direction:column;
  padding:16px 0; overflow-y:auto;
}
.sidebar-header {
  padding:0 16px 20px; display:flex; align-items:center; gap:10px;
}
.sidebar-header h1 { font-size:15px; font-weight:600; letter-spacing:-0.01em; display:flex; flex-direction:column; }
.sidebar-header h1 .by { font-size:10px; font-weight:400; color:var(--text-dim); letter-spacing:0; }
.sidebar-header .icon { color:var(--gold); font-size:16px; }
.sidebar-status {
  margin-left:auto; display:flex; align-items:center; gap:6px;
  font-size:11px; color:var(--text-dim);
}
.dot { width:6px; height:6px; border-radius:50%; }
.dot.on { background:var(--success); box-shadow:0 0 6px oklch(0.65 0.15 145 / 50%); }
.dot.off { background:var(--danger); }

.sidebar-nav { display:flex; flex-direction:column; gap:2px; padding:0 8px; }
.sidebar-label {
  font-size:11px; font-weight:500; color:var(--text-dim);
  text-transform:uppercase; letter-spacing:0.5px;
  padding:12px 8px 6px; user-select:none;
}
.nav-item {
  display:flex; align-items:center; gap:10px;
  padding:8px 12px; border-radius:calc(var(--radius) * 0.8);
  cursor:pointer; color:var(--text-muted); font-size:13px; font-weight:450;
  border:none; background:none; width:100%; text-align:left;
  transition:background .12s, color .12s;
}
.nav-item:hover { background:oklch(1 0 0 / 5%); color:var(--text); }
.nav-item.active { background:oklch(1 0 0 / 8%); color:var(--text); }
.nav-item svg { width:16px; height:16px; opacity:0.6; }
.nav-item.active svg { opacity:1; }

.sidebar-footer {
  margin-top:auto; padding:12px 16px; border-top:1px solid var(--border);
}
.wallet-mini { font-family:var(--mono); font-size:11px; color:var(--text-dim); }
.wallet-mini .bal { color:var(--gold); font-weight:600; font-size:13px; display:block; margin-bottom:2px; }

/* ── Currency watermark ── */
.content {
  flex:1; overflow-y:auto; padding:28px 32px; position:relative;
}
.content::before {
  content:''; position:fixed; top:0; right:0; bottom:0; width:calc(100% - 220px);
  pointer-events:none; z-index:0;
  background:
    /* Guilloche concentric rings — top right (gold) */
    radial-gradient(ellipse 700px 700px at 90% 8%, oklch(0.82 0.15 85 / 6%) 0%, oklch(0.82 0.15 85 / 3%) 15%, transparent 45%),
    radial-gradient(ellipse 600px 600px at 90% 8%, transparent 12%, oklch(0.82 0.15 85 / 5%) 12.5%, transparent 13.5%),
    radial-gradient(ellipse 600px 600px at 90% 8%, transparent 18%, oklch(0.82 0.15 85 / 4.5%) 18.5%, transparent 19.5%),
    radial-gradient(ellipse 600px 600px at 90% 8%, transparent 24%, oklch(0.82 0.15 85 / 4%) 24.5%, transparent 25.5%),
    radial-gradient(ellipse 600px 600px at 90% 8%, transparent 30%, oklch(0.82 0.15 85 / 3.5%) 30.5%, transparent 31.5%),
    radial-gradient(ellipse 600px 600px at 90% 8%, transparent 36%, oklch(0.82 0.15 85 / 3%) 36.5%, transparent 37.5%),
    radial-gradient(ellipse 600px 600px at 90% 8%, transparent 42%, oklch(0.82 0.15 85 / 2.5%) 42.5%, transparent 43.5%),
    /* Guilloche concentric rings — bottom left (green) */
    radial-gradient(ellipse 550px 550px at 15% 90%, oklch(0.65 0.15 145 / 5%) 0%, transparent 35%),
    radial-gradient(ellipse 450px 450px at 15% 90%, transparent 15%, oklch(0.65 0.15 145 / 3.5%) 15.5%, transparent 16.5%),
    radial-gradient(ellipse 450px 450px at 15% 90%, transparent 25%, oklch(0.65 0.15 145 / 3%) 25.5%, transparent 26.5%),
    radial-gradient(ellipse 450px 450px at 15% 90%, transparent 35%, oklch(0.65 0.15 145 / 2.5%) 35.5%, transparent 36.5%),
    /* Center rosette (very subtle) */
    radial-gradient(ellipse 300px 300px at 55% 50%, oklch(0.82 0.15 85 / 3%) 0%, transparent 30%),
    radial-gradient(ellipse 250px 250px at 55% 50%, transparent 20%, oklch(0.82 0.15 85 / 2.5%) 20.5%, transparent 21.5%),
    radial-gradient(ellipse 250px 250px at 55% 50%, transparent 30%, oklch(0.82 0.15 85 / 2%) 30.5%, transparent 31.5%),
    /* Fine crosshatch engraving */
    repeating-linear-gradient(45deg, oklch(1 0 0 / 2%) 0px, oklch(1 0 0 / 2%) 1px, transparent 1px, transparent 6px),
    repeating-linear-gradient(-45deg, oklch(1 0 0 / 1.5%) 0px, oklch(1 0 0 / 1.5%) 1px, transparent 1px, transparent 8px),
    repeating-linear-gradient(90deg, oklch(1 0 0 / 0.8%) 0px, oklch(1 0 0 / 0.8%) 1px, transparent 1px, transparent 16px);
}
.content::after {
  content:'$'; position:fixed; top:50%; right:calc((100% - 220px) / 2 + 110px);
  transform:translate(50%, -50%);
  font-family:var(--mono); font-size:420px; font-weight:900;
  color:oklch(0.82 0.15 85 / 6%); pointer-events:none; z-index:0;
  line-height:1;
  text-shadow:0 0 80px oklch(0.82 0.15 85 / 3%);
}
.content > * { position:relative; z-index:1; }
.content-header { margin-bottom:24px; }
.content-header h2 { font-size:20px; font-weight:600; letter-spacing:-0.02em; }
.content-header p { font-size:13px; color:var(--text-dim); margin-top:4px; }

.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:14px; }
.grid-4 { grid-template-columns:repeat(4,1fr); }
.card {
  background:var(--bg-card); border:1px solid var(--border);
  border-radius:var(--radius); padding:18px 20px;
}
.card h3 {
  font-size:11px; color:var(--text-dim); text-transform:uppercase;
  letter-spacing:0.5px; font-weight:500; margin-bottom:10px;
}
.metric { font-size:32px; font-weight:700; font-family:var(--mono); line-height:1.1; }
.metric.brand { color:var(--brand); }
.metric.success { color:var(--success); }
.metric.gold { color:var(--gold); }
.metric.warning { color:var(--warning); }
.sub { font-size:12px; color:var(--text-dim); margin-top:6px; }

/* ── Savings Hero ── */
.savings-hero {
  background:linear-gradient(135deg, oklch(0.25 0.03 145), oklch(0.21 0.006 286));
  border:1px solid oklch(0.65 0.15 145 / 15%);
  border-radius:var(--radius); padding:24px; margin-bottom:14px;
  display:flex; align-items:center; gap:24px;
}
.savings-amount { font-size:40px; font-weight:800; font-family:var(--mono); color:var(--success); line-height:1; }
.savings-detail { flex:1; }
.savings-detail .label { font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-muted); font-weight:500; margin-bottom:4px; }
.savings-detail .breakdown { font-size:13px; color:var(--text-muted); margin-top:8px; line-height:1.6; }
.savings-detail .breakdown span { color:var(--text); font-family:var(--mono); font-weight:500; }
.savings-pct {
  font-size:48px; font-weight:800; font-family:var(--mono);
  color:oklch(0.65 0.15 145 / 30%); line-height:1;
}

/* ── Bar chart ── */
.bar-chart { display:flex; flex-direction:column; gap:8px; }
.bar-row { display:flex; align-items:center; gap:10px; font-size:12px; }
.bar-label {
  width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--text-muted); font-family:var(--mono); font-size:12px;
}
.bar-track { flex:1; height:8px; background:oklch(1 0 0 / 5%); border-radius:4px; overflow:hidden; }
.bar-fill { height:100%; border-radius:4px; background:var(--brand); transition:width .4s ease; }
.bar-val { font-family:var(--mono); color:var(--text-dim); font-size:11px; min-width:60px; text-align:right; }

/* ── Daily chart ── */
.daily-chart { display:flex; align-items:flex-end; gap:3px; height:100px; padding-top:8px; }
.daily-bar {
  flex:1; background:var(--brand); border-radius:3px 3px 0 0; min-height:2px;
  transition:height .3s, opacity .15s; opacity:.5; position:relative; cursor:crosshair;
}
.daily-bar:hover { opacity:1; }
.daily-bar:hover::after {
  content:attr(data-tip); position:absolute; bottom:calc(100% + 6px); left:50%;
  transform:translateX(-50%); background:oklch(0.25 0.006 286); color:var(--text);
  font-size:10px; font-family:var(--mono); padding:3px 6px; border-radius:4px;
  white-space:nowrap; pointer-events:none; border:1px solid var(--border-strong);
}

/* ── Sessions ── */
.session-list { display:flex; flex-direction:column; gap:6px; }
.session-item {
  background:var(--bg-card); border:1px solid var(--border); border-radius:calc(var(--radius) * 0.8);
  padding:12px 16px; cursor:pointer; transition:background .12s, border-color .12s;
}
.session-item:hover { background:var(--bg-hover); border-color:var(--border-strong); }
.session-item .title { font-size:13px; font-weight:500; }
.session-item .meta { font-size:11px; color:var(--text-dim); font-family:var(--mono); margin-top:4px; }
.session-detail {
  background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius);
  padding:20px; margin-top:14px; max-height:60vh; overflow-y:auto;
}
.msg { margin-bottom:14px; }
.msg.user .role { color:var(--brand); }
.msg.assistant .role { color:var(--success); }
.msg .role { font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px; }
.msg pre { font-family:var(--mono); font-size:12px; white-space:pre-wrap; line-height:1.6; color:var(--text-muted); }

/* ── Learnings ── */
.learning-item {
  padding:10px 0; border-bottom:1px solid var(--border);
  display:flex; gap:12px; align-items:center;
}
.learning-item:last-child { border:none; }
.badge {
  font-size:10px; font-family:var(--mono); font-weight:600;
  padding:2px 8px; border-radius:4px; white-space:nowrap;
}
.badge.high { background:oklch(0.65 0.15 145 / 15%); color:var(--success); }
.badge.mid { background:oklch(0.70 0.16 85 / 15%); color:var(--warning); }
.badge.low { background:oklch(1 0 0 / 6%); color:var(--text-dim); }
.learning-text { flex:1; font-size:13px; color:var(--text-muted); line-height:1.4; }
.learning-count { font-size:11px; font-family:var(--mono); color:var(--text-dim); }

/* ── Search ── */
.search-box {
  width:100%; padding:10px 14px; background:oklch(1 0 0 / 4%); border:1px solid var(--border);
  border-radius:calc(var(--radius) * 0.8); color:var(--text); font-size:13px;
  margin-bottom:16px; outline:none; transition:border-color .15s;
}
.search-box::placeholder { color:var(--text-dim); }
.search-box:focus { border-color:var(--brand); }

.tab { display:none; }
.tab.active { display:block; }
.empty { color:var(--text-dim); text-align:center; padding:48px 24px; font-size:13px; }

@media (max-width:768px) {
  body { flex-direction:column; }
  .sidebar { width:100%; min-width:100%; flex-direction:row; padding:8px; overflow-x:auto; border-right:none; border-bottom:1px solid var(--border); }
  .sidebar-header, .sidebar-label, .sidebar-footer { display:none; }
  .sidebar-nav { flex-direction:row; gap:4px; padding:0; }
  .content { padding:16px; }
  .grid-4 { grid-template-columns:repeat(2,1fr); }
  .savings-hero { flex-direction:column; gap:12px; text-align:center; }
  .savings-pct { display:none; }
}
</style>
</head>
<body>

<!-- Sidebar -->
<aside class="sidebar">
  <div class="sidebar-header">
    <span class="icon">&#9670;</span>
    <h1>Franklin<span class="by">by BlockRun.ai</span></h1>
    <div class="sidebar-status">
      <span id="status">...</span>
      <span class="dot off" id="dot"></span>
    </div>
  </div>

  <div class="sidebar-label">Dashboard</div>
  <div class="sidebar-nav">
    <button class="nav-item active" data-tab="overview">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
      Overview
    </button>
    <button class="nav-item" data-tab="sessions">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      Sessions
    </button>
    <button class="nav-item" data-tab="social">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l11.733 16h4.267l-11.733-16z"/><path d="M4 20l6.768-6.768M15.232 11.232L20 4"/></svg>
      Social
    </button>
    <button class="nav-item" data-tab="learnings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
      Learnings
    </button>
  </div>

  <div class="sidebar-footer">
    <div class="wallet-mini">
      <span class="bal" id="sidebar-balance">—</span>
      <span id="sidebar-addr">Loading wallet...</span>
    </div>
  </div>
</aside>

<!-- Content -->
<div class="content">
  <!-- Overview -->
  <div class="tab active" id="tab-overview">
    <div class="content-header">
      <h2>Overview</h2>
      <p>Usage stats and cost breakdown</p>
    </div>

    <!-- Savings Hero -->
    <div class="savings-hero" id="savings-hero" style="display:none">
      <div>
        <div class="savings-detail">
          <div class="label">Saved vs Claude Opus</div>
        </div>
        <div class="savings-amount" id="savings-amount">—</div>
        <div class="savings-detail">
          <div class="breakdown">
            You spent <span id="savings-actual">—</span> instead of <span id="savings-opus">—</span>
          </div>
        </div>
      </div>
      <div class="savings-pct" id="savings-pct">—</div>
    </div>

    <div class="grid grid-4">
      <div class="card">
        <h3>Balance</h3>
        <div class="metric gold" id="balance">—</div>
        <div class="sub" id="wallet-chain">—</div>
      </div>
      <div class="card">
        <h3>Total Spent</h3>
        <div class="metric brand" id="total-cost">—</div>
        <div class="sub" id="total-requests">—</div>
      </div>
      <div class="card">
        <h3>Requests</h3>
        <div class="metric" id="request-count">—</div>
        <div class="sub" id="avg-cost">—</div>
      </div>
      <div class="card">
        <h3>Models Used</h3>
        <div class="metric" id="model-count">—</div>
        <div class="sub" id="period-info">—</div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>Daily Spend (30 days)</h3>
      <div class="daily-chart" id="daily-chart"></div>
    </div>
    <div class="card" style="margin-top:14px">
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
    <div class="card" style="margin-top:14px">
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

// API helpers
const api = (path) => fetch('/api/' + path).then(r => r.json()).catch(() => null);
const usd = (n) => '$' + (n || 0).toFixed(4);
const usdBig = (n) => '$' + (n || 0).toFixed(2);
const esc = (s) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Load overview
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

    const modelNames = Object.keys(stats.byModel || {});
    document.getElementById('model-count').textContent = modelNames.length;
    document.getElementById('period-info').textContent = stats.period || '';

    // Savings hero
    if (stats.opusCost > 0) {
      const saved = stats.saved || (stats.opusCost - stats.totalCostUsd);
      const pct = stats.savedPct || ((1 - stats.totalCostUsd / stats.opusCost) * 100);
      document.getElementById('savings-hero').style.display = 'flex';
      document.getElementById('savings-amount').textContent = usdBig(saved);
      document.getElementById('savings-pct').textContent = pct.toFixed(0) + '%';
      document.getElementById('savings-actual').textContent = usd(stats.totalCostUsd);
      document.getElementById('savings-opus').textContent = usdBig(stats.opusCost);
    }

    // Model chart
    const models = Object.entries(stats.byModel || {})
      .map(([name, d]) => ({ name, cost: d.costUsd || 0, reqs: d.requests || 0 }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 10);
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

// Load sessions
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
      const id = el.dataset.id;
      const history = await api('sessions/' + encodeURIComponent(id));
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

// Session search
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

// Load social
async function loadSocial() {
  const social = await api('social');
  if (!social) return;
  document.getElementById('social-stats').innerHTML =
    '<div class="card"><h3>Posted</h3><div class="metric success">' + (social.posted || 0) + '</div></div>' +
    '<div class="card"><h3>Drafted</h3><div class="metric">' + (social.drafted || 0) + '</div></div>' +
    '<div class="card"><h3>Skipped</h3><div class="metric">' + (social.skipped || 0) + '</div></div>' +
    '<div class="card"><h3>Social Cost</h3><div class="metric gold">' + usd(social.totalCost || 0) + '</div></div>';
}

// Load learnings
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

// SSE
const es = new EventSource('/api/events');
const dot = document.getElementById('dot');
const statusEl = document.getElementById('status');
es.onopen = () => { dot.className = 'dot on'; statusEl.textContent = 'live'; };
es.onerror = () => { dot.className = 'dot off'; statusEl.textContent = 'offline'; };
es.onmessage = (e) => {
  try {
    const evt = JSON.parse(e.data);
    if (evt.type === 'stats.updated') loadOverview();
  } catch {}
};

// Init
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
