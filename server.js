'use strict';

/* Blocky World family LAN server: no third-party packages or cloud services. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, '.blocky-world-data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const PORT = Number(process.env.BLOCKY_PORT || 8080);
const COOKIE = 'bw_session';
const SESSION_TTL = 8 * 60 * 60 * 1000;
const ALLOWED_USERS = ['p1', 'p2'];
const PUBLIC_FILES = new Set(['/index.html', '/style.css', '/js/network.js']);
let accounts = null;
let bootstrapCode = null;
const sessions = new Map();
const attempts = new Map();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

function reply(res, status, data, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra });
  res.end(JSON.stringify(data));
}
function cookies(req) {
  const values = Object.create(null);
  for (const entry of (req.headers.cookie || '').split(';')) {
    const at = entry.indexOf('=');
    if (at >= 0) values[entry.slice(0, at).trim()] = decodeURIComponent(entry.slice(at + 1).trim());
  }
  return values;
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '', size = 0;
    req.setEncoding('utf8');
    req.on('data', part => {
      size += Buffer.byteLength(part);
      if (size > limit) { reject(Object.assign(new Error('Request too large.'), { status: 413 })); req.destroy(); return; }
      raw += part;
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(Object.assign(new Error('Send valid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
function userFor(req) {
  const token = cookies(req)[COOKIE];
  const session = token && sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.lastSeen > SESSION_TTL) { sessions.delete(token); return null; }
  session.lastSeen = Date.now();
  const account = accounts && accounts.users[session.userId];
  return account ? { id: session.userId, displayName: account.displayName, token } : null;
}
function requireUser(req, res) {
  const user = userFor(req);
  if (!user) reply(res, 401, { error: 'Sign in to continue.' });
  return user;
}
function setCookie(res, token) {
  res.setHeader('Set-Cookie', COOKIE + '=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(SESSION_TTL / 1000));
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
}
function savePath(userId) { return path.join(DATA_DIR, 'world-' + userId + '.json'); }
async function readWorld(userId) {
  try {
    const world = JSON.parse(await fs.promises.readFile(savePath(userId), 'utf8'));
    if (world && world.version === 2 && Number.isInteger(world.seed)) return world;
  } catch (e) { if (e.code !== 'ENOENT') console.error('Could not read local world:', e.message); }
  return { version: 2, seed: 1337, player1: null, slot: 0, pick: null, settings: null, edits: [] };
}
async function writeWorld(userId, world) {
  const file = savePath(userId), temp = file + '.tmp';
  await fs.promises.writeFile(temp, JSON.stringify(world), { mode: 0o600 });
  await fs.promises.rename(temp, file);
}

async function handleApi(req, res, url) {
  const route = url.pathname, method = req.method;
  if (method !== 'GET' && !sameOrigin(req)) return reply(res, 403, { error: 'Use the Blocky World server origin.' });

  if (method === 'GET' && route === '/api/status') {
    if (!accounts) return reply(res, 200, { setupRequired: true, authenticated: false, profiles: ALLOWED_USERS });
    const user = userFor(req);
    return reply(res, 200, { setupRequired: false, authenticated: !!user, profiles: ALLOWED_USERS, user: user ? { id: user.id, displayName: user.displayName } : null });
  }

  if (method === 'POST' && route === '/api/setup') {
    if (accounts) return reply(res, 409, { error: 'Setup is already complete on this PC.' });
    const body = await readBody(req, 16 * 1024);
    if (!bootstrapCode || !safeEqual(String(body.bootstrapCode || ''), bootstrapCode)) return reply(res, 403, { error: 'That one-time setup code is not correct.' });
    if (!Array.isArray(body.users) || body.users.length !== 2 || body.users.some((u, i) =>
      !u || u.id !== ALLOWED_USERS[i] || typeof u.displayName !== 'string' || !u.displayName.trim() || u.displayName.length > 32 ||
      typeof u.pin !== 'string' || !/^\d{4,12}$/.test(u.pin))) {
      return reply(res, 400, { error: 'Enter two profile names and PINs from 4 to 12 digits.' });
    }
    const users = {};
    for (const input of body.users) {
      const salt = crypto.randomBytes(16).toString('hex');
      const key = await scrypt(input.pin, salt, 64);
      users[input.id] = { displayName: input.displayName.trim(), salt, pinHash: key.toString('hex') };
    }
    accounts = { version: 1, users };
    await fs.promises.writeFile(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), { mode: 0o600 });
    bootstrapCode = null;
    return reply(res, 201, { ok: true });
  }

  if (method === 'POST' && route === '/api/login') {
    if (!accounts) return reply(res, 409, { error: 'Complete setup on this PC first.' });
    const body = await readBody(req, 4096);
    const userId = String(body.userId || ''), pin = String(body.pin || '');
    if (!ALLOWED_USERS.includes(userId) || !/^\d{4,12}$/.test(pin)) return reply(res, 400, { error: 'Choose a profile and enter its PIN.' });
    const key = (req.socket.remoteAddress || 'unknown') + ':' + userId;
    const attempt = attempts.get(key) || { count: 0, blockedUntil: 0, lastTry: Date.now() };
    if (attempt.blockedUntil > Date.now()) return reply(res, 429, { error: 'Too many tries. Wait five minutes, then try again.' });
    const account = accounts.users[userId];
    const derived = await scrypt(pin, account.salt, 64);
    if (!safeEqual(derived.toString('hex'), account.pinHash)) {
      attempt.count++;
      attempt.lastTry = Date.now();
      if (attempt.count >= 5) { attempt.count = 0; attempt.blockedUntil = Date.now() + 5 * 60 * 1000; }
      attempts.set(key, attempt);
      return reply(res, 401, { error: 'That PIN did not match. Try again.' });
    }
    attempts.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { userId, lastSeen: Date.now() });
    setCookie(res, token);
    return reply(res, 200, { ok: true, user: { id: userId, displayName: account.displayName } });
  }

  if (method === 'POST' && route === '/api/logout') {
    const user = requireUser(req, res);
    if (!user) return;
    sessions.delete(user.token);
    clearCookie(res);
    return reply(res, 200, { ok: true });
  }

  const user = requireUser(req, res);
  if (!user) return;

  if (method === 'GET' && route === '/api/world') {
    return reply(res, 200, { ownerId: user.id, world: await readWorld(user.id) });
  }

  if (method === 'PUT' && route === '/api/world') {
    const body = await readBody(req, 2 * 1024 * 1024);
    const world = body.world;
    if (!world || typeof world !== 'object' || Array.isArray(world) || !Number.isInteger(world.seed) || world.seed < -2147483648 || world.seed > 2147483647)
      return reply(res, 400, { error: 'World save has an invalid format.' });
    const edits = Array.isArray(world.edits) ? world.edits : [];
    if (edits.length > 200000 || edits.some(e => !Array.isArray(e) || e.length !== 4 || e.some(n => !Number.isInteger(n)) || e[1] < 1 || e[1] > 99 || e[3] < 0 || e[3] > 255))
      return reply(res, 400, { error: 'World edits are invalid or too large.' });
    const safe = {
      version: 2, seed: world.seed,
      player1: Array.isArray(world.player1) && world.player1.length === 3 && world.player1.every(Number.isFinite) ? world.player1 : null,
      slot: Number.isInteger(world.slot) ? Math.max(0, Math.min(8, world.slot)) : 0,
      pick: world.pick && typeof world.pick === 'object' ? world.pick : null,
      settings: world.settings && typeof world.settings === 'object' ? world.settings : null,
      edits,
    };
    await writeWorld(user.id, safe);
    return reply(res, 200, { ok: true });
  }

  return reply(res, 404, { error: 'No such game service endpoint.' });
}

function serveFile(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, { error: 'Use GET for game files.' });
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return reply(res, 400, { error: 'Invalid URL.' }); }
  if (pathname === '/') pathname = '/index.html';
  if (pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.') && part !== '.')) return reply(res, 404, { error: 'Not found.' });
  const file = path.resolve(ROOT, '.' + pathname);
  const relative = path.relative(ROOT, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.startsWith('.blocky-world-data')) return reply(res, 404, { error: 'Not found.' });

  if (!userFor(req) && !PUBLIC_FILES.has(pathname)) return reply(res, 401, { error: 'Sign in to access the game.' });
  fs.readFile(file, (err, data) => {
    if (err) return reply(res, err.code === 'ENOENT' ? 404 : 403, { error: 'Not found.' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

async function start() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  try { accounts = JSON.parse(await fs.promises.readFile(ACCOUNTS_FILE, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; accounts = null; }
  if (accounts && (!accounts.users || ALLOWED_USERS.some(id => !accounts.users[id]))) throw new Error('The local profile store is invalid. Keep its backup and follow the recovery steps in README.md.');
  if (!accounts) bootstrapCode = crypto.randomBytes(9).toString('hex').toUpperCase();

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
    catch { return reply(res, 400, { error: 'Invalid URL.' }); }
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch(err => {
        if (!res.headersSent) reply(res, err.status || 500, { error: err.status ? err.message : 'The server could not complete the request.' });
        else res.destroy();
        if (!err.status) console.error('API error:', err);
      });
    } else serveFile(req, res, url);
  });
  setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) if (now - session.lastSeen > SESSION_TTL) sessions.delete(token);
    for (const [key, attempt] of attempts) if (!attempt.blockedUntil && now - attempt.lastTry > 60 * 60 * 1000) attempts.delete(key);
  }, 30_000).unref();

  server.listen(PORT, '0.0.0.0', () => {
    const addresses = [];
    for (const entries of Object.values(os.networkInterfaces())) for (const net of entries || []) if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    console.log('\n  Blocky World family LAN server\n  ---------------------------------------------');
    addresses.forEach(address => console.log('  On this network: http://' + address + ':' + PORT));
    console.log('  On this PC:      http://localhost:' + PORT);
    console.log('  LAN only: do not enable router port forwarding.');
    if (bootstrapCode) {
      console.log('\n  One-time setup code (enter it on this PC only): ' + bootstrapCode);
      console.log('  Create the two profiles in the game setup screen.');
    }
    console.log('\n  Keep this window open while the family plays. Press Ctrl+C to stop.\n');
  });
}

start().catch(err => { console.error('Could not start Blocky World:', err.message); process.exitCode = 1; });
