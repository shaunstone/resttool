'use strict';

// Remote Browser: runs Chromium on this machine and streams the active tab to
// any web browser over a WebSocket. Mouse/keyboard input from the viewer is
// replayed into the tab through the Chrome DevTools Protocol.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const puppeteer = require('puppeteer-core');

loadDotEnv(path.join(__dirname, '.env'));

const config = {
  host: process.env.HOST || '0.0.0.0',
  port: parseInt(process.env.PORT || '3300', 10),
  password: process.env.PASSWORD || '',
  noAuth: process.env.AUTH === 'none',
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionDays: parseFloat(process.env.SESSION_DAYS || '30'),
  chromePath: process.env.CHROME_PATH || findChrome(),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')),
  startUrl: process.env.START_URL || 'https://www.google.com',
  jpegQuality: parseInt(process.env.JPEG_QUALITY || '70', 10),
  maxDpr: parseFloat(process.env.MAX_DPR || '2'),
  noSandbox: process.env.NO_SANDBOX === '1' || process.getuid?.() === 0,
  headless: process.env.HEADLESS !== 'false',
};

if (!config.password && !config.noAuth) {
  console.error('Set PASSWORD=... (or AUTH=none if something else in front handles auth).');
  process.exit(1);
}
if (!config.chromePath) {
  console.error('Could not find Chromium/Chrome. Set CHROME_PATH=/path/to/chromium.');
  process.exit(1);
}

fs.mkdirSync(config.dataDir, { recursive: true });
const secret = config.sessionSecret || loadOrCreateSecret(path.join(config.dataDir, 'session.secret'));
const tabsFile = path.join(config.dataDir, 'tabs.json');

// ---------------------------------------------------------------------------
// Auth: password login -> HMAC-signed cookie
// ---------------------------------------------------------------------------

const COOKIE = 'rb_session';

function sign(value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeToken() {
  const exp = Date.now() + config.sessionDays * 86400e3;
  const payload = `${exp}.${crypto.randomBytes(8).toString('hex')}`;
  return `${payload}.${sign(payload)}`;
}

function validToken(token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(token.slice(i + 1));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;
  return Number(payload.split('.')[0]) > Date.now();
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  return config.noAuth || validToken(parseCookies(req.headers.cookie)[COOKIE]);
}

function passwordMatches(given) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(config.password).digest();
  return crypto.timingSafeEqual(a, b);
}

// Simple per-IP brute-force guard: 10 failures per 15 minutes.
const failures = new Map();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) return false;
  return f.count >= 10;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + 15 * 60e3 });
  else f.count++;
}

