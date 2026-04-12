/**
 * Franklin Panel — embedded HTML dashboard.
 * Single page, dark theme, zero dependencies.
 */

export function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Franklin Panel</title>
<style>
:root {
  --bg: #0a0a0f;
  --bg-card: #12121a;
  --bg-hover: #1a1a2a;
  --border: #2a2a3a;
  --text: #e0e0e8;
  --text-dim: #6a6a7a;
  --accent: #10b981;
  --gold: #ffd700;
  --blue: #60a5fa;
  --danger: #ef4444;
  --mono: 'SF Mono','Fira Code','Cascadia Code','Menlo',monospace;
  --sans: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { background:var(--bg); color:var(--text); font-family:var(--sans); font-size:14px; }
a { color:var(--blue); text-decoration:none; }
a:hover { text-decoration:underline; }

header {
  display:flex; align-items:center; justify-content:space-between;
  padding:16px 24px; border-bottom:1px solid var(--border);
}
header h1 { font-size:18px; font-weight:600; }
header h1 span { color:var(--gold); }
.dot { width:8px; height:8px; border-radius:50%; display:inline-block; margin-left:8px; }
.dot.on { background:var(--accent); animation:pulse 2s infinite; }
.dot.off { background:var(--danger); }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }

nav { display:flex; gap:0; border-bottom:1px solid var(--border); padding:0 24px; }
nav button {
  background:none; border:none; color:var(--text-dim); padding:12px 20px;
  cursor:pointer; font-size:14px; border-bottom:2px solid transparent;
  transition:all .15s;
}
nav button:hover { color:var(--text); }
nav button.active { color:var(--accent); border-bottom-color:var(--accent); }

main { padding:24px; max-width:1200px; margin:0 auto; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:16px; }
.card {
  background:var(--bg-card); border:1px solid var(--border);
  border-radius:8px; padding:16px 20px;
}
.card h3 { font-size:12px; color:var(--text-dim); text-transform:uppercase; letter-spacing:.5px; margin-bottom:12px; }
.big { font-size:28px; font-weight:700; font-family:var(--mono); }
.big.gold { color:var(--gold); }
.big.green { color:var(--accent); }
.sub { font-size:12px; color:var(--text-dim); margin-top:4px; }

.bar-chart { display:flex; flex-direction:column; gap:6px; }
.bar-row { display:flex; align-items:center; gap:8px; font-size:12px; }
.bar-label { width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-dim); font-family:var(--mono); }
.bar-fill { height:16px; border-radius:3px; background:var(--accent); min-width:2px; transition:width .3s; }
.bar-val { font-family:var(--mono); color:var(--text-dim); font-size:11px; }

.daily-chart { display:flex; align-items:flex-end; gap:2px; height:80px; }
.daily-bar { flex:1; background:var(--accent); border-radius:2px 2px 0 0; min-height:2px; transition:height .3s; opacity:.7; }
.daily-bar:hover { opacity:1; }

.session-list { display:flex; flex-direction:column; gap:8px; }
.session-item {
  background:var(--bg-card); border:1px solid var(--border); border-radius:6px;
  padding:12px 16px; cursor:pointer; transition:background .15s;
}
.session-item:hover { background:var(--bg-hover); }
.session-item .meta { font-size:12px; color:var(--text-dim); font-family:var(--mono); }
.session-detail { background:var(--bg-card); border:1px solid var(--border); border-radius:8px; padding:16px; margin-top:12px; }
.msg { margin-bottom:12px; }
.msg.user { color:var(--blue); }
.msg.assistant { color:var(--text); }
.msg pre { font-family:var(--mono); font-size:12px; white-space:pre-wrap; line-height:1.5; }

