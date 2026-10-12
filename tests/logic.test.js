Warning: truncated output (original token count: 37286)
Total output lines: 3456

'use strict';
/* ============================================================
   tests/logic.test.js — game logic, exercised against the real
   source files loaded into a stubbed sandbox.

   Run through tests/run.js, which supervises one suite per child
   process so an accidental infinite loop cannot freeze the run.

   Coordinate convention: the playable world is 200x200 centred on
   WORLD_CENTRE, so CX is the block the small test worlds centre on.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./harness');
const g = H.load({ seed: 1337 });

const {
  World, Chunk, CHUNK, WORLD_H, SEA_LEVEL, WORLD_SIZE, CHUNKS_PER_SIDE, MIN_EDGE, MAX_EDGE, BLOCKS, HOTBAR_BLOCKS, HOTBAR_ITEMS,
  CENTRE_CHUNK, WORLD_CENTRE, characterById, CHARACTERS, ANIMALS,
  Player, Fight, Bot, Particles, PROJ_DEFS, Game, M4, Observer, Cam, migrateWorldSave,
} = g;

const CX = Math.floor(WORLD_CENTRE);

/* ============================================================
   helpers
   ============================================================ */

// A one chunk world with real terrain, plus an empty neighbour ring so
// meshing and lighting have valid data at the seams. Generating all 169
// chunks per test would make the suite unusable, so tests use this instead.
function flatWorld(seed) {
  const w = new World(seed === undefined ? 1234 : seed);
  const c = w.getChunk(CENTRE_CHUNK, CENTRE_CHUNK, true);
  w.generateChunk(c);
  w.setCentre(CENTRE_CHUNK, CENTRE_CHUNK);
  for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
    const n = w.getChunk(CENTRE_CHUNK + dx, CENTRE_CHUNK + dz, true);
    n.allocate();
    n.blocks.fill(0);
    n.generated = true;
    w.activeChunks.add(n);
    w.computeLight(n);
  }
  return w;
}

// A flat cobble floor with a wall and cover pillars: the fight arena.
function arenaWorld(seed) {
  const w = flatWorld(seed === undefined ? 61 : seed);
  w.buildArena(CX, CX, 16);
  return w;
}

// A chunk erased to nothing, so quad counts are unambiguous.
function scratchWorld(seed) {
  const w = new World(seed === undefined ? 900 : seed);
  const c = w.getChunk(CENTRE_CHUNK, CENTRE_CHUNK, true);
  w.generateChunk(c);
  c.allocate();
  c.blocks.fill(0);
  w.computeLight(c);
  return { w, chunk: c, y: 30, BASE: CENTRE_CHUNK * 16 + 4 };
}

// Place a player somewhere clear of the cover pillars and the wall.
function openSpot(w, dx, dz) {
  return [CX + (dx || 5) + 0.5, w.arena.y, CX + (dz || 5) + 0.5];
}

function stepSim(p, frames, input) {
  const i = input || {};
  for (let n = 0; n < frames; n++) {
    p.update(1 / 60, i.mx || 0, i.mz || 0, !!i.jump, !!i.sneak);
  }
}

// Two fighters, reset into the arena then moved together so a swing can reach.
function closeRange(id1, id2, gap) {
  const w = arenaWorld();
  const a = new Player(w, characterById(id1));
  const b = new Player(w, characterById(id2));
  a.creative = false; a.flying = false;
  b.creative = false; b.flying = false;
  Fight.reset(a, b);
  a.pos = openSpot(w, 5, 5);
  b.pos = openSpot(w, 5 + (gap === undefined ? 1.8 : gap), 5);
  a.yaw = -Math.PI / 2;   // face +X, toward b
  b.yaw = Math.PI / 2;
  a.vel = [0, 0, 0];
  b.vel = [0, 0, 0];
  b.invuln = 0;
  return { w, a, b };
}

function runFight(pair, frames) {
  const { a, b } = pair;
  for (let i = 0; i < (frames || 30); i++) {
    Fight.update(1 / 60, a, b);
    a.update(1 / 60, 0, 0, false, false);
    b.update(1 / 60, 0, 0, false, false);
  }
}

function quadCount(mesh) {
  return (mesh && mesh.opaque ? mesh.opaque.count : 0) / 6;
}
function transQuadCount(mesh) {
  return (mesh && mesh.trans ? mesh.trans.count : 0) / 6;
}
function cutoutQuadCount(mesh) {
  return (mesh && mesh.cutout ? mesh.cutout.count : 0) / 6;
}

// A throwaway GL stub: the mesher only needs buffer bookkeeping.
function stubGL() {
  const noop = () => {};
  return {
    createVertexArray: () => ({}), bindVertexArray: noop, deleteVertexArray: noop,
    createBuffer: () => ({}), bindBuffer: noop, bufferData: noop,
    enableVertexAttribArray: noop, vertexAttribPointer: noop,
    ARRAY_BUFFER: 1, ELEMENT_ARRAY_BUFFER: 2, STATIC_DRAW: 3,
    FLOAT: 4, TRIANGLES: 5, UNSIGNED_INT: 6,
  };
}
function buildChunk(world, chunk) {
  return g.buildChunkMesh(stubGL(), world, chunk);
}

/* ============================================================
   1. Blocks and textures
   ============================================================ */
H.suite('Blocks');

H.test('every block has three valid texture layers', () => {
  for (const b of g.BLOCKS) {
    for (const key of ['top', 'side', 'bottom']) {
      H.assert(typeof b[key] === 'number', b.name + '.' + key);
      H.assert(b[key] >= 0 && b[key] < g.ATLAS.length, b.name + '.' + key + ' out of range');
    }
  }
});

H.test('every world block texture has a limited-color pixel motif', () => {
  const ids = new Set();
  for (const block of g.BLOCKS) {
    if (block.id === 0) continue;
    ids.add(block.top); ids.add(block.side); ids.add(block.bottom);
  }

  for (const id of ids) {
    const data = g.ATLAS[id].data;
    const colors = new Set();
    let hasCluster = false;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4;
      colors.add(data[i] + ',' + data[i + 1] + ',' + data[i + 2] + ',' + data[i + 3]);
      if (x < 15 && y < 15 && data[i + 3] > 0) {
        const right = i + 4, down = i + 64, diagonal = i + 68;
        if (data[i] === data[right] && data[i + 1] === data[right + 1] &&
            data[i + 2] === data[right + 2] && data[i + 3] === data[right + 3] &&
            data[i] === data[down] && data[i + 1] === data[down + 1] &&
            data[i + 2] === data[down + 2] && data[i + 3] === data[down + 3] &&
            data[i] === data[diagonal] && data[i + 1] === data[diagonal + 1] &&
            data[i + 2] === data[diagonal + 2] && data[i + 3] === data[diagonal + 3]) {
          hasCluster = true;
        }
      }
    }
    H.assert(colors.size <= 12, g.ATLAS[id].name + ' has noisy per-pixel color variation (' + colors.size + ' colors)');
    H.assert(hasCluster, g.ATLAS[id].name + ' lacks a readable pixel cluster');
  }
});

H.test('the representative plank tile keeps its violet palette with three clustered tones', () => {
  const block = g.BLOCKS.find(b => b.id === 8);
  H.eq(block.tiles.all, g.T.planks, 'the sample uses the existing Planks block material');
  const tile = g.ATLAS[g.T.planks];
  const colors = new Set();
  for (let i = 0; i < tile.data.length; i += 4) {
    colors.add(tile.data[i] + ',' + tile.data[i + 1] + ',' + tile.data[i + 2]);
  }
  H.eq(colors.size, 3, 'planks should use exactly three clustered tones');
  H.assert(colors.has('132,100,168'), 'planks retain the original violet base color');
  H.assert(colors.has('90,58,126'), 'planks retain a violet shadow tone');
  H.assert(colors.has('164,132,200'), 'planks retain a violet highlight tone');
});

H.test('Web, Star, and Shuriken use distinct three-tone pixel materials and silhouettes', () => {
  const originals = Game.drawBox;
  const cases = [
    ['web', g.T.fx_web, 4],
    ['star', g.T.fx_star, 4],
    ['shuriken', g.T.fx_shuriken, 3],
  ];
  const retainedPalettes = {
    web: ['140,236,255', '72,194,208', '226,252,255'],
    star: ['120,246,255', '255,208,74', '226,242,250'],
    shuriken: ['178,190,210', '200,212,232', '198,44,52'],
  };
  try {
    const materialTiles = new Set();
    const silhouettes = new Set();
    for (const [kind, tileId, expectedBoxes] of cases) {
      const tile = g.ATLAS[tileId];
      H.eq(tile.name, 'fx_' + kind, kind + ' dedicated material');
      const colors = new Set();
      for (let i = 0; i < tile.data.length; i += 4) {
        colors.add(tile.data[i] + ',' + tile.data[i + 1] + ',' + tile.data[i + 2]);
      }
      H.eq(colors.size, 3, kind + ' should use three pixel-art tones');
      for (const color of retainedPalettes[kind]) H.assert(colors.has(color), kind + ' retains color ' + color);
      H.eq(PROJ_DEFS[kind].tile, tileId, kind + ' impact particles keep the matching material');

      const draws = [];
      Game.drawBox = (prog, pos, size, usedTile) => draws.push({ size, tile: usedTile });
      Game.drawProjectile(null, { def: PROJ_DEFS[kind], pos: [0, 0, 0], big: false, spin: 0.55 });
      H.eq(draws.length, expectedBoxes, kind + ' keeps its deliberate silhouette geometry');
      H.assert(draws.every(draw => draw.tile === tileId), kind + ' silhouette uses its dedicated pixel material');
      materialTiles.add(tileId);
      const signature = draws.map(draw => draw.size.map(n => Number(n).toFixed(3)).join(',')).sort().join(';');
      silhouettes.add(signature);
    }
    H.eq(materialTiles.size, 3, 'each projectile has its own material');
    H.eq(silhouettes.size, 3, 'each projectile remains visibly distinct by silhouette');
  } finally {
    Game.drawBox = originals;
  }
});

H.test('glass and water pixel highlights keep their translucent alpha', () => {
  for (const name of ['glass', 'water']) {
    const tile = g.ATLAS.find(entry => entry.name === name);
    H.assert(tile, name + ' texture should exist');
    let maxAlpha = 0;
    for (let i = 3; i < tile.data.length; i += 4) maxAlpha = Math.max(maxAlpha, tile.data[i]);
    H.assert(maxAlpha < 255, name + ' highlights must not turn into opaque pixels');
  }
});

H.test('leaf alpha follows the foliage silhouette', () => {
  const leaves = g.ATLAS.find(entry => entry.name === 'leaves');
  H.assert(leaves, 'leaf texture should exist');
  const alphaAt = (x, y) => leaves.data[(y * 16 + x) * 4 + 3];
  H.eq(alphaAt(7, 7), 255, 'a known point inside the leaf silhouette should be opaque');
  H.eq(alphaAt(0, 0), 0, 'a known point outside the leaf silhouette should be transparent');
});

