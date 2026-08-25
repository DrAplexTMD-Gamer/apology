const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URLSearchParams } = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const MAX_BODY_BYTES = 45_000_000;
const MAX_VIDEO_UPLOAD_BYTES = Number(
  process.env.MAX_VIDEO_UPLOAD_BYTES || 150 * 1024 * 1024
);
const SUPABASE_TIMEOUT_MS = 12000;

const DATA_ROOT = '/tmp';

const PAGE_FILE = path.join(ROOT, 'apology_1.html');
const CONTENT_FILE = process.env.CONTENT_FILE || path.join(ROOT, 'content.json');
const CODES_FILE = path.join(DATA_ROOT, 'access-codes.json');
const STATE_FILE = path.join(DATA_ROOT, 'access-state.json');
const ANALYTICS_FILE = path.join(DATA_ROOT, 'analytics-log.json');
const VIDEO_BUCKET = process.env.SUPABASE_VIDEO_BUCKET || 'site-videos';

const SESSION_COOKIE = 'apology_session';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MASTER_CODE = process.env.MASTER_CODE || '';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();
const HAS_SUPABASE_CONFIG = Boolean(SUPABASE_URL && SUPABASE_KEY);
let supabase = null;

if (HAS_SUPABASE_CONFIG) {
  try {
    supabase = require('@supabase/supabase-js').createClient(
      SUPABASE_URL,
      SUPABASE_KEY
    );
  } catch (e) {
    console.error('Supabase client could not be created:', e);
  }
}

if (!fs.existsSync(CODES_FILE)) {
  writeJson(CODES_FILE, []);
}

if (!fs.existsSync(STATE_FILE)) {
  writeJson(STATE_FILE, {
    usedCodes: [],
    sessions: {}
  });
}

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

function timeoutAfter(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
}

async function withTimeout(promise, label) {
  return Promise.race([
    promise,
    timeoutAfter(SUPABASE_TIMEOUT_MS, label)
  ]);
}

async function getContent() {
  if (!supabase) {
    return readJson(CONTENT_FILE, {});
  }

  const { data, error } = await withTimeout(
    supabase
      .from('site_content')
      .select('content')
      .eq('id', 1)
      .single(),
    'Supabase content load'
  );

  if (error) throw error;

  writeJson(CONTENT_FILE, data.content);

  return data.content;
}

async function saveContent(content) {
  writeJson(CONTENT_FILE, content);

  if (!supabase) {
    return;
  }

  const { error } = await withTimeout(
    supabase
      .from('site_content')
      .update({ content })
      .eq('id', 1),
    'Supabase content save'
  );

  if (error) throw error;
}

async function saveAnalytics(payload) {
  if (!supabase) {
    // Fallback to local file
    let existing = [];
    try {
      existing = JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'));
    } catch {
      // File doesn't exist yet
    }

    // Find existing session by sessionId
    const existingIndex = existing.findIndex(item => item.sessionId === payload.sessionId);

    const sessionData = {
      ...payload,
      created_at: existingIndex === -1 ? new Date().toISOString() : existing[existingIndex].created_at,
      updated_at: new Date().toISOString()
    };

    if (existingIndex !== -1) {
      // Update existing session
      existing[existingIndex] = sessionData;
    } else {
      // Add new session
      existing.push(sessionData);
    }

    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(existing, null, 2));
    return;
  }

  // Save to Supabase - use upsert to update existing or insert new
  const { error } = await withTimeout(
    supabase
      .from('visitor_analytics')
      .upsert({
        session_id: payload.sessionId,
        ip: payload.ip,
        timestamp: payload.timestamp,
        user_agent: payload.userAgent,
        device: payload.device,
        screen_res: payload.screenRes,
        referrer: payload.referrer,
        total_duration: payload.totalDuration,
        page_views: payload.pageViews
      }, {
        onConflict: 'session_id'
      }),
    'Supabase analytics save'
  );

  if (error) throw error;
}

async function getAnalytics() {
  if (!supabase) {
    // Read from local file
    try {
      const data = JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'));
      return data.map(item => ({
        session_id: item.sessionId,
        ip: item.ip,
        timestamp: item.timestamp,
        device: item.device,
        screen_res: item.screenRes,
        referrer: item.referrer,
        total_duration: item.totalDuration,
        page_views: item.pageViews,
        created_at: item.created_at
      }));
    } catch {
      return [];
    }
  }

  // Fetch from Supabase
  const { data, error } = await withTimeout(
    supabase
      .from('visitor_analytics')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(1000),
    'Supabase analytics fetch'
  );

  if (error) throw error;
  return data || [];
}

function isVideoContentType(type) {
  return /^video\/[a-z0-9.+-]+$/i.test(String(type || ''));
}

function extensionForVideo(type, filename = '') {
  const fromName = path.extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, '');
  if (/^\.(mp4|m4v|mov|webm|ogv|ogg)$/i.test(fromName)) return fromName;

  const map = {
    'video/mp4': '.mp4',
    'video/x-m4v': '.m4v',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'video/ogg': '.ogv'
  };

  return map[String(type || '').toLowerCase()] || '.mp4';
}

