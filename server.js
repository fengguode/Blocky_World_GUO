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
let setupInProgress = false;
const sessions = new Map();
const attempts = new Map();
const inFlightLogins = new Set();
const worldWrites = new Map();
const visits = new Map();
const closedVisitSessions = new Map();
const MAX_CONCURRENT_PIN_CHECKS = 4;
const VISIT_HEARTBEAT_TIMEOUT = 3500;
const VISIT_REQUEST_TTL = 45_000;
const VISIT_CLOSED_TTL = 30_000;
const VISIT_EVENT_LIMIT = 5000;
const CHARACTER_IDS = new Set(['steve', 'alex', 'spider', 'doll', 'golem', 'ninja']);

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
    if (world && world.version === 2 && Number.isInteger(world.seed)) {
      if (!Number.isSafeInteger(world.revision) || world.revision < 0) world.revision = 0;
      return world;
    }
  } catch (e) { if (e.code !== 'ENOENT') console.error('Could not read local world:', e.message); }
  return { version: 2, revision: 0, seed: 1337, player1: null, slot: 0, pick: null, settings: null, edits: [] };
}
async function writeWorld(userId, world, commitAllowed) {
  const previous = worldWrites.get(userId) || Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    if (commitAllowed && !commitAllowed()) throw Object.assign(new Error('The live visit ended before this change could be saved.'), { status: 410 });
    const current = await readWorld(userId);
    if (current.revision >= Number.MAX_SAFE_INTEGER) {
      throw Object.assign(new Error('The world save revision limit has been reached.'), { status: 507 });
    }
    const nextRevision = current.revision + 1;
    if (world.editPatch === true) {
      // Patches carry changed blocks, so serialize them after the latest writer.
      // Never trust a client-provided revision to move the server's counter.
      world.revision = nextRevision;
    } else if (!Number.isSafeInteger(world.revision) || world.revision < 0) {
      world.revision = nextRevision;
    } else if (world.revision < current.revision) {
      throw Object.assign(new Error('A newer world save already exists. Refresh and sign in again.'), { status: 409 });
    } else if (world.revision > nextRevision) {
      throw Object.assign(new Error('The world save revision is invalid. Refresh and try again.'), { status: 409 });
    }
    let persisted = world;
    if (world.editPatch === true) {
      const merged = new Map((world.replaceEdits === true ? [] : current.edits).map(edit => [edit[0] + ',' + edit[1] + ',' + edit[2], edit]));
      for (const edit of world.edits) merged.set(edit[0] + ',' + edit[1] + ',' + edit[2], edit);
      persisted = Object.assign({}, world.preserveMetadata === true ? current : world, {
        revision: world.revision,
        edits: Array.from(merged.values()),
      });
    }
    delete persisted.editPatch;
    delete persisted.replaceEdits;
    delete persisted.preserveMetadata;
    if (world.revision === current.revision) {
      if (JSON.stringify(persisted) === JSON.stringify(current)) return;
      throw Object.assign(new Error('A different world save already exists at this revision. Refresh and sign in again.'), { status: 409 });
    }
    const file = savePath(userId), temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    try {
      await fs.promises.writeFile(temp, JSON.stringify(persisted), { mode: 0o600 });
      if (commitAllowed && !commitAllowed()) throw Object.assign(new Error('The live visit ended before this change could be saved.'), { status: 410 });
      await fs.promises.rename(temp, file);
    } catch (error) {
      await fs.promises.unlink(temp).catch(() => {});
      throw error;
    }
  });
  worldWrites.set(userId, write);
  try { await write; }
  finally { if (worldWrites.get(userId) === write) worldWrites.delete(userId); }
  return world.revision;
}

function visitByUser(user) {
  const owned = visits.get(user.id);
  if (owned && owned.ownerToken === user.token && owned.status !== 'closed') return { room: owned, role: 'owner' };
  for (const room of visits.values()) {
    if (room.pending && room.pending.visitorId === user.id && room.pending.visitorToken === user.token) return { room, role: 'pending' };
    if (room.visitorId === user.id && room.visitorToken === user.token) return { room, role: 'visitor' };
  }
  const closed = closedVisitSessions.get(user.token);
  if (closed && closed.expiresAt > Date.now()) return { room: closed.room, role: closed.role, closed: true };
  return null;
}