H.test('pig, sheep, and chick silhouettes have distinct proportions', () => {
  const pig = ANIMALS.find(a => a.id === 'pig');
  const sheep = ANIMALS.find(a => a.id === 'sheep');
  const chick = ANIMALS.find(a => a.id === 'chick');
  H.assert(pig.d > sheep.d, 'pig should read longer than sheep');
  H.assert(sheep.h > pig.h, 'sheep should read taller than pig');
  H.assert(chick.w < pig.w && chick.h < sheep.h && chick.d < sheep.d, 'chick should remain visibly smaller');
});

H.test('animal renderers draw visible faces, multiple colors, and silhouette details', () => {
  const originalDrawBox = Game.drawBox;
  try {
    for (const id of ['pig', 'sheep', 'chick']) {
      const def = ANIMALS.find(a => a.id === id);
      const calls = [];
      Game.drawBox = (prog, pos, size, tile, tint, yaw, alpha) => calls.push({ pos, size, tile, tint, yaw, alpha });
      Game.drawAnimal(null, { def, pos: [0, 0, 0], scale: 1, yaw: 0, walkAnim: 0 }, 1);
      const tiles = new Set(calls.map(c => c.tile));
      H.assert(calls.length >= (id === 'chick' ? 13 : 14), id + ' needs visible silhouette and face detail');
      H.assert(tiles.size >= 3, id + ' should use multiple colors/materials');
      H.assert(calls.filter(c => c.tile === g.T.eye).length >= 2, id + ' needs two visible eyes');
      if (id === 'pig') H.assert(calls.some(c => c.tile === def.accent && c.size[0] >= 0.3), 'pig needs a prominent snout');
      if (id === 'sheep') {
        H.eq(calls.filter(c => c.tile === def.body && c.size[0] >= 0.3 && c.size[1] >= 0.24 && c.size[1] < 0.3 && c.size[2] >= 0.3).length,
          6, 'sheep needs a six-puff wool outline');
      }
      if (id === 'pig') {
        const body = calls.find(c => c.tile === def.body && c.size[1] > 0.5);
        H.assert(body && body.size[0] > body.size[2], 'pig should have a broad, low silhouette');
      }
      if (id === 'sheep') {
        const body = calls.find(c => c.tile === def.body && c.size[1] > 0.5);
        H.assert(body && body.size[1] > calls[0].size[1], 'sheep fleece mass should rise above its legs');
      }
      if (id === 'chick') {
        H.assert(calls.some(c => c.tile === def.beak && c.size[0] >= 0.2), 'chick needs a prominent beak');
        const body = calls.find(c => c.tile === def.body && c.size[1] > 0.5);
        const head = calls.find(c => c.tile === def.face && c.size[1] > 0.5 && c !== body);
        H.assert(body && head && head.size[0] >= body.size[0] * 0.8, 'chick should have a compact body and large readable head');
      }
    }
  } finally {
    Game.drawBox = originalDrawBox;
  }
});
H.test('every hotbar entry is a real, solid block', () => {
  H.eq(g.HOTBAR_BLOCKS.length, 9);
  for (const id of g.HOTBAR_BLOCKS) {
    const b = g.BLOCKS[id];
    H.assert(b && b.id === id, 'missing block ' + id);
    H.assert(b.solid && !b.liquid, b.name + ' should be solid, not a liquid');
  }
});

H.test('opaque blocks have fully opaque textures', () => {
  // A solid block in the opaque pass with a hole would render as a void.
  for (const b of g.BLOCKS) {
    if (!b.solid || b.cutout) continue;
    for (const tex of [b.top, b.side, b.bottom]) {
      const data = g.ATLAS[tex].data;
      for (let i = 3; i < data.length; i += 4) {
        H.eq(data[i], 255, b.name + ' has a transparent pixel but is opaque');
      }
    }
  }
});

H.test('see-through blocks are flagged as cutout, not opaque', () => {
  H.eq(g.BLOCKS[9].opaque, false, 'leaves');
  H.eq(g.BLOCKS[9].cutout, true, 'leaves');
  H.eq(g.BLOCKS[10].cutout, true, 'glass');
  H.eq(g.BLOCKS[12].liquid, true, 'water');
});

H.test('block predicates agree with the table', () => {
  H.eq(g.isSolid(3), true, 'stone is solid');
  H.eq(g.isSolid(0), false, 'air is not solid');
  H.eq(g.isOpaque(3), true, 'stone is opaque');
  H.eq(g.isOpaque(9), false, 'leaves are see-through');
  H.eq(g.isLiquid(12), true);
  H.eq(g.isCutout(10), true);
  H.eq(g.lightOf(11), 14, 'glowstone emits light');
  H.eq(g.lightOf(3), 0);
});

/* ============================================================
   2. World size and shape
   ============================================================ */
H.suite('World size');

H.test('the world is 200000 x 200000 x 100 as specified', () => {
  H.eq(WORLD_SIZE, 200000, 'length and width');
  H.eq(WORLD_H, 100, 'height');
  H.eq(CHUNKS_PER_SIDE, 12500, '200000 blocks needs a 12500 chunk wide grid');
  H.eq(CHUNKS_PER_SIDE * CHUNK, 200000, 'the chunk grid covers 200000 blocks');
});

H.test('only the requested startup neighborhood is generated', () => {
  const w = new World(91);
  w.generateRadius(CENTRE_CHUNK, CENTRE_CHUNK, 2, null);
  H.eq(w.activeChunks.size, 25, 'the 5 by 5 startup neighborhood is generated');
  H.assert(w.chunks.size < CHUNKS_PER_SIDE * CHUNKS_PER_SIDE,
    'the full map must not be generated all at once');
});

H.test('old saves migrate to the expanded center without losing edits', () => {
  const old = { seed: 12, player1: [104, 40, 104], edits: [[100, 25, 120, 3]] };
  const migrated = migrateWorldSave(old);
  H.eq(migrated.worldSize, WORLD_SIZE, 'expanded dimensions are stored');
  H.eq(migrated.player1[0], WORLD_CENTRE, 'old player x is centered');
  H.eq(migrated.player1[2], WORLD_CENTRE, 'old player z is centered');
  H.eq(migrated.edits[0][0], WORLD_CENTRE - 4, 'old edit x is preserved and translated');
  H.eq(migrated.edits[0][2], WORLD_CENTRE + 16, 'old edit z is preserved and translated');
  H.eq(old.player1[0], 104, 'migration leaves the original save untouched');
});

H.test('missing-size 20000-world saves keep their layout while moving to the new center', () => {
  const old = {
    seed: 12,
    player1: [10001, 40, 9999],
    edits: [[10000, 25, 10016, 3], [9990, 26, 10016, 4]],
  };
  const migrated = migrateWorldSave(old);
  H.eq(migrated.worldSize, WORLD_SIZE, 'expanded dimensions are recorded');
  const offset = WORLD_CENTRE - 10008;
  H.eq(migrated.player1[0], old.player1[0] + offset, 'player x moves with the world center');
  H.eq(migrated.player1[2], old.player1[2] + offset, 'player z moves with the world center');
  H.eq(migrated.edits[0][0], old.edits[0][0] + offset, 'edit x moves with the world center');
  H.eq(migrated.edits[0][2], old.edits[0][2] + offset, 'edit z moves with the world center');
  H.eq(migrated.edits[1][3], old.edits[1][3], 'edit block id is preserved');
  H.eq(old.worldSize, undefined, 'the source save remains unchanged');
});

H.test('tagged 20000-world saves migrate by the center offset and retain edits', () => {
  const old = { worldSize: 20000, seed: 7, player1: [10001, 42, 10012], edits: [[9999, 28, 10020, 6]] };
  const migrated = migrateWorldSave(old);
  const offset = WORLD_CENTRE - 10008;
  H.eq(migrated.worldSize, WORLD_SIZE, 'expanded dimensions are recorded');
  H.eq(migrated.player1[0], old.player1[0] + offset, 'player x shifts with the center');
  H.eq(migrated.player1[2], old.player1[2] + offset, 'player z shifts with the center');
  H.eq(migrated.edits[0][0], old.edits[0][0] + offset, 'edit x shifts with the center');
  H.eq(migrated.edits[0][2], old.edits[0][2] + offset, 'edit z shifts with the center');
  H.eq(migrated.edits[0][3], old.edits[0][3], 'the block id is preserved');
});

H.test('ambiguous and empty missing-size saves retain the legacy migration', () => {
  const empty = { seed: 12, edits: [] };
  const migratedEmpty = migrateWorldSave(empty);
  H.eq(migratedEmpty.worldSize, WORLD_SIZE, 'empty save records expanded dimensions');
  H.eq(migratedEmpty.edits.length, 0, 'empty save remains empty');

  const ambiguous = { player1: [104, 40, 120], edits: [[100, 25, 120, 3]] };
  const migrated = migrateWorldSave(ambiguous);
  H.eq(migrated.player1[0], WORLD_CENTRE, 'ambiguous legacy player uses original-map center');
  H.eq(migrated.edits[0][0], WORLD_CENTRE - 4, 'ambiguous legacy edit is retained and translated');
});

H.test('explicit 200x200 saves still migrate from their declared size', () => {
  const old = { worldSize: 200, seed: 12, player1: [104, 40, 104], edits: [[100, 25, 120, 3]] };
  const migrated = migrateWorldSave(old);
  H.eq(migrated.worldSize, WORLD_SIZE, 'expanded dimensions are stored');
  H.eq(migrated.player1[0], WORLD_CENTRE, 'declared 200-world player is centered');
  H.eq(migrated.edits[0][0], WORLD_CENTRE - 4, 'declared 200-world edit is preserved and translated');
});

H.test('2000x2000 saves migrate by preserving their existing center and edits', () => {
  const old = { worldSize: 2000, seed: 12, player1: [1000, 40, 1000], edits: [[1000, 25, 1200, 3]] };
  const migrated = migrateWorldSave(old);
  H.eq(migrated.worldSize, WORLD_SIZE, 'expanded dimensions are stored');
  H.eq(migrated.player1[0], WORLD_CENTRE, 'old player x is centered');
  H.eq(migrated.player1[2], WORLD_CENTRE, 'old player z is centered');
  H.eq(migrated.edits[0][0], WORLD_CENTRE, 'old edit x is preserved and translated');
  H.eq(migrated.edits[0][2], WORLD_CENTRE + 200, 'old edit z is preserved and translated');
  H.eq(old.player1[0], 1000, 'migration leaves the original save untouched');
});

H.test('the playable square is centred and 200000 across', () => {
  const w = new World(92);
  H.eq(w.isInsideWorld(CX, CX), true, 'the centre is inside');
  H.eq(w.isInsideWorld(0, 0), true, 'the southwest corner is inside');
  H.eq(w.isInsideWorld(199999, 199999), true, 'the northeast corner is inside');
  H.eq(w.isInsideWorld(200000, CX), false, 'the east edge is exclusive');
});

