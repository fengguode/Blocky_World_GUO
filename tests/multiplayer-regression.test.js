'use strict';

// Disposable integration checks for the live-visit protocol. Run with:
//   node tests/multiplayer-regression.test.js
// The service and all profile data are created under the OS temp directory.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const H = require('./harness');

const ROOT = path.resolve(__dirname, '..');
const PLAYER = { pos: [100, 20, 100], yaw: 0, pitch: 0, characterId: 'steve' };

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(base, child) {
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error('Disposable server exited before startup.');
    try {
      const response = await fetch(base + '/api/status');
      if (response.ok) return;
    } catch (_) { /* Wait for the listener. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Disposable server did not start.');
}

async function login(base, userId, pin, pageId) {
  const response = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BW-Page': pageId },
    body: JSON.stringify({ userId, pin }),
  });
  assert.strictEqual(response.status, 200, 'synthetic profile login succeeds');
  const cookie = response.headers.get('set-cookie');
  assert(cookie && cookie.startsWith('bw_session='), 'login returns a session cookie');
  return cookie.split(';')[0];
}

async function call(base, cookie, pageId, route, body, method = 'POST') {
  const response = await fetch(base + route, {
    method,
    headers: { Cookie: cookie, 'X-BW-Page': pageId, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const data = await response.json();
  assert(response.ok, route + ' returned ' + response.status + ': ' + JSON.stringify(data));
  return data;
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'blocky-multiplayer-regression-'));
  const dataDir = path.join(temp, '.blocky-world-data');
  await fsp.mkdir(dataDir);
  await fsp.copyFile(path.join(ROOT, 'server.js'), path.join(temp, 'server.js'));
  const port = await freePort();
  const users = {};
  for (const [id, displayName, pin] of [
    ['p1', 'Synthetic Host', '123456'],
    ['p2', 'Synthetic Guest', '654321'],
    ['p3', 'Synthetic Spare', '112233'],
  ]) {
    const salt = crypto.randomBytes(16).toString('hex');
    users[id] = { displayName, salt, pinHash: crypto.scryptSync(pin, salt, 64).toString('hex') };
  }
  await fsp.writeFile(path.join(dataDir, 'accounts.json'), JSON.stringify({ version: 1, users }));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: temp, env: Object.assign({}, process.env, { BLOCKY_PORT: String(port) }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const base = 'http://127.0.0.1:' + port;
  const passed = [];
  const check = (name, fn) => Promise.resolve().then(fn).then(() => passed.push(name));

  try {
    await waitForServer(base, child);
    const hostPage = crypto.randomBytes(16).toString('hex');
    const guestPage = crypto.randomBytes(16).toString('hex');
    const host = await login(base, 'p1', '123456', hostPage);
    const guest = await login(base, 'p2', '654321', guestPage);
    const hostCall = (route, body, method) => call(base, host, hostPage, route, body, method);
    const guestCall = (route, body, method) => call(base, guest, guestPage, route, body, method);

    await check('host can open a Play & Build room and the approved guest can request access', async () => {
      const started = await hostCall('/api/visit/host', {});
      assert.strictEqual(started.ok, true);
      const lobby = await guestCall('/api/visits', {}, 'GET');
      assert(lobby.owners.some(owner => owner.id === 'p1' && owner.available));
      const requested = await guestCall('/api/visit/request', { ownerId: 'p1' });
      assert.strictEqual(requested.ownerName, 'Florenz');
      const waiting = await hostCall('/api/visit/sync', { cursor: 0, player: PLAYER });
      assert(waiting.pending && waiting.pending.id);
      const approved = await hostCall('/api/visit/respond', { requestId: waiting.pending.id, approve: true });
      assert.strictEqual(approved.approved, true);
      const guestStatus = await guestCall('/api/visit/sync', { cursor: 0 });
      assert.strictEqual(guestStatus.state, 'active');
    });

    await check('loadingOnly heartbeats keep a delayed loader active without receiving world snapshots', async () => {
      for (let second = 0; second < 6; second++) {
        const ownerPing = await hostCall('/api/visit/sync', { cursor: 0, player: PLAYER });
        assert.strictEqual(ownerPing.state, 'active');
        const loadingPing = await guestCall('/api/visit/sync', {
          cursor: 0, loadingOnly: true, worldReady: false, edits: [],
        });
        assert.strictEqual(loadingPing.state, 'active');
        assert.strictEqual(loadingPing.world, undefined, 'loading pings must omit world payload');
        if (second < 5) await new Promise(resolve => setTimeout(resolve, 1000));
      }
      const firstSnapshot = await guestCall('/api/visit/sync', { cursor: 0, worldReady: false });
      assert(firstSnapshot.world && Number.isInteger(firstSnapshot.world.seed));
      const repeatedSnapshot = await guestCall('/api/visit/sync', { cursor: firstSnapshot.cursor, worldReady: false });
      assert(repeatedSnapshot.world, 'server retains the initial snapshot until readiness is acknowledged');
      const ready = await guestCall('/api/visit/sync', {
        cursor: repeatedSnapshot.cursor, worldReady: true, player: PLAYER,
      });
      assert.strictEqual(ready.world, undefined, 'worldReady stops repeated world transmission');
      const ownerSeesGuest = await hostCall('/api/visit/sync', { cursor: 0, player: PLAYER });
      assert(ownerSeesGuest.remotePlayer && ownerSeesGuest.remotePlayer.characterId === 'steve');
    });

    await check('fight mode choices synchronize, mismatches wait, matched choices start, and controls propagate', async () => {
      await hostCall('/api/visit/mode', { mode: 'fight' });
      const ownerMode = await hostCall('/api/visit/sync', { cursor: 0, player: PLAYER });
      const guestMode = await guestCall('/api/visit/sync', { cursor: 0, worldReady: true, player: PLAYER });
      assert.strictEqual(ownerMode.mode, 'fight');
      assert.strictEqual(guestMode.mode, 'fight');
      let choice = await hostCall('/api/visit/fight-choice', { choice: 'duel' });
      assert.strictEqual(choice.phase, 'setup');
      choice = await guestCall('/api/visit/fight-choice', { choice: 'coop' });
      assert.strictEqual(choice.choice, null, 'different choices do not start a match');
      choice = await guestCall('/api/visit/fight-choice', { choice: 'duel' });
      assert.strictEqual(choice.choice, 'duel');
      assert.strictEqual(choice.phase, 'active');
      const fightInput = { mx: 0.75, mz: -0.25, turn: 0.5, yaw: 1.1, jump: true, sneak: false,
        actions: { attack: 2, special: 1, ult: 0, altAttack: 0 } };
      await guestCall('/api/visit/sync', { cursor: 0, worldReady: true, player: PLAYER, fightInput });
      const ownerPoll = await hostCall('/api/visit/sync', { cursor: 0, player: PLAYER });
      assert(ownerPoll.fightInput, 'the other player input is present in host sync');
      assert.strictEqual(ownerPoll.fightInput.mx, 0.75);
      assert.strictEqual(ownerPoll.fightInput.actions.attack, 2);
      assert(ownerPoll.events.some(event => event.type === 'fight-action' && event.data.role === 'visitor' && event.data.action === 'attack'));
    });

    await check('owner mode switch propagates and host closing during a loading phase closes the visitor session', async () => {
      const changed = await hostCall('/api/visit/mode', { mode: 'observe' });
      assert.strictEqual(changed.mode, 'observe');
      const guestMode = await guestCall('/api/visit/sync', { cursor: 0, worldReady: true });
      assert.strictEqual(guestMode.mode, 'observe');
      await hostCall('/api/visit/stop', {});
      const afterClose = await guestCall('/api/visit/sync', {
        cursor: 0, loadingOnly: true, worldReady: false, edits: [],
      });
      assert.strictEqual(afterClose.state, 'closed');
    });

    await check('a failed client world load ends the visit once and prevents snapshot retry loops', async () => {
      const t = H.load({ boot: false });
      const network = t.Network;
      network.visitRole = 'visitor';
      network.visitOwnerId = 'p1';
      network.request = async () => ({
        state: 'active', role: 'visitor', cursor: 1, mode: 'play', modeRevision: 0,
        events: [], world: { version: 2, revision: 0, seed: 777, edits: [] }, ownerName: 'Florenz',
      });
      t.Game.enterSharedWorld = async () => { throw new Error('synthetic load failure'); };
      let endCount = 0;
      network.handleVisitEnded = async () => { endCount++; network.visitRole = null; };
      await network.syncVisit();
      assert.strictEqual(network.visitRole, null, 'a load failure tears down visitor state');
      assert.strictEqual(network.sharedWorldLoading, false, 'the loading flag is cleared after failure');
      assert.strictEqual(network.visitLoadError, null, 'the surfaced load error is consumed');
      await network.syncVisit();
      assert.strictEqual(endCount, 1, 'the failed snapshot does not trigger repeated end handling');
    });

    console.log('Multiplayer disposable integration checks: ' + passed.length + ' passed, 0 failed');
    passed.forEach(name => console.log('  PASS  ' + name));
    console.log('Fixture: ' + temp + ' (synthetic account/world data only; port ' + port + ')');
  } catch (error) {
    console.error('FAIL  ' + error.message);
    if (stderr.trim()) console.error(stderr.trim());
    process.exitCode = 1;
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
