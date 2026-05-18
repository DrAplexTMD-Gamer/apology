const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URLSearchParams } = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;

const PAGE_FILE = path.join(ROOT, 'apology_1.html');
const CONTENT_FILE = path.join(ROOT, 'content.json');
const CODES_FILE = path.join(ROOT, 'access-codes.json');
const STATE_FILE = path.join(ROOT, 'access-state.json');

const SESSION_COOKIE = 'apology_session';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MASTER_CODE = process.env.MASTER_CODE || '';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function getContent() {
  return readJson(CONTENT_FILE, {
    name: "Her Name",
    sig: "— you know who",
    pages: []
  });
}

function saveContent(content) {
  writeJson(CONTENT_FILE, content);
}

function getCodes() {
  const fromFile = readJson(CODES_FILE, []);
  return Array.isArray(fromFile) ? fromFile.map(String) : [];
}

function saveCodes(codes) {
  writeJson(CODES_FILE, [...new Set(codes)]);
}

function getState() {
  const state = readJson(STATE_FILE, {
    usedCodes: [],
    sessions: {}
  });

  return {
    usedCodes: Array.isArray(state.usedCodes)
      ? state.usedCodes
      : [],
    sessions:
      state.sessions && typeof state.sessions === 'object'
        ? state.sessions
        : {}
  };
}

function parseCookies(req) {
  const header = req.headers.cookie || '';

  return Object.fromEntries(
    header
      .split(';')
      .map(part => {
        const [name, ...rest] = part.trim().split('=');
        return [name, decodeURIComponent(rest.join('='))];
      })
      .filter(([name]) => name)
  );
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
  return `
body{
  font-family:sans-serif;
  background:#f0ece6;
  display:flex;
  align-items:center;
  justify-content:center;
  min-height:100vh;
}
.box{
  width:min(92vw,420px);
  background:white;
  padding:2rem;
  border-radius:10px;
  text-align:center;
}
input,button{
  width:100%;
  margin-top:1rem;
  padding:0.8rem;
}
.err{
  color:#a06060;
  margin-top:0.7rem;
}
.codes{
  margin-top:1rem;
  text-align:left;
  white-space:pre-wrap;
  word-break:break-word;
}
`;
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
  return page(
    'for invited eyes',
    `
<form class="box" method="POST" action="/access">
  <h2>for invited eyes</h2>

  <input
    name="code"
    type="password"
    placeholder="enter code"
    autocomplete="one-time-code"
    autofocus
  >

  <div class="err">${escapeHtml(error)}</div>

  <button type="submit">enter</button>
</form>
`
  );
}

function adminPage(error = '', generatedCodes = []) {
  const codesBlock = generatedCodes.length
    ? `<div class="codes">${generatedCodes
        .map(escapeHtml)
        .join('\n')}</div>`
    : '';

  return page(
    'admin',
    `
<form class="box" method="POST" action="/admin/generate">
  <h2>code generator</h2>

  <input
    name="password"
    type="password"
    placeholder="admin password"
    autocomplete="current-password"
    autofocus
  >

  <input
    name="count"
    type="number"
    min="1"
    max="100"
    value="10"
  >

  <div class="err">${escapeHtml(error)}</div>

  <button type="submit">generate</button>

  ${codesBlock}
</form>
`
  );
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;

      if (body.length > 50_000_000) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function makeCode() {
  return `invite-${crypto.randomBytes(4).toString('hex')}`;
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
  const state = getState();

  if (code === MASTER_CODE && MASTER_CODE) {
    const token = crypto.randomBytes(32).toString('base64url');

    state.sessions[token] = {
      createdAt: new Date().toISOString()
    };

    writeJson(STATE_FILE, state);

    return {
      ok: true,
      token
    };
  }

  const codes = getCodes();

  if (!codes.includes(code)) {
    return {
      ok: false,
      error: 'invalid code.'
    };
  }

  if (state.usedCodes.includes(code)) {
    return {
      ok: false,
      error: 'that code has already been used.'
    };
  }

  const token = crypto.randomBytes(32).toString('base64url');

  state.usedCodes.push(code);

  state.sessions[token] = {
    createdAt: new Date().toISOString()
  };

  writeJson(STATE_FILE, state);

  return {
    ok: true,
    token
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      if (hasSession(req)) {
        redirect(res, '/site');
      } else {
        send(res, 200, loginPage());
      }

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

      fs.readFile(PAGE_FILE, (err, data) => {
        if (err) {
          send(
            res,
            500,
            'Could not load apology_1.html.'
          );

          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Set-Cookie':
            `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
        });

        res.end(data);
      });

      return;
    }

    if (req.method === 'POST' && req.url === '/access') {
      const body = await collectBody(req);

      const code =
        new URLSearchParams(body).get('code')?.trim() || '';

      const result = redeemCode(code);

      if (!result.ok) {
        send(res, 401, loginPage(result.error));
        return;
      }

      redirect(res, '/site', {
        'Set-Cookie':
          `${SESSION_COOKIE}=${encodeURIComponent(result.token)}; HttpOnly; SameSite=Lax; Path=/`
      });

      return;
    }

    if (req.method === 'GET' && req.url === '/admin') {
      send(res, 200, adminPage());
      return;
    }

    if (
      req.method === 'POST' &&
      req.url === '/admin/generate'
    ) {
      const body = await collectBody(req);

      const params = new URLSearchParams(body);

      const password = params.get('password') || '';

      const count = Number(params.get('count') || 10);

      if (!ADMIN_PASSWORD) {
        send(
          res,
          500,
          adminPage('ADMIN_PASSWORD is not set.')
        );

        return;
      }

      if (password !== ADMIN_PASSWORD) {
        send(
          res,
          401,
          adminPage('incorrect admin password.')
        );

        return;
      }

      if (
        !Number.isInteger(count) ||
        count < 1 ||
        count > 100
      ) {
        send(
          res,
          400,
          adminPage('choose between 1 and 100.')
        );

        return;
      }

      const generated = generateCodes(count);

      send(res, 200, adminPage('', generated));

      return;
    }

    if (req.method === 'GET' && req.url === '/content') {
      sendJson(res, 200, getContent());
      return;
    }

    if (
      req.method === 'POST' &&
      req.url === '/save-content'
    ) {
      const body = await collectBody(req);

      const parsed = JSON.parse(body);

      saveContent(parsed);

      sendJson(res, 200, { ok: true });

      return;
    }

    send(res, 404, 'Not found.');
  } catch (e) {
    console.error(e);

    send(res, 500, 'Server error.');
  }
});

server.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});