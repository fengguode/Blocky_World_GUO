'use strict';

// Five authenticated browser-session API load check. This deliberately copies
// the current server source into an OS temp fixture with synthetic PIN hashes
// and saves. It never launches or edits the configured family server.
// Run: node tests/multiplayer-five-clients.test.js
const assert = require('assert');
const crypto = require('crypto');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(ROOT, 'output', 'playwright', 'five-client-api-report.md');
const PLAYER = (x) => ({ pos: [x, 20, 100], yaw: 0, pitch: 0, characterId: 'steve' });
const evidence = [];

function note(label, method, route, status, body) {
  evidence.push({ label, method, route, status, body });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitReady(base, child) {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error('Disposable server exited before ready.');
    try {
      const r = await fetch(base + '/api/status');
      if (r.ok) return;
    } catch (_) { /* Listener is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Disposable server did not become ready.');
}

async function request(base, session, method, route, body) {
  const response = await fetch(base + route, {
    method,
    headers: Object.assign({ 'X-BW-Page': session.pageId }, session.cookie ? { Cookie: session.cookie } : {},
      method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const data = await response.json();
  note(session.label, method, route, response.status, data);
  return { status: response.status, data, setCookie: response.headers.get('set-cookie') };
}

async function login(base, label, profileId, pin) {
  const session = { label, profileId, pageId: crypto.randomBytes(16).toString('hex'), cookie: null };
  const result = await request(base, session, 'POST', '/api/login', { userId: profileId, pin });
  if (result.status === 200 && result.setCookie) session.cookie = result.setCookie.split(';')[0];
  return { session, ...result };
}

async function status(base, session) { return request(base, session, 'GET', '/api/status'); }
async function post(base, session, route, body = {}) { return request(base, session, 'POST', route, body); }
function expectStatus(result, code, context) {
  assert.strictEqual(result.status, code, context + ' response: ' + JSON.stringify(result.data));
}

async function writeReport(result) {
  await fsp.mkdir(path.dirname(REPORT), { recursive: true });
  const lines = [
    '# Five-session multiplayer API test', '',
    `- Run: ${new Date().toISOString()}`,
    `- Node: ${process.version}`,
    `- Fixture port: ${result.port}`,
    '- Server: copied from current V2 `server.js` into a temporary directory; no source patching.',
    '- Data: synthetic salts/PINs and a temporary `.blocky-world-data` directory; no family world or credentials used.',
    '- Sessions: five independently authenticated page/cookie pairs across p1, p2, p3. This tests five sessions; it does not assert five simultaneous admitted world players.',
    '', '## Scenario results', '',
  ];
  result.checks.forEach((check, i) => lines.push(`${i + 1}. **PASS** ${check}`));
  if (result.failure) lines.push('', '## Failure', '', '```text', String(result.failure), '```');
  lines.push('', '## HTTP evidence', '',
    'Bodies below are the exact parsed JSON returned by the copied service. Session labels identify the independent test client; all profile PIN values were synthetic.', '');
  for (const item of evidence) {
    lines.push(`### ${item.label}: ${item.method} ${item.route} → ${item.status}`, '', '```json', JSON.stringify(item.body, null, 2), '```', '');
  }
  if (result.cleanup) lines.push('## Cleanup', '', result.cleanup, '');
  await fsp.writeFile(REPORT, lines.join('\n'), 'utf8');
}

async function main() {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'blocky-five-clients-'));
  const dataDir = path.join(fixture, '.blocky-world-data');
  await fsp.mkdir(dataDir);
  await fsp.copyFile(path.join(ROOT, 'server.js'), path.join(fixture, 'server.js'));
  const port = await freePort();
  const users = {};
  for (const [id, pin] of [['p1', '138246'], ['p2', '275319'], ['p3', '462831']]) {
    const salt = crypto.randomBytes(16).toString('hex');
    users[id] = { displayName: 'Synthetic ' + id, salt, pinHash: crypto.scryptSync(pin, salt, 64).toString('hex') };
  }
  await fsp.writeFile(path.join(dataDir, 'accounts.json'), JSON.stringify({ version: 1, users }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fixture, env: Object.assign({}, process.env, { BLOCKY_PORT: String(port) }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const base = 'http://127.0.0.1:' + port;
  const checks = [];
  let failure = null;
  try {
    await waitReady(base, child);

    // Concurrent PIN verification for the same profile is a realistic shared-device contention case.
    const sameP1 = await Promise.all([
      login(base, 'p1-host-old', 'p1', '138246'), login(base, 'p1-host-current', 'p1', '138246'),
    ]);
    const sameP2 = await Promise.all([
      login(base, 'p2-visitor-a', 'p2', '275319'), login(base, 'p2-visitor-b', 'p2', '275319'),
    ]);
    for (const pair of [sameP1, sameP2]) {
      assert(pair.some(x => x.status === 200), 'at least one concurrent profile login should complete');
      for (const x of pair.filter(x => x.status === 429)) {
        const retry = await login(base, x.session.label + '-retry', x.session.profileId,
          x.session.profileId === 'p1' ? '138246' : '275319');
        expectStatus(retry, 200, 'serialized same-profile retry');
        pair[pair.indexOf(x)] = retry;
      }
      assert(pair.every(x => x.status === 200 && x.session.cookie), 'five client slots require five authenticated sessions');
    }
    const spare = await login(base, 'p3-spare', 'p3', '462831');
    expectStatus(spare, 200, 'third synthetic profile login');
    const sessions = [sameP1[0].session, sameP1[1].session, sameP2[0].session, sameP2[1].session, spare.session];
    assert.strictEqual(new Set(sessions.map(s => s.cookie)).size, 5, 'each session receives a distinct cookie');
    checks.push('five concurrent login attempts across two repeated profile IDs produced five distinct session cookies after retrying any 429; no profile was added.');

    const hostOld = sameP1[0].session, host = sameP1[1].session;
    const guestA = sameP2[0].session, guestB = sameP2[1].session, guestC = spare.session;
    for (const client of sessions) {
      const r = await status(base, client);
      expectStatus(r, 200, 'session remains authenticated after parallel logins');
      assert.strictEqual(r.data.authenticated, true);
    }
    checks.push('parallel logins do not invalidate earlier cookies: all five page-scoped sessions remain authenticated.');

    expectStatus(await post(base, hostOld, '/api/visit/host', { mode: 'fight' }), 201, 'first host session');
    expectStatus(await post(base, host, '/api/visit/host', { mode: 'fight' }), 201, 'second same-profile host session');
    const displaced = await post(base, hostOld, '/api/visit/sync', { cursor: 0, player: PLAYER(100) });
    expectStatus(displaced, 200, 'displaced host sync');
    assert.strictEqual(displaced.data.state, 'closed', 'second host session replaces prior room');
    const hostLobby = await request(base, host, 'GET', '/api/visits');
    expectStatus(hostLobby, 200, 'host listing');
    checks.push('a second authenticated session for p1 can replace the same profile’s hosted room; the first session receives `state: closed`.');

    // All three non-host sessions contend at once for the single request slot.
    const race = await Promise.all([guestA, guestB, guestC].map(client => post(base, client, '/api/visit/request', { ownerId: 'p1' })));
    assert.strictEqual(race.filter(r => r.status === 202).length, 1, 'exactly one visitor request can occupy the room');
    assert.strictEqual(race.filter(r => r.status === 409).length, 2, 'excess requests are rejected with conflict');
    checks.push('three simultaneous visitor requests race for one slot: one receives 202 Accepted and two receive 409 Conflict.');

    const waiting = await post(base, host, '/api/visit/sync', { cursor: 0, player: PLAYER(100) });
    expectStatus(waiting, 200, 'host sees pending request');
    assert(waiting.data.pending && waiting.data.pending.id);
    const winner = [guestA, guestB, guestC].find((_, i) => race[i].status === 202);
    const losers = [guestA, guestB, guestC].filter(client => client !== winner);
    expectStatus(await post(base, host, '/api/visit/respond', { requestId: waiting.data.pending.id, approve: true }), 200, 'approve only pending guest');
    const initial = await post(base, winner, '/api/visit/sync', { cursor: 0, worldReady: false });
    expectStatus(initial, 200, 'approved visitor initial snapshot');
    assert.strictEqual(initial.data.state, 'active');
    assert(initial.data.world, 'approved visitor receives a snapshot');

    // An unapproved session tries to send an edit while an accepted visitor moves.
    const forbiddenEdits = await Promise.all(losers.map(client => post(base, client, '/api/visit/sync', {
      cursor: 0, worldReady: true, player: PLAYER(150), edits: [[100, 10, 100, 4]],
    })));
    assert(forbiddenEdits.every(r => r.status === 200 && r.data.state === 'none'), 'non-participants get no visit role');
    const move = await post(base, winner, '/api/visit/sync', { cursor: initial.data.cursor, worldReady: true, player: PLAYER(144) });
    expectStatus(move, 200, 'accepted visitor movement');
    const hostSeesMove = await post(base, host, '/api/visit/sync', { cursor: 0, player: PLAYER(100) });
    assert(hostSeesMove.data.remotePlayer, 'owner receives accepted visitor state');
    assert.deepStrictEqual(hostSeesMove.data.remotePlayer.pos, [144, 20, 100]);
    const ownerWorld = await request(base, host, 'GET', '/api/world');
    expectStatus(ownerWorld, 200, 'owner save after denied edit attempts');
    assert(!ownerWorld.data.world.edits.some(e => e[0] === 100 && e[1] === 10 && e[2] === 100), 'denied sessions cannot persist edits');
    const edit = await post(base, winner, '/api/visit/sync', {
      cursor: move.data.cursor, worldReady: true, player: PLAYER(144), edits: [[101, 10, 100, 4]],
    });
    expectStatus(edit, 200, 'accepted visitor edit');
    const afterEdit = await request(base, host, 'GET', '/api/world');
    assert(afterEdit.data.world.edits.some(e => e[0] === 101 && e[1] === 10 && e[2] === 100 && e[3] === 4), 'approved visitor edit is stored in owner world');
    checks.push('only the accepted session’s movement is relayed; both excess sessions receive `state: none`, and their attempted edit is absent from the owner save. The accepted visitor edit is present.');

    expectStatus(await post(base, host, '/api/visit/mode', { mode: 'fight' }), 200, 'host switches to Fight');
    const picksA = await post(base, host, '/api/visit/fight-choice', { choice: 'duel' });
    expectStatus(picksA, 200, 'host fight choice');
    const picksB = await post(base, winner, '/api/visit/fight-choice', { choice: 'coop' });
    expectStatus(picksB, 200, 'approved visitor fight choice');
    assert.strictEqual(picksB.data.choice, null, 'different roles do not start the match');
    const loserPick = await post(base, losers[0], '/api/visit/fight-choice', { choice: 'duel' });
    expectStatus(loserPick, 409, 'unapproved fight choice');
    assert.strictEqual(loserPick.data.error, 'Fight Arena is not active for this visit.');
    const matched = await post(base, winner, '/api/visit/fight-choice', { choice: 'duel' });
    assert.strictEqual(matched.data.choice, 'duel');
    assert.strictEqual(matched.data.phase, 'active');
    const fightInput = { mx: 0.5, mz: 0, turn: 0, yaw: 0.3, jump: true, sneak: false,
      actions: { attack: 1, special: 0, ult: 0, altAttack: 0 } };
    await post(base, winner, '/api/visit/sync', { cursor: 0, worldReady: true, player: PLAYER(144), fightInput });
    const hostFight = await post(base, host, '/api/visit/sync', { cursor: 0, player: PLAYER(100) });
    assert.strictEqual(hostFight.data.fightInput.mx, 0.5, 'host receives the accepted fighter controls');
    assert(hostFight.data.events.some(e => e.type === 'fight-action' && e.data.role === 'visitor'));
    checks.push('after request contention, Fight role choices are limited to the approved pair; a loser gets 409 and accepted visitor controls propagate to the host.');

    expectStatus(await post(base, winner, '/api/visit/leave', {}), 200, 'accepted guest leaves');
    const hostAfterLeave = await post(base, host, '/api/visit/sync', { cursor: 0, player: PLAYER(100) });
    assert.strictEqual(hostAfterLeave.data.state, 'hosting');
    expectStatus(await post(base, guestC, '/api/visit/request', { ownerId: 'p1' }), 202, 'spare session reconnect request');
    const pendingReconnect = await post(base, host, '/api/visit/sync', { cursor: hostAfterLeave.data.cursor, player: PLAYER(100) });
    expectStatus(await post(base, host, '/api/visit/respond', { requestId: pendingReconnect.data.pending.id, approve: true }), 200, 'approve reconnected guest');
    const rejoined = await post(base, guestC, '/api/visit/sync', { cursor: 0, worldReady: true, player: PLAYER(155) });
    assert.strictEqual(rejoined.data.state, 'active');
    assert.strictEqual(rejoined.data.role, 'visitor');
    expectStatus(await post(base, host, '/api/visit/stop', {}), 200, 'host stops while guest is connected');
    const disconnected = await post(base, guestC, '/api/visit/sync', { cursor: rejoined.data.cursor, worldReady: true });
    assert.strictEqual(disconnected.data.state, 'closed', 'unexpected owner disconnect closes the guest visit');
    expectStatus(await post(base, host, '/api/visit/host', { mode: 'fight' }), 201, 'host reconnects and reopens room');
    expectStatus(await post(base, guestC, '/api/visit/request', { ownerId: 'p1' }), 202, 'closed guest session may request a fresh visit');
    const reconnectPending = await post(base, host, '/api/visit/sync', { cursor: 0, player: PLAYER(100) });
    expectStatus(await post(base, host, '/api/visit/respond', { requestId: reconnectPending.data.pending.id, approve: true }), 200, 'approve after reconnect');
    const finalJoin = await post(base, guestC, '/api/visit/sync', { cursor: 0, worldReady: true, player: PLAYER(155) });
    assert.strictEqual(finalJoin.data.state, 'active');
    expectStatus(await post(base, host, '/api/visit/mode', { mode: 'fight' }), 200, 'Fight mode after reconnect');
    assert.strictEqual((await post(base, host, '/api/visit/fight-choice', { choice: 'coop' })).data.phase, 'setup');
    const finalChoice = await post(base, guestC, '/api/visit/fight-choice', { choice: 'coop' });
    assert.strictEqual(finalChoice.data.phase, 'active', 'reconnected visitor has the visitor choice role');
    checks.push('accepted visitor leave frees capacity; a second profile can reconnect; host stop closes it; the same authenticated guest can request again after host reopen and still receives the visitor Fight role.');

    // Verify stale host heartbeat closure (unexpected disconnect without `/stop`).
    await post(base, host, '/api/visit/stop', {});
    expectStatus(await post(base, host, '/api/visit/host', { mode: 'play' }), 201, 'start host for stale-heartbeat test');
    expectStatus(await post(base, guestA, '/api/visit/request', { ownerId: 'p1' }), 202, 'request before host disconnect');
    const stalePending = await post(base, host, '/api/visit/sync', { cursor: 0, player: PLAYER(100) });
    await post(base, host, '/api/visit/respond', { requestId: stalePending.data.pending.id, approve: true });
    await post(base, guestA, '/api/visit/sync', { cursor: 0, worldReady: true, player: PLAYER(166) });
    const waitStart = Date.now();
    while (Date.now() - waitStart < 16_500) {
      await post(base, guestA, '/api/visit/sync', { cursor: 0, worldReady: true, player: PLAYER(166) });
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    const staleClosed = await post(base, guestA, '/api/visit/sync', { cursor: 0, worldReady: true });
    assert.strictEqual(staleClosed.data.state, 'closed', 'guest detects host heartbeat timeout after 15 seconds');
    checks.push('unexpected host silence beyond the 15-second heartbeat timeout closes the visitor session while visitor heartbeats continue.');
  } catch (error) {
    failure = error && (error.stack || error.message) || String(error);
  } finally {
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
    });
    await fsp.rm(fixture, { recursive: true, force: true });
  }
  const cleanup = 'Disposable server process stopped; its temp fixture and synthetic world/account files were removed. No configured service or profile data was opened.';
  await writeReport({ port, checks, failure, cleanup });
  console.log(`Five-client API load: ${checks.length} scenario(s) passed${failure ? ', FAILED' : ', no failures'}.`);
  console.log('Report: ' + REPORT);
  console.log(`Authenticated session slots: five across p1/p2/p3; concurrent admitted world capacity exercised: host + one visitor.`);
  if (failure) { console.error(failure); process.exitCode = 1; }
  else checks.forEach((check, i) => console.log(`  PASS ${i + 1}. ${check}`));
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