H.test('a player cannot walk off the edge of the world', () => {
  const w = flatWorld(97);
  const p = new Player(w, characterById('steve'));
  p.creative = true;
  p.flying = true;
  p.pos = [CX, 50, CX];
  for (let i = 0; i < 600; i++) {
    p.update(1 / 60, 1, 1, false, false);
    Game.clampToWorld(p);
  }
  const dx = Math.abs(p.pos[0] - CX);
  const dz = Math.abs(p.pos[2] - CX);
  H.assert(dx <= WORLD_SIZE / 2, 'x escaped the world: ' + dx.toFixed(1));
  H.assert(dz <= WORLD_SIZE / 2, 'z escaped the world: ' + dz.toFixed(1));
});

H.test('the observer camera stays within the world', () => {
  Observer.pos = [CX + 500, 200, CX - 500];
  for (let i = 0; i < 60; i++) { Observer.pos[0] += 100; Observer.pos[2] -= 100; }
  Observer.update(1 / 60, 1.5);
  const limit = WORLD_SIZE / 2 + 1;
  H.assert(Math.abs(Observer.pos[0] - CX) <= limit, 'observer x: ' + Observer.pos[0].toFixed(1));
  H.assert(Math.abs(Observer.pos[2] - CX) <= limit, 'observer z: ' + Observer.pos[2].toFixed(1));
});

H.test('edits outside the world are rejected', () => {
  const w = flatWorld(96);
  H.eq(w.setBlock(CX + 150, 40, CX, 3), false, 'too far east');
  H.eq(w.setBlock(CX, 40, CX - 150, 3), false, 'too far south');
  H.eq(w.setBlock(CX, 40, CX, 3), true, 'the centre is fine');
});

/* ============================================================
   3. Terrain generation
   ============================================================ */
H.suite('World generation');

H.test('terrain is deterministic for a given seed', () => {
  const a = new World(777), b = new World(777);
  for (let i = 0; i < 60; i++) {
    H.eq(a.heightAt(CX + i * 3 - 90, CX + i * 5 - 150), b.heightAt(CX + i * 3 - 90, CX + i * 5 - 150));
  }
});

H.test('flat worlds keep a grassy level surface and generate no trees', () => {
  const w = new World(42, null, 'flat');
  const c = w.getChunk(CENTRE_CHUNK, CENTRE_CHUNK, true);
  w.generateChunk(c);
  const base = CENTRE_CHUNK * CHUNK;
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      H.eq(w.heightAt(base + x, base + z), SEA_LEVEL, 'flat height');
      H.eq(c.get(x, SEA_LEVEL, z), 1, 'flat surface should be grass');
    }
  }
  H.assert(!c.blocks.includes(7), 'flat terrain should not generate tree trunks');
  H.assert(!c.blocks.includes(9), 'flat terrain should not generate tree leaves');
});

H.test('different seeds produce genuinely different landscapes', () => {
  const sample = (seed) => {
    const w = new World(seed);
    const h = [];
    for (let i = 0; i < 200; i++) {
      h.push(w.heightAt(CX + (i * 13) % 200 - 100, CX + (i * 29) % 200 - 100));
    }
    return h;
  };
  const a = sample(1), b = sample(2);
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  H.assert(diff > a.length * 0.5, 'seeds should differ, differed at ' + diff);
});

H.test('terrain uses the height a 100 block world gives it', () => {
  for (const seed of [95, 1337, 42, 7, 1000]) {
    const w = new World(seed);
    let min = 999, max = 0, sum = 0, n = 0;
    for (let i = 0; i < 1200; i++) {
      const h = w.heightAt(CX + ((i * 13) % 200) - 100, CX + ((i * 29) % 200) - 100);
      min = Math.min(min, h); max = Math.max(max, h); sum += h; n++;
    }
    H.assert(max > SEA_LEVEL + 30, 'seed ' + seed + ' only reached ' + max);
    H.assert(min >= 2, 'seed ' + seed + ' dipped to ' + min);
    H.assert(max <= WORLD_H - 22, 'seed ' + seed + ' hit ' + max + ', too near the ceiling');
    H.assert(max - min > 25, 'seed ' + seed + ' has little relief');
    void sum;
  }
});

H.test('some of the world is under water', () => {
  const w = new World(42);
  let wet = 0, n = 0;
  for (let i = 0; i < 800; i++) {
    n++;
    if (w.heightAt(CX + (i * 13) % 200 - 100, CX + (i * 29) % 200 - 100) < SEA_LEVEL) wet++;
  }
  H.assert(wet / n > 0.005, 'expected some water, got ' + ((wet / n) * 100).toFixed(1) + '%');
});

H.test('the world floor is solid bedrock and the sky is open', () => {
  const w = flatWorld(5);
  H.eq(w.getBlock(CX, 0, CX), 17, 'y=0 must be bedrock');
  H.eq(w.getBlock(CX, WORLD_H - 1, CX), 0, 'top of world must be air');
  H.eq(w.getBlock(CX, -1, CX), 17, 'below the world must be solid');
});

H.test('every generated column has a solid surface', () => {
  const w = flatWorld(6);
  const base = CENTRE_CHUNK * CHUNK;
  let checked = 0;
  for (let dz = 0; dz < 16; dz++) {
    for (let dx = 0; dx < 16; dx++) {
      const x = base + dx, z = base + dz;
      const surface = w.findSurfaceY(x, z);
      if (surface < 0) continue;
      H.assert(g.isSolid(w.getBlock(x, surface, z)), 'surface must be solid at ' + x + ',' + z);
      H.eq(w.getBlock(x, 0, z), 17, 'bedrock missing at ' + x + ',' + z);
      checked++;
    }
  }
  H.eq(checked, 256, 'every column should have a surface');
});

H.test('water never sits above sea level', () => {
  // Scan the whole world rather than one chunk: whether a given chunk holds
  // any water depends on the seed, and a test should not hinge on that.
  const w = new World(25);
  w.generateRadius(CENTRE_CHUNK, CENTRE_CHUNK, 6, null);
  let sawWater = 0;
  for (const c of w.activeChunks) {
    if (!c.generated) continue;
    for (let i = 0; i < c.blocks.length; i++) {
      if (c.blocks[i] !== 12) continue;
      sawWater++;
      const y = Math.floor(i / (CHUNK * CHUNK));
      H.assert(y <= SEA_LEVEL, 'water at y=' + y + ' is above sea level ' + SEA_LEVEL);
    }
  }
  H.assert(sawWater > 0, 'the world should contain some water');
});

H.test('a single chunk need not contain water', () => {
  // Guards the test above against being rewritten to scan one chunk again.
  const w = flatWorld(7);
  const base = CENTRE_CHUNK * CHUNK;
  for (let y = 0; y < WORLD_H; y++) {
    H.eq(w.getBlock(base, y, base) === 12 && y > SEA_LEVEL, false,
      'no water above sea level in this chunk');
  }
});

H.test('findSurfaceY skips water, leaves and air', () => {
  const w = arenaWorld(36);
  const arena = w.arena;
  const x = CX + 5, z = CX + 5;
  for (let y = arena.floorY; y <= arena.y + 6; y++) w.setBlock(x, y, z, 0);
  w.setBlock(x, arena.floorY, z, 3);
  for (let y = arena.floorY + 1; y <= arena.floorY + 2; y++) w.setBlock(x, y, z, 12);
  w.setBlock(x, arena.floorY + 3, z, 9);
  H.eq(w.findSurfaceY(x, z), arena.floorY, 'should find the stone under water and leaves');
});

H.test('isStandable only accepts ground with headroom', () => {
  const w = flatWorld(35);
  const base = CENTRE_CHUNK * CHUNK;
  let checked = 0;
  for (let dz = 0; dz < 16; dz++) {
    for (let dx = 0; dx < 16; dx++) {
      const x = base + dx, z = base + dz;
      const y = w.findSurfaceY(x, z);
      if (y < 0 || y + 2 >= WORLD_H) continue;
      const ground = g.isSolid(w.getBlock(x, y, z));
      const clear = w.getBlock(x, y + 1, z) === 0 && w.getBlock(x, y + 2, z) === 0;
      H.eq(w.isStandable(x, z), ground && clear, 'disagrees at ' + x + ',' + z);
      checked++;
    }
  }
  H.assert(checked > 200, 'checked too few columns: ' + checked);
});

H.test('a spawn point is air with solid ground beneath', () => {
  const w = flatWorld(31);
  const s = w.findSpawn();
  H.eq(s.length, 3);
  H.eq(w.getBlock(Math.floor(s[0]), Math.floor(s[1]), Math.floor(s[2])), 0,
    'the spawn itself must be air');
  H.assert(g.isSolid(w.getBlock(Math.floor(s[0]), Math.floor(s[1]) - 1, Math.floor(s[2]))),
    'there must be ground under the spawn');
});

/* ============================================================
   4. Lighting
   ============================================================ */
H.suite('Lighting');

H.test('open sky is bright and buried rock is dark', () => {
  const w = flatWorld(11);
  const x = CX + 4, z = CX + 4;
  const surface = w.findSurfaceY(x, z);
  H.assert(surface > 2);
  H.eq(w.getLight(x, surface + 1, z), 15, 'just above ground should be full daylight');
  H.assert(w.getLight(x, 0, z) < 15, 'buried bedrock must not be lit through solid rock');

  // capping the column should shadow the cell below
  const y = surface + 1;
  const before = w.getLight(x, y, z);
  w.setBlock(x, y, z, 3);
  H.assert(w.getLight(x, y - 1, z) < before, 'a roof should cast a shadow');
});

H.test('a sealed room goes dark', () => {
  const w = arenaWorld(12);
  const floor = w.arena.floorY;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -4; dy <= -1; dy++) w.setBlock(CX + dx, floor + dy, CX + dz, 0);
    }
  }
  H.assert(w.getLight(CX, floor - 2, CX) < 12, 'a sealed pocket should be dark');
});

H.test('glowstone lights its neighbourhood and falls off', () => {
  // Build on bare ground rather than in the arena, whose pillars already
  // carry glowstone caps that would light this spot before we start.
  const w = flatWorld(13);
  const x = CX + 4, z = CX + 4;
  const y = w.findSurfaceY(x, z) + 3;
  for (let dy = 0; dy <= 3; dy++) w.setBlock(x, y + dy, z, 0);
  const baseline = w.getBlockLight(x, y, z);
  H.assert(baseline < 4, 'the test spot should start dark, was ' + baseline);

  w.setBlock(x, y, z, 11);
  H.eq(w.getBlockLight(x, y, z), 14, 'the source itself is bright');
  const near = w.getBlockLight(x + 1, y, z);
  H.assert(near >= 13, 'light should spread to the neighbour, got ' + near);
  H.assert(w.getBlockLight(x + 5, y, z) < near, 'light should fall off with distance');
});

H.test('removing a light source removes its glow', () => {
  const w = flatWorld(14);
  const x = CX + 5, z = CX + 5;
  const y = w.findSurfaceY(x, z) + 3;
  for (let dy = 0; dy <= 3; dy++) w.setBlock(x, y + dy, z, 0);
  w.setBlock(x, y, z, 11);
  const lit = w.getBlockLight(x + 1, y, z);
  w.setBlock(x, y, z, 0);
  H.assert(w.getBlockLight(x + 1, y, z) < lit,
    'glow must fade: was ' + lit + ', now ' + w.getBlockLight(x + 1, y, z));
});

