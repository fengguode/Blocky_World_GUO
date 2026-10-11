'use strict';

// Real World/Game lifecycle regression for shared Fight arenas. This uses the
// production game modules in the existing headless harness; no network or
// personal save data is involved. Run with: node tests/fight-environment.test.js
const assert = require('assert');
const H = require('./harness');

const SEED = 7319;
const SAVED = [150101, 38, 150107];

function makeClient(role, centeredAtSave) {
  const t = H.load({ boot: false });
  const { World, Player, Game, Network, CHUNK, WORLD_CENTRE, characterById } = t;
  t.document.querySelector = () => t.document.createElement('div');
  t.document.getElementById('ult-fill').parentElement = t.document.createElement('div');
  const originChunk = centeredAtSave ? Math.floor(SAVED[0] / CHUNK) : Math.floor(WORLD_CENTRE / CHUNK);
  const originZ = centeredAtSave ? Math.floor(SAVED[2] / CHUNK) : Math.floor(WORLD_CENTRE / CHUNK);
  const world = new World(SEED);
  world.generateRadius(originChunk, originZ, 1, null);

  // Model the owner having explored to the saved position while the original
  // World origin remains where that world was first loaded.
  if (!centeredAtSave) {
    const cx = Math.floor(SAVED[0] / CHUNK), cz = Math.floor(SAVED[2] / CHUNK);
    for (let z = cz - 1; z <= cz + 1; z++) for (let x = cx - 1; x <= cx + 1; x++) {
      const chunk = world.getChunk(x, z, true);
      if (!chunk.generated) world.generateChunk(chunk);
    }
  }

  const surface = world.findSurfaceY(SAVED[0], SAVED[2]);
  const savedPosition = [SAVED[0] + 0.5, surface + 1, SAVED[2] + 0.5];
  const p1 = new Player(world, characterById('steve'), false);
  p1.pos = savedPosition.slice(); p1.spawn = savedPosition.slice(); p1.creative = true; p1.flying = false;
  const p2 = new Player(world, characterById('golem'), true);
  p2.pos = [savedPosition[0] + 2, savedPosition[1], savedPosition[2]];
  p2.spawn = p2.pos.slice(); p2.creative = true; p2.flying = false;

  Game.world = world;
  World.world = world;
  Game.players = [p1, p2];
  Game.canvas = { requestPointerLock() {} };
  Game.saved = { seed: SEED, worldSize: t.WORLD_SIZE, player1: savedPosition.slice(), edits: [] };
  Game.mode = 'play';
  Game.state = 'menu';
  Game.paused = false;
  Game.hostedFightPreview = false;
  Game.sharedFightStarted = false;
  Game.sharedFightWaiting = false;
  Network.visitRole = role;
  Network.visitActive = role === 'visitor';
  Network.sharedArenaCenter = null;
  Network.remotePlayerState = { pos: savedPosition.slice(), yaw: 0, pitch: 0, characterId: 'steve' };
  return t;
}

function closeTo(actual, expected, message) {
  assert(Math.abs(actual - expected) < 0.001, message + ': expected ' + expected + ', got ' + actual);
}

function arenaCenter(t) {
  assert(t.Game.world.arena, 'world must have an arena');
  return [t.Game.world.arena.x, t.Game.world.arena.z];
}

function assertArena(t, center, phase) {
  const arena = t.Game.world.arena;
  assert(arena, phase + ': arena should remain built');
  assert.deepStrictEqual([arena.x, arena.z], center, phase + ': arena coordinates must match the host center');
  assert.strictEqual(t.Game.world.getBlock(arena.x, arena.floorY, arena.z), 4,
    phase + ': the arena floor must be present');
  assert(t.Game.sharedArenaBackup, phase + ': pre-arena world must be backed up');
}

function expectedFighterPositions(t, center) {
  const r = 13 * 0.5;
  closeTo(t.Fight.players[0].pos[0], center[0] - r, 'canonical owner fighter X');
  closeTo(t.Fight.players[0].pos[2], center[1], 'canonical owner fighter Z');
  closeTo(t.Fight.players[1].pos[0], center[0] + r, 'canonical visitor fighter X');
  closeTo(t.Fight.players[1].pos[2], center[1], 'canonical visitor fighter Z');
}