function appendVisitEvent(room, actorId, type, data) {
  room.seq++;
  room.events.push({ seq: room.seq, actorId, type, data });
  if (room.events.length > VISIT_EVENT_LIMIT) room.events.splice(0, room.events.length - VISIT_EVENT_LIMIT);
}

function closeVisit(room, reason) {
  if (!room || room.status === 'closed') return;
  room.status = 'closed';
  room.closedAt = Date.now();
  room.closeReason = reason || 'The host is no longer available.';
  appendVisitEvent(room, null, 'closed', { reason: room.closeReason });
  for (const [token, role] of [[room.ownerToken, 'owner'], [room.visitorToken, 'visitor'], [room.pending && room.pending.visitorToken, 'pending']]) {
    if (token) closedVisitSessions.set(token, { room, role, expiresAt: room.closedAt + VISIT_CLOSED_TTL });
  }
  room.pending = null;
  room.visitorId = null;
  room.visitorToken = null;
  room.visitorNeedsWorld = false;
  room.visitorWorldSent = false;
}

function safePlayerState(value) {
  if (!value || typeof value !== 'object') return null;
  const pos = value.pos;
  if (!Array.isArray(pos) || pos.length !== 3 || !pos.every(Number.isFinite) || pos[0] < 5 || pos[0] > 203 || pos[2] < 5 || pos[2] > 203 || pos[1] < -8 || pos[1] > 200) return null;
  if (!Number.isFinite(value.yaw) || Math.abs(value.yaw) > 1000 || !Number.isFinite(value.pitch) || Math.abs(value.pitch) > 2 || !CHARACTER_IDS.has(value.characterId)) return null;
  return { pos: pos.map(n => Math.round(n * 1000) / 1000), yaw: value.yaw, pitch: value.pitch, characterId: value.characterId, updatedAt: Date.now() };
}

async function persistVisitEdits(room, actorId, actorToken, edits) {
  if (!edits.length) return;
  const actorIsOwner = actorId === room.ownerId;
  const commitAllowed = () => room.status === 'active' && sessions.has(room.ownerToken) &&
    (actorIsOwner ? room.ownerToken === actorToken && Date.now() - room.ownerSeen < VISIT_HEARTBEAT_TIMEOUT
      : room.visitorToken === actorToken && Date.now() - room.ownerSeen < VISIT_HEARTBEAT_TIMEOUT);
  let revision;
  try {
    revision = await writeWorld(room.ownerId, {
      version: 2, revision: null, edits, editPatch: true, replaceEdits: false, preserveMetadata: true,
    }, commitAllowed);
  } catch (error) {
    if (error.status === 410) return false;
    throw error;
  }
  if (!commitAllowed()) return false;
  room.worldRevision = Math.max(room.worldRevision || 0, revision);
  for (const edit of edits) appendVisitEvent(room, actorId, 'edit', edit);
  return room.worldRevision;
}