/* ============================================================
   5. Block edits
   ============================================================ */
H.suite('Block edits');

H.test('setBlock round-trips through getBlock', () => {
  const w = flatWorld(21);
  H.eq(w.setBlock(CX, 40, CX, 11), true);
  H.eq(w.getBlock(CX, 40, CX), 11);
  H.eq(w.setBlock(CX, 40, CX, 0), true);
  H.eq(w.getBlock(CX, 40, CX), 0);
});

H.test('saved flowing-water levels restore with world edits', () => {
  const w = new World(26, [[CX, 40, CX, 21]]);
  const chunk = w.getChunk(CENTRE_CHUNK, CENTRE_CHUNK, true);
  w.generateChunk(chunk);
  H.eq(w.getBlock(CX, 40, CX), 21, 'the saved flow level is restored');
  H.eq(g.isLiquid(w.getBlock(CX, 40, CX)), true, 'restored flowing water stays liquid');
});

H.test('edits outside the vertical limits are rejected', () => {
  const w = flatWorld(22);
  H.eq(w.setBlock(CX, 0, CX, 0), false, 'cannot edit the bedrock floor');
  H.eq(w.setBlock(CX, WORLD_H, CX, 3), false, 'cannot edit above the world');
});

H.test('an edit dirties the containing chunk', () => {
  const w = flatWorld(23);
  const c = w.getChunk(CENTRE_CHUNK, CENTRE_CHUNK, false);
  c.dirty = false;
  w.setBlock(CX, 40, CX, 3);
  H.eq(c.dirty, true);
});

H.test('an edit on a chunk seam dirties the neighbour too', () => {
  const w = flatWorld(24);
  const seamX = CENTRE_CHUNK * CHUNK;      // local x = 0
  const left = w.getChunk(CENTRE_CHUNK - 1, CENTRE_CHUNK, false);
  const here = w.getChunk(CENTRE_CHUNK, CENTRE_CHUNK, false);
  H.assert(left, 'the western neighbour should exist');
  left.dirty = false;
  here.dirty = false;
  w.setBlock(seamX, 41, CX, 3);
  H.eq(here.dirty, true);
  H.eq(left.dirty, true, 'the neighbour across the seam must re-mesh');
});

H.test('an edit re-lights the affected column', () => {
  const w = flatWorld(25);
  const y = w.findSurfaceY(CX, CX) + 1;
  w.setBlock(CX, y, CX, 3);
  const capped = w.getLight(CX, y, CX);
  w.setBlock(CX, y, CX, 0);
  H.assert(w.getLight(CX, y, CX) > capped, 'removing the cap should brighten the column');
});

/* ============================================================
   6. Arena
   ============================================================ */
H.suite('Spawn and arena');

H.test('the arena has a floor, a wall and cover', () => {
  const w = arenaWorld(32);
  const arena = w.arena;
  H.eq(arena.x, CX);
  H.eq(w.getBlock(CX, arena.floorY, CX), 4, 'floor must be cobble');
  H.eq(w.getBlock(CX, arena.y, CX), 0, 'headroom above the floor');
  H.eq(w.getBlock(CX, arena.y, CX - 16), 4, 'the edge wall must be solid');
  H.eq(w.getBlock(CX, arena.y + 1, CX - 16), 4, 'and tall enough to stop a fall');
});

H.test('cover starts above head height', () => {
  const w = arenaWorld(37);
  const arena = w.arena;
  // A fighter is 1.78 blocks tall standing on arena.y, so their body fills
  // arena.y and arena.y+1. Cover must begin above that.
  H.eq(w.getBlock(CX, arena.y + 1, CX), 0, 'nobody should be boxed in by cover');
  H.eq(w.getBlock(CX, arena.y + 2, CX), 6, 'cover should start at head height + 1');
  H.eq(w.getBlock(CX, arena.y + 5, CX), 11, 'the pillar should be capped with glowstone');
});

H.test('the arena floor is flat all round', () => {
  const w = arenaWorld(33);
  const arena = w.arena;
  const samples = [[6, 0], [0, 6], [-6, 0], [0, -6], [6, 6], [-6, -6],
    [6, -6], [-6, 6], [12, 0], [0, 12], [-12, 0], [0, -12]];
  for (const [dx, dz] of samples) {
    H.eq(w.getBlock(CX + dx, arena.floorY, CX + dz), 4, 'floor at ' + dx + ',' + dz);
    H.eq(w.getBlock(CX + dx, arena.y, CX + dz), 0, 'headroom at ' + dx + ',' + dz);
  }
});

H.test('the whole arena floor is solid', () => {
  const w = arenaWorld(34);
  const arena = w.arena;
  let solid = 0, total = 0;
  for (let dz = -14; dz <= 14; dz++) {
    for (let dx = -14; dx <= 14; dx++) {
      if (Math.hypot(dx, dz) > 14) continue;
      total++;
      if (g.isSolid(w.getBlock(CX + dx, arena.floorY, CX + dz))) solid++;
    }
  }
  H.eq(solid, total, 'every floor tile must be solid, got ' + solid + '/' + total);
});

H.test('both fighters start on clear ground', () => {
  const w = arenaWorld();
  const a = new Player(w, characterById('steve'));
  const b = new Player(w, characterById('golem'));
  Fight.reset(a, b);
  for (const [who, p] of [['first', a], ['second', b]]) {
    const fx = Math.floor(p.pos[0]), fz = Math.floor(p.pos[2]);
    H.eq(p.pos[1], w.arena.y, who + " fighter should stand on the surface");
    H.assert(g.isSolid(w.getBlock(fx, w.arena.floorY, fz)), who + ' needs ground');
    H.eq(w.getBlock(fx, w.arena.y, fz), 0, who + ' needs headroom');
    H.eq(w.getBlock(fx, w.arena.y + 1, fz), 0, who + ' needs room to jump');
  }
  H.assert(Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]) > 5,
    'the fighters should start apart');
});

H.test('the arena is built inside the playable world', () => {
  const w = arenaWorld();
  H.assert(w.isInsideWorld(w.arena.x - 16, w.arena.z - 16), 'south west corner');
  H.assert(w.isInsideWorld(w.arena.x + 16, w.arena.z + 16), 'north east corner');
});

/* ============================================================
   7. Raycasting
   ============================================================ */
H.suite('Raycasting');

H.test('a ray straight down hits the ground beneath', () => {
  const w = arenaWorld(41);
  const arena = w.arena;
  // A column inside the wall but clear of the cover pillars.
  const x = CX + 5.5, z = CX + 5.5;
  const hit = w.raycast(x, arena.y + 3, z, 0, -1, 0, 20);
  H.eq(hit.hit, true, 'should hit the arena floor');
  H.eq(hit.y, arena.floorY, 'should hit the top floor block');
  H.eq(hit.ny, 1, 'the normal should point up');
});

H.test('a ray into empty sky misses', () => {
  const w = flatWorld(42);
  H.eq(w.raycast(CX + 0.5, WORLD_H - 2, CX + 0.5, 0, 1, 0, 5).hit, false);
});

H.test('the reported normal matches the face that was hit', () => {
  const w = arenaWorld(43);
  // Fire at the arena wall from outside it, so the ray crosses open air
  // first and the reported normal is the face it actually struck.
  const hit = w.raycast(CX + 0.5, w.arena.y, CX + 18.5, 0, 0, -1, 30);
  H.eq(hit.hit, true, 'should reach the wall');
  H.eq(hit.nz, 1, 'striking the near face should report +Z');
  H.eq(hit.z, CX + 16, 'should hit the outermost wall column');
});

H.test('raycast normals are correct on every face', () => {
  const w = arenaWorld(46);
  const arena = w.arena;
  // A single block floating in clear air, so each face is hit head on.
  const bx = CX + 5, by = arena.y + 2, bz = CX + 5;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) w.setBlock(bx + dx, by + dy, bz + dz, 0);
    }
  }
  w.setBlock(bx, by, bz, 3);
  // A ray travelling in direction d strikes the face whose outward normal is
  // -d, so the reported normal points back at the shooter.
  const cases = [
    { from: [bx + 3.5, by + 0.5, bz + 0.5], dir: [-1, 0, 0], n: [1, 0, 0], name: 'from +X' },
    { from: [bx - 0.5, by + 0.5, bz + 0.5], dir: [1, 0, 0], n: [-1, 0, 0], name: 'from -X' },
    { from: [bx + 0.5, by + 0.5, bz + 3.5], dir: [0, 0, -1], n: [0, 0, 1], name: 'from +Z' },
    { from: [bx + 0.5, by + 0.5, bz - 0.5], dir: [0, 0, 1], n: [0, 0, -1], name: 'from -Z' },
    { from: [bx + 0.5, by + 3.5, bz + 0.5], dir: [0, -1, 0], n: [0, 1, 0], name: 'from above' },
    { from: [bx + 0.5, by - 0.5, bz + 0.5], dir: [0, 1, 0], n: [0, -1, 0], name: 'from below' },
  ];
  for (const c of cases) {
    const hit = w.raycast(c.from[0], c.from[1], c.from[2], c.dir[0], c.dir[1], c.dir[2], 8);
    H.eq(hit.hit, true, c.name + ' should hit');
    H.eq([hit.nx, hit.ny, hit.nz].join(','), c.n.join(','), c.name + ' normal');
  }
});

H.test('raycast stops at its distance limit', () => {
  const w = flatWorld(44);
  H.eq(w.raycast(CX + 0.5, WORLD_H - 1, CX + 0.5, 0, -1, 0, 1.5).hit, false);
});

H.test('raycast passes through water', () => {
  const w = arenaWorld(45);
  const x = CX + 5, z = CX + 5;
  for (let y = 1; y <= w.arena.y + 8; y++) w.setBlock(x, y, z, 0);
  for (let y = 2; y <= w.arena.y + 6; y++) w.setBlock(x, y, z, 12);
  H.eq(w.raycast(x + 0.5, w.arena.y + 8.5, z + 0.5, 0, -1, 0, 30).hit, false);
});

/* ============================================================
   8. Meshing
   ============================================================ */
H.suite('Meshing');

H.test('an empty chunk produces no mesh data', () => {
  const { w, chunk } = scratchWorld(51);
  const mesh = buildChunk(w, chunk);
  H.eq(quadCount(mesh), 0);
  H.eq(transQuadCount(mesh), 0);
});

H.test('a single block renders six quads', () => {
  const { w, chunk, y, BASE } = scratchWorld(52);
  w.setBlock(BASE, y, BASE, 3);
  H.eq(quadCount(buildChunk(w, chunk)), 6, 'a cube has six faces');
});

H.test('two touching blocks hide the shared face', () => {
  const { w, chunk, y, BASE } = scratchWorld(53);
  w.setBlock(BASE, y, BASE, 3);
  w.setBlock(BASE + 1, y, BASE, 3);
  H.eq(quadCount(buildChunk(w, chunk)), 10, '6+6-2 = 10');
});