function run() {
  const host = makeClient('owner', false);
  const visitor = makeClient('visitor', true);
  const expected = [Math.floor(host.Game.world.originX), Math.floor(host.Game.world.originZ)];
  const hostOrigin = [host.Game.world.originX, host.Game.world.originZ];
  const visitorOrigin = [visitor.Game.world.originX, visitor.Game.world.originZ];
  assert(Math.hypot(hostOrigin[0] - visitorOrigin[0], hostOrigin[1] - visitorOrigin[1]) > 10_000,
    'fixture must place the owner world origin far from the visitor load origin');

  // Record the old local-origin behavior with the shared protocol center absent.
  visitor.Game.ensureFightArena();
  const fallbackCenter = arenaCenter(visitor);
  visitor.Game.restoreSharedArena();
  assert.notDeepStrictEqual(fallbackCenter, expected,
    'without a host-provided sharedArenaCenter, distant visitor build origin produces a different arena');

  host.Network.sharedArenaCenter = expected.slice();
  visitor.Network.sharedArenaCenter = expected.slice();
  const hostPositionBefore = host.Game.players[0].pos.slice();
  const visitorPositionBefore = visitor.Game.players[0].pos.slice();
  host.Game.startHostedFightPreview();
  assertArena(host, expected, 'host preview');
  assert.strictEqual(host.Fight.roundActive, false, 'host preview waits without starting combat');

  visitor.Game.openSharedFightChoice();
  assertArena(visitor, expected, 'visitor choice lobby');
  assert.strictEqual(visitor.Game.paused, true, 'visitor waits in the choice lobby');
  assert.strictEqual(visitor.Game.sharedFightWaiting, true);
  assert.strictEqual(visitor.Fight.roundActive, false, 'choice lobby must not run combat');
  assert.deepStrictEqual(arenaCenter(host), arenaCenter(visitor),
    'host preview and visitor choice lobby must show the same arena');
  host.Network.visitActive = true;
  host.Game.startSharedFight('duel');
  visitor.Game.startSharedFight('duel');
  assertArena(host, expected, 'host Duel');
  assertArena(visitor, expected, 'visitor Duel');
  assert.deepStrictEqual(arenaCenter(host), arenaCenter(visitor));
  expectedFighterPositions(host, expected);
  expectedFighterPositions(visitor, expected);
  assert.strictEqual(host.Game.paused, false);
  assert.strictEqual(visitor.Game.paused, false);
  assert.strictEqual(host.Game.players[1].world, host.Game.world);
  assert.strictEqual(visitor.Game.players[1].world, visitor.Game.world);

  // A finished match returns both clients to the same paused arena lobby. A
  // different shared choice then reuses that arena for a three-player rematch.
  host.Fight.roundActive = false;
  visitor.Fight.roundActive = false;
  host.Game.openSharedFightChoice();
  visitor.Game.openSharedFightChoice();
  assertArena(host, expected, 'host rematch lobby');
  assertArena(visitor, expected, 'visitor rematch lobby');
  host.Game.startSharedFight('coop');
  visitor.Game.startSharedFight('coop');
  assertArena(host, expected, 'host Co-op rematch');
  assertArena(visitor, expected, 'visitor Co-op rematch');
  assert.strictEqual(host.Game.players.length, 3);
  assert.strictEqual(visitor.Game.players.length, 3);
  assert.deepStrictEqual(arenaCenter(host), arenaCenter(visitor));

  // Switching from Fight to Build restores each independently loaded shared
  // world and its original local player position without leaving arena edits.
  host.Game.enterSharedMode('play', false);
  visitor.Game.enterSharedMode('play', false);
  for (const [client, before, label] of [[host, hostPositionBefore, 'host'], [visitor, visitorPositionBefore, 'visitor']]) {
    assert.strictEqual(client.Game.world.arena, null, label + ' returns to Build without an arena');
    assert.strictEqual(client.Game.sharedArenaBackup, null, label + ' clears the temporary arena backup');
    closeTo(client.Game.players[0].pos[0], before[0], label + ' original position restored');
    closeTo(client.Game.players[0].pos[2], before[2], label + ' original position restored');
    assert.strictEqual(client.Game.mode, 'play');
    assert.strictEqual(client.Game.paused, false);
  }

  console.log('Fight environment lifecycle: 1 scenario passed, 0 failed');
  console.log('  PASS  distant world origins reproduce the local fallback mismatch; negotiated host arena stays stable through preview, paused choice, Duel, Co-op rematch, and Build restoration');
  console.log('  Host world origin: ' + hostOrigin.join(', '));
  console.log('  Visitor world origin: ' + visitorOrigin.join(', '));
  console.log('  Shared arena center: ' + expected.join(', '));
}

try { run(); }
catch (error) { console.error('FAIL  ' + (error.stack || error)); process.exitCode = 1; }