async function uploadVideo(buffer, type, filename) {
  if (!supabase) {
    const err = new Error('Supabase is not configured, so videos cannot be uploaded.');
    err.statusCode = 503;
    throw err;
  }

  const ext = extensionForVideo(type, filename);
  const objectPath = `videos/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;

  const { error } = await withTimeout(
    supabase.storage
      .from(VIDEO_BUCKET)
      .upload(objectPath, buffer, {
        contentType: type || 'video/mp4',
        upsert: false
      }),
    'Supabase video upload'
  );

  if (error) throw error;

  const { data } = supabase.storage
    .from(VIDEO_BUCKET)
    .getPublicUrl(objectPath);

  if (!data || !data.publicUrl) {
    throw new Error('Video uploaded, but no public URL was returned.');
  }

  return {
    path: objectPath,
    url: data.publicUrl
  };
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

function publicError(e) {
  return e && e.message ? e.message : 'Unknown server error';
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, {
    Location: location,
    'Cache-Control': 'no-store',
    ...headers
  });

  res.end();
}

function serveSitePage(res) {
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
      // Ask Chromium browsers for the optional high-entropy client hints that
      // let the page record a model/OS version when the browser permits it.
      'Accept-CH': 'Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List, Sec-CH-UA-Form-Factors',
      'Permissions-Policy': 'ch-ua-high-entropy-values=(self)'
    });

    res.end(data);
  });
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
    placeholder="how many codes"
  >

  <p class="err">${escapeHtml(error)}</p>

  <button type="submit">generate</button>

  ${codesBlock}

  <p class="hint">
    New codes are saved to access-codes.json and printed here once.
  </p>
</form>`);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;

    req.on('data', chunk => {
      if (tooLarge) return;

      body += chunk;

      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true;
        body = '';

        const err = new Error(
          `Request body is too large. Limit is ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB.`
        );
        err.statusCode = 413;
        reject(err);
        req.pause();
      }
    });

    req.on('end', () => {
      if (!tooLarge) resolve(body);
    });
    req.on('error', reject);
  });
}

function collectBinaryBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', chunk => {
      if (tooLarge) return;

      size += chunk.length;

      if (size > limitBytes) {
        tooLarge = true;
        chunks.length = 0;

        const err = new Error(
          `Video is too large. Limit is ${Math.round(limitBytes / 1024 / 1024)} MB.`
        );
        err.statusCode = 413;
        reject(err);
        req.pause();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks));
    });
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
    if (
      req.method === 'GET' &&
      (req.url === '/' || req.url === '/site')
    ) {
      serveSitePage(res);
      return;
    }

    if (req.method === 'POST' && req.url === '/access') {
      redirect(res, '/');
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
      try {
        sendJson(res, 200, await getContent());
      } catch (e) {
        console.error('Content load failed:', e);
        sendJson(res, 200, {
          ...readJson(CONTENT_FILE, {}),
          _warning: `Could not load latest Supabase content: ${publicError(e)}`
        });
      }

      return;
    }

    if (
      req.method === 'POST' &&
      req.url.startsWith('/upload-video')
    ) {
      try {
        const contentType = String(req.headers['content-type'] || '').split(';')[0].trim();

        if (!isVideoContentType(contentType)) {
          const err = new Error('Please upload a valid video file.');
          err.statusCode = 415;
          throw err;
        }

        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const filename = url.searchParams.get('name') || '';
        const buffer = await collectBinaryBody(req, MAX_VIDEO_UPLOAD_BYTES);
        const result = await uploadVideo(buffer, contentType, filename);

        sendJson(res, 200, {
          ok: true,
          ...result
        });
      } catch (e) {
        console.error('Video upload failed:', e);
        sendJson(res, e.statusCode || 503, {
          ok: false,
          error: publicError(e),
          hint:
            e.statusCode === 413
              ? 'Choose a smaller video, or increase MAX_VIDEO_UPLOAD_BYTES if your host can handle it.'
              : `Make sure the Supabase Storage bucket "${VIDEO_BUCKET}" exists and is public.`
        });
      }

      return;
    }

    if (
      req.method === 'POST' &&
      req.url === '/save-content'
    ) {
      try {
        const body = await collectBody(req);
        const parsed = JSON.parse(body);

        await saveContent(parsed);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        console.error('Content save failed:', e);

        const status = e.statusCode || 503;
        sendJson(res, status, {
          ok: false,
          error: publicError(e),
          hint:
            status === 413
              ? 'The page data is too large. Remove some embedded photos or reduce photo sizes.'
              : 'Check SUPABASE_URL and SUPABASE_KEY in Render, then redeploy.'
        });
      }

      return;
    }

    if (req.method === 'POST' && req.url === '/log-analytics') {
      try {
        const body = await collectBody(req);
        const payload = JSON.parse(body);

        // Enrich with server-side IP
        payload.ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
                     || req.socket.remoteAddress
                     || 'Unknown';

        await saveAnalytics(payload);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        console.error('Analytics log failed:', e);
        sendJson(res, 500, { ok: false, error: publicError(e) });
      }
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/admin/analytics')) {
      try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        // Keep the password out of the URL wherever possible. Query-string
        // support is retained temporarily for existing direct API links.
        const headerPassword = req.headers['x-admin-password'];
        const password =
          (Array.isArray(headerPassword) ? headerPassword[0] : headerPassword) ||
          url.searchParams.get('password') ||
          '';

        // Verify password
        if (!ADMIN_PASSWORD) {
          sendJson(res, 503, {
            ok: false,
            error: 'Analytics is not configured: ADMIN_PASSWORD is missing in Render.'
          });
          return;
        }

        if (password !== ADMIN_PASSWORD) {
          sendJson(res, 401, { ok: false, error: 'Invalid password' });
          return;
        }

        const data = await getAnalytics();
        sendJson(res, 200, data);
      } catch (e) {
        console.error('Analytics fetch failed:', e);
        sendJson(res, 500, { ok: false, error: publicError(e) });
      }
      return;
    }

    send(res, 404, 'Not found.');
  } catch (e) {
    console.error(e);

    if (
      req.url === '/content' ||
      req.url === '/save-content' ||
      req.url.startsWith('/upload-video')
    ) {
      sendJson(res, e.statusCode || 500, {
        ok: false,
        error: publicError(e)
      });

      return;
    }

    send(res, 500, 'Server error.');
  }
});

server.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});