H.test('meshing reads the correct east and south neighbour chunks at seams', () => {
  const w = new World(59);
  const chunk = w.getChunk(100, 200, true);
  const east = w.getChunk(101, 200, true);
  const south = w.getChunk(100, 201, true);
  for (const c of [chunk, east, south]) { c.allocate(); c.generated = true; }
  chunk.set(15, 10, 8, 3);
  east.set(0, 10, 8, 3);
  chunk.set(8, 10, 15, 3);
  south.set(8, 10, 0, 3);
  H.eq(quadCount(buildChunk(w, chunk)), 10, 'both cross-chunk shared faces are hidden');
});

H.test('ambient occlusion samples adjacent tangent cells on all face corners', () => {
  const here = g.pidx(8, 20, 8);
  const axes = [0, 1, 2];
  const offset = vector => g.pidx(8 + vector[0], 20 + vector[1], 8 + vector[2]) - here;
  for (const face of g.FACES) {
    const tangentAxes = axes.filter(axis => face.n[axis] === 0);
    for (let cornerIndex = 0; cornerIndex < 4; cornerIndex++) {
      const corner = face.corners[cornerIndex];
      const sideA = face.n.slice(), sideB = face.n.slice(), diagonal = face.n.slice();
      sideA[tangentAxes[0]] += corner[tangentAxes[0]] === 0 ? -1 : 1;
      sideB[tangentAxes[1]] += corner[tangentAxes[1]] === 0 ? -1 : 1;
      diagonal[tangentAxes[0]] += corner[tangentAxes[0]] === 0 ? -1 : 1;
      diagonal[tangentAxes[1]] += corner[tangentAxes[1]] === 0 ? -1 : 1;
      const expected = [offset(sideA), offset(sideB), offset(diagonal)];
      H.assert(JSON.stringify(face.aoOffsets[cornerIndex]) === JSON.stringify(expected),
        'AO offsets must follow the two tangent axes');

      g._padBlocks.fill(0);
      H.eq(g.aoAt(here, cornerIndex, face), 3, 'empty surroundings have no occlusion');
      g._padBlocks[here + expected[0]] = 3;
      H.eq(g.aoAt(here, cornerIndex, face), 2, 'an adjacent first-side blocker darke…17286 tokens truncated…gestures for scrollable child panels');

  const t = H.load({ touch: true, boot: false });
  const menu = t.document.getElementById('menu');
  menu.scrollTop = 40;
  menu.scrollHeight = 700;
  menu.clientHeight = 500;
  t.Touch.init();
  const menuTouchStart = menu.eventListeners.touchstart[0];
  const menuMove = menu.eventListeners.touchmove[0];
  const menuEnd = menu.eventListeners.touchend[0];
  let menuPrevented = 0;
  menuTouchStart({ changedTouches: [{ identifier: 9, clientX: 200, clientY: 300 }] });
  menuMove({ changedTouches: [{ identifier: 9, clientX: 204, clientY: 295 }], cancelable: true, preventDefault() { menuPrevented++; } });
  H.eq(menu.scrollTop, 40, 'small finger drift while tapping must not move the menu');
  H.eq(menuPrevented, 0, 'small finger drift must not cancel a menu button tap');
  menuEnd({ changedTouches: [{ identifier: 9 }] });
  menuTouchStart({ changedTouches: [{ identifier: 10, clientX: 200, clientY: 300 }] });
  menuMove({ changedTouches: [{ identifier: 10, clientX: 205, clientY: 220 }], cancelable: true, preventDefault() { menuPrevented++; } });
  H.eq(menu.scrollTop, 120, 'vertical menu swipe should move the full-screen scroll area with the finger');
  H.eq(menuPrevented, 1, 'deliberate vertical menu swipe should prevent Safari from competing with the manual scroll');
  menuEnd({ changedTouches: [{ identifier: 10 }] });

  let canceledTap = false;
  for (const end of t.documentListeners.touchend || []) {
    end({ cancelable: true, target: { closest: () => null }, preventDefault() { canceledTap = true; } });
  }
  H.assert(!canceledTap, 'global touchend handling must not cancel quick menu or auth taps');
  const move = t.listeners.touchmove[0];
  let prevented = 0;
  move({ changedTouches: [{ identifier: 44, clientX: 20, clientY: 30 }],
    cancelable: true, preventDefault() { prevented++; } });
  H.eq(prevented, 0, 'untracked panel touches must not cancel native scrolling');
  t.Touch.lookId = 44;
  move({ changedTouches: [{ identifier: 44, clientX: 24, clientY: 34 }],
    cancelable: true, preventDefault() { prevented++; } });
  H.eq(prevented, 1, 'game-owned look drags must still suppress page gestures');
});

H.test('pagehide live-visit sync carries page authentication on a keepalive request', () => {
  const requests = [];
  const t = H.load({ boot: false, fetch: (url, options) => {
    requests.push({ url, options });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: 'active', cursor: 3 }) });
  } });
  const network = t.Network;
  network.serverMode = true;
  network.profile = { id: 'p1' };
  network.ready = true;
  network.visitRole = 'owner';
  network.visitActive = true;
  network.savedWorld = { seed: 123, edits: [], revision: 2 };
  network.pendingSave = { seed: 123, edits: [[120, 8, 121, 4]], revision: 2 };
  network.visitPlayerState = () => ({ x: 1, y: 2, z: 3 });
  network.visitEditDelta = () => [[120, 8, 121, 4]];
  network.saveOnPageHide();

  H.eq(requests.length, 1, 'pagehide should queue one authenticated visit sync');
  H.eq(requests[0].url, '/api/visit/sync', 'visit state should use the live-sync route');
  H.eq(requests[0].options.keepalive, true, 'the request should be allowed to finish during navigation');
  H.assert(/^[a-f0-9]{32}$/.test(requests[0].options.headers['X-BW-Page']),
    'the server-required page auth header must accompany pagehide sync');
  H.assert(t.storage.getItem('blocky-world-server-recovery-v1:p1'),
    'the unsent world snapshot must remain recoverable while the visit sync is queued');
});

H.test('pagehide world flush uses the authenticated keepalive fetch path', async () => {
  const requests = [];
  const t = H.load({ boot: false, fetch: (url, options) => {
    requests.push({ url, options });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ revision: 2 }) });
  } });
  const network = t.Network;
  network.serverMode = true;
  network.profile = { id: 'p2' };
  network.ready = true;
  network.savedWorld = { seed: 123, edits: [], revision: 2 };
  network.pendingSave = { seed: 123, edits: [], revision: 2 };
  network.saveOnPageHide();
  await new Promise(resolve => setImmediate(resolve));

  H.eq(requests.length, 1, 'pagehide should queue the pending world flush');
  H.eq(requests[0].url, '/api/world', 'world changes should use the normal authenticated save route');
  H.eq(requests[0].options.keepalive, true, 'world saving should survive page navigation');
  H.assert(/^[a-f0-9]{32}$/.test(requests[0].options.headers['X-BW-Page']),
    'the server-required page auth header must accompany pagehide saves');
});

H.test('the quality profile trims weak phones but not desktops', () => {
  const weak = H.load({ touch: true, mem: 2, cores: 2, boot: false });
  H.assert(weak.Game.settings.renderDist <= 4,
    'a weak phone should see less far, got ' + weak.Game.settings.renderDist);
  H.assert(weak.Game.dprCap <= 1.5,
    'a low-memory phone should be capped harder, got ' + weak.Game.dprCap);

  const good = H.load({ touch: true, mem: 8, cores: 8, boot: false });
  H.assert(good.Game.settings.renderDist >= weak.Game.settings.renderDist,
    'a capable phone should see at least as far');

  const desktop = H.load({ touch: false, mem: 8, cores: 8, boot: false });
  H.assert(desktop.Game.settings.renderDist >= 4, 'a desktop should keep a longer view');
  H.assert(desktop.Game.dprCap <= 1.5,
    'desktop pixel work should be capped at 1.5x, got ' + desktop.Game.dprCap);

  const weakDesktop = H.load({ touch: false, mem: 4, cores: 4, boot: false });
  H.eq(weakDesktop.Game.settings.renderDist, 4, 'a weaker desktop should shorten the automatic view');
  H.assert(weakDesktop.Game.dprCap <= 1.25,
    'a weaker desktop should receive a lower pixel cap, got ' + weakDesktop.Game.dprCap);
});

H.test('the visit owner can open shared mode controls while pointer locked', () => {
  const t = H.load({ boot: false });
  let released = 0, opened = 0, prevented = false;
  t.Network.visitRole = 'owner';
  t.Network.visitActive = true;
  t.Input.releaseLock = () => { released++; };
  t.Network.openVisitModePicker = () => { opened++; };
  t.Game.bindGlobalKeys();
  const keydown = t.listeners.keydown[t.listeners.keydown.length - 1];
  keydown({ code: 'KeyM', preventDefault: () => { prevented = true; } });
  H.eq(released, 1, 'release pointer lock so the overlay receives clicks');
  H.eq(opened, 1, 'show the shared mode picker');
  H.eq(prevented, true, 'do not trigger browser defaults');

  t.Network.visitRole = 'visitor';
  keydown({ code: 'KeyM', preventDefault: () => { prevented = false; } });
  H.eq(released, 1, 'visitors cannot open the owner mode picker');
  H.eq(opened, 1, 'visitors leave mode changes to the owner');
});

H.test('render distance stays playable on every device profile', () => {
  const profiles = [
    { touch: true, mem: 1, cores: 1 },
    { touch: true, mem: 8, cores: 8 },
    { touch: false, mem: 1, cores: 1 },
    { touch: false, mem: 8, cores: 8 },
  ];
  for (const cfg of profiles) {
    const t = H.load(Object.assign({ boot: false }, cfg));
    const d = t.Game.settings.renderDist;
    H.assert(d >= 3 && d <= 9, JSON.stringify(cfg) + ' produced renderDist ' + d);
  }
});

H.test('consuming look input applies it exactly once', () => {
  const t = H.load({ touch: true, boot: false });
  t.Touch.look.x = 40;
  t.Touch.look.y = -20;
  H.eq(t.Touch.consumeLook().x, 40);
  H.eq(t.Touch.consumeLook().x, 0, 'look delta must not be applied twice');
});

H.test('the stick is analog: partial pushes give partial speed', () => {
  const T = H.load({ touch: true, boot: false }).Touch;
  // Mirrors the maths in touch.js: normalise by the radius, then rescale the
  // magnitude past the dead zone.
  const push = (dx) => {
    const nx = dx / T.stickRadius;
    const mag = Math.abs(nx);
    if (mag < T.deadZone) return 0;
    return Math.sign(nx) * (mag - T.deadZone) / (1 - T.deadZone);
  };
  const half = push(T.stickRadius * 0.5);
  const full = push(T.stickRadius);
  H.assert(half > 0 && half < 1, 'a half push should be partial, got ' + half.toFixed(2));
  H.near(full, 1, 0.001, 'a full push should max out');
  H.assert(full > half * 2, 'full should be much faster than half');
});

