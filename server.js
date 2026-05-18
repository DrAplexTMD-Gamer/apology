const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URLSearchParams } = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PAGE_FILE = path.join(ROOT, 'apology_1.html');
const CODES_FILE = path.join(ROOT, 'access-codes.json');
const STATE_FILE = path.join(ROOT, 'access-state.json');
const SESSION_COOKIE = 'apology_session';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function getCodes() {
  const fromEnv = (process.env.SITE_CODES || '')
    .split(',')
    .map(code => code.trim())
    .filter(Boolean);

  if (fromEnv.length) return fromEnv;

  const fromFile = readJson(CODES_FILE, []);
  return Array.isArray(fromFile) ? fromFile.map(String) : [];
}

function saveCodes(codes) {
  writeJson(CODES_FILE, [...new Set(codes)]);
}

function getState() {
  const state = readJson(STATE_FILE, { usedCodes: [], sessions: {} });
  return {
    usedCodes: Array.isArray(state.usedCodes) ? state.usedCodes : [],
    sessions: state.sessions && typeof state.sessions === 'object' ? state.sessions : {}
  };
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').map(part => {
    const [name, ...rest] = part.trim().split('=');
    return [name, decodeURIComponent(rest.join('='))];
  }).filter(([name]) => name));
}

function hasSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;

  const state = getState();
  return Boolean(state.sessions[token]);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(value, null, 2));
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, {
    Location: location,
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function baseStyles() {
  return `@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300;1,400&family=Jost:wght@300;400&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
html,body{min-height:100%;background:#f0ece6;color:#3a3530;}
body{min-height:100svh;display:flex;align-items:center;justify-content:center;padding:calc(1.5rem + env(safe-area-inset-top)) calc(1rem + env(safe-area-inset-right)) calc(1.5rem + env(safe-area-inset-bottom)) calc(1rem + env(safe-area-inset-left));}
.box{width:min(100%,430px);text-align:center;background:rgba(245,241,235,0.72);border:1px solid #ddd5c8;border-radius:6px;padding:2rem 1.6rem;box-shadow:0 20px 70px rgba(58,53,48,0.12);}
.title{font-family:'Cormorant Garamond',serif;font-size:1.65rem;font-weight:300;font-style:italic;color:#3a3530;margin-bottom:0.5rem;}
.sub{font-family:'Jost',sans-serif;font-size:10px;font-weight:300;letter-spacing:0.16em;text-transform:uppercase;color:#9c8f82;margin-bottom:1.4rem;}
input{font-family:'Jost',sans-serif;font-size:13px;font-weight:300;border:none;border-bottom:1px solid #c8bfb5;background:transparent;outline:none;width:100%;padding:7px 0 8px;color:#3a3530;text-align:center;letter-spacing:0.08em;margin-top:0.5rem;}
.err{font-family:'Jost',sans-serif;font-size:11px;color:#a06060;min-height:16px;margin-top:0.8rem;letter-spacing:0.06em;}
button,.link-btn{font-family:'Jost',sans-serif;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;margin-top:0.9rem;padding:9px 22px;border-radius:99px;cursor:pointer;background:#3a3530;color:#f0ece6;border:1px solid #3a3530;text-decoration:none;display:inline-block;}
.codes{font-family:'Jost',sans-serif;font-size:12px;text-align:left;line-height:1.8;background:#eee9e2;border-radius:4px;padding:1rem;margin-top:1rem;white-space:pre-wrap;word-break:break-word;}
.hint{font-family:'Jost',sans-serif;font-size:11px;color:#9c8f82;line-height:1.7;margin-top:1rem;}
@media (max-width:640px){.box{padding:1.65rem 1.15rem;}}`;
}

function page(title, body) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${baseStyles()}</style>
</head>
<body>${body}</body>
</html>`;
}

function loginPage(error = '') {
  return page('for invited eyes', `<form class="box" method="POST" action="/access">
  <p class="title">for invited eyes</p>
  <p class="sub">enter your one-time code</p>
  <input name="code" type="password" autocomplete="one-time-code" autofocus>
  <p class="err">${escapeHtml(error)}</p>
  <button type="submit">enter</button>
</form>`);
}

function adminPage(error = '', generatedCodes = []) {
  const codesBlock = generatedCodes.length
    ? `<div class="codes">${generatedCodes.map(escapeHtml).join('\n')}</div>`
    : '';

  return page('admin', `<form class="box" method="POST" action="/admin/generate">
  <p class="title">code maker</p>
  <p class="sub">private admin generator</p>
  <input name="password" type="password" placeholder="admin password" autocomplete="current-password" autofocus>
  <input name="count" type="number" min="1" max="100" value="10" placeholder="how many codes">
  <p class="err">${escapeHtml(error)}</p>
  <button type="submit">generate</button>
  ${codesBlock}
  <p class="hint">New codes are saved to access-codes.json and printed here once. Keep them somewhere safe before leaving this page.</p>
</form>`);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 20_000) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function makeCode() {
  return `invite-${crypto.randomBytes(4).toString('hex')}-${crypto.randomBytes(4).toString('hex')}`;
}

function generateCodes(count) {
  const existing = getCodes();
  const seen = new Set(existing);
  const generated = [];

  while (generated.length < count) {
    const code = makeCode();
    if (seen.has(code)) continue;
    seen.add(code);
    generated.push(code);
  }

  saveCodes([...existing, ...generated]);
  return generated;
}

function redeemCode(code) {
  const codes = getCodes();
  const state = getState();

  if (!codes.includes(code)) return { ok: false, error: 'invalid code.' };
  if (state.usedCodes.includes(code)) return { ok: false, error: 'that code has already been used.' };

  const token = crypto.randomBytes(32).toString('base64url');
  state.usedCodes.push(code);
  state.sessions[token] = { createdAt: new Date().toISOString() };
  writeJson(STATE_FILE, state);

  return { ok: true, token };
}

function servePage(res) {
  fs.readFile(PAGE_FILE, (err, data) => {
    if (err) {
      send(res, 500, 'Could not load apology_1.html. Make sure it is in the same folder as server.js.');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      if (hasSession(req)) redirect(res, '/site');
      else send(res, 200, loginPage());
      return;
    }

    if (req.method === 'GET' && req.url === '/site') {
  if (!hasSession(req)) {
    redirect(res, '/');
    return;
  }

  const token = parseCookies(req)[SESSION_COOKIE];
  const state = getState();

  delete state.sessions[token];
  writeJson(STATE_FILE, state);

  servePage(res);

  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  );

  return;
}

    if (req.method === 'POST' && req.url === '/access') {
      const body = await collectBody(req);
      const code = new URLSearchParams(body).get('code')?.trim() || '';
      const result = redeemCode(code);

      if (!result.ok) {
        send(res, 401, loginPage(result.error));
        return;
      }

      redirect(res, '/site', {
        'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(result.token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/admin') {
      send(res, 200, adminPage());
      return;
    }

    if (req.method === 'POST' && req.url === '/admin/generate') {
      const body = await collectBody(req);
      const params = new URLSearchParams(body);
      const password = params.get('password') || '';
      const count = Number(params.get('count') || 10);

      if (!ADMIN_PASSWORD) {
        send(res, 500, adminPage('ADMIN_PASSWORD is not set on the server.'));
        return;
      }

      if (password !== ADMIN_PASSWORD) {
        send(res, 401, adminPage('incorrect admin password.'));
        return;
      }

      if (!Number.isInteger(count) || count < 1 || count > 100) {
        send(res, 400, adminPage('choose between 1 and 100 codes.'));
        return;
      }

      const generated = generateCodes(count);
      send(res, 200, adminPage('', generated));
      return;
    }

    if (req.method === 'GET' && req.url === '/admin/codes.json') {
      sendJson(res, 200, { codes: getCodes(), usedCodes: getState().usedCodes });
      return;
    }

    send(res, 404, 'Not found.');
  } catch (e) {
    send(res, 500, 'Server error.');
  }
});

server.listen(PORT, () => {
  console.log(`Apology site running at http://localhost:${PORT}`);
});