function clientIp(req) {
  // Only trust X-Forwarded-For from a reverse proxy on this machine, otherwise anyone could fake it.
  const direct = req.socket.remoteAddress || '';
  const local = /^(::1|127\.|::ffff:127\.)/.test(direct);
  return (local && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || direct;
}

function isHttps(req) {
  return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function sendFile(res, file) {
  fs.readFile(path.join(PUBLIC, file), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function redirect(res, to, headers = {}) {
  res.writeHead(303, { Location: to, ...headers });
  res.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/login' && req.method === 'GET') return sendFile(res, 'login.html');
  if (p === '/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (tooManyFailures(ip)) return redirect(res, '/login?e=locked');
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      const password = new URLSearchParams(body).get('password') || '';
      if (!passwordMatches(password)) { recordFailure(ip); return redirect(res, '/login?e=1'); }
      failures.delete(ip);
      const cookie = `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(config.sessionDays * 86400)}${isHttps(req) ? '; Secure' : ''}`;
      redirect(res, '/', { 'Set-Cookie': cookie });
    });
    return;
  }
  if (p === '/logout') return redirect(res, '/login', { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0` });
  if (p === '/login.css' || p === '/icon.svg' || p === '/manifest.webmanifest') return sendFile(res, p.slice(1));

  if (!isAuthed(req)) return redirect(res, '/login');

  if (p === '/' || p === '/index.html') return sendFile(res, 'index.html');
  if (p === '/app.js' || p === '/app.css') return sendFile(res, p.slice(1));
  res.writeHead(404);
  res.end('Not found');
});

// ---------------------------------------------------------------------------
// Browser + tab management
// ---------------------------------------------------------------------------

let browser;
const tabs = new Map(); // id -> { page, cdp }
const pageIds = new WeakMap();
let nextId = 1;
let activeId = null;
let viewport = { width: 1280, height: 800, dpr: 1, mobile: false, touch: false };
let screencasting = false;

function tabIdFor(page) {
  if (!pageIds.has(page)) pageIds.set(page, String(nextId++));
  return pageIds.get(page);
}

const registering = new Map(); // id -> promise, so concurrent callers share one registration

function registerPage(page) {
  const id = tabIdFor(page);
  if (tabs.has(id)) return Promise.resolve(id);
  if (!registering.has(id)) {
    registering.set(id, doRegister(page, id).finally(() => registering.delete(id)));
  }
  return registering.get(id);
}

async function doRegister(page, id) {
  const cdp = await page.createCDPSession();
  const tab = { page, cdp };
  tabs.set(id, tab);

  cdp.on('Page.screencastFrame', (frame) => {
    cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    if (id !== activeId) return;
    broadcastFrame(Buffer.from(frame.data, 'base64'), frame.metadata);
  });

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) { sendTabs(); saveTabs(); }
  });
  page.on('load', () => sendTabs());
  page.on('domcontentloaded', () => sendTabs());
  page.on('close', () => {
    tabs.delete(id);
    if (activeId === id) {
      const next = [...tabs.keys()].pop();
      if (next) activate(next);
      else newTab(config.startUrl);
    }
    sendTabs();
    saveTabs();
  });
  page.on('dialog', (dialog) => {
    // Forward alert/confirm/prompt to viewers; auto-dismiss if nobody is watching.
    if (clients.size === 0) return dialog.dismiss().catch(() => {});
    pendingDialog = { dialog, tabId: id };
    broadcast({ t: 'dialog', type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue() });
  });

  await applyViewport(page);
  return id;
}

async function applyViewport(page) {
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.dpr,
    isMobile: viewport.mobile,
    hasTouch: viewport.touch,
  }).catch(() => {});
}

async function startScreencast() {
  const tab = tabs.get(activeId);
  if (!tab || clients.size === 0) return;
  screencasting = true;
  await tab.cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: config.jpegQuality,
    maxWidth: Math.round(viewport.width * viewport.dpr),
    maxHeight: Math.round(viewport.height * viewport.dpr),
    everyNthFrame: 1,
  }).catch((e) => console.warn('startScreencast failed:', e.message));
}

async function stopScreencast(id = activeId) {
  const tab = tabs.get(id);
  screencasting = false;
  if (tab) await tab.cdp.send('Page.stopScreencast').catch(() => {});
}

async function restartScreencast() {
  await stopScreencast();
  await startScreencast();
}

async function activate(id) {
  if (!tabs.has(id)) return;
  if (activeId && activeId !== id) await stopScreencast(activeId);
  activeId = id;
  const { page } = tabs.get(id);
  await page.bringToFront().catch(() => {});
  await applyViewport(page);
  await startScreencast();
  sendTabs();
}

async function newTab(url) {
  const page = await browser.newPage();
  const id = await registerPage(page);
  await activate(id);
  if (url) navigate(page, url);
  saveTabs();
  return id;
}

function normalizeUrl(input) {
  const s = String(input || '').trim();
  if (!s) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (/^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(s) || /^localhost(:\d+)?(\/.*)?$/.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(s)) {
    return 'https://' + s;
  }
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);
}

function navigate(page, url) {
  page.goto(normalizeUrl(url), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
    if (!/net::ERR_ABORTED|Navigating frame was detached|Target closed/.test(e.message)) broadcast({ t: 'error', message: e.message });
  });
}

async function tabList() {
  const list = [];
  for (const [id, { page }] of tabs) {
    let title = '';
    try { title = await page.title(); } catch {}
    list.push({ id, url: page.url(), title, active: id === activeId });
  }
  return list;
}

let tabsTimer = null;
function sendTabs() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(async () => broadcast({ t: 'tabs', tabs: await tabList() }), 50);
}

function savedUrls() {
  return [...tabs.values()].map(({ page }) => page.url()).filter((u) => u && u !== 'about:blank' && !u.startsWith('chrome-error:'));
}

let saveTimer = null;
function saveTabs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(tabsFile, JSON.stringify({ urls: savedUrls(), active: [...tabs.keys()].indexOf(activeId) }), () => {});
  }, 500);
}

async function launchBrowser() {
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--password-store=basic',
  ];
  if (config.noSandbox) args.push('--no-sandbox', '--disable-setuid-sandbox');

  browser = await puppeteer.launch({
    executablePath: config.chromePath,
    headless: config.headless,
    userDataDir: path.join(config.dataDir, 'profile'),
    defaultViewport: null,
    args,
  });

  browser.on('targetcreated', async (target) => {
    if (target.type() !== 'page') return;
    const page = await target.page().catch(() => null);
    if (!page) return;
    const known = pageIds.has(page);
    const id = await registerPage(page);
    // Popups / target=_blank links become the active tab, like a normal browser.
    if (!known && target.opener()) activate(id);
    sendTabs();
  });

  browser.on('disconnected', () => {
    console.error('Chromium exited; shutting down so the service manager can restart us.');
    process.exit(1);
  });

  // Restore tabs from last run.
  let saved = { urls: [], active: 0 };
  try { saved = JSON.parse(fs.readFileSync(tabsFile, 'utf8')); } catch {}
  const urls = saved.urls?.length ? saved.urls : [config.startUrl];

  const existing = await browser.pages();
  const ids = [];
  for (let i = 0; i < urls.length; i++) {
    const page = existing[i] || (await browser.newPage());
    ids.push(await registerPage(page));
    navigate(page, urls[i]);
  }
  for (const extra of existing.slice(urls.length)) await extra.close().catch(() => {});
  await activate(ids[Math.min(Math.max(saved.active || 0, 0), ids.length - 1)]);
}

// ---------------------------------------------------------------------------
// WebSocket: frames out, input in
// ---------------------------------------------------------------------------

const clients = new Set();
let pendingDialog = null;
const MAX_BUFFERED = 2 * 1024 * 1024; // drop frames for viewers that fall behind

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === 1) ws.send(data);
}

function broadcastFrame(buf, meta) {
  const header = JSON.stringify({ t: 'frame', w: meta.deviceWidth, h: meta.deviceHeight, sy: meta.scrollOffsetY });
  for (const ws of clients) {
    if (ws.readyState !== 1 || ws.bufferedAmount > MAX_BUFFERED) continue;
    ws.send(header);
    ws.send(buf, { binary: true });
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !isAuthed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', async (ws, req) => {
  clients.add(ws);
  console.log(`viewer connected (${clientIp(req)}), ${clients.size} total`);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.send(JSON.stringify({ t: 'tabs', tabs: await tabList() }));
  // A fresh screencast always emits an initial frame, so new viewers see something immediately.
  restartScreencast();

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleMessage(ws, msg).catch((e) => console.warn('input error:', e.message));
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`viewer disconnected, ${clients.size} total`);
    if (clients.size === 0) stopScreencast();
  });
});

setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

async function handleMessage(ws, msg) {
  const tab = tabs.get(activeId);

  switch (msg.t) {
    case 'resize': {
      const width = clamp(Math.round(msg.width), 200, 3840);
      const height = clamp(Math.round(msg.height), 200, 2160);
      const dpr = clamp(Number(msg.dpr) || 1, 1, config.maxDpr);
      const mobile = !!msg.mobile;
      const touch = !!msg.touch;
      const v = viewport;
      if (width === v.width && height === v.height && dpr === v.dpr && mobile === v.mobile && touch === v.touch) return;
      viewport = { width, height, dpr, mobile, touch };
      if (tab) await applyViewport(tab.page);
      await restartScreencast();
      return;
    }
    case 'mouse': {
      if (!tab) return;
      await tab.cdp.send('Input.dispatchMouseEvent', {
        type: msg.type, // mousePressed | mouseReleased | mouseMoved
        x: msg.x, y: msg.y,
        button: msg.button || 'none',
        buttons: msg.buttons || 0,
        clickCount: msg.clickCount || 0,
        modifiers: msg.modifiers || 0,
      });
      return;
    }
    case 'wheel': {
      if (!tab) return;
      await tab.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: msg.x, y: msg.y, deltaX: msg.dx || 0, deltaY: msg.dy || 0, modifiers: msg.modifiers || 0,
      });
      return;
    }
    case 'touch': {
      if (!tab) return;
      await tab.cdp.send('Input.dispatchTouchEvent', {
        type: msg.type, // touchStart | touchMove | touchEnd | touchCancel
        touchPoints: (msg.points || []).map((p) => ({ x: p.x, y: p.y, id: p.id })),
        modifiers: msg.modifiers || 0,
      });
      return;
    }
    case 'key': {
      if (!tab) return;
      const printable = msg.text && msg.text.length === 1 && !(msg.modifiers & (2 | 4)); // no Ctrl/Meta
      const type = msg.type === 'keyUp' ? 'keyUp' : printable ? 'keyDown' : 'rawKeyDown';
      await tab.cdp.send('Input.dispatchKeyEvent', {
        type,
        key: msg.key,
        code: msg.code,
        text: type === 'keyDown' ? msg.text : undefined,
        unmodifiedText: type === 'keyDown' ? msg.text : undefined,
        windowsVirtualKeyCode: msg.keyCode || 0,
        nativeVirtualKeyCode: msg.keyCode || 0,
        modifiers: msg.modifiers || 0,
        location: msg.location || 0,
        autoRepeat: !!msg.repeat,
        commands: type === 'rawKeyDown' ? editCommands(msg) : undefined,
      });
      // After a copy/cut, ship the selected text back so the viewer can put it on their clipboard.
      if (type === 'rawKeyDown' && (msg.modifiers & 2) && (msg.code === 'KeyC' || msg.code === 'KeyX')) {
        const text = await tab.page.evaluate(() => {
          const el = document.activeElement;
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number') {
            return el.value.slice(el.selectionStart, el.selectionEnd);
          }
          return String(window.getSelection() || '');
        }).catch(() => '');
        if (text) ws.send(JSON.stringify({ t: 'clipboard', text }));
      }
      return;
    }
    case 'text': {
      // Text from paste or a phone's on-screen keyboard.
      if (!tab || typeof msg.text !== 'string') return;
      await tab.cdp.send('Input.insertText', { text: msg.text.slice(0, 100000) });
      return;
    }
    case 'navigate': if (tab) navigate(tab.page, msg.url); return;
    case 'back': if (tab) tab.page.goBack().catch(() => {}); return;
    case 'forward': if (tab) tab.page.goForward().catch(() => {}); return;
    case 'reload': if (tab) tab.page.reload().catch(() => {}); return;
    case 'newTab': await newTab(msg.url || config.startUrl); return;
    case 'switchTab': await activate(String(msg.id)); return;
    case 'closeTab': {
      const t = tabs.get(String(msg.id));
      if (t) await t.page.close().catch(() => {});
      return;
    }
    case 'dialog': {
      if (!pendingDialog) return;
      const { dialog } = pendingDialog;
      pendingDialog = null;
      if (msg.accept) await dialog.accept(msg.text ?? undefined).catch(() => {});
      else await dialog.dismiss().catch(() => {});
      broadcast({ t: 'dialogClosed' });
      return;
    }
    case 'refreshFrame': await restartScreencast(); return;
  }
}

// Editing shortcuts need explicit commands when keys are injected via CDP on Linux.
function editCommands(msg) {
  if (!(msg.modifiers & 2)) return undefined;
  const map = { KeyA: 'selectAll', KeyC: 'copy', KeyX: 'cut', KeyZ: msg.modifiers & 8 ? 'redo' : 'undo', KeyY: 'redo' };
  return map[msg.code] ? [map[msg.code]] : undefined;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findChrome() {
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function loadOrCreateSecret(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ---------------------------------------------------------------------------

(async () => {
  await launchBrowser();
  server.listen(config.port, config.host, () => {
    console.log(`Remote Browser listening on http://${config.host}:${config.port} (chromium: ${config.chromePath})`);
  });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    clearTimeout(saveTimer);
    try {
      fs.writeFileSync(tabsFile, JSON.stringify({ urls: savedUrls(), active: [...tabs.keys()].indexOf(activeId) }));
    } catch {}
    await browser?.close().catch(() => {});
    process.exit(0);
  });
}