H.test('the stick has a dead zone and no diagonal speed advantage', () => {
  const T = H.load({ touch: true, boot: false }).Touch;
  const r = T.stickRadius;
  const stick = (dx, dy) => {
    const nx = dx / r, ny = dy / r;
    const mag = Math.hypot(nx, ny);
    if (mag < T.deadZone) return { x: 0, y: 0, mag: 0 };
    const scaled = (mag - T.deadZone) / (1 - T.deadZone);
    return { x: (nx / mag) * scaled, y: (ny / mag) * scaled, mag: scaled };
  };

  // inside the dead zone gives no input at all
  H.eq(stick(r * T.deadZone * 0.5, 0).mag, 0, 'a tiny push should read as neutral');
  H.eq(stick(0, r * T.deadZone * 0.5).mag, 0, 'on either axis');

  // a full push in any direction is full speed
  H.near(stick(r, 0).mag, 1, 0.001, 'straight full');
  const q = r * Math.SQRT1_2;
  H.near(stick(q, q).mag, 1, 0.001, 'diagonal full');
  H.near(Math.hypot(stick(q, q).x, stick(q, q).y), 1, 0.001,
    'diagonal should not be faster than straight');

  // half a push is meaningfully slower
  H.assert(stick(r * 0.5, 0).mag < 0.6, 'half a push should be well under full');
});

H.test('the stick radius and dead zone are thumb sized', () => {
  const T = H.load({ touch: true, boot: false }).Touch;
  H.assert(T.stickRadius > 30 && T.stickRadius < 120,
    'stick radius should suit a thumb, got ' + T.stickRadius);
  H.assert(T.deadZone > 0.05 && T.deadZone < 0.3,
    'dead zone should be forgiving, got ' + T.deadZone);
});

