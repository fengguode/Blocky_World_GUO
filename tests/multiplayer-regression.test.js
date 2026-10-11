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
    const sparePage = crypto.randomBytes(16).toString('hex');
    const host = await login(base, 'p1', '123456', hostPage);
    const guest = await login(base, 'p2', '654321', guestPage);
    const spare = await login(base, 'p3', '112233', sparePage);
    const hostCall = (route, body, method) => call(base, host, hostPage, route, body, method);
    const guestCall = (route, body, method) => call(base, guest, guestPage, route, body, method);
    const spareCall = (route, body, method) => call(base, spare, sparePage, route, body, method);

    await check('current world-size metadata survives a server save and reload', async () => {
      const initial = await hostCall('/api/world?type=normal', null, 'GET');
      const savedWorld = Object.assign({}, initial.world, {
        worldSize: 200000,
        player1: [199999, 46, 199999],
        inventory: { apple: 2, meat: 3 },
        edits: [[199995, 80, 199995, 2]],
        editPatch: true,
        replaceEdits: true,
      });
      await hostCall('/api/world?type=normal', { world: savedWorld }, 'PUT');
      const reloaded = await hostCall('/api/world?type=normal', null, 'GET');
      assert.strictEqual(reloaded.world.worldSize, 200000, 'the current coordinate-space marker remains durable');
      assert.deepStrictEqual(reloaded.world.inventory, { apple: 2, meat: 3 });
      assert.deepStrictEqual(reloaded.world.edits, [[199995, 80, 199995, 2]]);
    });

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

    await check('Play & Build visitor attacks relay one validated damage event to the owner', async () => {
      await hostCall('/api/visit/mode', { mode: 'play' });
      const before = await hostCall('/api/visit/sync', { cursor: 0, player: PLAYER, inventory: { apple: 4, meat: 2 } });
      const saved = await hostCall('/api/world?type=normal', null, 'GET');
      assert.deepStrictEqual(saved.world.inventory, { apple: 4, meat: 2 }, 'owner food inventory is durable during an active visit');
      const far = Object.assign({}, PLAYER, { pos: [100, 20, 1000], playAttackSeq: 1, playAttackDamage: 20 });
      const farPoll = await guestCall('/api/visit/sync', { cursor: 0, worldReady: true, player: far });
      assert(!farPoll.events.some(event => event.type === 'play-attack'), 'implausible teleport attacks are rejected');
      let poll = await hostCall('/api/visit/sync', { cursor: before.cursor, player: PLAYER });
      assert(!poll.events.some(event => event.type === 'play-attack'), 'a rejected position cannot reach the owner');

      let visitorZ = 100;
      for (let step = 0; step < 10; step++) {
        visitorZ += 1;
        await new Promise(resolve => setTimeout(resolve, 175));
        await guestCall('/api/visit/sync', {
          cursor: 0, worldReady: true,
          player: Object.assign({}, PLAYER, { pos: [100, 20, visitorZ], playAttackSeq: 0 }),
        });
      }
      poll = await hostCall('/api/visit/sync', { cursor: poll.cursor, player: PLAYER });
      assert(Math.hypot(poll.remotePlayer.pos[0] - PLAYER.pos[0], poll.remotePlayer.pos[2] - PLAYER.pos[2]) > 3.6,
        'the visitor can move away using elapsed time');

      let forgedZ = visitorZ;
      for (let step = 0; step < 100; step++) {
        forgedZ = Math.max(103, forgedZ - 0.1);
        await guestCall('/api/visit/sync', {
          cursor: 0, worldReady: true,
          player: Object.assign({}, PLAYER, { pos: [100, 20, forgedZ], yaw: 0, playAttackSeq: 0 }),
        });
      }
      await guestCall('/api/visit/sync', {
        cursor: 0, worldReady: true,
        player: Object.assign({}, PLAYER, { pos: [100, 20, forgedZ], yaw: 0, playAttackSeq: 1, playAttackDamage: 20 }),
      });
      poll = await hostCall('/api/visit/sync', { cursor: poll.cursor, player: PLAYER });
      assert(Math.hypot(poll.remotePlayer.pos[0] - PLAYER.pos[0], poll.remotePlayer.pos[2] - PLAYER.pos[2]) > 3.6,
        'rapid individually small forged moves cannot walk into attack range');
      assert(!poll.events.some(event => event.type === 'play-attack'), 'rapid movement does not enable a forged attack');

      visitorZ = poll.remotePlayer.pos[2];
      while (visitorZ > 100) {
        visitorZ = Math.max(100, visitorZ - 1);
        await new Promise(resolve => setTimeout(resolve, 175));
        await guestCall('/api/visit/sync', {
          cursor: 0, worldReady: true,
          player: Object.assign({}, PLAYER, { pos: [100, 20, visitorZ], playAttackSeq: 0 }),
        });
      }

      const forgedYaw = Object.assign({}, PLAYER, { pos: [102, 20, 100], yaw: Math.PI, playAttackSeq: 1, playAttackDamage: 20 });
      await guestCall('/api/visit/sync', { cursor: 0, worldReady: true, player: forgedYaw });
      poll = await hostCall('/api/visit/sync', { cursor: poll.cursor, player: PLAYER });
      assert.strictEqual(poll.remotePlayer.yaw, 0, 'an implausible same-packet turn does not replace the last accepted facing');
      assert(!poll.events.some(event => event.type === 'play-attack'), 'forged orientation is not sufficient to create a hit');

      await new Promise(resolve => setTimeout(resolve, 400));
      const behind = Object.assign({}, PLAYER, { pos: [100, 20, 103], yaw: Math.PI, playAttackSeq: 1, playAttackDamage: 20 });
      await guestCall('/api/visit/sync', { cursor: 0, worldReady: true, player: behind });
      poll = await hostCall('/api/visit/sync', { cursor: poll.cursor, player: PLAYER });
      assert(!poll.events.some(event => event.type === 'play-attack'), 'attacks from behind are rejected');

      await new Promise(resolve => setTimeout(resolve, 350));
      const front = Object.assign({}, PLAYER, { pos: [100, 20, 103], yaw: 0, playAttackSeq: 2, playAttackDamage: 20 });
      await guestCall('/api/visit/sync', { cursor: 0, worldReady: true, player: front });
      const hit = await hostCall('/api/visit/sync', { cursor: poll.cursor, player: PLAYER });
      const attack = hit.events.find(event => event.type === 'play-attack');
      assert(attack, 'owner receives a close, front-facing visitor attack');
      assert.strictEqual(attack.data.role, 'visitor');
      assert.strictEqual(attack.data.targetRole, 'owner');
      assert.strictEqual(attack.data.damage, 20);
      assert.strictEqual(attack.data.seq, 2);
      const stale = await guestCall('/api/visit/sync', { cursor: 0, worldReady: true, player: Object.assign({}, front, { playAttackSeq: 1 }) });
      assert(!stale.events.some(event => event.type === 'play-attack'), 'stale attack sequences cannot be replayed');
      const cadence = await guestCall('/api/visit/sync', { cursor: 0, worldReady: true, player: Object.assign({}, front, { playAttackSeq: 3 }) });
      assert(!cadence.events.some(event => event.type === 'play-attack'), 'attacks faster than the cooldown are rejected');
      let sanitized = await hostCall('/api/visit/sync', { cursor: hit.cursor, player: PLAYER });
      assert(!sanitized.events.some(event => event.type === 'play-attack'), 'the owner sees no over-cadence attack');
      await new Promise(resolve => setTimeout(resolve, 350));
      await guestCall('/api/visit/sync', { cursor: 0, worldReady: true, player: Object.assign({}, front, { playAttackSeq: 4, playAttackDamage: 999 }) });
      sanitized = await hostCall('/api/visit/sync', { cursor: sanitized.cursor, player: PLAYER });
      const safeAttack = sanitized.events.find(event => event.type === 'play-attack');
      assert(safeAttack, 'the next attack sequence is relayed');
      assert.strictEqual(safeAttack.data.damage, 8, 'damage is clamped to a permitted attack tier');
    });

    await check('a replacement visitor starts a fresh Play attack sequence', async () => {
      await guestCall('/api/visit/leave', {});
      const requested = await spareCall('/api/visit/request', { ownerId: 'p1' });
      assert.strictEqual(requested.ownerName, 'Florenz');
      const waiting = await hostCall('/api/visit/sync', { cursor: 0, player: PLAYER });
      const approved = await hostCall('/api/visit/respond', { requestId: waiting.pending.id, approve: true });
      assert.strictEqual(approved.approved, true);
      const ready = await spareCall('/api/visit/sync', { cursor: 0, worldReady: true, player: PLAYER });
      assert.strictEqual(ready.state, 'active');
      await new Promise(resolve => setTimeout(resolve, 350));
      await spareCall('/api/visit/sync', { cursor: 0, worldReady: true, player: Object.assign({}, PLAYER, { pos: [100, 20, 103], yaw: 0, playAttackSeq: 1, playAttackDamage: 12 }) });
      const hit = await hostCall('/api/visit/sync', { cursor: ready.cursor, player: PLAYER });
      const attack = hit.events.find(event => event.type === 'play-attack' && event.data.role === 'visitor');
      assert(attack, 'the replacement visitor’s first attack is relayed');
      assert.strictEqual(attack.data.seq, 1);
    });

    await check('owner mode switch propagates and host closing during a loading phase closes the visitor session', async () => {
      const changed = await hostCall('/api/visit/mode', { mode: 'observe' });
      assert.strictEqual(changed.mode, 'observe');
      const guestMode = await spareCall('/api/visit/sync', { cursor: 0, worldReady: true });
      assert.strictEqual(guestMode.mode, 'observe');
      await hostCall('/api/visit/stop', {});
      const afterClose = await spareCall('/api/visit/sync', {
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