.learning-item { padding:8px 0; border-bottom:1px solid var(--border); display:flex; gap:12px; align-items:center; }
.learning-item:last-child { border:none; }
.confidence { font-size:11px; font-family:var(--mono); padding:2px 6px; border-radius:3px; }
.confidence.high { background:#10b98133; color:var(--accent); }
.confidence.mid { background:#ffd70033; color:var(--gold); }
.confidence.low { background:#6a6a7a33; color:var(--text-dim); }

.search-box {
  width:100%; padding:10px 16px; background:var(--bg-card); border:1px solid var(--border);
  border-radius:6px; color:var(--text); font-size:14px; margin-bottom:16px; outline:none;
}
.search-box:focus { border-color:var(--accent); }
.tab { display:none; }
.tab.active { display:block; }
.empty { color:var(--text-dim); text-align:center; padding:40px; }
</style>
</head>
<body>

<header>
  <h1><span>◆</span> Franklin Panel</h1>
  <div>
    <span id="status" style="font-size:12px;color:var(--text-dim)">connecting</span>
    <span class="dot off" id="dot"></span>
  </div>
</header>

<nav>
  <button class="active" data-tab="overview">Overview</button>
  <button data-tab="sessions">Sessions</button>
  <button data-tab="social">Social</button>
  <button data-tab="learnings">Learnings</button>
</nav>

<main>
  <!-- Overview -->
  <div class="tab active" id="tab-overview">
    <div class="grid">
      <div class="card">
        <h3>Wallet</h3>
        <div class="big gold" id="balance">—</div>
        <div class="sub" id="wallet-addr">Loading...</div>
      </div>
      <div class="card">
        <h3>Total Spent</h3>
        <div class="big green" id="total-cost">—</div>
        <div class="sub" id="total-requests">— requests</div>
      </div>
      <div class="card">
        <h3>Savings vs Opus</h3>
        <div class="big green" id="savings">—</div>
        <div class="sub">compared to Claude Opus pricing</div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>Daily Cost (30 days)</h3>
      <div class="daily-chart" id="daily-chart"></div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>Model Usage</h3>
      <div class="bar-chart" id="model-chart"></div>
    </div>
  </div>

  <!-- Sessions -->
  <div class="tab" id="tab-sessions">
    <input class="search-box" id="session-search" placeholder="Search sessions..." />
    <div class="session-list" id="session-list"></div>
    <div class="session-detail" id="session-detail" style="display:none"></div>
  </div>

  <!-- Social -->
  <div class="tab" id="tab-social">
    <div class="grid" id="social-stats"></div>
    <div class="card" style="margin-top:16px">
      <h3>Recent Activity</h3>
      <div id="social-feed" class="empty">No social activity yet</div>
    </div>
  </div>

  <!-- Learnings -->
  <div class="tab" id="tab-learnings">
    <div id="learnings-list"></div>
  </div>
</main>

<script>
// Tab switching
document.querySelectorAll('nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// API helpers
const api = (path) => fetch('/api/' + path).then(r => r.json()).catch(() => null);

// Format currency
const usd = (n) => '$' + (n || 0).toFixed(4);
const usdBig = (n) => '$' + (n || 0).toFixed(2);

// Load overview
async function loadOverview() {
  const [wallet, stats, insights] = await Promise.all([
    api('wallet'), api('stats'), api('insights?days=30')
  ]);

  if (wallet) {
    document.getElementById('balance').textContent = usdBig(wallet.balance) + ' USDC';
    document.getElementById('wallet-addr').textContent = wallet.address + ' (' + wallet.chain + ')';
  }

  if (stats) {
    document.getElementById('total-cost').textContent = usd(stats.totalCostUsd);
    document.getElementById('total-requests').textContent = stats.totalRequests.toLocaleString() + ' requests';
    if (stats.opusCost > 0) {
      const pct = ((1 - stats.totalCostUsd / stats.opusCost) * 100).toFixed(0);
      document.getElementById('savings').textContent = pct + '%';
    }

    // Model chart
    const models = Object.entries(stats.byModel || {})
      .map(([name, d]) => ({ name, cost: d.costUsd || 0 }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 10);
    const maxCost = Math.max(...models.map(m => m.cost), 0.001);
    document.getElementById('model-chart').innerHTML = models.map(m =>
      '<div class="bar-row">' +
        '<span class="bar-label">' + m.name.split('/').pop() + '</span>' +
        '<div class="bar-fill" style="width:' + (m.cost/maxCost*100) + '%"></div>' +
        '<span class="bar-val">' + usd(m.cost) + '</span>' +
      '</div>'
    ).join('');
  }

  if (insights && insights.dailyCosts) {
    const days = insights.dailyCosts.slice(-30);
    const maxDay = Math.max(...days.map(d => d.cost), 0.001);
    document.getElementById('daily-chart').innerHTML = days.map(d =>
      '<div class="daily-bar" title="' + d.date + ': ' + usd(d.cost) + '" style="height:' + (d.cost/maxDay*100) + '%"></div>'
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
    '<div class="session-item" data-id="' + s.id + '">' +
      '<div>' + (s.model || 'unknown') + ' — ' + s.messageCount + ' messages</div>' +
      '<div class="meta">' + new Date(s.createdAt).toLocaleString() + ' · ' + (s.workDir || '').split('/').pop() + '</div>' +
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
        text = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return '<div class="msg ' + role + '"><pre>' + role.toUpperCase() + ': ' + text + '</pre></div>';
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
        '<div>' + r.snippet.replace(/</g, '&lt;') + '</div>' +
        '<div class="meta">' + r.sessionId + ' · score: ' + r.score.toFixed(2) + '</div>' +
      '</div>'
    ).join('');
  }, 300);
});

// Load social
async function loadSocial() {
  const social = await api('social');
  if (!social) { return; }
  document.getElementById('social-stats').innerHTML =
    '<div class="card"><h3>Posted</h3><div class="big green">' + (social.posted || 0) + '</div></div>' +
    '<div class="card"><h3>Drafted</h3><div class="big">' + (social.drafted || 0) + '</div></div>' +
    '<div class="card"><h3>Skipped</h3><div class="big">' + (social.skipped || 0) + '</div></div>' +
    '<div class="card"><h3>Total Cost</h3><div class="big gold">' + usd(social.totalCost || 0) + '</div></div>';
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
        '<span class="confidence ' + cls + '">' + (l.confidence * 100).toFixed(0) + '%</span>' +
        '<span>' + l.learning + '</span>' +
        '<span style="margin-left:auto;color:var(--text-dim);font-size:11px">×' + l.times_confirmed + '</span>' +
      '</div>';
    }).join('');
}

// SSE
const es = new EventSource('/api/events');
const dot = document.getElementById('dot');
const statusEl = document.getElementById('status');
es.onopen = () => { dot.className = 'dot on'; statusEl.textContent = 'live'; };
es.onerror = () => { dot.className = 'dot off'; statusEl.textContent = 'disconnected'; };
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
// Refresh wallet balance every 30s
setInterval(() => api('wallet').then(w => {
  if (w) document.getElementById('balance').textContent = usdBig(w.balance) + ' USDC';
}), 30000);
</script>
</body>
</html>`;
}