H.test('the movement stick is visible before it is touched', () => {
  // The complaint that started this: the stick only appeared once a thumb was
  // already down, so a child had nothing to aim at. It must be on screen at
  // rest, and the resting spot comes from CSS with no inline override.
  const css = fs.readFileSync(path.join(H.ROOT, 'style.css'), 'utf8');

  const stick = css.slice(css.indexOf('#touch-stick {'));
  const block = stick.slice(0, stick.indexOf('}'));
  H.assert(!/opacity:\s*0\s*;/.test(block),
    'the stick base must not start invisible, it has to be seen before use');
  H.assert(!/display:\s*none\s*;/.test(block),
    'the stick must not be display:none, or there is nothing to aim at');

  // A resting position is required, expressed with safe-area insets so it
  // clears the home indicator on an iPad.
  H.assert(/left:\s*calc\(/.test(block) && /top:\s*calc\(/.test(block),
    'the resting position should be set in CSS and respect the safe area');

  // And it must not be parked off screen at any phone or tablet size.
  const size = Math.max(css.indexOf('safe-area-inset-bottom'), 0);
  H.assert(size > 0, 'the resting spot should account for the home indicator');
});

H.test('the touch layer attaches its listeners on a touch device only', () => {
  // init() bails out early on a desktop, so the listeners are never bound.
  // That is intended, but it means a forced-on touch UI on a desktop would be
  // dead, so assert the guard is what we think it is.
  const desktop = H.load({ touch: false, boot: false });
  desktop.Touch.init();
  H.eq(desktop.Touch.stickId, null, 'no stick should be tracked on a desktop');
  H.eq(desktop.Touch.move.x, 0, 'and no movement input');

  const phone = H.load({ touch: true, boot: false });
  phone.Touch.init();
  H.eq(phone.Touch.enabled, true, 'a touch device should bind the stick');
});

H.test('look gain scales with screen size so the feel is consistent', () => {
  const gain = (width) => 26 / Math.max(400, width);
  H.assert(gain(390) > gain(1024), 'a phone needs more gain per pixel');
  H.assert(gain(390) * 200 > 0, 'a drag must turn the view');
});

/* ============================================================
   20. Save data and options
   ============================================================ */
H.suite('Save data and settings');

H.test('settings survive a save and reload', () => {
  const shared = H.makeStorage();
  const first = H.load({ storage: shared, boot: false });
  // Pick values the defaults can never be, so a mix-up cannot pass.
  first.Game.settings.renderDist = 3;
  first.Game.settings.renderDistAuto = false;
  first.Game.settings.dayNight = false;
  first.Game.settings.sfx = false;
  first.Game.pick.p1 = 'ninja';
  first.Game.pick.p2 = 'doll';
  first.Game.pick.p2bot = false;
  first.Game.selectedSlot = 5;
  first.Game.world = first.World.world = new first.World(4242);
  first.Game.players[0] = new first.Player(first.Game.world, first.characterById('ninja'));
  first.Game.players[0].inventory.apple = 4;
  first.Game.players[0].inventory.meat = 2;
  first.Game.save();

  const written = H.savedData(first.storage);
  H.assert(written, 'something should have been written to storage');

  const second = H.load({ storage: shared, boot: false });
  H.eq(second.Game.settings.renderDist, 3, 'render distance');
  H.eq(second.Game.settings.dayNight, false, 'day/night');
  H.eq(second.Game.settings.sfx, false, 'sound');
  H.eq(second.Game.pick.p1, 'ninja', 'player one character');
  H.eq(second.Game.pick.p2, 'doll', 'player two character');
  H.eq(second.Game.pick.p2bot, false, 'bot preference');
  H.eq(second.Game.selectedSlot, 5, 'hotbar slot');
  H.eq(second.Game.saved.inventory.apple, 4, 'apple inventory survives the local save');
  H.eq(second.Game.saved.inventory.meat, 2, 'meat inventory survives the local save');
});

H.test('flat and normal worlds keep separate local saves', () => {
  const shared = H.makeStorage();
  const first = H.load({ storage: shared, boot: false });
  first.Game.activeWorldType = 'normal';
  first.Game.world = first.World.world = new first.World(111);
  first.Game.save();
  first.storage.setItem('blocky-world-selected-type', 'flat');
  first.Game.activeWorldType = 'flat';
  first.Game.world = first.World.world = new first.World(222, null, 'flat');
  first.Game.save();

  H.eq(JSON.parse(first.storage.getItem('blocky-world-local-save-v1')).seed, 111, 'normal save seed');
  H.eq(JSON.parse(first.storage.getItem('blocky-world-local-save-v1:flat')).seed, 222, 'flat save seed');

  const flatLoad = H.load({ storage: shared, boot: false });
  H.eq(flatLoad.Game.activeWorldType, 'flat', 'the selected world type');
  H.eq(flatLoad.Game.saved.seed, 222, 'the flat world should load its own save');
  first.storage.setItem('blocky-world-selected-type', 'normal');
  const normalLoad = H.load({ storage: shared, boot: false });
  H.eq(normalLoad.Game.saved.seed, 111, 'the normal world should retain its own save');
});

H.test('server recovery uses its own world type and revision', () => {
  const script = String.raw`    const assert = require('assert');
    const fs = require('fs');
    const vm = require('vm');
    const source = fs.readFileSync('js/network.js', 'utf8');
    function fixture(flatRevision) {
      const values = new Map();
      const localStorage = {
        getItem: (key) => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key),
      };
      const calls = [];
      const context = {
        window: {}, document: { addEventListener() {}, getElementById() { return null; } },
        localStorage, location: { protocol: 'https:' }, navigator: {}, console,
        setTimeout() { return 1; }, clearTimeout() {}, Game: { activeWorldType: 'normal' },
      };
      vm.createContext(context);
      vm.runInContext(source, context);
      const network = context.window.Network;
      network.serverMode = true;
      network.ready = true;
      network.profile = { id: 'p1' };
      network.activeWorldType = 'normal';
      network.serverRevision = 10;
      network.saveRevision = 10;
      network.savedWorld = { worldType: 'normal', revision: 10, seed: 100, edits: [] };
      network.lastSavedSeed = 100;
      network.request = async (url, options) => {
        calls.push({ url, options });
        if (options && options.method === 'PUT') return { revision: flatRevision + 1 };
        if (url.includes('type=flat')) return { world: { revision: flatRevision, seed: 222, edits: [] } };
        return { world: { revision: 10, seed: 100, edits: [] } };
      };
      return { context, network, localStorage, calls };
    }
    (async () => {
      const recovery = fixture(2);
      recovery.localStorage.setItem(recovery.network.recoveryKey(), JSON.stringify({
        baseRevision: 2,
        world: { worldType: 'flat', revision: 2, seed: 222, edits: [] },
      }));
      await recovery.network.restoreRecovery();
      assert.strictEqual(recovery.network.activeWorldType, 'flat');
      assert.strictEqual(recovery.context.Game.activeWorldType, 'flat');
      await recovery.network.flushSave();
      const write = recovery.calls.find((call) => call.options && call.options.method === 'PUT');
      assert(write && write.url.includes('type=flat'), 'recovery must be written to the flat save');

      const conflict = fixture(3);
      conflict.network.showRecoveryConflict = () => {};
      conflict.localStorage.setItem(conflict.network.recoveryKey(), JSON.stringify({
        baseRevision: 2,
        world: { worldType: 'flat', revision: 2, seed: 222, edits: [] },
      }));
      await conflict.network.restoreRecovery();
      assert.strictEqual(conflict.network.serverRevision, 3, 'compare against flat server revision');
      assert(conflict.network.recoveryConflict, 'a newer flat save should show a conflict');
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  H.eq(result.status, 0, result.stderr || 'recovery regression subprocess failed');
});

H.test('a render distance the player chose survives the auto profile', () => {
  // Regression: applyQuality() ran after load() and reset the value to the
  // device profile default, so moving the slider was silently undone on the
  // next reload.
  const shared = H.makeStorage();
  const first = H.load({ storage: shared, touch: true, mem: 8, cores: 8, boot: false });
  first.Game.settings.renderDist = 8;
  first.Game.settings.renderDistAuto = false;
  first.Game.world = first.World.world = new first.World(4242);
  first.Game.save();

  const second = H.load({ storage: shared, touch: true, mem: 8, cores: 8, boot: false });
  H.eq(second.Game.settings.renderDist, 8, 'the chosen render distance');
  H.eq(second.Game.renderDist, 8, 'and the renderer should be using it');
});

H.test('the auto profile still picks a distance while it is allowed to', () => {
  const weak = H.load({ touch: true, mem: 2, cores: 2, boot: false });
  const good = H.load({ touch: true, mem: 8, cores: 8, boot: false });
  H.assert(weak.Game.settings.renderDist < good.Game.settings.renderDist,
    'a weak phone (' + weak.Game.settings.renderDist + ') should see less far than a good one ('
    + good.Game.settings.renderDist + ')');
});

H.test('QA memory storage stays in page memory and makes no network calls', () => {
  const calls = { storage: 0, network: 0 };
  const nativeStorage = {
    getItem() { calls.storage++; throw new Error('native localStorage accessed'); },
    setItem() { calls.storage++; throw new Error('native localStorage accessed'); },
    removeItem() { calls.storage++; throw new Error('native localStorage accessed'); },
    key() { calls.storage++; throw new Error('native localStorage accessed'); },
    get length() { calls.storage++; throw new Error('native localStorage accessed'); },
  };
  const fetchTrap = () => { calls.network++; throw new Error('network request attempted'); };
  const qa = H.load({ qaMemoryOnly: true, includeNetwork: false, storage: nativeStorage, boot: false, fetch: fetchTrap });
  H.eq(qa.Network, undefined, 'the network module is omitted');
  H.eq(qa.windowStub.Network, undefined, 'the page has no network API');
  H.assert(qa.Game && qa.World && qa.Game.render, 'the real game and renderer load');
  qa.Game.world = qa.World.world = new qa.World(42);
  qa.Game.load();
  qa.Game.save();
  H.assert(qa.BWStorage.getItem(qa.Game.saveKey('normal')), 'game saves use page memory');
  H.assert(qa.BWStorage.length > 0, 'page memory reports its saved data');
  H.eq(calls.storage, 0, 'QA never reads or writes native localStorage');
  H.eq(calls.network, 0, 'QA never makes a network request');
  const fresh = H.load({ qaMemoryOnly: true, includeNetwork: false, storage: nativeStorage, boot: false, fetch: fetchTrap });
  H.eq(fresh.BWStorage.length, 0, 'a fresh page starts with empty memory');
  H.eq(calls.storage, 0, 'fresh QA load still avoids native localStorage');
});

H.test('QA can switch worlds without a network module', async () => {
  const qa = H.load({ qaMemoryOnly: true, includeNetwork: false, boot: false });
  qa.Game.save = () => true;
  qa.Game.buildWorld = async () => {};
  qa.UI.showMainMenu = () => {};
  qa.UI.toast = () => {};
  await qa.Game.selectWorld('flat');
  H.eq(qa.Game.activeWorldType, 'flat', 'the requested world becomes active');
  H.eq(qa.BWStorage.getItem('blocky-world-selected-type'), 'flat', 'the selected world uses memory storage');
  H.eq(qa.Network, undefined, 'the network module remains absent');
});

H.test('normal storage adapter preserves localStorage delegation', () => {
  const native = H.makeStorage();
  const ordinary = H.load({ storage: native, boot: false });
  ordinary.BWStorage.setItem('adapter-check', 'saved');
  H.eq(ordinary.BWStorage.getItem('adapter-check'), 'saved');
  H.eq(native.getItem('adapter-check'), 'saved');
});

H.test('the save contains every key the loader reads', () => {
  const shared = H.makeStorage();
  const first = H.load({ storage: shared, boot: false });
  first.Game.world = first.World.world = new first.World(4242);
  first.Game.save();
  const raw = H.savedData(first.storage);
  H.assert(raw, 'a save should have been written');
  for (const key of ['seed', 'player1', 'slot', 'pick', 'settings']) {
    H.assert(key in raw, 'the save should contain ' + key);
  }
});

H.test('a fresh load uses the defaults', () => {
  const fresh = H.load({ boot: false });
  H.eq(fresh.Game.pick.p1, 'steve');
  H.eq(fresh.Game.pick.p2bot, true, 'the computer opponent is the default');
});

H.test('corrupt save data does not stop the game loading', () => {
  const broken = H.makeStorage();
  broken.setItem('blocky-world-local-save-v1', '{not valid json');
  const t = H.load({ storage: broken, boot: false });
  H.assert(t.Game, 'the game object should still exist');
  H.eq(t.Game.pick.p1, 'steve', 'it should fall back to defaults');
});

H.test('a save is actually read back in, not just written', () => {
  // Guards the harness itself: these tests are only meaningful if load() runs
  // when a sandbox is created, so assert a plain round trip end to end.
  const shared = H.makeStorage();
  const first = H.load({ storage: shared, boot: false });
  first.Game.settings.dayNight = false;
  first.Game.world = first.World.world = new first.World(4242);
  first.Game.save();

  const second = H.load({ storage: shared, boot: false });
  H.eq(second.Game.settings.dayNight, false, 'the second load should see the saved value');
  H.assert(second.Game.saved, 'the loaded sandbox should report a parsed save');
});

H.test('settings stay inside legal ranges', () => {
  const s = Game.settings;
  H.assert(s.renderDist >= 3 && s.renderDist <= 9, 'render distance ' + s.renderDist);
  H.assert(s.sensitivity > 0 && s.sensitivity < 0.01, 'sensitivity ' + s.sensitivity);
});

H.test('the hotbar selection is clamped', () => {
  Game.selectSlot(-5);
  H.eq(Game.selectedSlot, 0);
  Game.selectSlot(99);
  H.eq(Game.selectedSlot, HOTBAR_ITEMS.length - 1, 'selection clamps to the last selectable item');
  H.eq(g.HOTBAR_BLOCKS.length, 9, 'the shovel tool does not increase the block inventory count');
  H.eq(HOTBAR_ITEMS[9].id, 'shovel', 'the shovel retains its original slot');
  H.eq(HOTBAR_ITEMS[10].id, 'apple', 'apple is the first food slot');
  H.eq(HOTBAR_ITEMS[11].id, 'meat', 'meat is the last hotbar slot');
  Game.selectSlot(3);
  H.eq(Game.selectedSlot, 3);
});

/* ============================================================
   21. Regressions
   ============================================================ */
H.suite('Regressions');

H.test('the spawn chunk is always generated', () => {
  const w = new World(81);
  w.generateRadius(CENTRE_CHUNK, CENTRE_CHUNK, 6, null);
  const s = w.findSpawn();
  const c = w.getChunk(Math.floor(s[0] / CHUNK), Math.floor(s[2] / CHUNK), false);
  H.assert(c && c.generated, 'the spawn chunk must be generated');
  H.assert(g.isSolid(w.getBlock(Math.floor(s[0]), Math.floor(s[1]) - 1, Math.floor(s[2]))),
    'there must be ground under the spawn');
});

H.test('arena construction finishes quickly and completely', () => {
  const w = new World(82);
  w.generateRadius(CENTRE_CHUNK, CENTRE_CHUNK, 6, null);
  const t0 = Date.now();
  const arena = w.buildArena(Math.floor(w.originX), Math.floor(w.originZ), 16);
  const ms = Date.now() - t0;
  H.assert(ms < 1500, 'took ' + ms + 'ms');
  let solid = 0, total = 0;
  for (let dz = -14; dz <= 14; dz++) {
    for (let dx = -14; dx <= 14; dx++) {
      if (Math.hypot(dx, dz) > 14) continue;
      total++;
      if (g.isSolid(w.getBlock(Math.floor(w.originX) + dx, arena.floorY,
        Math.floor(w.originZ) + dz))) solid++;
    }
  }
  H.eq(solid, total, 'every floor tile must be solid, got ' + solid + '/' + total);
});

H.test('a missing controller never crashes the update path', () => {
  const t = H.load({ touch: true });
  H.eq(t.Input.pad(), null, 'no controller should be detected');
  H.eq(t.Input.readPad(), null, 'reading a pad should be safe');
  const inp = t.Game.gatherInput();
  H.assert(typeof inp.mx === 'number' && !isNaN(inp.mx));
});

H.test('gatherInput2 returns a full command set with no pad', () => {
  const t = H.load({ touch: true });
  t.Game.bot = new t.Bot(t.Game.players[1], 1);
  const cmd = t.Game.gatherInput2(1 / 60);
  for (const k of ['mx', 'mz', 'jump', 'attack', 'special', 'ult']) {
    H.assert(k in cmd, 'missing ' + k);
  }
});

H.test('Fight.reset works with any world, not just the global one', () => {
  const w = arenaWorld(150);
  const a = new Player(w, characterById('steve'));
  const b = new Player(w, characterById('golem'));
  Fight.reset(a, b);
  H.assert(a.pos.length === 3 && b.pos.length === 3, 'both should be placed');
  H.assert(Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]) > 3,
    'and set apart');
});

H.test('Fight.update survives a world it cannot resolve', () => {
  // Defensive: Particles and projectiles need a world. If none can be found
  // the frame should be skipped rather than throwing mid-update.
  const saved0 = Fight.players[0], saved1 = Fight.players[1];
  Fight.players[0] = null;
  Fight.players[1] = null;
  const savedWorld = g.World.world;
  g.World.world = undefined;
  try {
    Fight.update(1 / 60, null, null);   // must not throw
  } finally {
    Fight.players[0] = saved0;
    Fight.players[1] = saved1;
    g.World.world = savedWorld;
  }
});

H.test('meshing a chunk with no neighbours does not crash', () => {
  const w = new World(84);
  const c = w.getChunk(CENTRE_CHUNK, CENTRE_CHUNK, true);
  w.generateChunk(c);
  H.assert(buildChunk(w, c) !== null, 'a lone chunk should still mesh');
});

H.test('state transitions cover every mode', () => {
  const t = H.load({ seed: 4242 });
  t.Game.startPlay();
  H.eq(t.Game.state, 'play');
  t.Game.toMenu();
  H.eq(t.Game.state, 'menu');
  t.Game.startObserve();
  H.eq(t.Game.state, 'observe');
  t.Game.toMenu();
  t.Game.pick.p2bot = true;
  t.Game.startFight();
  H.eq(t.Game.state, 'fight');
  H.assert(t.Game.bot, 'a computer opponent should be created');
  t.Game.togglePause(true);
  H.eq(t.Game.state, 'paused');
  t.Game.togglePause(false);
  H.eq(t.Game.state, 'fight');
  t.Game.toMenu();
  H.eq(t.Game.state, 'menu');
});

/* ============================================================
   22. Performance
   ============================================================ */
H.suite('Performance');

H.test('a chunk mesh fits inside one frame budget', () => {
  const w = flatWorld(71);
  const c = w.getChunk(CENTRE_CHUNK, CENTRE_CHUNK, false);
  for (let i = 0; i < 20; i++) buildChunk(w, c);   // warm up the JIT

  // Take the best of several rounds. A single timed average on a shared
  // machine measures the scheduler as much as the mesher, which made this
  // test flap between 13ms and 19ms run to run.
  const rounds = [];
  for (let r = 0; r < 5; r++) {
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) buildChunk(w, c);
    rounds.push((Date.now() - t0) / 10);
  }
  rounds.sort((a, b) => a - b);
  const per = rounds[0];
  H.assert(per < 16, 'the fastest chunk mesh took ' + per.toFixed(1) + 'ms, budget is 16ms');
});

H.test('chunk streaming respects a time budget rather than a chunk count', () => {
  const t = H.load({ boot: true });
  const built = t.Game.streamChunks(4);
  H.assert(typeof built === 'number', 'the streamer should report how many it built');
  // Streaming must never be unbounded, or a long walk turns into a freeze.
  H.assert(built <= 12, 'a 4ms budget built ' + built + ' chunks, which is unbounded work');
});

H.test('stationary streaming does not rescan a completed chunk queue', () => {
  const t = H.load({ boot: true });
  t.Cam.pos = t.Game.players[0].pos.slice();
  const cx = Math.floor(t.Cam.pos[0] / CHUNK), cz = Math.floor(t.Cam.pos[2] / CHUNK);
  t.Cam.pos[0] = cx * CHUNK + 8;
  t.Cam.pos[2] = cz * CHUNK + 8;
  const originalViewDistance = t.Game.viewDistance;
  t.Game.viewDistance = () => 20;
  t.Game._streamAt = null;
  t.Game._streamQueue = undefined;

  t.Game.streamChunks(4);
  const firstChunkCount = t.Game.world.chunks.size;
  t.Game.streamChunks(4);
  H.eq(t.Game.world.chunks.size, firstChunkCount, 'stationary frames should not create more chunks');

  t.Cam.pos[0] = (cx + 6) * CHUNK + 0.1;
  t.Game.streamChunks(4);
  H.assert(t.Game.world.chunks.size > firstChunkCount, 'crossing a chunk boundary should request the newly visible edge');

  const replacement = new World(15);
  replacement.generateRadius(cx + 6, cz, 1, null);
  t.Game.world = replacement;
  t.Game.streamChunks(4);
  H.assert(replacement.chunks.size > 9, 'replacing the world should populate the local chunk window');
  H.assert(t.Game._renderChunks.every(c => replacement.activeChunks.has(c)), 'the render list should belong to the active world');

  const distanceChunkCount = replacement.chunks.size;
  t.Game.renderDist++;
  t.Game.viewDistance = originalViewDistance;
  t.Game.streamChunks(4);
  H.assert(replacement.chunks.size > distanceChunkCount, 'changing view distance should expand the local chunk window');
});

H.test('dirty mesh updates only traverse the nearby render set', () => {
  const t = H.load({ boot: true });
  t.Cam.pos = t.Game.players[0].pos.slice();
  const chunks = t.Game.world.activeChunks;
  const originalForEach = chunks.forEach.bind(chunks);
  let fullWorldScans = 0;
  chunks.forEach = (...args) => { fullWorldScans++; return originalForEach(...args); };
  t.Game.streamChunks(4);
  const visible = Array.from(chunks).find(c => c.mesh);
  H.assert(visible, 'the test world should have a meshed nearby chunk');
  t.Game._renderChunks = [visible];
  visible.dirty = true;

  t.Game.updateDirtyChunks(1);
  H.eq(visible.dirty, false, 'a dirty nearby mesh should be rebuilt');
  H.eq(fullWorldScans, 0, 'dirty mesh work should not enumerate the full world map');
});

H.test('building the arena stays interactive', () => {
  const w = new World(72);
  w.generateRadius(CENTRE_CHUNK, CENTRE_CHUNK, 6, null);
  const t0 = Date.now();
  w.buildArena(Math.floor(w.originX), Math.floor(w.originZ), 16);
  const ms = Date.now() - t0;
  H.assert(ms < 1500, 'the arena took ' + ms + 'ms, it must not hang the game');
});

H.test('a single block edit relights quickly', () => {
  const w = new World(73);
  w.generateRadius(CENTRE_CHUNK, CENTRE_CHUNK, 6, null);
  const t0 = Date.now();
  const x = Math.floor(w.originX);
  for (let i = 0; i < 20; i++) w.setBlock(x, 30 + i, x, i % 2 ? 3 : 0);
  const per = (Date.now() - t0) / 20;
  H.assert(per < 40, 'a block edit took ' + per.toFixed(1) + 'ms');
});


/* ============================================================
   run
   ============================================================ */
H.test('a frame error saves progress and leaves a recoverable pause', () => {
  const pendingFrames = [];
  const oldRaf = g.windowStub.requestAnimationFrame;
  const oldLoop = Game.loop;
  const oldSave = Game.save;
  const oldError = console.error;
  const oldState = Game.state;
  const oldPaused = Game.paused;
  const oldFailure = Game.runtimeFailure;
  let saved = false;
  g.windowStub.requestAnimationFrame = callback => { pendingFrames.push(callback); return pendingFrames.length; };
  console.error = () => {};
  Game.state = 'play';
  Game.paused = false;
  Game.runtimeFailure = false;
  Game.lastFrameAt = 0;
  Game.frameInterval = 16;
  Game.save = () => { saved = true; return { status: 'saved' }; };
  Game.loop = () => { throw new Error('simulated frame crash'); };
  try {
    Game.scheduleFrame();
    pendingFrames.shift()(20);
    H.eq(saved, true, 'the world save is attempted before showing recovery');
    H.eq(Game.runtimeFailure, true, 'the failed loop is held until the player chooses what to do');
    H.eq(Game.state, 'paused', 'the player sees a pause state rather than a dead loop');
    H.eq(g.document.getElementById('runtime-error-message').classList.contains('hidden'), false,
      'the recovery instructions are visible');
    H.assert(/progress was saved/.test(g.document.getElementById('runtime-error-message').textContent),
      'the recovery message should only say saved for a confirmed local save');
    H.eq(pendingFrames.length, 1, 'animation scheduling survives the exception');
  } finally {
    g.windowStub.requestAnimationFrame = oldRaf;
    console.error = oldError;
    Game.loop = oldLoop;
    Game.save = oldSave;
    Game.state = oldState;
    Game.paused = oldPaused;
    Game.runtimeFailure = oldFailure;
  }
});
H.test('server save failure is not reported as confirmed progress', async () => {
  const network = g.Network;
  const oldSave = Game.save;
  const oldFlush = network.flushSave;
  const oldServerMode = network.serverMode;
  const oldState = Game.state;
  const oldPaused = Game.paused;
  const oldFailure = Game.runtimeFailure;
  network.serverMode = true;
  network.flushSave = async () => false;
  Game.save = () => ({ status: 'queued', recoveryCopy: false });
  Game.state = 'play';
  Game.paused = false;
  Game.runtimeFailure = false;
  try {
    await Game.handleRuntimeError(new Error('simulated unsaved crash'));
    const message = g.document.getElementById('runtime-error-message').textContent;
    H.assert(/neither a save nor a recovery copy could be confirmed/.test(message),
      'a failed server flush without a local copy must report possible data loss');
    H.assert(!/progress was saved/.test(message), 'never claim the server save succeeded');
  } finally {
    Game.save = oldSave;
    network.flushSave = oldFlush;
    network.serverMode = oldServerMode;
    Game.state = oldState;
    Game.paused = oldPaused;
    Game.runtimeFailure = oldFailure;
  }
});
H.suite('QA bundle');
H.test('sanitized QA output preserves offline play without network or persistent storage', () => {
  const path = require('node:path');
  const builder = require(path.join(H.ROOT, 'scripts', 'build-qa.js'));
  H.eq(builder.validateOutputPath(path.join(H.ROOT, '.qa-public')), path.join(H.ROOT, '.qa-public'), 'the dedicated output path is accepted');
  for (const unsafe of [H.ROOT, path.dirname(H.ROOT)]) {
    let rejected = false;
    try { builder.validateOutputPath(unsafe); } catch (_) { rejected = true; }
    H.eq(rejected, true, 'unsafe output paths are rejected');
  }
  const build = spawnSync(process.execPath, [path.join(H.ROOT, 'scripts', 'build-qa.js')], {
    encoding: 'utf8', timeout: 120000,
  });
  H.eq(build.status, 0, 'QA bundle build succeeds: ' + (build.stderr || build.stdout));
  const memoryCalls = { storage: 0, fetch: 0 };
  const nativeStorageTrap = {
    getItem() { memoryCalls.storage++; throw new Error('persistent storage read'); },
    setItem() { memoryCalls.storage++; throw new Error('persistent storage write'); },
    removeItem() { memoryCalls.storage++; throw new Error('persistent storage remove'); },
    key() { memoryCalls.storage++; throw new Error('persistent storage key'); },
    get length() { memoryCalls.storage++; throw new Error('persistent storage length'); },
  };
  const qa = H.load({
    sourceRoot: path.join(H.ROOT, '.qa-public'), includeNetwork: false,
    boot: false, storage: nativeStorageTrap,
    fetch() { memoryCalls.fetch++; throw new Error('unexpected network request'); },
  });
  H.eq(qa.Network, undefined, 'network module is absent');
  H.eq(qa.windowStub.Network, undefined, 'no page network API is installed');
  H.assert(typeof qa.Game.render === 'function', 'game renderer is present');
  H.assert(typeof qa.Game.startObserve === 'function' && typeof qa.Observer.update === 'function', 'observer view is present');

  const world = new qa.World(1337);
  const chunk = world.getChunk(qa.CENTRE_CHUNK, qa.CENTRE_CHUNK, true);
  world.generateChunk(chunk);
  H.assert(chunk.generated, 'fixed-seed terrain generated');
  const glRecord = { vaos: [], buffers: [] };
  H.assert(qa.buildChunkMesh(H.stubGL(glRecord), world, chunk), 'generated terrain renders through the real mesher');
  const repeat = new qa.World(1337);
  H.eq(world.heightAt(qa.WORLD_CENTRE, qa.WORLD_CENTRE), repeat.heightAt(qa.WORLD_CENTRE, qa.WORLD_CENTRE), 'fixed seed reproduces terrain');

  world.generateRadius(qa.CENTRE_CHUNK, qa.CENTRE_CHUNK, 1, null);
  qa.Game.world = qa.World.world = world;
  qa.Game.canvas = { requestPointerLock() {} };
  const spawn = world.findSpawn();
  const p1 = new qa.Player(world, qa.characterById(qa.Game.pick.p1), false);
  p1.pos = spawn.slice(); p1.spawn = spawn.slice();
  const p2 = new qa.Player(world, qa.characterById(qa.Game.pick.p2), true);
  p2.pos = [spawn[0] + 2, spawn[1], spawn[2]]; p2.spawn = p2.pos.slice();
  qa.Game.players = [p1, p2];
  qa.Game.startFight();
  H.eq(qa.Game.state, 'fight', 'local Fight mode starts');
  H.assert(qa.Game.bot, 'offline computer opponent remains available');
  qa.Game.canvas = { width: 1280, height: 720, clientWidth: 1280, clientHeight: 720 };
  qa.Game.gl = H.stubGL({ vaos: [], buffers: [] });
  qa.Game.gl.getProgramParameter = () => 1;
  qa.Game.setupGL();
  qa.Game.render(1 / 60);
  H.assert(qa.Game.gl, 'the real renderer initialized with the stub WebGL context');
  qa.Game.handleFightInput(p1, p2, { attack: true });
  H.assert(p1.swing, 'local attack input enters the real attack path');
  qa.Fight.update(1 / 60, p1, p2);
  H.assert(Number.isFinite(p1.hp) && Number.isFinite(p2.hp), 'local fight update keeps fighter state valid');
  qa.Observer.pos = [qa.WORLD_CENTRE + 20, 100, qa.WORLD_CENTRE - 20];
  qa.Observer.update(1 / 60, 1.5);
  H.assert(qa.Observer.pos.every(Number.isFinite), 'observer camera updates');

  qa.Game.save();
  H.assert(qa.BWStorage.length > 0, 'save stays in page-local memory');
  H.eq(memoryCalls.storage, 0, 'native persistent storage is untouched');
  H.eq(memoryCalls.fetch, 0, 'no fetch request is attempted');
  const fresh = H.load({ sourceRoot: path.join(H.ROOT, '.qa-public'), includeNetwork: false, boot: false });
  H.eq(fresh.BWStorage.length, 0, 'reload starts with a fresh in-memory world');
});

if (require.main === module) {
  process.exit(H.main(process.argv.slice(2)));
}