function visitEdits(value) {
  if (!Array.isArray(value) || value.length > 100) return null;
  if (value.some(e => !Array.isArray(e) || e.length !== 4 || e.some(n => !Number.isInteger(n)) || e[0] < 96 || e[0] >= 208 || e[2] < 96 || e[2] >= 208 || e[1] < 1 || e[1] > 99 || e[3] < 0 || e[3] > 255)) return null;
  return value;
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
    if (accounts || setupInProgress) return reply(res, 409, { error: 'Setup is already complete or running on this PC.' });
    setupInProgress = true;
    try {
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
      const newAccounts = { version: 1, users };
      const temp = ACCOUNTS_FILE + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
      await fs.promises.writeFile(temp, JSON.stringify(newAccounts, null, 2), { mode: 0o600 });
      await fs.promises.rename(temp, ACCOUNTS_FILE);
      accounts = newAccounts;
      bootstrapCode = null;
      return reply(res, 201, { ok: true });
    } finally {
      setupInProgress = false;
    }
  }

  if (method === 'POST' && route === '/api/login') {
    if (!accounts) return reply(res, 409, { error: 'Complete setup on this PC first.' });
    const body = await readBody(req, 4096);
    const userId = String(body.userId || ''), pin = String(body.pin || '');
    if (!ALLOWED_USERS.includes(userId) || !/^\d{4,12}$/.test(pin)) return reply(res, 400, { error: 'Choose a profile and enter its PIN.' });
    const key = (req.socket.remoteAddress || 'unknown') + ':' + userId;
    const attempt = attempts.get(key) || { count: 0, blockedUntil: 0, lastTry: Date.now() };
    if (attempt.blockedUntil > Date.now()) return reply(res, 429, { error: 'Too many tries. Wait five minutes, then try again.' });
    if (inFlightLogins.has(key) || inFlightLogins.size >= MAX_CONCURRENT_PIN_CHECKS)
      return reply(res, 429, { error: 'Another sign-in check is running. Wait a moment and try again.' });
    attempt.count++;
    attempt.lastTry = Date.now();
    if (attempt.count >= 5) attempt.blockedUntil = Date.now() + 5 * 60 * 1000;
    attempts.set(key, attempt);
    const account = accounts.users[userId];
    inFlightLogins.add(key);
    try {
      const derived = await scrypt(pin, account.salt, 64);
      if (!safeEqual(derived.toString('hex'), account.pinHash)) {
        return reply(res, attempt.blockedUntil > Date.now() ? 429 : 401, {
          error: attempt.blockedUntil > Date.now() ? 'Too many tries. Wait five minutes, then try again.' : 'That PIN did not match. Try again.',
        });
      }
      attempts.delete(key);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { userId, lastSeen: Date.now() });
      setCookie(res, token);
      return reply(res, 200, { ok: true, user: { id: userId, displayName: account.displayName } });
    } finally {
      inFlightLogins.delete(key);
    }
  }

  if (method === 'POST' && route === '/api/logout') {
    const user = requireUser(req, res);
    if (!user) return;
    const room = visits.get(user.id);
    if (room && room.ownerToken === user.token && room.status !== 'closed') closeVisit(room, 'The host signed out.');
    sessions.delete(user.token);
    const pendingWrite = worldWrites.get(user.id);
    if (pendingWrite) await pendingWrite.catch(() => {});
    clearCookie(res);
    return reply(res, 200, { ok: true });
  }

  const user = requireUser(req, res);
  if (!user) return;

  if (method === 'GET' && route === '/api/visits') {
    const owners = [];
    for (const room of visits.values()) {
      if (room.status === 'hosting' && Date.now() - room.ownerSeen < VISIT_HEARTBEAT_TIMEOUT && room.ownerId !== user.id) {
        owners.push({ id: room.ownerId, displayName: room.ownerName, available: !room.pending && !room.visitorId });
      }
    }
    return reply(res, 200, { owners });
  }

  if (method === 'POST' && route === '/api/visit/host') {
    const participating = visitByUser(user);
    if (participating && !participating.closed) return reply(res, 409, { error: 'Leave your current live visit before hosting.' });
    const previous = visits.get(user.id);
    if (previous && previous.status !== 'closed') closeVisit(previous, 'The host started a new live visit.');
    const savedWorld = await readWorld(user.id);
    const room = {
      id: crypto.randomBytes(12).toString('base64url'), ownerId: user.id, ownerToken: user.token,
      ownerName: user.displayName, ownerSeen: Date.now(), status: 'hosting', pending: null, worldRevision: savedWorld.revision,
      visitorId: null, visitorToken: null, visitorName: null, visitorSeen: 0,
      visitorNeedsWorld: false, visitorWorldSent: false, seq: 0, events: [], players: { owner: null, visitor: null },
    };
    visits.set(user.id, room);
    return reply(res, 201, { ok: true, ownerId: room.ownerId });
  }

  if (method === 'POST' && route === '/api/visit/stop') {
    const room = visits.get(user.id);
    if (room && room.ownerToken === user.token) closeVisit(room, 'The host ended the live visit.');
    return reply(res, 200, { ok: true });
  }

  if (method === 'POST' && route === '/api/visit/leave') {
    const found = visitByUser(user);
    if (found && !found.closed && found.role === 'pending' && found.room.pending && found.room.pending.visitorToken === user.token) {
      const room = found.room;
      const pending = room.pending;
      room.pending = null;
      const ended = Object.assign({}, room, { status: 'closed', closeReason: 'The visitor cancelled the request.' });
      closedVisitSessions.set(user.token, { room: ended, role: 'pending', expiresAt: Date.now() + VISIT_CLOSED_TTL });
    } else if (found && !found.closed && found.role === 'visitor' && found.room.visitorToken === user.token) {
      const room = found.room;
      const ended = Object.assign({}, room, { status: 'closed', closeReason: 'The visitor left the world.' });
      closedVisitSessions.set(user.token, { room: ended, role: 'visitor', expiresAt: Date.now() + VISIT_CLOSED_TTL });
      appendVisitEvent(room, user.id, 'left', { displayName: room.visitorName });
      room.visitorId = null;
      room.visitorToken = null;
      room.visitorName = null;
      room.visitorSeen = 0;
      room.visitorNeedsWorld = false;
      room.visitorWorldSent = false;
      room.players.visitor = null;
      room.status = 'hosting';
    }
    return reply(res, 200, { ok: true });
  }

  if (method === 'POST' && route === '/api/visit/request') {
    const body = await readBody(req, 4096);
    const ownerId = String(body.ownerId || '');
    if (!ALLOWED_USERS.includes(ownerId) || ownerId === user.id) return reply(res, 400, { error: 'Choose the other profile.' });
    const existing = visitByUser(user);
    if (existing && !existing.closed) return reply(res, 409, { error: 'Leave your current live visit first.' });
    const room = visits.get(ownerId);
    if (!room || room.status !== 'hosting' || Date.now() - room.ownerSeen >= VISIT_HEARTBEAT_TIMEOUT)
      return reply(res, 409, { error: 'That world is no longer being hosted.' });
    if (room.pending || room.visitorId) return reply(res, 409, { error: 'That world already has a visitor request or guest.' });
    room.pending = { id: crypto.randomBytes(12).toString('base64url'), visitorId: user.id, visitorToken: user.token, visitorName: user.displayName, createdAt: Date.now() };
    return reply(res, 202, { ok: true, ownerName: room.ownerName });
  }

  if (method === 'POST' && route === '/api/visit/respond') {
    const body = await readBody(req, 4096);
    const room = visits.get(user.id);
    if (!room || room.ownerToken !== user.token || room.status !== 'hosting' || !room.pending || room.pending.id !== body.requestId)
      return reply(res, 409, { error: 'That visit request is no longer waiting.' });
    const pending = room.pending;
    room.pending = null;
    if (Date.now() - pending.createdAt > VISIT_REQUEST_TTL || !sessions.has(pending.visitorToken))
      return reply(res, 410, { error: 'That visit request has expired.' });
    if (body.approve !== true) {
      closedVisitSessions.set(pending.visitorToken, { room: Object.assign({}, room, { status: 'closed', closeReason: 'The host declined the visit.' }), role: 'pending', expiresAt: Date.now() + VISIT_CLOSED_TTL });
      return reply(res, 200, { ok: true, approved: false });
    }
    room.worldRevision = (await readWorld(room.ownerId)).revision;
    room.visitorId = pending.visitorId;
    room.visitorToken = pending.visitorToken;
    room.visitorName = pending.visitorName;
    room.visitorSeen = Date.now();
    room.visitorNeedsWorld = true;
    room.visitorWorldSent = false;
    room.status = 'active';
    room.players.visitor = null;
    appendVisitEvent(room, user.id, 'joined', { displayName: pending.visitorName });
    return reply(res, 200, { ok: true, approved: true });
  }

  if (method === 'POST' && route === '/api/visit/sync') {
    const body = await readBody(req, 96 * 1024);
    const found = visitByUser(user);
    if (!found) return reply(res, 200, { state: 'none' });
    const { room, role } = found;
    if (found.closed || room.status === 'closed') return reply(res, 200, { state: 'closed', reason: room.closeReason || 'The host is no longer available.' });
    if (role !== 'owner' && (!sessions.has(room.ownerToken) || Date.now() - room.ownerSeen >= VISIT_HEARTBEAT_TIMEOUT)) {
      closeVisit(room, 'The host disconnected.');
      return reply(res, 200, { state: 'closed', reason: room.closeReason });
    }
    if (role === 'owner') {
      room.ownerSeen = Date.now();
      const player = safePlayerState(body.player);
      if (player) room.players.owner = player;
    } else if (role === 'pending') {
      if (!room.pending || room.pending.visitorToken !== user.token) return reply(res, 200, { state: 'closed', reason: 'The host is no longer available.' });
      if (Date.now() - room.pending.createdAt > VISIT_REQUEST_TTL) {
        const stale = room.pending;
        room.pending = null;
        closedVisitSessions.set(stale.visitorToken, { room: Object.assign({}, room, { status: 'closed', closeReason: 'The visit request expired.' }), role: 'pending', expiresAt: Date.now() + VISIT_CLOSED_TTL });
        return reply(res, 200, { state: 'closed', reason: 'The visit request expired.' });
      }
      return reply(res, 200, { state: 'pending', ownerName: room.ownerName });
    } else {
      if (room.status !== 'active' || room.visitorToken !== user.token) return reply(res, 200, { state: 'closed', reason: 'The host is no longer available.' });
      room.visitorSeen = Date.now();
      const player = safePlayerState(body.player);
      if (player) room.players.visitor = player;
      if (body.worldReady === true && room.visitorWorldSent) room.visitorNeedsWorld = false;
    }

    const edits = visitEdits(body.edits === undefined ? [] : body.edits);
    if (!edits) return reply(res, 400, { error: 'Shared block edits are invalid.' });
    if (edits.length && room.status === 'active') {
      const revision = await persistVisitEdits(room, user.id, user.token, edits);
      if (!revision) return reply(res, 200, { state: 'closed', reason: room.closeReason || 'The host is no longer available.' });
      room.worldRevision = Math.max(room.worldRevision || 0, revision);
    }

    if (role === 'owner' && room.status === 'hosting' && room.pending && Date.now() - room.pending.createdAt > VISIT_REQUEST_TTL) {
      const stale = room.pending;
      room.pending = null;
      closedVisitSessions.set(stale.visitorToken, { room: Object.assign({}, room, { status: 'closed', closeReason: 'The visit request expired.' }), role: 'pending', expiresAt: Date.now() + VISIT_CLOSED_TTL });
    }

    const cursor = Number.isSafeInteger(body.cursor) && body.cursor >= 0 ? body.cursor : 0;
    const batch = room.events.filter(event => event.seq > cursor).slice(0, 200);
    const nextCursor = batch.length ? batch[batch.length - 1].seq : room.seq;
    const response = {
      state: room.status, role, cursor: nextCursor,
      worldRevision: room.worldRevision,
      pending: role === 'owner' && room.pending ? { id: room.pending.id, displayName: room.pending.visitorName } : null,
      remotePlayer: room.players[role === 'owner' ? 'visitor' : 'owner'],
      events: batch.filter(event => event.actorId !== user.id).map(({ seq, type, data }) => ({ seq, type, data })),
    };
    if (role === 'visitor' && room.status === 'active' && room.visitorToken === user.token && room.visitorNeedsWorld) {
      response.world = await readWorld(room.ownerId);
      response.ownerName = room.ownerName;
      room.visitorWorldSent = true;
    }
    const firstSeq = room.events.length ? room.events[0].seq : room.seq + 1;
    if (cursor < firstSeq - 1 && room.status === 'active') {
      response.resync = true;
      response.world = await readWorld(room.ownerId);
      response.cursor = room.seq;
    }
    return reply(res, 200, response);
  }

  if (method === 'GET' && route === '/api/world') {
    return reply(res, 200, { ownerId: user.id, world: await readWorld(user.id) });
  }

  if ((method === 'PUT' && route === '/api/world') || (method === 'POST' && route === '/api/world/flush')) {
    const body = await readBody(req, 6 * 1024 * 1024);
    const world = body.world;
    if (!world || typeof world !== 'object' || Array.isArray(world) || !Number.isInteger(world.seed) || world.seed < -2147483648 || world.seed > 2147483647)
      return reply(res, 400, { error: 'World save has an invalid format.' });
    const edits = Array.isArray(world.edits) ? world.edits : [];
    if (edits.length > 200000 || edits.some(e => !Array.isArray(e) || e.length !== 4 || e.some(n => !Number.isInteger(n)) || e[0] < 96 || e[0] >= 304 || e[2] < 96 || e[2] >= 304 || e[1] < 1 || e[1] > 99 || e[3] < 0 || e[3] > 255))
      return reply(res, 400, { error: 'World edits are invalid or too large.' });
    const safe = {
      version: 2, seed: world.seed,
      revision: Number.isSafeInteger(world.revision) && world.revision >= 0 ? world.revision : null,
      player1: Array.isArray(world.player1) && world.player1.length === 3 && world.player1.every(Number.isFinite) ? world.player1 : null,
      slot: Number.isInteger(world.slot) ? Math.max(0, Math.min(8, world.slot)) : 0,
      pick: world.pick && typeof world.pick === 'object' ? world.pick : null,
      settings: world.settings && typeof world.settings === 'object' ? world.settings : null,
      edits,
      editPatch: world.editPatch === true,
      replaceEdits: world.replaceEdits === true,
    };
    await writeWorld(user.id, safe, () => sessions.has(user.token));
    return reply(res, 200, { ok: true, revision: safe.revision });
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
    for (const [key, attempt] of attempts) {
      if ((attempt.blockedUntil && attempt.blockedUntil <= now) || (!attempt.blockedUntil && now - attempt.lastTry > 60 * 60 * 1000)) attempts.delete(key);
    }
  }, 30_000).unref();

  setInterval(() => {
    const now = Date.now();
    for (const [ownerId, room] of visits) {
      if (room.status !== 'closed' && now - room.ownerSeen >= VISIT_HEARTBEAT_TIMEOUT) {
        closeVisit(room, 'The host disconnected.');
      } else if (room.status === 'active' && now - room.visitorSeen >= VISIT_HEARTBEAT_TIMEOUT) {
        const ended = Object.assign({}, room, { status: 'closed', closeReason: 'The visitor disconnected.' });
        closedVisitSessions.set(room.visitorToken, { room: ended, role: 'visitor', expiresAt: now + VISIT_CLOSED_TTL });
        appendVisitEvent(room, null, 'left', { displayName: room.visitorName });
        room.visitorId = null;
        room.visitorToken = null;
        room.visitorName = null;
        room.visitorSeen = 0;
        room.visitorNeedsWorld = false;
        room.visitorWorldSent = false;
        room.players.visitor = null;
        room.status = 'hosting';
      } else if (room.pending && now - room.pending.createdAt >= VISIT_REQUEST_TTL) {
        const expired = room.pending;
        room.pending = null;
        const ended = Object.assign({}, room, { status: 'closed', closeReason: 'The visit request expired.' });
        closedVisitSessions.set(expired.visitorToken, { room: ended, role: 'pending', expiresAt: now + VISIT_CLOSED_TTL });
      }
      if (room.status === 'closed' && now - room.closedAt >= VISIT_CLOSED_TTL && visits.get(ownerId) === room) visits.delete(ownerId);
    }
    for (const [token, item] of closedVisitSessions) if (item.expiresAt <= now) closedVisitSessions.delete(token);
  }, 1000).unref();

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
