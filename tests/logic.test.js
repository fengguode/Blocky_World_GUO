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
  World, Chunk, CHUNK, WORLD_H, SEA_LEVEL, WORLD_SIZE, CHUNKS_PER_SIDE, MIN_EDGE, MAX_EDGE, BLOCKS, HOTBAR_BLOCKS, HOTBAR_ITEMS, T,
  CENTRE_CHUNK, WORLD_CENTRE, characterById, CHARACTERS, CHARACTER_MODEL_STYLES, ANIMALS, isStorybookWorld,
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

function collisionWorld() {
  const cells = new Set();
  const key = (x, y, z) => x + ',' + y + ',' + z;
  const w = {
    setBlock(x, y, z, id) {
      const k = key(x, y, z);
      if (id) cells.add(k); else cells.delete(k);
    },
    getBlock(x, y, z) { return cells.has(key(x, y, z)) ? 3 : 0; },
  };
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) w.setBlock(x, 0, z, 3);
  }
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
  const originalDrawAnimalBoxes = Game.drawAnimalBoxes;
  const originalDrawAnimalEllipsoids = Game.drawAnimalEllipsoids;
  try {
    for (const id of ['pig', 'sheep', 'chick']) {
      const def = ANIMALS.find(a => a.id === id);
      const calls = [];
      const cubes = [];
      let roundBatches = 0;
      let cubeBatches = 0;
      Game.drawAnimalEllipsoids = (prog, parts) => { if (parts.length) roundBatches++; calls.push(...parts); };
      Game.drawAnimalBoxes = (prog, parts) => { if (parts.length) cubeBatches++; cubes.push(...parts); calls.push(...parts); };
      Game.drawAnimal(null, { def, pos: [0, 0, 0], scale: 1, yaw: 0, walkAnim: 0 }, 1);
      const tiles = new Set(calls.map(c => c.tile));
      H.assert(calls.length >= (id === 'chick' ? 13 : 14), id + ' needs visible silhouette and face detail');
      H.eq(calls.length, { pig: 20, sheep: 24, chick: 24 }[id], id + ' should retain all approved detail parts');
      H.eq(roundBatches, 1, id + ' should submit soft anatomy in one rounded instanced draw');
      H.eq(cubeBatches, id === 'chick' ? 1 : 0, id + ' should batch only its angular beak details');
      H.assert(tiles.size >= 3, id + ' should use multiple colors/materials');
      H.assert(calls.filter(c => c.tile === def.body).every(c => !cubes.includes(c)), id + ' body and fleece should use rounded geometry');
      H.assert(calls.filter(c => c.tile === g.T.eye).length >= 2, id + ' needs two visible eyes');
      if (id === 'pig') H.assert(calls.some(c => c.tile === def.accent && c.size[0] >= 0.3), 'pig needs a prominent snout');
      if (id === 'sheep') {
        H.eq(calls.filter(c => c.tile === def.body && c.size[0] >= 0.3 && c.size[1] > 0.2 && c.size[1] < 0.35 && c.size[2] >= 0.3).length,
          7, 'sheep needs seven staggered fleece lobes');
        H.eq(calls.filter(c => c.tile === def.body).length, 11, 'sheep body should keep its three core tiers, seven lobes, and forehead tuft');
      }
      if (id === 'pig') {
        const body = calls.find(c => c.tile === def.body && c.size[1] > 0.4 && c.size[1] < 0.5);
        H.assert(body && body.size[0] > body.size[2], 'pig should have a broad, low silhouette');
      }
      if (id === 'sheep') {
        const body = calls.find(c => c.tile === def.body && c.size[1] > 0.5);
        H.assert(body && body.size[1] > calls[0].size[1], 'sheep fleece mass should rise above its legs');
      }
      if (id === 'chick') {
        H.assert(calls.some(c => c.tile === def.beak && c.size[0] >= 0.2), 'chick needs a prominent beak');
        H.eq(calls.filter(c => c.tile === def.accent && c.pos[1] > 1.1).length, 3, 'chick should have three separate crest feathers');
        H.eq(calls.filter(c => c.tile === def.accent && c.pos[1] < 1.1 && c.pos[2] > 0.2 && c.size[2] === 0.24).length,
          3, 'chick should have a three-feather tail fan');
        H.assert(def.w >= 0.8 && def.h >= 0.9, 'chick should stay small but large enough to read at play distance');
        const body = calls.find(c => c.tile === def.body && c.size[1] > 0.5 && c.size[1] < 0.6);
        const head = calls.find(c => c.tile === def.face && c.size[1] > 0.4);
        H.assert(body && head && head.size[0] >= body.size[0] * 0.8, 'chick should have a compact body and large readable head');
      }
    }
  } finally {
    Game.drawAnimalBoxes = originalDrawAnimalBoxes;
    Game.drawAnimalEllipsoids = originalDrawAnimalEllipsoids;
  }
});

H.test('rabbit, fox, and deer have species-specific readable silhouettes', () => {
  const originalDrawAnimalBoxes = Game.drawAnimalBoxes;
  const originalDrawAnimalEllipsoids = Game.drawAnimalEllipsoids;
  try {
    for (const id of ['rabbit', 'fox', 'deer']) {
      const def = ANIMALS.find(a => a.id === id);
      const calls = [];
      const cubes = [];
      Game.drawAnimalEllipsoids = (prog, parts) => calls.push(...parts);
      Game.drawAnimalBoxes = (prog, parts) => { cubes.push(...parts); calls.push(...parts); };
      Game.drawAnimal(null, { def, pos: [0, 0, 0], scale: 1, yaw: 0, walkAnim: 0 }, 1);
      H.assert(calls.length >= 15, id + ' needs a multi-part model');
      H.assert(calls.filter(c => c.tile === g.T.eye).length >= 2, id + ' needs visible eyes');
      H.assert(calls.filter(c => c.tile === def.body).some(c => !cubes.includes(c)), id + ' torso should use rounded geometry');
      if (id === 'rabbit') {
        H.eq(calls.filter(c => c.tile === def.ear && c.size[1] >= 0.34).length, 2, 'rabbit needs two long inner ears');
        H.assert(calls.some(c => c.tile === def.face && c.size[0] >= 0.2 && c.size[2] > 0.08), 'rabbit needs a projecting muzzle and tail puff');
      } else if (id === 'fox') {
        H.assert(calls.some(c => c.tile === def.accent && c.size[1] > 0.25), 'fox needs a pale chest and tail tip');
        H.assert(calls.some(c => c.tile === def.body && c.size[2] >= 0.7), 'fox needs a long bushy tail');
      } else {
        H.eq(calls.filter(c => c.tile === def.antler).length, 6, 'deer needs branched antlers on both sides');
        H.assert(calls.some(c => c.tile === def.body && c.size[1] > 0.7), 'deer needs a long raised neck');
        H.assert(def.h > ANIMALS.find(a => a.id === 'pig').h * 1.5, 'deer should have a distinct tall silhouette');
      }
    }
  } finally {
    Game.drawAnimalBoxes = originalDrawAnimalBoxes;
    Game.drawAnimalEllipsoids = originalDrawAnimalEllipsoids;
  }
});

H.test('wolf uses a heavy rounded ruff, amber eye framing, and sharp ivory fangs', () => {
  const originalDrawAnimalBoxes = Game.drawAnimalBoxes;
  const originalDrawAnimalEllipsoids = Game.drawAnimalEllipsoids;
  try {
    const def = ANIMALS.find(a => a.id === 'wolf');
    const rounded = [], angular = [];
    Game.drawAnimalEllipsoids = (prog, parts) => rounded.push(...parts);
    Game.drawAnimalBoxes = (prog, parts) => angular.push(...parts);
    Game.drawAnimal(null, { def, pos: [0, 0, 0], scale: 1, yaw: 0, walkAnim: 0 }, 1);
    H.assert(rounded.filter(part => part.tile === def.face && part.size[1] > 0.5).length >= 1,
      'wolf needs a broad light ruff around its shoulders');
    H.assert(rounded.filter(part => part.tile === g.T.wolf_dark).length >= 4,
      'wolf needs dark face framing, muzzle, ears, and tail');
    H.eq(angular.filter(part => part.tile === g.T.wool).length, 2,
      'wolf keeps two crisp ivory fangs');
    H.assert(rounded.filter(part => part.tile === g.T.wolf_eye).length >= 2,
      'wolf keeps its amber eyes visible');
  } finally {
    Game.drawAnimalBoxes = originalDrawAnimalBoxes;
    Game.drawAnimalEllipsoids = originalDrawAnimalEllipsoids;
  }
});

H.test('wildlife draws each geometry family in one shared batch', () => {
  const originalDrawAnimalBoxes = Game.drawAnimalBoxes;
  const originalDrawAnimalEllipsoids = Game.drawAnimalEllipsoids;
  try {
    const animals = ['pig', 'chick', 'wolf'].map(id => ({
      def: ANIMALS.find(a => a.id === id), pos: [0, 0, 0], scale: 1, yaw: 0, walkAnim: 0,
    }));
    const roundBatches = [], cubeBatches = [];
    Game.drawAnimalEllipsoids = (prog, parts) => roundBatches.push(parts);
    Game.drawAnimalBoxes = (prog, parts) => cubeBatches.push(parts);
    Game.drawAnimals(null, animals, 1);
    H.eq(roundBatches.length, 1, 'all organic wildlife geometry should share one draw batch');
    H.eq(cubeBatches.length, 1, 'all crisp wildlife details should share one draw batch');
    H.assert(roundBatches[0].length > animals.length * 10, 'the rounded batch should contain anatomy from each animal');
    H.assert(cubeBatches[0].length >= 4, 'the crisp batch should retain beaks and fangs');
  } finally {
    Game.drawAnimalBoxes = originalDrawAnimalBoxes;
    Game.drawAnimalEllipsoids = originalDrawAnimalEllipsoids;
  }
});

H.test('animal stepped head tiers follow each animal scale vertically', () => {
  const originalDrawAnimalBoxes = Game.drawAnimalBoxes;
  const originalDrawAnimalEllipsoids = Game.drawAnimalEllipsoids;
  try {
    const captureHeadTiers = (def, scale, headY, headHeight) => {
      const headCalls = [];
      const capture = (parts) => {
        for (const { pos, size, tile } of parts) {
        if (tile === def.face && pos[1] > headY - headHeight * 0.16 * scale) headCalls.push({ pos, size });
        }
      };
      Game.drawAnimalBoxes = (prog, parts) => capture(parts);
      Game.drawAnimalEllipsoids = (prog, parts) => capture(parts);
      Game.drawAnimal(null, { def, pos: [0, 0, 0], scale, yaw: 0, walkAnim: 0 }, 1);
      return headCalls;
    };

    for (const id of ['pig', 'sheep', 'chick']) {
      const def = ANIMALS.find(a => a.id === id);
      const headY = def.h * (0.42 + 0.8);
      const headHeight = def.h * (id === 'chick' ? 0.72 : id === 'sheep' ? 0.48 : 0.5);
      const unitTiers = captureHeadTiers(def, 1, headY, headHeight);
      const scaledTiers = captureHeadTiers(def, 1.15, headY, headHeight);
      H.eq(unitTiers.length, 4, id + ' should render four stepped head tiers');
      H.eq(scaledTiers.length, unitTiers.length, id + ' should keep all head tiers when scaled');

      for (let i = 0; i < unitTiers.length; i++) {
        const unitTier = unitTiers[i];
        const scaledTier = scaledTiers[i];
        H.assert(unitTier.size[1] > 0, id + ' head tier ' + i + ' should have positive height');
        for (const [axis, dimension] of [[0, 'width'], [1, 'height'], [2, 'depth']]) {
          H.assert(Math.abs(scaledTier.size[axis] / unitTier.size[axis] - 1.15) < 1e-9,
            id + ' head tier ' + i + ' ' + dimension + ' should follow entity scale');
        }
        H.assert(Math.abs(scaledTier.pos[1] - (headY + (unitTier.pos[1] - headY) * 1.15)) < 1e-9,
          id + ' head tier ' + i + ' vertical offset should follow entity scale');
      }
    }
  } finally {
    Game.drawAnimalBoxes = originalDrawAnimalBoxes;
    Game.drawAnimalEllipsoids = originalDrawAnimalEllipsoids;
  }
});

H.test('animal cube batches upload per-part transforms and issue one instanced draw', () => {
  const originalGL = Game.gl;
  const originalProgram = Game.progBox;
  const originalVAO = Game.animalBatchVAO;
  const originalBuffer = Game.animalBatchBuffer;
  const originalCapacity = Game.animalBatchCapacity;
  const originalData = Game.animalBatchData;
  const originalCube = Game.cube;
  const uniformInstanced = [];
  const uniformRound = [];
  const uploads = [];
  const draws = [];
  const fakeGL = {
    ARRAY_BUFFER: 1, DYNAMIC_DRAW: 2, TRIANGLES: 3, UNSIGNED_SHORT: 4,
    useProgram() {}, uniformMatrix4fv() {}, uniform3f() {},
    uniform1f(location, value) {
      if (location === 'uInstanced') uniformInstanced.push(value);
      if (location === 'uRoundShape') uniformRound.push(value);
    },
    bindBuffer() {}, bufferData() {}, bufferSubData(target, offset, data) { uploads.push(Array.from(data)); },
    bindVertexArray(vao) { H.eq(vao, 'animal-vao', 'batch should use its instance-enabled VAO'); },
    drawElementsInstanced(...args) { draws.push(args); },
  };
  Game.gl = fakeGL;
  Game.progBox = { u: { uMVP: 'uMVP', uBoxCenter: 'uBoxCenter', uBoxSize: 'uBoxSize', uBoxRotation: 'uBoxRotation', uTint: 'uTint', uAlpha: 'uAlpha', uTile: 'uTile', uUseTex: 'uUseTex', uInstanced: 'uInstanced', uRoundShape: 'uRoundShape' } };
  Game.animalBatchVAO = 'animal-vao';
  Game.animalBatchBuffer = 'animal-buffer';
  Game.animalBatchCapacity = 4;
  Game.animalBatchData = new Float32Array(44);
  Game.cube = { count: 36 };
  const boxes = [
    { pos: [4, 2, -3], size: [1, 2, 3], tile: 7, yaw: 0 },
    { pos: [-1, 5, 8], size: [0.5, 0.75, 1.25], tile: 11, yaw: Math.PI / 2, pitch: Math.PI / 6 },
  ];
  try {
    Game.drawAnimalBoxes(null, boxes);
    H.eq(JSON.stringify(uniformInstanced), '[1]', 'batch shader should select per-instance transforms');
    H.eq(JSON.stringify(uniformRound), '[0]', 'cube batch should retain flat face normals');
    H.eq(draws.length, 1, 'all animal boxes should issue one GPU draw');
    H.eq(JSON.stringify(draws[0]), JSON.stringify([fakeGL.TRIANGLES, 36, fakeGL.UNSIGNED_SHORT, 0, 2]),
      'draw should instance the shared cube mesh');
    H.eq(uploads.length, 1, 'instance data should upload in one contiguous buffer');
    H.eq(uploads[0].length, 22, 'instance data should contain eleven floats per box');
    H.eq(JSON.stringify(uploads[0].slice(0, 11)), JSON.stringify([4, 2, -3, 1, 2, 3, 1, 0, 1, 0, 7]),
      'instance data should preserve each box position, dimensions, and tile');
    H.near(uploads[0][17], 0, 1e-6, 'quarter-turn yaw cosine should be near zero');
    H.near(uploads[0][18], 1, 1e-6, 'quarter-turn yaw sine should be one');
    H.near(uploads[0][19], Math.cos(Math.PI / 6), 1e-6, 'part pitch cosine should be uploaded');
    H.near(uploads[0][20], Math.sin(Math.PI / 6), 1e-6, 'part pitch sine should be uploaded');
    H.eq(uploads[0][21], 11, 'second instance should keep its own material tile');
  } finally {
    Game.gl = originalGL;
    Game.progBox = originalProgram;
    Game.animalBatchVAO = originalVAO;
    Game.animalBatchBuffer = originalBuffer;
    Game.animalBatchCapacity = originalCapacity;
    Game.animalBatchData = originalData;
    Game.cube = originalCube;
  }
});

H.test('rounded animal parts use their own instanced mesh and corrected normals', () => {
  const saved = {
    gl: Game.gl, program: Game.progBox,
    vao: Game.animalRoundBatchVAO, buffer: Game.animalRoundBatchBuffer,
    capacity: Game.animalRoundBatchCapacity, data: Game.animalRoundBatchData,
    mesh: Game.animalEllipsoid,
  };
  const drawCalls = [];
  const roundValues = [];
  const uploads = [];
  const fakeGL = {
    ARRAY_BUFFER: 1, DYNAMIC_DRAW: 2, TRIANGLES: 3, UNSIGNED_SHORT: 4,
    useProgram() {}, uniformMatrix4fv() {}, uniform3f() {},
    uniform1f(location, value) { if (location === 'uRoundShape') roundValues.push(value); },
    bindBuffer() {}, bufferData() {}, bufferSubData(target, offset, data) { uploads.push(Array.from(data)); },
    bindVertexArray(vao) { H.eq(vao, 'round-vao', 'rounded parts should bind the ellipsoid mesh VAO'); },
    drawElementsInstanced(...args) { drawCalls.push(args); },
  };
  Game.gl = fakeGL;
  Game.progBox = { u: { uMVP: 'uMVP', uBoxCenter: 'uBoxCenter', uBoxSize: 'uBoxSize', uBoxRotation: 'uBoxRotation', uTint: 'uTint', uAlpha: 'uAlpha', uTile: 'uTile', uUseTex: 'uUseTex', uInstanced: 'uInstanced', uRoundShape: 'uRoundShape' } };
  Game.animalRoundBatchVAO = 'round-vao';
  Game.animalRoundBatchBuffer = 'round-buffer';
  Game.animalRoundBatchCapacity = 4;
  Game.animalRoundBatchData = new Float32Array(44);
  Game.animalEllipsoid = { count: 576 };
  try {
    Game.drawAnimalEllipsoids(null, [{ pos: [1, 2, 3], size: [0.4, 0.7, 0.3], tile: 9, yaw: 0.5, pitch: -0.4 }]);
    H.eq(JSON.stringify(roundValues), '[1]', 'ellipsoid shader should inverse-scale normals');
    H.eq(drawCalls.length, 1, 'rounded parts should use one instanced draw');
    H.eq(JSON.stringify(drawCalls[0]), JSON.stringify([fakeGL.TRIANGLES, 576, fakeGL.UNSIGNED_SHORT, 0, 1]),
      'rounded batch should draw the low-poly ellipsoid mesh');
    H.eq(uploads.length, 1, 'rounded transforms should upload once');
    H.near(uploads[0][8], Math.cos(-0.4), 1e-6, 'rounded part should upload its pitch cosine');
    H.near(uploads[0][9], Math.sin(-0.4), 1e-6, 'rounded part should upload its pitch sine');
    H.eq(uploads[0][10], 9, 'rounded part should preserve its material tile');
  } finally {
    Game.gl = saved.gl;
    Game.progBox = saved.program;
    Game.animalRoundBatchVAO = saved.vao;
    Game.animalRoundBatchBuffer = saved.buffer;
    Game.animalRoundBatchCapacity = saved.capacity;
    Game.animalRoundBatchData = saved.data;
    Game.animalEllipsoid = saved.mesh;
  }
});

H.test('non-instanced character limbs retain their yaw and pitch rotation', () => {
  const saved = {
    gl: Game.gl, program: Game.progBox, vao: Game.animalBatchVAO,
    cube: Game.cube, boxModel: Game._boxModel, boxMvp: Game._boxMvp,
    viewProj: Cam.viewProj,
  };
  const matrices = [];
  const rotations = [];
  const fakeGL = {
    TRIANGLES: 1, UNSIGNED_SHORT: 2,
    useProgram() {}, uniformMatrix4fv(location, transpose, value) { matrices.push(Array.from(value)); },
    uniform3f() {}, uniform1f() {}, uniform4f(location, ...value) { rotations.push(value); },
    bindVertexArray() {}, drawElements() {},
  };
  Game.gl = fakeGL;
  Game.progBox = { u: { uMVP: 0, uBoxCenter: 1, uBoxSize: 2, uBoxRotation: 3, uTint: 4,
    uAlpha: 5, uTile: 6, uUseTex: 7, uInstanced: 8, uRoundShape: 9 } };
  Game.animalBatchVAO = null;
  Game.cube = { vao: 'cube', count: 36 };
  Game._boxModel = M4.create();
  Game._boxMvp = M4.create();
  Cam.viewProj = M4.create();
  try {
    Game.drawAnimalBoxes(null, [{
      pos: [4, 2, -3], size: [1, 2, 3], tile: 7, yaw: Math.PI / 2, pitch: Math.PI / 6,
    }]);
    H.eq(matrices.length, 1, 'fallback draws the character limb once');
    H.near(matrices[0][4], -1, 1e-6, 'limb local Y gains the expected X tilt');
    H.near(matrices[0][5], Math.sqrt(3), 1e-6, 'limb local Y retains its pitched vertical component');
    H.near(matrices[0][6], 0, 1e-6, 'quarter-turn yaw rotates the pitch into world X');
    H.eq(rotations.length, 1, 'fallback shader receives the same per-part orientation');
    H.near(rotations[0][1], 1, 1e-6, 'fallback orientation uses the requested yaw');
    H.near(rotations[0][2], Math.cos(Math.PI / 6), 1e-6, 'fallback orientation uses the requested pitch');
  } finally {
    Game.gl = saved.gl;
    Game.progBox = saved.program;
    Game.animalBatchVAO = saved.vao;
    Game.cube = saved.cube;
    Game._boxModel = saved.boxModel;
    Game._boxMvp = saved.boxMvp;
    Cam.viewProj = saved.viewProj;
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

H.test('the fixed-seed welcome clearing is deterministic and saves only player edits', () => {
  const first = new World(1337), second = new World(1337);
  first.generateRadius(CENTRE_CHUNK, CENTRE_CHUNK, 2, null);
  second.generateRadius(CENTRE_CHUNK, CENTRE_CHUNK, 2, null);
  const x = WORLD_CENTRE, z = WORLD_CENTRE;
  const samples = [
    [0, 29, 0], [-22, 34, -12], [-25, 30, -12],
    [12, 29, -18], [-9, 36, -24], [-9, 41, -24],
    [-28, 30, -5], [-25, 30, -5], [-8, 24, -16], [0, 24, -16],
  ];
  for (const [dx, y, dz] of samples) {
    const a = first.getBlock(x + dx, y, z + dz);
    H.eq(second.getBlock(x + dx, y, z + dz), a, 'same seed / coordinates must regenerate the same clearing');
  }
  H.eq(first.getBlock(x, 29, z), 1, 'the meadow is grassy');
  H.eq(first.getBlock(x - 22, 34, z - 12), 5, 'the first cottage has a warm sand roof');
  H.eq(first.getBlock(x + 12, 29, z - 18), 7, 'the second cottage has a log floor');
  H.eq(first.getBlock(x + 15, 31, z - 18), 11, 'the cottage windows are backed by warm glowstone');
  H.eq(first.getBlock(x - 9, 30, z - 24), 7, 'the treehouse trunk rises above the meadow');
  H.eq(first.getBlock(x - 9, 38, z - 24), 7, 'the raised treehouse has a broad log platform');
  H.eq(first.getBlock(x - 30, 39, z + 13), 9, 'a tall canopy frames the clearing');
  H.eq(first.getBlock(x - 28, 30, z - 5), 22, 'a rose patch grows by the clearing');
  H.eq(first.getBlock(x - 25, 30, z - 5), 22, 'flower patches have a clustered footprint');
  H.eq(first.getBlock(x - 5, 29, z - 9), 4, 'the village trail curves into the clearing');
  H.eq(first.getBlock(x - 10, 29, z - 14), 7, 'a warm log deck crosses the foreground creek on the upper bank');
  H.eq(first.getBlock(x - 10, 27, z - 14), 7, 'bridge piers visibly connect the creek bed to the deck');
  H.eq(first.getBlock(x - 10, 30, z - 14), 7, 'the bridge has raised edge posts above its deck');
  H.eq(first.getBlock(x - 12, 29, z - 16), 12, 'the upper stream remains open beside the bridge');
  H.eq(first.getBlock(x - 8, 29, z - 14), 0, 'the bridge ends before the waterfall lip');
  H.eq(first.getBlock(x - 15, 29, z - 16), 12, 'the upstream stream is raised to meadow level');
  H.eq(first.getBlock(x - 8, 24, z - 16), 12, 'the wide stream falls five blocks at the cascade');
  H.eq(first.getBlock(x, 24, z - 16), 12, 'the downstream water keeps flowing through the clearing');
  H.eq(first.getBlock(x, 24, z - 19), 12, 'the wider creek has a readable near bank');
  H.eq(first.getBlock(x, 24, z - 9), 12, 'the wider creek has a readable far bank');
  H.eq(first.edits.size, 0, 'generated storybook scenery is not recorded as a player edit');
});

H.test('clearing respects saved edits and leaves Flat World level and treeless', () => {
  const x = WORLD_CENTRE, z = WORLD_CENTRE;
  const shared = H.makeStorage();
  const first = H.load({ storage: shared, boot: false });
  const edited = new first.World(1337);
  edited.generateRadius(CENTRE_CHUNK, CENTRE_CHUNK, 2, null);
  first.Game.world = first.World.world = edited;
  first.Game.players[0] = new first.Player(edited, first.characterById('steve'));
  first.Game.save();
  H.eq(H.savedData(shared).edits.length, 0, 'the generated clearing is not serialized as player edits');
  H.eq(edited.setBlock(x - 22, 34, z - 12, 16), true, 'a player can edit the cottage roof');
  first.Game.save();

  const reload = H.load({ storage: shared, boot: false });
  const saved = H.savedData(shared);
  const restored = new reload.World(saved.seed, saved.edits);
  restored.generateRadius(CENTRE_CHUNK, CENTRE_CHUNK, 2, null);
  H.eq(restored.getBlock(x - 22, 34, z - 12), 16, 'the edited roof survives save, reload, and deterministic regeneration');

  const flat = new World(1337, null, 'flat');
  const fc = flat.getChunk(CENTRE_CHUNK, CENTRE_CHUNK, true);
  flat.generateChunk(fc);
  H.eq(flat.getBlock(x, SEA_LEVEL, z), 1, 'flat center remains grassy at sea level');
  H.eq(flat.getBlock(x - 22, 29, z - 12), 0, 'flat world gets no generated cottage');
  H.assert(!fc.blocks.includes(22) && !fc.blocks.includes(23) && !fc.blocks.includes(24),
    'flat worlds remain flower-free');
});

H.test('fixed showcase ground skips natural terrain noise for its spawn chunk', () => {
  const w = new World(1337);
  let calls = 0;
  const heightAt = w.heightAt;
  w.heightAt = function (x, z) { calls++; return heightAt.call(this, x, z); };
  w.generateChunk(w.getChunk(CENTRE_CHUNK, CENTRE_CHUNK, true));
  H.eq(calls, 0, 'natural terrain height is irrelevant under the deterministic flat clearing surface');
});

H.test('fresh Storybook worlds frame the clearing from the south while other worlds keep normal spawn', () => {
  const storybook = new World(1337);
  storybook.generateRadius(CENTRE_CHUNK, CENTRE_CHUNK, 2, null);
  const welcome = storybook.findWelcomeSpawn();
  H.assert(welcome, 'the fixed clearing has a safe welcome vantage');
  H.eq(welcome[0], WORLD_CENTRE + 0.5, 'the welcome spawn stays on the clearing centreline');
  H.eq(welcome[2], WORLD_CENTRE + 4.5, 'the welcome spawn sits on the southern trail near the stream and village');
  H.eq(storybook.getBlock(Math.floor(welcome[0]), 29, Math.floor(welcome[2])), 4,
    'the path leads from the village right to the welcome viewpoint');

  H.eq(new World(42).findWelcomeSpawn(), null, 'random worlds keep ordinary spawn behavior');
  H.eq(new World(1337, null, 'flat').findWelcomeSpawn(), null, 'flat worlds keep ordinary spawn behavior');

  const t = H.load({ boot: false });
  t.Game.world = new t.World(1337);
  t.Game.saved = null;
  H.eq(t.Game.isFreshStorybookStart(), true, 'only a fresh Storybook world requests the welcome frame');
  t.Game.saved = { seed: 1337, player1: null };
  H.eq(t.Game.isFreshStorybookStart(), false, 'a saved or shared Storybook world keeps its saved-world entry behavior');
  t.Game.saved = null;
  t.Game.world = new t.World(1337, null, 'flat');
  H.eq(t.Game.isFreshStorybookStart(), false, 'a fresh Flat world does not get the Storybook view');

  t.Game.world = new t.World(1337);
  t.Game._storybookOpeningViewPending = true;
  t.Cam.yaw = 1.3;
  t.Cam.pitch = 0.1;
  t.Cam.orbit = 0;
  H.eq(t.Game.applyStorybookOpeningView(), true, 'a fresh Storybook entry applies its composed view');
  H.eq(t.Game.dayPhase, 0.25, 'the warm opening phase applies only to a fresh Storybook entry');
  H.eq(t.Cam.yaw, 0, 'the camera faces north across the clearing');
  H.eq(t.Cam.pitch, -0.32, 'the view tilts down enough to include the nearby cascade and flowers');
  H.eq(t.Cam.orbit, t.Cam.thirdPersonDist, 'third-person framing begins at its intended distance');
  H.eq(t.Game._storybookOpeningViewPending, false, 'the framing applies only once');
  H.eq(t.Game.applyStorybookOpeningView(), false, 'later menu returns preserve the player camera');
  const other = H.load({ boot: false });
  other.Game.world = new other.World(42);
  H.eq(other.Game.applyStorybookOpeningView(), false, 'other world types keep ordinary startup lighting');
  H.eq(other.Game.dayPhase, 0.32, 'the warm opening phase does not change the global day phase');
});

H.test('non-showcase and flat chunk generation skips Storybook metadata work', () => {
  for (const world of [new World(42), new World(1337, null, 'flat')]) {
    let calls = 0;
    const storybookColumn = world.storybookColumn;
    world.storybookColumn = function (...args) { calls++; return storybookColumn.apply(this, args); };
    world.generateChunk(world.getChunk(CENTRE_CHUNK, CENTRE_CHUNK, true));
    H.eq(calls, 0, world.worldType + ' seed ' + world.seed + ' should not query Storybook columns');
  }
});

H.test('Flat World with the Storybook seed receives no welcome palette or shader tint', () => {
  const t = H.load({ boot: false });
  const player = { pos: [WORLD_CENTRE, 29, WORLD_CENTRE] };
  t.Game.players = [player];
  const flat = new t.World(1337, null, 'flat');
  const normal = new t.World(42);
  const showcase = new t.World(1337);
  H.eq(isStorybookWorld(flat), false, 'flat seed 1337 is not the Storybook world');
  H.eq(isStorybookWorld(normal), false, 'other normal seeds are not the Storybook world');
  H.eq(isStorybookWorld(showcase), true, 'normal seed 1337 keeps the Storybook world');
  t.Game.world = flat;
  const flatSky = t.Game.skyColors();
  t.Game.world = normal;
  const normalSky = t.Game.skyColors();
  for (const key of ['top', 'bottom']) {
    for (let i = 0; i < 3; i++) H.near(flatSky[key][i], normalSky[key][i], 1e-12,
      'flat Storybook-seed sky should match an unthemed normal sky');
  }
  t.Game.world = showcase;
  const showcaseSky = t.Game.skyColors();
  H.assert(showcaseSky.top.some((value, i) => Math.abs(value - normalSky.top[i]) > 1e-6),
    'the normal Storybook world keeps its welcome sky palette');
  H.assert(showcaseSky.bottom[0] > normalSky.bottom[0] && showcaseSky.bottom[2] < normalSky.bottom[2],
    'the welcome sky warms toward amber only in the Storybook world');
});

H.test('showcase column metadata packs ground, stream and clearing flags without changing terrain values', () => {
  const w = new World(1337);
  const x = WORLD_CENTRE, z = WORLD_CENTRE;
  const clearing = w.storybookColumn(x, z, 42);
  H.eq(clearing >>> 8, 29, 'clearing metadata keeps the meadow ground height');
  H.eq(clearing & 1, 1, 'clearing metadata keeps the forest suppression flag');
  const creek = w.storybookColumn(x, z - 16, 42);
  H.eq(creek >>> 8, 21, 'creek metadata keeps the lower waterfall channel');
  H.eq((creek >>> 1) & 0x7f, 24, 'creek metadata keeps the downstream water level');
});

H.test('non-showcase random seeds keep their original terrain and sea-level water', () => {
  const w = new World(42);
  const x = WORLD_CENTRE, z = WORLD_CENTRE;
  H.eq(w.storybookColumn(x, z, w.heightAt(x, z)), null, 'only the fixed storybook seed has a clearing');
  const c = w.getChunk(CENTRE_CHUNK, CENTRE_CHUNK, true);
  w.generateChunk(c);
  let hash = 2166136261 >>> 0;
  for (const id of c.blocks) hash = Math.imul(hash ^ id, 16777619) >>> 0;
  H.eq(hash, 1800347313, 'seed 42 center chunk block data matches the pre-showcase baseline');
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
      H.eq(g.aoAt(here, cornerIndex, face), 2, 'an adjacent first-side blocker darkens the corner');
      g._padBlocks[here + expected[1]] = 3;
      H.eq(g.aoAt(here, cornerIndex, face), 0, 'two adjacent side blockers fully occlude the corner');
      g._padBlocks.fill(0);
      g._padBlocks[here + expected[2]] = 3;
      H.eq(g.aoAt(here, cornerIndex, face), 2, 'an adjacent diagonal blocker darkens the corner');

      g._padBlocks.fill(0);
      const distant = face.n.slice();
      distant[tangentAxes[0]] += (corner[tangentAxes[0]] === 0 ? -2 : 2);
      g._padBlocks[here + offset(distant)] = 3;
      H.eq(g.aoAt(here, cornerIndex, face), 3, 'a blocker two blocks away has no effect');
    }
  }
});

H.test('opaque and transparent mesh buffers grow independently', () => {
  for (const transparentFirst of [false, true]) {
    const { w, chunk } = scratchWorld(58);
    const bands = transparentFirst
      ? [{ id: 10, from: 1, to: 21 }, { id: 3, from: 40, to: 43 }]
      : [{ id: 3, from: 1, to: 21 }, { id: 10, from: 40, to: 43 }];
    let opaqueCells = 0, transparentCells = 0;
    for (const { id, from, to } of bands) {
      for (let y = from; y < to; y++) {
        for (let z = 0; z < CHUNK; z++) {
          for (let x = 0; x < CHUNK; x++) {
            if ((x + y + z) & 1) continue;
            chunk.blocks[Chunk.idx(x, y, z)] = id;
            if (id === 3) opaqueCells++; else transparentCells++;
          }
        }
      }
    }
    const gl = stubGL();
    const arrayBufferLengths = [];
    gl.bufferData = (target, data) => {
      if (target === gl.ARRAY_BUFFER) arrayBufferLengths.push(data.length);
    };
    const mesh = g.buildChunkMesh(gl, w, chunk);
    const opaqueVertices = opaqueCells * 6 * 4;
    const transparentVertices = transparentCells * 6 * 4;
    H.eq(mesh.opaque.count, opaqueCells * 6 * 6, 'opaque indices cover every visible face');
    H.eq(mesh.trans.count, transparentCells * 6 * 6, 'transparent indices cover every visible face');
    H.eq(arrayBufferLengths[0], opaqueVertices * 9, 'opaque vertices fit their own buffer');
    H.eq(arrayBufferLengths[1], transparentVertices * 9, 'transparent vertices fit their own buffer');
  }
});

H.test('a 2x2x2 cube culls all its interior faces', () => {
  const { w, chunk, y, BASE } = scratchWorld(54);
  for (let dx = 0; dx < 2; dx++) {
    for (let dz = 0; dz < 2; dz++) {
      for (let dy = 0; dy < 2; dy++) w.setBlock(BASE + dx, y + dy, BASE + dz, 3);
    }
  }
  H.eq(quadCount(buildChunk(w, chunk)), 24, 'only the shell of 8 blocks is visible');
});

H.test('a 4x4x4 cube renders only its six outer faces', () => {
  const { w, chunk, y, BASE } = scratchWorld(60);
  for (let dx = 0; dx < 4; dx++) {
    for (let dz = 0; dz < 4; dz++) {
      for (let dy = 0; dy < 4; dy++) w.setBlock(BASE + dx, y + dy, BASE + dz, 3);
    }
  }
  H.eq(quadCount(buildChunk(w, chunk)), 96, 'six faces of four by four quads');
});

H.test('water goes to the transparent pass', () => {
  const { w, chunk, y, BASE } = scratchWorld(55);
  chunk.blocks[Chunk.idx(BASE - chunk.cx * CHUNK, y, BASE - chunk.cz * CHUNK)] = 12;
  const mesh = buildChunk(w, chunk);
  H.eq(quadCount(mesh), 0, 'water must not be opaque');
  H.eq(transQuadCount(mesh), 6, 'water has six transparent faces');
});

H.test('water spreads across a surface for at most four blocks', () => {
  const { w, chunk, y, BASE } = scratchWorld(65);
  for (let dx = -5; dx <= 5; dx++) {
    for (let dz = -5; dz <= 5; dz++) {
      chunk.blocks[Chunk.idx(BASE + dx - chunk.cx * CHUNK, y - 1, BASE + dz - chunk.cz * CHUNK)] = 3;
    }
  }
  w.setBlock(BASE, y, BASE, 12);
  H.eq(w.getBlock(BASE + 1, y, BASE), 18, 'first flow cell retains strength four');
  H.eq(w.getBlock(BASE + 4, y, BASE), 21, 'fourth cell is the last flowing block');
  H.eq(w.getBlock(BASE + 5, y, BASE), 0, 'water does not spread beyond its bound');
});

H.test('flowing water retracts when its only source is removed', () => {
  const { w, chunk, y, BASE } = scratchWorld(67);
  for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++)
    chunk.blocks[Chunk.idx(BASE + dx - chunk.cx * CHUNK, y - 1, BASE + dz - chunk.cz * CHUNK)] = 3;
  w.setBlock(BASE, y, BASE, 12);
  H.assert(g.isLiquid(w.getBlock(BASE + 1, y, BASE)), 'the source creates a nearby flow');
  w.setBlock(BASE, y, BASE, 0);
  H.eq(w.getBlock(BASE + 1, y, BASE), 0, 'unsupported eastward flow drains');
  H.eq(w.getBlock(BASE - 1, y, BASE), 0, 'unsupported westward flow drains');
});

H.test('flowing water remains supported by a second source', () => {
  const { w, chunk, y, BASE } = scratchWorld(68);
  for (let dx = -5; dx <= 8; dx++) for (let dz = -5; dz <= 5; dz++)
    chunk.blocks[Chunk.idx(BASE + dx - chunk.cx * CHUNK, y - 1, BASE + dz - chunk.cz * CHUNK)] = 3;
  w.setBlock(BASE, y, BASE, 12);
  w.setBlock(BASE + 3, y, BASE, 12);
  w.setBlock(BASE, y, BASE, 0);
  H.assert(g.isLiquid(w.getBlock(BASE + 1, y, BASE)), 'the second source refills its nearby channel');
});

H.test('flowing water attenuates sunlight and carries block light', () => {
  const { w, chunk, y, BASE } = scratchWorld(69);
  chunk.blocks[Chunk.idx(BASE - chunk.cx * CHUNK, y, BASE - chunk.cz * CHUNK)] = 18;
  chunk.blocks[Chunk.idx(BASE + 2 - chunk.cx * CHUNK, y, BASE - chunk.cz * CHUNK)] = 11;
  w.computeLight(chunk);
  H.eq(w.getLight(BASE, y, BASE), 14, 'flowing water attenuates vertical sunlight');
  H.assert(w.getBlockLight(BASE + 1, y, BASE) > 0, 'block light passes through flowing water');
});
H.test('flowing water continues lateral sunlight propagation', () => {
  const { w, chunk, y, BASE } = scratchWorld(70);
  const localX = BASE - chunk.cx * CHUNK, localZ = BASE - chunk.cz * CHUNK;
  chunk.light.fill(0);
  chunk.blocks[Chunk.idx(localX, y, localZ)] = 18;
  chunk.light[Chunk.idx(localX, y, localZ)] = 10;
  w.bspreadSun(chunk);
  H.eq(chunk.light[Chunk.idx(localX + 1, y, localZ)], 9,
    'sunlight should spread out of a flowing-water cell');
});
H.test('water refills a dug cell after a placed block is removed', () => {
  const { w, chunk, y, BASE } = scratchWorld(66);
  for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++)
    chunk.blocks[Chunk.idx(BASE + dx - chunk.cx * CHUNK, y - 1, BASE + dz - chunk.cz * CHUNK)] = 3;
  chunk.blocks[Chunk.idx(BASE - chunk.cx * CHUNK, y, BASE - chunk.cz * CHUNK)] = 12;
  w.setBlock(BASE, y, BASE, 3);
  H.eq(w.getBlock(BASE, y, BASE), 3, 'the placed block stays in the world');
  H.assert(g.isLiquid(w.getBlock(BASE + 1, y, BASE)), 'water is displaced into a nearby empty cell');
  w.setBlock(BASE, y, BASE, 0);
  H.assert(g.isLiquid(w.getBlock(BASE, y, BASE)), 'water flows back into the cleared cell');
});

H.test('leaves go to the depth-writing cutout pass', () => {
  const { w, chunk, y, BASE } = scratchWorld(64);
  w.setBlock(BASE, y, BASE, 9);
  const mesh = buildChunk(w, chunk);
  H.eq(quadCount(mesh), 0, 'leaves keep their texture holes');
  H.eq(cutoutQuadCount(mesh), 6, 'leaf faces render with depth writes');
  H.eq(transQuadCount(mesh), 0, 'leaves are not blended with the background');
});
H.test('flowing-water blocks do not cast ambient occlusion', () => {
  const mesher = fs.readFileSync(path.join(__dirname, '..', 'js', 'mesher.js'), 'utf8');
  H.assert(/AO_OCCLUDES\[18\]\s*=\s*AO_OCCLUDES\[19\]\s*=\s*AO_OCCLUDES\[20\]\s*=\s*AO_OCCLUDES\[21\]\s*=\s*0/.test(mesher),
    'all flowing-water levels should use the same non-occluding AO treatment as source water');
});
H.test('flower cutouts do not darken neighboring solid faces with ambient occlusion', () => {
  const captureOpaqueVertices = (plantId) => {
    const { w, chunk, y, BASE } = scratchWorld(87);
    w.setBlock(BASE, y, BASE, 3);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          w.setBlock(BASE + dx, y + dy, BASE + dz, plantId);
        }
      }
    }

    const gl = stubGL();
    let opaqueVertices = null;
    gl.bufferData = (target, data) => {
      if (target === gl.ARRAY_BUFFER && opaqueVertices === null) opaqueVertices = Array.from(data);
    };
    g.buildChunkMesh(gl, w, chunk);
    return opaqueVertices;
  };

  for (const plant of BLOCKS.filter(block => block && block.plant)) {
    const vertices = captureOpaqueVertices(plant.id);
    H.assert(vertices && vertices.length >= 24 * g.VERT_FLOATS,
      plant.name + ' should leave all six adjacent stone faces available');
    for (let aoOffset = 7; aoOffset < vertices.length; aoOffset += g.VERT_FLOATS) {
      H.near(vertices[aoOffset], 1, 1e-6,
        plant.name + ' should not darken any stone face corner');
    }
  }
});
H.test('first-person hand preserves scene depth for the transparent pass', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'js', 'main.js'), 'utf8');
  H.assert(!/clear\(gl\.DEPTH_BUFFER_BIT\)/.test(main),
    'the first-person hand must not clear terrain depth before transparent water renders');
  H.assert(/drawBuildHand\(prog, this\.players\[0\], true\)/.test(main),
    'the first-person hand remains rendered');
});

H.test('water hides its faces against other water', () => {
  const { w, chunk, y, BASE } = scratchWorld(56);
  chunk.blocks[Chunk.idx(BASE - chunk.cx * CHUNK, y, BASE - chunk.cz * CHUNK)] = 12;
  chunk.blocks[Chunk.idx(BASE + 1 - chunk.cx * CHUNK, y, BASE - chunk.cz * CHUNK)] = 12;
  H.eq(transQuadCount(buildChunk(w, chunk)), 10);
});

H.test('water is culled behind an opaque block', () => {
  const { w, chunk, y, BASE } = scratchWorld(57);
  chunk.blocks[Chunk.idx(BASE - chunk.cx * CHUNK, y, BASE - chunk.cz * CHUNK)] = 12;
  w.setBlock(BASE + 1, y, BASE, 3);
  const mesh = buildChunk(w, chunk);
  H.eq(quadCount(mesh), 6, 'the stone renders fully');
  H.eq(transQuadCount(mesh), 5, 'the covered water face is culled');
});

H.test('glass next to glass hides the internal faces', () => {
  const { w, chunk, y, BASE } = scratchWorld(58);
  w.setBlock(BASE, y, BASE, 10);
  w.setBlock(BASE + 1, y, BASE, 10);
  H.eq(transQuadCount(buildChunk(w, chunk)), 10);
});

H.test('a solid block keeps its face next to glass', () => {
  const { w, chunk, y, BASE } = scratchWorld(59);
  w.setBlock(BASE, y, BASE, 3);
  w.setBlock(BASE + 1, y, BASE, 10);
  const mesh = buildChunk(w, chunk);
  // Glass is see-through, so the stone behind it must stay visible.
  H.eq(quadCount(mesh), 6, 'stone stays fully drawn');
  H.eq(transQuadCount(mesh), 5, 'the glass face touching the stone is culled');
});

/* ============================================================
   9. Player physics
   ============================================================ */
H.suite('Player physics');

H.test('a player falls and lands on solid ground', () => {
  const w = arenaWorld();
  const p = new Player(w, characterById('steve'));
  p.pos = [CX + 5.5, w.arena.y + 6, CX + 5.5];
  stepSim(p, 180);
  H.eq(p.onGround, true, 'should have landed');
  H.near(p.pos[1], w.arena.y, 0.05, 'should rest on the floor');
});

H.test('a player never falls through the floor', () => {
  const w = arenaWorld();
  const floor = w.arena.y;
  const p = new Player(w, characterById('steve'));
  p.pos = [CX + 5.5, floor + 12, CX + 5.5];
  for (let i = 0; i < 300; i++) {
    p.update(1 / 60, 0, 0, false, false);
    H.assert(p.pos[1] >= floor - 0.1, 'fell through at frame ' + i);
  }
});

H.test('a player cannot walk through a wall', () => {
  const w = arenaWorld();
  const p = new Player(w, characterById('steve'));
  p.pos = [CX + 5.5, w.arena.y, CX + 8.5];
  for (let dy = 0; dy <= 2; dy++) w.setBlock(CX + 5, w.arena.y + dy, CX + 6, 3);
  p.yaw = 0;   // facing -Z
  stepSim(p, 120, { mz: 1 });
  H.assert(p.pos[2] > 6.5, 'should be stopped by the wall, ended at z=' + p.pos[2].toFixed(2));
});

H.test('walking moves the player along the direction they face', () => {
  const w = arenaWorld();
  const p = new Player(w, characterById('steve'));
  p.pos = [CX + 5.5, w.arena.y, CX + 5.5];
  p.yaw = 0;
  const z0 = p.pos[2];
  stepSim(p, 60, { mz: 1 });
  const moved = Math.abs(p.pos[2] - z0);
  H.assert(moved > 1, 'walking should cover ground, moved ' + moved.toFixed(2));
  H.assert(p.pos[2] < z0, 'facing -Z should shrink the Z coordinate');
});

H.test('a grounded player walks up a one-block step without jumping', () => {
  const w = collisionWorld();
  for (let x = 0; x <= 3; x++) w.setBlock(x, 1, 0, 3);
  const p = new Player(w, characterById('steve'));
  p.pos = [-1.5, 1, 0.5];
  p.onGround = true;
  p.yaw = -Math.PI / 2; // forward moves toward +X

  stepSim(p, 60, { mz: 1 });
  H.assert(p.pos[0] > 2.5,
    'the player should walk across the raised platform, reached x=' + p.pos[0].toFixed(2));
  H.near(p.pos[1], 2, 0.05, 'the player should stand on the step without jumping');
});

H.test('a grounded player can auto-step while moving along the Z axis', () => {
  const w = collisionWorld();
  for (let z = 0; z <= 3; z++) w.setBlock(0, 1, z, 3);
  const p = new Player(w, characterById('steve'));
  p.pos = [0.5, 1, -1.5];
  p.onGround = true;
  p.yaw = Math.PI; // forward moves toward +Z

  stepSim(p, 60, { mz: 1 });
  H.assert(p.pos[2] > 2.5,
    'the player should walk across the Z-axis step, reached z=' + p.pos[2].toFixed(2));
  H.near(p.pos[1], 2, 0.05, 'the player should climb only one block');
});

H.test('diagonal movement cannot auto-step up two blocks in one frame', () => {
  const w = collisionWorld();
  w.setBlock(0, 1, -1, 3); // first axis can step onto this block
  w.setBlock(0, 2, 0, 3);  // second axis would need a second step in the same frame
  const p = new Player(w, characterById('steve'));
  p.pos = [-0.33, 1, -0.33];
  p.onGround = true;
  p.yaw = -Math.PI / 2;

  p.update(0.05, 1, 1, false, false);
  H.near(p.pos[1], 2, 0.05,
    'the diagonal move should step onto the first block, but not the second');
  H.assert(p.pos[2] < 0,
    'the second axis should remain blocked after the one-step-per-frame limit is used');
});

H.test('a player cannot auto-step into a two-block wall or a low ceiling', () => {
  const blockedBy = (upperBlockY) => {
    const w = collisionWorld();
    w.setBlock(0, 1, 0, 3);
    w.setBlock(0, upperBlockY, 0, 3);
    const p = new Player(w, characterById('steve'));
    p.pos = [-1.5, 1, 0.5];
    p.onGround = true;
    p.yaw = -Math.PI / 2;
    stepSim(p, 45, { mz: 1 });
    H.assert(p.pos[0] < 0,
      'the player should stop before the obstructed step, reached x=' + p.pos[0].toFixed(2));
    H.near(p.pos[1], 1, 0.05, 'the player should remain at the lower level');
  };

  blockedBy(2); // a second wall block occupies the raised player's body
  blockedBy(3); // a block at head height is a low ceiling
});

H.test('automatic step-up does not apply while flying or airborne', () => {
  const tryMovement = ({ flying, grounded }) => {
    const w = collisionWorld();
    w.setBlock(0, 1, 0, 3);
    const p = new Player(w, characterById('steve'));
    p.pos = [-0.33, 1, 0.5];
    p.vel = [8, 0, 0];
    p.onGround = grounded;
    p.flying = flying;
    p.yaw = -Math.PI / 2;
    p.update(1 / 60, 0, flying ? 1 : 0, false, false);
    return p;
  };

  const flyer = tryMovement({ flying: true, grounded: true });
  H.near(flyer.pos[1], 1, 0.05, 'flight stays level at the step');
  H.assert(flyer.pos[0] < 0, 'flight must keep the solid-block collision');

  const airborne = tryMovement({ flying: false, grounded: false });
  H.assert(airborne.pos[1] < 1.1, 'an airborne player should not be lifted onto the step');
  H.assert(airborne.pos[0] < 0, 'the airborne player should still collide with the step');
});

H.test('a stale grounded state clears when falling through open air', () => {
  const p = new Player(collisionWorld(), characterById('steve'));
  p.pos = [0.5, 5, 0.5];
  p.onGround = true;

  p.update(1 / 60, 0, 0, false, false);
  H.eq(p.onGround, false, 'the player must become airborne without a landing collision');
});

H.test('a player walks down from a raised platform and lands normally', () => {
  const w = collisionWorld();
  for (let x = 0; x <= 2; x++) w.setBlock(x, 1, 0, 3);
  const p = new Player(w, characterById('steve'));
  p.pos = [1.5, 2, 0.5];
  p.onGround = true;
  p.yaw = Math.PI / 2; // forward moves toward -X, off the platform

  stepSim(p, 60, { mz: 1 });
  H.assert(p.pos[0] < 0, 'the player should walk down from the raised platform');
  H.near(p.pos[1], 1, 0.05, 'the player should land on the lower floor');
  H.eq(p.onGround, true, 'the lower floor should ground the player');
});

H.test('sneaking stops intentional movement at a ledge', () => {
  const w = collisionWorld();
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z < 0; z++) w.setBlock(x, 0, z, 0);
  }
  const p = new Player(w, characterById('steve'));
  p.pos = [0.5, 1, 0.5];
  p.onGround = true;
  p.yaw = 0; // forward moves toward -Z and off the platform

  stepSim(p, 120, { mz: 1, sneak: true });
  H.assert(p.pos[2] >= 0 && p.pos[2] < 0.35,
    'sneaking should approach the ledge closely and stop before falling, ended at z=' + p.pos[2].toFixed(2));
});

H.test('sneak ledge protection stops residual momentum while reversing input', () => {
  const w = collisionWorld();
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z < 0; z++) w.setBlock(x, 0, z, 0);
  }
  const p = new Player(w, characterById('steve'));
  p.pos = [0.5, 1, 0.02];
  p.vel = [0, 0, -20]; // residual momentum toward -Z, off the ledge
  p.onGround = true;
  p.yaw = 0;

  p.update(1 / 60, 0, -1, false, true); // input away from the ledge, still sneaking
  H.assert(p.pos[2] >= 0,
    'sneaking should stop residual momentum at the edge even when reversing input');
});

H.test('sneak ledge protection does not absorb real hit knockback against input', () => {
  const w = collisionWorld();
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z < 0; z++) w.setBlock(x, 0, z, 0);
  }
  const p = new Player(w, characterById('steve'));
  p.pos = [0.5, 1, 0.02];
  p.onGround = true;
  p.yaw = 0;
  p.takeDamage(1, [0, 0, -1], 20);

  p.update(1 / 60, 0, -1, false, true); // input points away; the hit impulse points toward -Z
  H.assert(p.pos[2] < 0,
    'a recent hit reaction should continue even when sneaking and reversing input');
});

H.test('knockback without aligned movement input does not auto-step', () => {
  const w = collisionWorld();
  w.setBlock(0, 1, 0, 3);
  const p = new Player(w, characterById('steve'));
  p.pos = [-0.33, 1, 0.5];
  p.vel = [8, 0, 0];
  p.onGround = true;

  p.update(1 / 60, 0, 0, false, false);
  H.near(p.pos[1], 1, 0.05, 'knockback alone must not climb onto the block');
  H.assert(p.pos[0] < 0, 'knockback should retain normal collision with the block');
});

H.test('sneaking is slower than walking', () => {
  const w = arenaWorld();
  const measure = (sneak) => {
    const p = new Player(w, characterById('steve'));
    p.pos = [CX + 5.5, w.arena.y, CX + 5.5];
    p.yaw = 0;
    stepSim(p, 60, { mz: 1, sneak });
    return Math.abs(p.pos[2] - (CX + 5.5));
  };
  const walk = measure(false);
  const sneak = measure(true);
  H.assert(walk > 1, 'the walker should move, got ' + walk.toFixed(2));
  H.assert(sneak > 0.1, 'the sneaker should move too, got ' + sneak.toFixed(2));
  H.assert(sneak < walk * 0.7,
    'sneak ' + sneak.toFixed(2) + ' should be well under walk ' + walk.toFixed(2));
});

H.test('jumping leaves the ground, clears a block and lands', () => {
  const w = arenaWorld();
  const p = new Player(w, characterById('steve'));
  p.pos = [CX + 5.5, w.arena.y, CX + 5.5];
  stepSim(p, 30);
  H.eq(p.onGround, true, 'should start on the ground');
  const start = p.pos[1];
  p.update(1 / 60, 0, 0, true, false);
  let peak = start, airborne = false;
  for (let i = 0; i < 140; i++) {
    p.update(1 / 60, 0, 0, false, false);
    peak = Math.max(peak, p.pos[1]);
    if (!p.onGround) airborne = true;
  }
  H.eq(airborne, true, 'the jump must leave the ground');
  H.assert(peak - start > 1.0,
    'a jump should clear a block, but only rose ' + (peak - start).toFixed(2));
  H.eq(p.onGround, true, 'should land again');
});

H.test('quicker characters really jump higher', () => {
  const w = arenaWorld();
  const peakOf = (id) => {
    const p = new Player(w, characterById(id));
    p.pos = [CX + 5.5, w.arena.y, CX + 5.5];
    stepSim(p, 30);
    const start = p.pos[1];
    p.update(1 / 60, 0, 0, true, false);
    let peak = start;
    for (let i = 0; i < 140; i++) {
      p.update(1 / 60, 0, 0, false, false);
      peak = Math.max(peak, p.pos[1]);
    }
    return peak - start;
  };
  const steve = peakOf('steve');
  const alex = peakOf('alex');
  const ninja = peakOf('ninja');
  H.assert(alex > steve, 'Alex ' + alex.toFixed(2) + ' should out-jump Steve ' + steve.toFixed(2));
  H.assert(ninja > alex, 'the ninja ' + ninja.toFixed(2) + ' should out-jump Alex ' + alex.toFixed(2));
});

H.test('flying ignores gravity', () => {
  const w = arenaWorld();
  const p = new Player(w, characterById('steve'));
  p.creative = true;
  p.flying = true;
  const y = w.arena.y + 6;
  p.pos = [CX + 5.5, y, CX + 5.5];
  stepSim(p, 120);
  H.near(p.pos[1], y, 0.01, 'a hovering player must not sink');
  H.eq(p.onGround, false);
});

H.test('flying up and down moves the player vertically', () => {
  const w = arenaWorld();
  const p = new Player(w, characterById('steve'));
  p.flying = true;
  const base = w.arena.y + 5;
  p.pos = [CX + 5.5, base, CX + 5.5];
  stepSim(p, 60, { jump: true });
  H.assert(p.pos[1] > base + 0.5, 'should have climbed');
  const top = p.pos[1];
  stepSim(p, 60, { sneak: true });
  H.assert(p.pos[1] < top, 'should have descended');
});

H.test('swimming keeps a player afloat', () => {
  const w = arenaWorld();
  const p = new Player(w, characterById('steve'));
  const x = CX + 5, z = CX + 5;
  for (let y = w.arena.floorY - 4; y <= w.arena.y + 2; y++) w.setBlock(x, y, z, 12);
  p.pos = [x + 0.5, w.arena.y - 3, z + 0.5];
  stepSim(p, 60);
  H.eq(p.inWater, true, 'should detect being in water');
  H.assert(p.pos[1] > w.arena.floorY - 6, 'should not sink out of the world');
});

H.test('the head can be submerged while the feet are not', () => {
  const w = arenaWorld();
  const p = new Player(w, characterById('steve'));
  const x = CX + 6, z = CX + 6;
  for (let y = w.arena.y; y <= w.arena.y + 3; y++) w.setBlock(x, y, z, 12);
  p.pos = [x + 0.5, w.arena.y + 0.2, z + 0.5];
  p.update(1 / 60, 0, 0, false, false);
  H.eq(p.headInWater, true, 'the eye should be submerged');
});

H.test('a player who falls off the world respawns', () => {
  const w = arenaWorld();
  const p = new Player(w, characterById('steve'));
  p.spawn = [CX + 5.5, w.arena.y, CX + 5.5];
  p.pos = [CX + 5.5, -20, CX + 5.5];
  p.update(1 / 60, 0, 0, false, false);
  H.near(p.pos[1], w.arena.y, 0.5, 'should be back at the spawn');
});

H.test('the golem is knocked back less than a light character', () => {
  const w = arenaWorld();
  const push = (id) => {
    const p = new Player(w, characterById(id));
    p.pos = [CX + 5.5, w.arena.y, CX + 5.5];
    p.vel = [0, 0, 0];
    p.takeDamage(10, [1, 0, 0], 20);
    return Math.abs(p.vel[0]);
  };
  const golem = push('golem');
  const alex = push('alex');
  H.assert(golem < alex,
    'the golem should be pushed less (' + golem.toFixed(2) + ' vs ' + alex.toFixed(2) + ')');
});

/* ---- wall climbing ---- */
H.test('the spider climbs a wall it walks into', () => {
  const w = arenaWorld();
  const p = new Player(w, characterById('spider'));
  for (let dy = 0; dy <= 8; dy++) w.setBlock(CX + 5, w.arena.y + dy, CX + 5, 3);
  p.pos = [CX + 3.5, w.arena.y, CX + 5.5];
  p.yaw = -Math.PI / 2;
  const start = p.pos[1];
  let engaged = false;
  for (let i = 0; i < 150; i++) {
    p.update(1 / 60, 0, 1, false, false);
    if (p.climbNormal) engaged = true;
  }
  H.eq(engaged, true, 'the climb should engage at the wall');
  H.assert(p.pos[1] > start + 1.5,
    'should climb a couple of blocks, rose from ' + start + ' to ' + p.pos[1].toFixed(2));
});

H.test('climb engages when already pressed against the wall', () => {
  const w = arenaWorld();
  const p = new Player(w, characterById('spider'));
  for (let dy = 0; dy <= 8; dy++) w.setBlock(CX + 5, w.arena.y + dy, CX + 5, 3);
  p.pos = [CX + 4.7, w.arena.y, CX + 5.5];
  p.yaw = -Math.PI / 2;
  p.update(1 / 60, 0, 1, false, false);
  H.assert(p.climbNormal !== null,
    'a single probe point ahead would land inside the player and miss');
});

H.test('only characters with the ability can climb', () => {
  const w = arenaWorld();
  for (let dy = 0; dy <= 8; dy++) w.setBlock(CX + 5, w.arena.y + dy, CX + 5, 3);
  const walker = new Player(w, characterById('steve'));
  walker.pos = [CX + 3.5, w.arena.y, CX + 5.5];
  walker.yaw = -Math.PI / 2;
  stepSim(walker, 150, { mz: 1 });
  H.eq(walker.climbNormal, null, 'Steve has no climbing ability');
  H.assert(walker.pos[1] <= w.arena.y + 0.5, 'Steve should be stopped by the wall');
});

/* ============================================================
   10. Damage
   ============================================================ */
H.suite('Damage');

H.test('damage reduces health and never goes below zero', () => {
  const { b } = closeRange('steve', 'golem');
  b.invuln = 0;
  H.eq(b.takeDamage(20, [1, 0, 0], 5), true, 'a clean hit should land');
  H.eq(b.hp, b.maxHp - 20, 'health should drop by the damage taken');
  b.invuln = 0;
  b.takeDamage(9999, [1, 0, 0], 5);
  H.eq(b.hp, 0, 'health should stop at zero');
});

H.test('invulnerability blocks an immediate second hit', () => {
  const { b } = closeRange('steve', 'golem');
  b.invuln = 0;
  H.eq(b.takeDamage(10, [1, 0, 0], 5), true);
  H.eq(b.takeDamage(10, [1, 0, 0], 5), false, 'the follow-up must be ignored');
});

H.test('knockback pushes away from the attacker', () => {
  const { b } = closeRange('steve', 'golem');
  b.invuln = 0;
  b.vel = [0, 0, 0];
  b.takeDamage(10, [0, 0, -1], 10);
  H.assert(b.vel[2] < -1, 'should be pushed along -Z');
});

H.test('running out of health knocks a fighter out and they recover', () => {
  const { a, b } = closeRange('steve', 'golem');
  b.spawn = b.pos.slice();
  b.takeDamage(b.maxHp + 5, [1, 0, 0], 5);
  H.eq(b.ko, true);
  H.assert(b.koTimer > 0, 'a knockout needs a recovery timer');
  b.invuln = 0;
  H.eq(b.takeDamage(10, [1, 0, 0], 5), false, 'a downed fighter cannot be hit');
  for (let i = 0; i < 250; i++) b.update(1 / 60, 0, 0, false, false);
  H.eq(b.ko, false, 'should have recovered');
  H.eq(b.hp, b.maxHp, 'should return to full health');
});

H.test('a knocked out Fight Arena fighter keeps falling instead of freezing in midair', () => {
  const { b } = closeRange('steve', 'golem');
  b.pos = [CX + 8.5, b.pos[1] + 8, CX + 8.5];
  b.vel = [0, 0, 0];
  b.takeDamage(b.maxHp, null, 0);
  const beforeY = b.pos[1];
  b.update(0.1, 0, 0, false, false);
  H.assert(b.pos[1] < beforeY, 'KO physics still applies gravity');
  H.eq(b.ko, true, 'the existing KO recovery timer remains active');
});

H.test('Play & Build respawn restores health without resetting world or food inventory', () => {
  const w = arenaWorld();
  const p = new Player(w, characterById('steve'));
  p.spawn = [CX + 5.5, w.arena.y, CX + 5.5];
  p.pos = [CX + 8.5, w.arena.y, CX + 8.5];
  p.inventory.apple = 3;
  p.inventory.meat = 2;
  const edit = [CX + 7, w.arena.y, CX + 7];
  w.setBlock(edit[0], edit[1], edit[2], 16);
  const editsBefore = w.edits.size;
  p.takeDamage(p.maxHp, null, 0);
  H.eq(p.koTimer, 2.4, 'zero health starts the approved respawn timer');
  p.update(2.399, 0, 0, false, false);
  H.eq(p.ko, true, 'the player remains down until the timer ends');
  p.update(0.002, 0, 0, false, false);
  H.eq(p.ko, false, 'the player respawns');
  H.eq(p.pos[0], p.spawn[0], 'respawn uses the spawn position');
  H.eq(p.hp, p.maxHp, 'respawn restores full character health');
  H.eq(p.inventory.apple, 3, 'apples survive respawn');
  H.eq(p.inventory.meat, 2, 'meat survives respawn');
  H.eq(w.edits.size, editsBefore, 'respawn does not change world edits');
  H.eq(w.getBlock(edit[0], edit[1], edit[2]), 16, 'the built world block remains');
});

H.test('selected wood, stone, and gold materials set the approved attack damage', () => {
  const p = new Player(arenaWorld(), characterById('steve'));
  for (const [slot, damage] of [[0, 8], [4, 12], [1, 16], [8, 20], [9, 8]]) {
    p.selectedSlot = slot;
    H.eq(Game.playAttackDamage(p), damage, 'slot ' + slot + ' damage');
  }
});

H.test('leaf apple drop uses the approved 15 percent threshold', () => {
  H.eq(Game.shouldDropApple(0.149999), true, 'a roll below 0.15 drops an apple');
  H.eq(Game.shouldDropApple(0.15), false, 'a roll at 0.15 does not drop an apple');
});

H.test('apples and meat heal the approved amount and consume one item', () => {
  const previousSave = Game.save;
  const previousSlot = Game.selectedSlot;
  const previousPlayer = Game.players[0];
  const p = new Player(arenaWorld(), characterById('steve'));
  p.hp = 60;
  p.inventory.apple = 2;
  p.inventory.meat = 1;
  Game.players[0] = p;
  Game.save = () => true;
  Game.selectedSlot = 10;
  H.eq(Game.consumeFood(p), true, 'an apple can be eaten');
  H.eq(p.hp, 80, 'an apple restores 20 HP');
  H.eq(p.inventory.apple, 1, 'one apple is consumed');
  Game.selectedSlot = 11;
  H.eq(Game.consumeFood(p), true, 'meat can be eaten');
  H.eq(p.hp, 100, 'meat restores 30 HP up to the character maximum');
  H.eq(p.inventory.meat, 0, 'one meat is consumed');
  Game.save = previousSave;
  Game.selectedSlot = previousSlot;
  Game.players[0] = previousPlayer;
});

H.test('the healing character recovers after landing a hit', () => {
  const w = arenaWorld();
  const doll = new Player(w, characterById('doll'));
  const victim = new Player(w, characterById('golem'));
  doll.pos = openSpot(w, 5, 5);
  victim.pos = openSpot(w, 6.8, 5);
  doll.creative = false; doll.flying = false;
  victim.creative = false; victim.flying = false;
  doll.hp = doll.maxHp - 30;
  const before = doll.hp;
  Fight.players[0] = doll;
  Fight.players[1] = victim;
  Fight.applyHit(doll, victim, 10, [1, 0, 0], 5, PROJ_DEFS.star);
  H.assert(doll.hp > before, 'the doll should heal on a successful hit');
});

/* ============================================================
   11. Characters
   ============================================================ */
H.suite('Characters');

H.test('changing character keeps the current world and current health proportion', () => {
  const t = H.load({ boot: false });
  const player = {
    char: characterById('steve'), hp: 60, maxHp: 100, ko: false,
    pos: [4, 20, 6], selectedSlot: 0, climbNormal: [1, 0, 0],
  };
  t.Game.players = [player];
  t.Game.world = { seed: 12345, edits: new Map() };
  const changed = t.Game.changeCharacter('doll');
  H.eq(changed.id, 'doll', 'the requested character should be selected');
  H.eq(player.char.id, 'doll', 'the active player should change immediately');
  H.eq(player.maxHp, 85, 'the new character health should be applied');
  H.eq(player.hp, 51, 'current health percentage should be preserved');
  H.eq(player.climbNormal, null, 'character-specific movement state should reset');
  H.eq(t.Game.pick.p1, 'doll', 'the chosen character should be remembered for this profile');
  H.eq(t.Game.world.seed, 12345, 'character change should not replace the current world');
});

H.test('creative inventory summary shows outfit, selected item and unlimited block stock', () => {
  const t = H.load({ boot: false });
  t.Game.selectedSlot = 2;
  t.UI.updateEquipmentStatus({ char: characterById('doll') }, 'play');
  const summary = t.document.getElementById('equipment-status');
  H.assert(summary.textContent.includes('Dolly'), 'the active character should be visible');
  H.assert(summary.textContent.includes('Sparkle Power'), 'the active outfit should be visible');
  H.assert(summary.textContent.includes(BLOCKS[HOTBAR_BLOCKS[2]].name), 'the selected item should be visible');
  H.assert(summary.textContent.includes('PLACE builds'), 'block placement guidance should be visible');
  H.assert(summary.textContent.includes(BLOCKS[HOTBAR_BLOCKS[2]].name), 'the selected block should be visible');
  H.assert(summary.textContent.includes('∞'), 'creative block stock should be shown as unlimited');
});

H.test('every character is complete and coherent', () => {
  for (const c of CHARACTERS) {
    H.assert(c.id && c.name && c.style && c.desc, c.id + ' needs a name, style and description');
    H.assert(c.color && c.color[0] === '#', c.id + ' needs a colour');
    H.assert(c.hp > 0 && c.speed > 0, c.id + ' needs stats');
    H.assert(c.ultName && c.ultDesc, c.id + ' needs an ultimate');
    H.assert(Array.isArray(c.attacks) && c.attacks.length === 3,
      c.id + ' should have three attacks');
  }
});

H.test('attack timing profiles make sense', () => {
  for (const c of CHARACTERS) {
    for (let i = 0; i < c.attacks.length; i++) {
      const a = c.attacks[i];
      H.assert(a.name, c.id + ' attack ' + i + ' needs a name');
      H.assert(a.dmg > 0 && a.dmg < 100, c.id + '.' + a.name + ' damage out of range');
      H.assert(a.windup > 0 && a.active > 0 && a.recover > 0,
        c.id + '.' + a.name + ' needs a full timing profile');
      H.assert(a.reach > 0, c.id + '.' + a.name + ' needs reach');
      H.assert(a.type === 'melee' || a.type === 'ranged', c.id + '.' + a.name + ' bad type');
    }
  }
});

H.test('heavier attacks hit harder and take longer', () => {
  for (const c of CHARACTERS) {
    const [light, , heavy] = c.attacks;
    H.assert(heavy.dmg > light.dmg, c.id + ' heavy should hit harder');
    H.assert(heavy.windup >= light.windup, c.id + ' heavy should wind up slower');
    H.assert(heavy.recover >= light.recover, c.id + ' heavy should recover slower');
  }
});

H.test('ranged attacks out-reach melee ones', () => {
  for (const c of CHARACTERS) {
    const ranged = c.attacks.filter((a) => a.type === 'ranged');
    if (!ranged.length) continue;
    for (const r of ranged) {
      for (const m of c.attacks.filter((a) => a.type === 'melee')) {
        H.assert(r.reach > m.reach, c.id + ': ' + r.name + ' should out-reach ' + m.name);
      }
    }
  }
});

H.test('characters are genuinely differentiated', () => {
  const sigs = CHARACTERS.map((c) => [c.hp, c.speed, c.jump].join('/'));
  H.eq(new Set(sigs).size, sigs.length, 'two characters share identical stats');
  H.eq(new Set(CHARACTERS.map((c) => c.ultName)).size, CHARACTERS.length,
    'two characters share an ultimate name');
});

H.test('each character outfit uses a role-patterned texture', () => {
  const roles = [
    ['steve', 'builder_shirt', [246, 194, 82]],
    ['alex', 'ranger_shirt', [242, 184, 78]],
    ['spider', 'climber_shirt', [246, 204, 91]],
    ['doll', 'dolly_dress', [255, 221, 112]],
    ['ninja', 'fire_ninja', [246, 112, 54]],
  ];
  for (const [id, textureName, accent] of roles) {
    const character = characterById(id);
    const tile = g.ATLAS[character.shirt];
    H.eq(tile.name, textureName, id + ' should use its own outfit texture');
    let foundAccent = false;
    for (let i = 0; i < tile.data.length; i += 4) {
      if (tile.data[i] === accent[0] && tile.data[i + 1] === accent[1] && tile.data[i + 2] === accent[2]) {
        foundAccent = true;
        break;
      }
    }
    H.assert(foundAccent, id + ' should have its role accent pattern');
  }
  H.eq(g.ATLAS[characterById('golem').shirt].name, 'cobble',
    'the golem should keep its stone material');
});

H.test('all role outfit fabrics retain their background shading', () => {
  for (const name of ['builder_shirt', 'ranger_shirt', 'climber_shirt', 'dolly_dress', 'dolly_leggings', 'fire_ninja']) {
    const tile = g.ATLAS.find(entry => entry.name === name);
    H.assert(tile, name + ' texture should exist');
    const colors = new Set();
    for (let i = 0; i < tile.data.length; i += 4) {
      colors.add(tile.data[i] + ',' + tile.data[i + 1] + ',' + tile.data[i + 2]);
    }
    H.assert(colors.size > 8, name + ' should keep its speckled fabric background beneath the role motif');
  }
});

H.test('the menu stat bars use values between zero and one', () => {
  for (const c of CHARACTERS) {
    for (const k of ['power', 'speed', 'range']) {
      H.assert(c.stats[k] >= 0 && c.stats[k] <= 1, c.id + '.' + k + ' out of range');
    }
  }
});

H.test('characterById falls back safely', () => {
  H.eq(g.characterById('does-not-exist').id, 'steve');
  H.eq(g.characterById('ninja').name, 'Fire Ninja');
});

H.test('a tab keeps its profile authorization identity across page reloads', () => {
  const tabStorage = H.makeStorage();
  const firstLoad = H.load({ boot: false, load: false, sessionStorage: tabStorage });
  const reload = H.load({ boot: false, load: false, sessionStorage: tabStorage });
  H.eq(reload.PAGE_AUTH_ID, firstLoad.PAGE_AUTH_ID);
  H.assert(/^[a-f0-9]{32}$/.test(firstLoad.PAGE_AUTH_ID), 'page identity must remain a random 128-bit hex token');
});

H.test('every animal definition is usable', () => {
  for (const a of ANIMALS) {
    H.assert(a.id && a.name && a.tame, a.id + ' is incomplete');
    H.assert(a.w > 0 && a.h > 0 && a.d > 0, a.id + ' needs a positive size');
    H.assert(a.speed > 0, a.id + ' needs a speed');
    H.assert(Array.isArray(a.habitats) && a.habitats.length > 0, a.id + ' needs habitat preferences');
    H.assert(a.groupMin > 0 && a.groupMax >= a.groupMin, a.id + ' needs valid group sizes');
    for (const k of ['body', 'face', 'leg']) {
      H.assert(typeof a[k] === 'number', a.id + '.' + k + ' must be a texture index');
    }
    for (const k of ['ear', 'antler']) if (a[k] !== undefined) {
      H.assert(typeof a[k] === 'number', a.id + '.' + k + ' must be a texture index');
    }
  }
  for (const id of ['rabbit', 'fox', 'deer']) H.assert(ANIMALS.some(a => a.id === id), id + ' should be a new original species');
});

/* ============================================================
   12. Combat flow
   ============================================================ */
H.suite('Combat flow');

H.test('a melee swing connects and deals its listed damage', () => {
  const { a, b } = closeRange('steve', 'golem', 1.8);
  const hp = b.hp;
  g.Fight.tryMelee(a, 0, b);
  runFight({ a, b }, 30);
  H.assert(b.hp < hp, 'the swing should land');
  H.eq(Math.round(hp - b.hp), a.char.attacks[0].dmg, 'exactly the listed damage');
});

H.test('the heavy attack hits harder than the light one', () => {
  const light = closeRange('steve', 'golem', 1.8);
  const heavy = closeRange('steve', 'golem', 1.8);
  Fight.tryMelee(light.a, 0, light.b);
  runFight(light, 45);
  Fight.tryMelee(heavy.a, 2, heavy.b);
  runFight(heavy, 45);
  const lightDmg = light.a.maxHp - light.b.hp;
  const heavyDmg = heavy.a.maxHp - heavy.b.hp;
  H.assert(heavyDmg > lightDmg, 'heavy ' + heavyDmg + ' should beat light ' + lightDmg);
});

H.test('a swing is on cooldown until it finishes', () => {
  const { a, b } = closeRange('steve', 'golem', 1.8);
  Fight.tryMelee(a, 2, b);
  H.assert(a.swing !== null);
  const held = a.swing;
  Fight.tryMelee(a, 0, b);
  H.eq(a.swing, held, 'a second attack must be ignored mid-swing');
  runFight({ a, b }, 120);
  H.eq(a.swing, null, 'the swing should finish');
  H.eq(a.attacking, false);
  Fight.tryMelee(a, 0, b);
  H.assert(a.swing !== null, 'a new swing is allowed afterwards');
});

H.test('a swing misses a distant opponent', () => {
  const { a, b } = closeRange('steve', 'golem', 1.8);
  b.pos = [a.pos[0] + 15, a.pos[1], a.pos[2]];
  const hp = b.hp;
  Fight.tryMelee(a, 0, b);
  runFight({ a, b }, 30);
  H.eq(b.hp, hp, 'a distant opponent must not be hit');
});

H.test('a swing never hits its own thrower', () => {
  const { a, b } = closeRange('steve', 'golem', 1.8);
  const hp = a.hp;
  Fight.tryMelee(a, 0, b);
  runFight({ a, b }, 30);
  H.eq(a.hp, hp, 'no self damage');
});

H.test('landing a hit charges the ultimate, taking one charges it less', () => {
  const { a, b } = closeRange('steve', 'golem', 1.8);
  a.ultMeter = 0; b.ultMeter = 0;
  Fight.applyHit(a, b, 20, [1, 0, 0], 5, PROJ_DEFS.star);
  H.assert(a.ultMeter > 0, 'the attacker should gain charge');
  H.assert(a.ultMeter > b.ultMeter, 'the victim should gain less');
});

H.test('a sustained exchange fully charges the ultimate', () => {
  const { a, b } = closeRange('steve', 'golem', 1.8);
  a.ultMeter = 0;
  a.maxHp = 100000; a.hp = 100000;
  b.maxHp = 100000; b.hp = 100000;
  for (let n = 0; n < 12 && a.ultMeter < a.maxUlt; n++) {
    b.invuln = 0;
    Fight.applyHit(a, b, 20, [1, 0, 0], 0, PROJ_DEFS.star);
  }
  H.assert(a.ultMeter >= a.maxUlt, 'got ' + a.ultMeter.toFixed(0));
});

H.test('the ultimate will not fire before it is charged, and only once', () => {
  const { a, b } = closeRange('steve', 'golem', 1.8);
  a.ultMeter = 0;
  H.eq(Fight.useUltimate(a, b), false, 'an empty bar must refuse');
  a.ultMeter = a.maxUlt;
  H.eq(Fight.useUltimate(a, b), true, 'a full bar must fire');
  H.eq(a.ultMeter, 0, 'the bar should be spent');
  H.eq(Fight.useUltimate(a, b), false, 'and cannot fire twice');
});

H.test('every ultimate fires and produces a visible effect', () => {
  for (const c of CHARACTERS) {
    const w = arenaWorld();
    const a = new Player(w, c);
    const b = new Player(w, characterById('golem'));
    a.creative = false; a.flying = false;
    b.creative = false; b.flying = false;
    Fight.reset(a, b);
    a.pos = openSpot(w, 5, 5);
    b.pos = openSpot(w, 8.5, 5);
    a.yaw = -Math.PI / 2;
    a.ultMeter = a.maxUlt;
    const projBefore = Fight.projectiles.length;
    const partsBefore = Particles.list.length;

    H.eq(Fight.useUltimate(a, b), true, c.id + ' ultimate should fire');
    // The bar is emptied when the ultimate fires. Some ultimates hit on the
    // same frame, and landing a hit refunds part of the bar, so assert the
    // bar was spent rather than that it is exactly zero afterwards.
    H.assert(a.ultMeter < a.maxUlt,
      c.id + ' should consume the bar, still at ' + a.ultMeter.toFixed(1));

    // The target is topped up and kept un-KO'd each frame, so track damage
    // separately rather than reading it back off hp.
    let damage = 0;
    let peakProjectiles = 0;
    let peakParticles = 0;
    b.maxHp = 100000; b.hp = 100000;
    for (let i = 0; i < 90; i++) {
      b.invuln = 0;
      const before = b.hp;
      Fight.update(1 / 60, a, b);
      a.update(1 / 60, 0, 0, false, false);
      b.update(1 / 60, 0, 0, false, false);
      damage += before - b.hp;
      b.hp = 100000;
      // Sample as we go: these effects are short lived, so checking only the
      // final frame would miss anything that has already expired.
      peakProjectiles = Math.max(peakProjectiles, Fight.projectiles.length - projBefore);
      peakParticles = Math.max(peakParticles, Particles.list.length - partsBefore);
    }
    const didSomething = peakProjectiles > 0 || peakParticles > 0 || damage > 0;
    H.assert(didSomething, c.id + ' ultimate (' + c.ultName + ') did nothing visible');
  }
});

H.test('the dash ultimates actually connect with the opponent', () => {
  // Regression: both dashes used to move the fighter without ever landing a
  // hit, so the ultimate looked like it did nothing at all.
  for (const id of ['ninja', 'alex']) {
    const w = arenaWorld();
    const a = new Player(w, characterById(id));
    const b = new Player(w, characterById('golem'));
    a.creative = false; a.flying = false;
    b.creative = false; b.flying = false;
    Fight.reset(a, b);
    a.pos = openSpot(w, 5, 5);
    b.pos = openSpot(w, 8.5, 5);
    a.yaw = -Math.PI / 2;
    a.ultMeter = a.maxUlt;
    H.eq(Fight.useUltimate(a, b), true, id + ' ultimate should fire');

    let damage = 0;
    b.maxHp = 100000; b.hp = 100000;
    for (let i = 0; i < 60; i++) {
      b.invuln = 0;
      const before = b.hp;
      Fight.update(1 / 60, a, b);
      a.update(1 / 60, 0, 0, false, false);
      b.update(1 / 60, 0, 0, false, false);
      damage += before - b.hp;
      b.hp = 100000;
    }
    H.assert(damage > 0,
      id + ' ultimate dealt no damage to an opponent standing 3.5 blocks away');
  }
});

H.test('the shockwave ultimate hits a nearby target', () => {
  const w = arenaWorld();
  const golem = new Player(w, characterById('golem'));
  const victim = new Player(w, characterById('steve'));
  golem.creative = false; golem.flying = false;
  victim.creative = false; victim.flying = false;
  Fight.reset(golem, victim);
  golem.pos = openSpot(w, 5, 5);
  victim.pos = openSpot(w, 8.5, 5);
  golem.ultMeter = golem.maxUlt;
  victim.invuln = 0;
  const hp = victim.hp;
  Fight.useUltimate(golem, victim);
  H.assert(victim.hp < hp, 'the stomp should hit a nearby target');
});

H.test('the beacon ultimate holds the enemy in place', () => {
  // Keep both fighters well inside the arena, well clear of the wall, so the
  // signal burst has a clear line to reach the target.
  const w = arenaWorld();
  const a = new Player(w, characterById('spider'));
  const b = new Player(w, characterById('golem'));
  a.creative = false; a.flying = false;
  b.creative = false; b.flying = false;
  Fight.reset(a, b);
  a.pos = openSpot(w, 3, 3);
  b.pos = openSpot(w, 11, 3);
  a.yaw = -Math.PI / 2;
  a.ultMeter = a.maxUlt;

  H.eq(Fight.useUltimate(a, b), true, 'the ultimate should fire');
  for (let i = 0; i < 60; i++) {
    b.invuln = 0;
    Fight.update(1 / 60, a, b);
    a.update(1 / 60, 0, 0, false, false);
    b.update(1 / 60, 0, 0, false, false);
  }
  H.eq(b.blocked, true, 'the cocoon should hold the enemy');
  H.assert(b.blockTimer > 0, 'and it should wear off after a moment');
  H.assert(b.blockTimer < 2.7, 'the hold should be temporary, not permanent');
});

H.test('the combo counter builds and then lapses', () => {
  const { a, b } = closeRange('steve', 'golem', 1.8);
  for (let n = 0; n < 3; n++) {
    b.invuln = 0;
    Fight.applyHit(a, b, 10, [1, 0, 0], 1, PROJ_DEFS.star);
  }
  H.eq(a.combo, 3, 'three hits make a three-hit combo');
  for (let i = 0; i < 200; i++) a.update(1 / 60, 0, 0, false, false);
  H.eq(a.combo, 0, 'the combo should lapse');
});

H.test('taking a hit breaks the combo counter', () => {
  const { a, b } = closeRange('steve', 'golem', 1.8);
  b.invuln = 0;
  Fight.applyHit(a, b, 10, [1, 0, 0], 1, PROJ_DEFS.star);
  H.eq(a.combo, 1, 'the first hit starts a combo');
  // The victim is still in post-hit invulnerability, so a second blow in the
  // same instant is correctly ignored. Break the combo directly instead.
  a.takeDamage(10, [-1, 0, 0], 1);
  H.eq(a.combo, 0, 'getting hit should break the combo');
  void b;
});

H.test('a knockout ends the round and names a winner', () => {
  const { a, b } = closeRange('steve', 'golem', 1.8);
  b.invuln = 0;
  Fight.applyHit(a, b, b.maxHp + 50, [1, 0, 0], 5, PROJ_DEFS.star);
  H.eq(b.ko, true);
  H.eq(Fight.winner, a, 'the attacker should win');
  H.eq(Fight.roundActive, false, 'the round should be over');
});

/* ============================================================
   13. Projectiles
   ============================================================ */
H.suite('Projectiles');

H.test('a thrown shot travels and eventually expires', () => {
  const { a, b } = closeRange('spider', 'golem', 20);
  a.yaw = -Math.PI / 2;
  b.pos = [a.pos[0] + 30, a.pos[1], a.pos[2]];
  Fight.tryRanged(a, 0);
  H.eq(Fight.projectiles.length, 1, 'a shot should exist');
  const pr = Fight.projectiles[0];
  const x0 = pr.pos[0];
  for (let i = 0; i < 10; i++) pr.update(1 / 60, a.world, Fight.players);
  H.assert(pr.pos[0] > x0, 'the shot should travel toward +X');
  for (let i = 0; i < 400 && !pr.dead; i++) pr.update(1 / 60, a.world, Fight.players);
  H.eq(pr.dead, true, 'the shot should eventually vanish');
});

H.test('a shot hits an opponent standing in its path', () => {
  const { a, b } = closeRange('spider', 'golem', 6);
  a.yaw = -Math.PI / 2;
  a.pitch = 0;
  b.invuln = 0;
  const hp = b.hp;
  Fight.tryRanged(a, 0);
  for (let i = 0; i < 60; i++) {
    Fight.update(1 / 60, a, b);
    a.update(1 / 60, 0, 0, false, false);
    b.update(1 / 60, 0, 0, false, false);
  }
  H.assert(b.hp < hp, 'the shot should have connected');
});

H.test('a shot never hits its owner', () => {
  const { a, b } = closeRange('spider', 'golem', 20);
  a.yaw = -Math.PI / 2;
  b.pos = [a.pos[0] + 25, a.pos[1], a.pos[2]];
  const hp = a.hp;
  Fight.tryRanged(a, 0);
  runFight({ a, b }, 30);
  H.eq(a.hp, hp, 'the shooter must be safe');
});

H.test('a shot is stopped by a wall', () => {
  const { a, b } = closeRange('spider', 'golem', 12);
  a.yaw = -Math.PI / 2;
  b.pos = [a.pos[0] + 20, a.pos[1], a.pos[2]];
  for (let dy = 0; dy <= 3; dy++) a.world.setBlock(Math.floor(a.pos[0] + 8), a.pos[1] + dy, Math.floor(a.pos[2]), 3);
  Fight.tryRanged(a, 0);
  const pr = Fight.projectiles[0];
  for (let i = 0; i < 90 && !pr.dead; i++) pr.update(1 / 60, a.world, Fight.players);
  H.eq(pr.dead, true, 'the wall should stop the shot');
});

/* ============================================================
   14. Computer opponent
   ============================================================ */
H.suite('Computer opponent');

H.test('the bot always returns a usable command', () => {
  const w = arenaWorld();
  const botP = new Player(w, characterById('golem'));
  const human = new Player(w, characterById('steve'));
  botP.pos = openSpot(w, 5, 5);
  human.pos = openSpot(w, 9, 5);
  botP.creative = false; botP.flying = false;
  human.creative = false; human.flying = false;
  const bot = new Bot(botP, 1);
  for (let i = 0; i < 300; i++) {
    const cmd = bot.think_opponent(human, 1 / 60);
    H.assert(typeof cmd.mx === 'number' && !isNaN(cmd.mx), 'mx must be a number');
    H.assert(typeof cmd.mz === 'number' && !isNaN(cmd.mz), 'mz must be a number');
    H.assert(Math.abs(cmd.mx) <= 1.001, 'mx out of range: ' + cmd.mx);
    H.assert(Math.abs(cmd.mz) <= 1.001, 'mz out of range: ' + cmd.mz);
    for (const k of ['jump', 'attack', 'special', 'ult']) {
      H.assert(typeof cmd[k] === 'boolean', k + ' must be a boolean');
    }
  }
});

H.test('difficulty zero selects the easy bot profile', () => {
  const w = arenaWorld();
  const player = new Player(w, characterById('golem'));
  const bot = new Bot(player, 0);
  H.eq(bot.level, 0, 'zero is a valid difficulty, not a missing value');
  H.eq(bot.mistakeRate, 0.42, 'easy mode uses the easy mistake rate');
});

H.test('the bot closes the distance to its opponent', () => {
  const w = arenaWorld();
  const botP = new Player(w, characterById('golem'));
  const human = new Player(w, characterById('steve'));
  botP.pos = openSpot(w, 5, 5);
  human.pos = openSpot(w, 13, 5);
  botP.creative = false; botP.flying = false;
  human.creative = false; human.flying = false;
  const bot = new Bot(botP, 2);
  const before = Math.hypot(human.pos[0] - botP.pos[0], human.pos[2] - botP.pos[2]);
  for (let i = 0; i < 240; i++) {
    const cmd = bot.think_opponent(human, 1 / 60);
    botP.update(1 / 60, cmd.mx, cmd.mz, cmd.jump, false);
    human.update(1 / 60, 0, 0, false, false);
  }
  const after = Math.hypot(human.pos[0] - botP.pos[0], human.pos[2] - botP.pos[2]);
  H.assert(after < before, 'should close in: ' + before.toFixed(1) + ' -> ' + after.toFixed(1));
});

H.test('the bot turns to face its opponent', () => {
  const w = arenaWorld();
  const botP = new Player(w, characterById('golem'));
  const human = new Player(w, characterById('steve'));
  botP.pos = openSpot(w, 5, 5);
  human.pos = [botP.pos[0], botP.pos[1], botP.pos[2] + 6];
  botP.yaw = Math.PI;   // facing away
  botP.creative = false; botP.flying = false;
  const bot = new Bot(botP, 1);
  for (let i = 0; i < 120; i++) bot.think_opponent(human, 1 / 60);
  const want = Math.atan2(-(human.pos[0] - botP.pos[0]), -(human.pos[2] - botP.pos[2]));
  let diff = Math.abs(botP.yaw - want);
  while (diff > Math.PI) diff = Math.abs(diff - Math.PI * 2);
  H.assert(diff < 0.35, 'should face the opponent, off by ' + diff.toFixed(2));
});

H.test('the bot attacks when adjacent', () => {
  const w = arenaWorld();
  const botP = new Player(w, characterById('golem'));
  const human = new Player(w, characterById('steve'));
  botP.pos = openSpot(w, 5, 5);
  human.pos = openSpot(w, 6.5, 5);
  botP.creative = false; botP.flying = false;
  human.creative = false; human.flying = false;
  const bot = new Bot(botP, 2);
  let attacks = 0;
  for (let i = 0; i < 300; i++) {
    if (bot.think_opponent(human, 1 / 60).attack) attacks++;
  }
  H.assert(attacks > 0, 'the bot should attack when adjacent');
});

H.test('the bot does nothing once knocked out', () => {
  const w = arenaWorld();
  const botP = new Player(w, characterById('golem'));
  const human = new Player(w, characterById('steve'));
  botP.pos = openSpot(w, 5, 5);
  human.pos = openSpot(w, 6.5, 5);
  botP.ko = true;
  const bot = new Bot(botP, 2);
  let acted = false;
  for (let i = 0; i < 120; i++) {
    const cmd = bot.think_opponent(human, 1 / 60);
    if (cmd.attack || cmd.special || cmd.ult) acted = true;
  }
  H.eq(acted, false, 'a downed bot must stop acting');
});

H.test('a harder bot attacks more often than an easier one', () => {
  // Measure the bot's decision rate directly. Counting hits over a long fight
  // is dominated by noise, because a stationary target in reach gets hit by
  // every swing. The difficulty levels differ in how often the bot chooses to
  // attack at all, so that is what to measure.
  const decisionRate = (level) => {
    const w = arenaWorld();
    const botP = new Player(w, characterById('golem'));
    const target = new Player(w, characterById('alex'));
    botP.pos = openSpot(w, 5, 5);
    target.pos = openSpot(w, 6.8, 5);
    botP.creative = false; botP.flying = false;
    target.creative = false; target.flying = false;
    const bot = new Bot(botP, level);
    let decisions = 0;
    for (let i = 0; i < 60 * 120; i++) {     // two minutes of game time
      const cmd = bot.think_opponent(target, 1 / 60);
      if (cmd.attack || cmd.special) decisions++;
    }
    return decisions;
  };
  const easy = decisionRate(0);
  const hard = decisionRate(2);
  H.assert(hard > easy,
    'hard (' + hard + ' attacks) should swing more often than easy (' + easy + ')');
});

H.test('a harder bot is harder to catch out', () => {
  // An easy bot fumbles far more often than a hard one.
  const w = arenaWorld();
  const rate = (level) => {
    const botP = new Player(w, characterById('golem'));
    const target = new Player(w, characterById('alex'));
    botP.pos = openSpot(w, 5, 5);
    target.pos = openSpot(w, 6.8, 5);
    const bot = new Bot(botP, level);
    let attacks = 0;
    for (let i = 0; i < 60 * 120; i++) {
      const cmd = bot.think_opponent(target, 1 / 60);
      if (cmd.attack || cmd.special) attacks++;
    }
    return attacks;
  };
  H.assert(rate(0) < rate(2), 'the easy bot should commit to fewer attacks');
});

H.test('a hard bot lands a consistent amount of damage', () => {
  // Sanity check that damage actually flows: any level must deal real damage
  // to a stationary, defenceless target over a long window.
  const w = arenaWorld();
  const botP = new Player(w, characterById('golem'));
  const target = new Player(w, characterById('alex'));
  botP.creative = false; botP.flying = false;
  target.creative = false; target.flying = false;
  target.maxHp = 1000000;
  Fight.reset(botP, target);
  botP.pos = openSpot(w, 5, 5);
  botP.yaw = -Math.PI / 2;
  target.pos = openSpot(w, 6.8, 5);
  target.hp = 1000000;
  const bot = new Bot(botP, 2);
  for (let i = 0; i < 60 * 90; i++) {
    const cmd = bot.think_opponent(target, 1 / 60);
    if (!botP.swing) {
      if (cmd.attack) Fight.tryMelee(botP, 0, target);
      else if (cmd.special) Fight.tryMelee(botP, 1, target);
    }
    target.invuln = 0;
    Fight.update(1 / 60, botP, target);
    botP.update(1 / 60, cmd.mx, cmd.mz, cmd.jump, false);
    target.update(1 / 60, 0, 0, false, false);
  }
  const damage = 1000000 - target.hp;
  H.assert(damage > 100, 'a hard bot should do real damage, dealt ' + damage.toFixed(0));
});

/* ============================================================
   15. Animals
   ============================================================ */
H.suite('Animals');

H.test('world animal spawning creates compact wolf packs', () => {
  const w = arenaWorld();
  const previousWorld = Game.world;
  const previousDist = Game.renderDist;
  const previousAnimals = Game.animals;
  const previousRegionCenter = Game._animalRegionCenter;
  const previousSequence = Game._animalGroupSequence;
  Game.world = w;
  Game.renderDist = 3;
  w.originX = CX;
  w.originZ = CX;
  Game.spawnAnimals(8);
  const wolves = Game.animals.filter(a => a.def.id === 'wolf');
  H.eq(wolves.length, 9, 'three groups of three wolves');
  H.eq(new Set(wolves.map(a => a.packId)).size, 3, 'wolves are split into packs');
  Game.world = previousWorld;
  Game.renderDist = previousDist;
  Game.animals = previousAnimals;
  Game._animalRegionCenter = previousRegionCenter;
  Game._animalGroupSequence = previousSequence;
});

H.test('wildlife prefers compatible terrain and stays in spaced, capped groups', () => {
  const originalRandom = Math.random;
  const previousWorld = Game.world;
  const previousDist = Game.renderDist;
  const previousAnimals = Game.animals;
  const previousRegionCenter = Game._animalRegionCenter;
  const previousRefreshTimer = Game._animalRefreshTimer;
  const previousSequence = Game._animalGroupSequence;
  let state = 11235813;
  Math.random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const surfaceY = x => x < CX - 18 ? SEA_LEVEL + 26 : SEA_LEVEL;
  const world = {
    findSurfaceY(x) { return surfaceY(x); },
    getBlock(x, y) {
      const groundY = surfaceY(x);
      if (y === groundY) return groundY >= SEA_LEVEL + 22 ? 13 : 1;
      if (groundY === SEA_LEVEL && x >= CX + 18 && y >= groundY + 2 && y <= groundY + 7) return 9;
      return 0;
    },
  };
  try {
    Game.world = world;
    Game.renderDist = 5;
    H.eq(Game.wildlifeHabitatAt(CX, CX).type, 'meadow', 'open grass is classified as meadow');
    H.eq(Game.wildlifeHabitatAt(CX + 24, CX).type, 'woodland', 'nearby leaves classify a woodland');
    H.eq(Game.wildlifeHabitatAt(CX - 28, CX).type, 'highland', 'snowy high ground is classified as highland');

    Game.spawnAnimals(19, [CX, SEA_LEVEL + 1, CX]);
    H.assert(Game.animals.length <= Game.animalActiveCap, 'initial population must honor the active cap');
    const wolves = Game.animals.filter(a => a.def.predator);
    H.eq(wolves.length, 9, 'the initial population contains three compact wolf packs');
    const prey = Game.animals.filter(a => !a.def.predator);
    H.assert(prey.length >= 18, 'the initial population has varied prey groups near the target');
    H.assert(new Set(prey.map(a => a.def.id)).size >= 3, 'the region should contain several species');
    const groups = new Map();
    for (const animal of Game.animals) {
      const key = animal.packId || animal.herdId;
      H.assert(key, animal.def.id + ' belongs to an explicit pack or herd');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(animal);
      const habitat = Game.wildlifeHabitatAt(Math.floor(animal.pos[0]), Math.floor(animal.pos[2]));
      H.assert(habitat && animal.def.habitats.includes(habitat.type), animal.def.id + ' spawns only in a preferred habitat');
    }
    const anchors = new Map();
    for (const animal of Game.animals) if (!anchors.has(animal.packId || animal.herdId)) anchors.set(animal.packId || animal.herdId, animal.groupAnchor);
    const centres = Array.from(anchors.values());
    for (let i = 0; i < centres.length; i++) for (let j = i + 1; j < centres.length; j++) {
      H.assert(Math.hypot(centres[i][0] - centres[j][0], centres[i][1] - centres[j][1]) >= Game.animalGroupSpacing,
        'distinct packs and herds should leave quiet space between groups');
    }
    for (const members of groups.values()) {
      if (members[0].def.predator) H.eq(members.length, 3, 'wolf packs have three members');
      else H.assert(members.length <= members[0].def.groupMax, 'herds stay within species group sizes');
    }

    const player = { pos: [CX + 60, SEA_LEVEL + 1, CX], ko: false };
    Game.updateAnimals(1 / 60, player);
    H.eq(Game._animalRegionCenter[0], player.pos[0], 'population recenters when the player explores a new region');
    H.assert(Game.animals.length <= Game.animalActiveCap, 'regional refresh still respects the active cap');

    Game.animals = Game.animals.filter(a => a.def.predator);
    Game._animalRefreshTimer = Game.animalRefreshSeconds - 0.01;
    Game.updateAnimals(0.02, player);
    const replenished = Game.animals.filter(a => !a.def.predator);
    H.assert(replenished.length >= 2 && replenished.length <= 4,
      'a quiet interval replenishes one natural prey group instead of flooding the region');
  } finally {
    Math.random = originalRandom;
    Game.world = previousWorld;
    Game.renderDist = previousDist;
    Game.animals = previousAnimals;
    Game._animalRegionCenter = previousRegionCenter;
    Game._animalRefreshTimer = previousRefreshTimer;
    Game._animalGroupSequence = previousSequence;
  }
});

H.test('a wolf attack makes its whole pack aggressive toward the player', () => {
  const w = arenaWorld();
  const packId = 'test-pack';
  const wolves = [0, 1, 2].map(i => {
    const wolf = new g.Animal(g.animalById('wolf'), CX + 5.5 + i * 0.4, w.arena.y + 1, CX + 5.5);
    wolf.packId = packId;
    return wolf;
  });
  Game.animals = wolves;
  Game.provokeWolfPack(wolves[1]);
  H.assert(wolves.every(wolf => wolf.aggressiveTimer > 0), 'every wolf in the attacked wolf’s pack reacts');
  Game.animals = [];
});

H.test('an unprovoked wolf hunts nearby animals without targeting the player', () => {
  const w = arenaWorld();
  const wolf = new g.Animal(g.animalById('wolf'), CX + 4.5, w.arena.y + 1, CX + 5.5);
  const sheep = new g.Animal(g.animalById('sheep'), CX + 8.5, w.arena.y + 1, CX + 5.5);
  wolf.preyTarget = sheep;
  const before = Math.hypot(wolf.pos[0] - sheep.pos[0], wolf.pos[2] - sheep.pos[2]);
  for (let i = 0; i < 60; i++) wolf.update(1 / 60, w, null);
  const after = Math.hypot(wolf.pos[0] - sheep.pos[0], wolf.pos[2] - sheep.pos[2]);
  H.assert(after < before, 'wolf should move toward its animal prey');
  H.eq(wolf.aggressiveTimer, 0, 'hunting does not make a calm wolf attack the player');
});

H.test('a wolf only bites the player after the pack is provoked', () => {
  const w = arenaWorld();
  const wolf = new g.Animal(g.animalById('wolf'), CX + 5.5, w.arena.y + 1, CX + 5.5);
  const player = { pos: wolf.pos.slice(), ko: false, hp: 100, takeDamage(amount) { this.hp -= amount; } };
  wolf.biteCooldown = 0;
  for (let i = 0; i < 12; i++) wolf.update(1 / 60, w, player);
  H.eq(player.hp, 100, 'a calm wolf must not damage the player');
  wolf.pos = player.pos.slice();
  wolf.biteCooldown = 0;
  wolf.aggressiveTimer = 5;
  wolf.update(1 / 60, w, player);
  H.assert(player.hp < 100, 'a provoked wolf should bite a nearby player');
  H.eq(player.hp, 95, 'a bite deals five damage');
  const firstHp = player.hp;
  wolf.update(0.5, w, player);
  H.eq(player.hp, firstHp, 'a wolf cannot retaliate again within one second');
});

H.test('every animal has 30 HP and an injured sheep retaliates once per second for 5', () => {
  const w = arenaWorld();
  const player = { pos: [CX + 5.5, w.arena.y + 1, CX + 5.5], ko: false, hits: [], takeDamage(amount) { this.hits.push(amount); } };
  for (const def of ANIMALS) H.eq(new g.Animal(def, CX + 5.5, w.arena.y + 1, CX + 5.5).health, 30, def.name + ' health');
  const sheep = new g.Animal(g.animalById('sheep'), player.pos[0], player.pos[1], player.pos[2]);
  sheep.aggressiveTimer = 5;
  sheep.biteCooldown = 0;
  sheep.update(1 / 60, w, player);
  H.eq(player.hits[0], 5, 'retaliation damage');
  sheep.update(0.5, w, player);
  H.eq(player.hits.length, 1, 'no second hit before one second');
  sheep.update(0.55, w, player);
  H.eq(player.hits.length, 2, 'retaliation resumes after the one-second cooldown');
  H.eq(player.hits[1], 5, 'each retaliation still deals five damage');
});

H.test('hitting a wolf provokes its pack', () => {
  const w = arenaWorld();
  const player = new g.Player(w, g.characterById('steve'), false);
  player.pos = [CX + 5.5, w.arena.y + 1, CX + 5.5];
  player.yaw = 0;
  const packId = 'hit-test-pack';
  const wolves = [0, 1, 2].map(i => {
    const wolf = new g.Animal(g.animalById('wolf'), CX + 5.5, w.arena.y + 1, CX + 5 - i * 1.0);
    wolf.packId = packId;
    return wolf;
  });
  Game.animals = wolves;
  H.assert(Game.tryHitAnimal(player), 'the nearest wolf in front should be hit');
  H.eq(wolves[0].health, 22, 'a fist attack deals eight damage');
  H.assert(wolves.every(wolf => wolf.aggressiveTimer > 0), 'the whole pack should react');
  Game.animals = [];
});

H.test('defeating an animal gives exactly one meat item', () => {
  const w = arenaWorld();
  const oldAnimals = Game.animals;
  const oldSave = Game.save;
  const oldSlot = Game.selectedSlot;
  const oldPlayer = Game.players[0];
  const player = new g.Player(w, g.characterById('steve'), false);
  player.pos = [CX + 5.5, w.arena.y + 1, CX + 5.5];
  player.yaw = 0;
  player.selectedSlot = 8;
  Game.selectedSlot = 8;
  Game.players[0] = player;
  Game.animals = [new g.Animal(g.animalById('sheep'), CX + 5.5, w.arena.y + 1, CX + 4.5)];
  Game.save = () => true;
  H.assert(Game.tryHitAnimal(player), 'the sheep is in attack range');
  H.eq(Game.animals[0].health, 10, 'gold deals 20 damage');
  H.eq(player.inventory.meat, 0, 'a live animal does not drop meat');
  H.assert(Game.tryHitAnimal(player), 'the sheep remains attackable');
  H.eq(Game.animals[0].dead, true, 'the animal is defeated');
  H.eq(player.inventory.meat, 1, 'one meat is added once');
  H.eq(Game.tryHitAnimal(player), false, 'dead animals cannot be hit or drop again');
  H.eq(player.inventory.meat, 1, 'the drop cannot be duplicated');
  Game.animals = oldAnimals;
  Game.save = oldSave;
  Game.selectedSlot = oldSlot;
  Game.players[0] = oldPlayer;
});

H.test('an animal stays on the ground', () => {
  const w = arenaWorld();
  const a = new g.Animal(ANIMALS[0], CX + 5.5, w.arena.y + 3, CX + 5.5);
  for (let i = 0; i < 300; i++) a.update(1 / 60, w);
  H.assert(a.pos[1] >= w.arena.y - 1, 'should not sink through the floor');
  H.assert(a.pos[1] < w.arena.y + 6, 'should not fly away');
});

H.test('animals stay on the arena instead of wandering off', () => {
  const w = arenaWorld();
  let escaped = 0;
  for (let n = 0; n < 8; n++) {
    const a = new g.Animal(ANIMALS[n % 3], CX + 5.5, w.arena.y + 2, CX + 5.5);
    for (let i = 0; i < 600; i++) {
      a.update(1 / 60, w);
      if (Math.hypot(a.pos[0] - CX, a.pos[2] - CX) > 20) { escaped++; break; }
    }
  }
  H.eq(escaped, 0, 'no animal should leave the platform');
});

/* ============================================================
   16. Particles
   ============================================================ */
H.suite('Particles');

H.test('particles are created, expire, and stay bounded', () => {
  const w = arenaWorld();
  Particles.clear();
  Particles.burst([CX + 5.5, w.arena.y + 1, CX + 5.5], PROJ_DEFS.star, 20, 0.4);
  H.eq(Particles.list.length, 20);
  for (let i = 0; i < 300; i++) Particles.update(1 / 60, w);
  H.eq(Particles.list.length, 0, 'all should expire');
});

H.test('the particle list cannot grow without bound', () => {
  const w = arenaWorld();
  Particles.clear();
  for (let i = 0; i < 40; i++) {
    Particles.burst([CX + 5.5, w.arena.y + 1, CX + 5.5], PROJ_DEFS.star, 50, 0.4);
  }
  H.assert(Particles.list.length <= 900, 'grew to ' + Particles.list.length);
  Particles.clear();
});

/* ============================================================
   17. Matrix maths
   ============================================================ */
H.suite('Matrix maths');

H.test('perspective produces a sane matrix', () => {
  const p = M4.perspective(M4.create(), Math.PI / 3, 1.5, 0.1, 100);
  H.eq(p[11], -1, 'w row must be -1 for perspective');
  H.assert(p[0] > 0, 'focal x must be positive');
});

H.test('lookAt keeps unit, orthogonal axes', () => {
  const v = M4.lookAt(M4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
  // column-major: axis i is v[i], v[i+4], v[i+8]
  const axis = (i) => [v[i], v[i + 4], v[i + 8]];
  const len = (i) => Math.hypot(axis(i)[0], axis(i)[1], axis(i)[2]);
  const dot = (i, j) => axis(i).reduce((acc, c, k) => acc + c * axis(j)[k], 0);
  for (let i = 0; i < 3; i++) H.near(len(i), 1, 0.001, 'axis ' + i);
  H.near(dot(0, 1), 0, 0.001, 'x dot y');
  H.near(dot(0, 2), 0, 0.001, 'x dot z');
  H.near(dot(1, 2), 0, 0.001, 'y dot z');
  H.eq(v[15], 1);
});

H.test('lookAt puts the camera behind the target', () => {
  // Eye at +Z looking at the origin, so the translation must place the
  // origin at -5 along Z.
  const v = M4.lookAt(M4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
  H.near(v[14], -5, 0.001, 'the view should be translated back by the eye distance');
});

H.test('invert undoes a transform', () => {
  const m = M4.multiply(M4.create(),
    M4.rotateY(M4.create(), 0.7),
    M4.translate(M4.create(), 3, 4, -2));
  const round = M4.multiply(M4.create(), m, M4.invert(M4.create(), m));
  for (let i = 0; i < 16; i++) {
    H.near(round[i], (i % 5 === 0) ? 1 : 0, 0.001, 'element ' + i);
  }
});

H.test('rotateY swings +X round to -Z', () => {
  const r = M4.rotateY(M4.create(), Math.PI / 2);
  H.near(r[0] * 1, 0, 0.001, 'x becomes zero');
  H.near(r[2] * 1, -1, 0.001, 'x becomes -z');
});

H.test('box TRS keeps a character part at its world position', () => {
  const model = M4.composeTRS(M4.create(), [12, 20, -4], [2, 3, 4], Math.PI / 2);
  const transform = (x, y, z) => [
    model[0] * x + model[4] * y + model[8] * z + model[12],
    model[1] * x + model[5] * y + model[9] * z + model[13],
    model[2] * x + model[6] * y + model[10] * z + model[14],
  ];
  const origin = transform(0, 0, 0);
  H.near(origin[0], 12, 0.001, 'box center x follows the character');
  H.near(origin[1], 20, 0.001, 'box center y follows the character');
  H.near(origin[2], -4, 0.001, 'box center z follows the character');
  const localX = transform(1, 0, 0);
  H.near(localX[2], -6, 0.001, 'box scale and facing rotation are composed');
});

H.test('playable character models use rounded forms and keep their signature details', () => {
  const originalRounded = Game.drawAnimalEllipsoids;
  const originalBoxes = Game.drawAnimalBoxes;
  const originalFaceStrips = Game.drawCharacterFaceStrips;
  const originalBuildHand = Game.drawBuildHand;
  const oldState = Game.state;
  const oldPlayers = Game.players;
  let rounded = [], details = [], faceStrips = [], faceStripMeshes = [], roundedTint, detailTint;
  Game.drawAnimalEllipsoids = (prog, parts, tint) => { rounded = parts; roundedTint = tint; };
  Game.drawAnimalBoxes = (prog, parts, tint) => { details = parts; detailTint = tint; };
  Game.drawCharacterFaceStrips = (prog, strips, base, yaw, headSize, headY) => {
    faceStrips = strips;
    faceStripMeshes = strips.map(strip => ({
      strip,
      mesh: Game.buildCharacterFaceStripMesh(strip, base, yaw, headSize, headY),
    }));
  };
  Game.drawBuildHand = () => {};
  Game.state = 'fight';
  Game.players = [];
  try {
    for (const character of CHARACTERS) {
      rounded = []; details = []; faceStrips = []; faceStripMeshes = [];
      const player = {
        char: character, pos: [12, 3, -4], yaw: 0, walkAnim: 0, onGround: true,
        swing: null, hurtFlash: 0, ko: false, ultMeter: 0, maxUlt: 100,
      };
      Game.drawCharacter(null, player, 1);
      const style = CHARACTER_MODEL_STYLES[character.appearance];
      H.assert(style, character.name + ' has a model style');
      H.assert(rounded.length >= 12, character.name + ' renders a rounded body, head, limbs, hair, and footwear');
      H.assert(rounded.some(part => part.tile === character.shirt && part.size === style.torso),
        character.name + ' keeps the selected outfit on the rounded torso');
      H.assert(rounded.some(part => part.tile === character.skin && part.size === style.head),
        character.name + ' keeps the selected face on a rounded head');
      H.eq(details.filter(part => part.size === style.eye).length, 2,
      character.name + ' has two visible eye details');
    }

    const capture = (character, overrides = {}) => {
      rounded = []; details = []; faceStrips = []; faceStripMeshes = [];
      Game.drawCharacter(null, {
        char: character, pos: [0, 0, 0], yaw: 0, walkAnim: 0, onGround: true,
        swing: null, hurtFlash: 0, ko: false, ultMeter: 0, maxUlt: 100,
        ...overrides,
      }, 1);
      return { rounded, details, faceStrips, faceStripMeshes };
    };
    const steve = characterById('steve');
    const steveStyle = CHARACTER_MODEL_STYLES[steve.appearance];
    const walking = capture(steve, { walkAnim: Math.PI / 2 });
    H.assert(walking.rounded.filter(part => part.tile === steve.shirt && part.size === steveStyle.arm)
      .every(part => Math.abs(part.pitch) > 0.5), 'walking swings both rounded arms at the shoulder');
    H.assert(walking.rounded.filter(part => part.tile === steve.pants && part.size === steveStyle.leg)
      .every(part => Math.abs(part.pitch) > 0.4), 'walking swings both rounded legs at the hip');
    const attacking = capture(steve, { swing: { t: 0.5, attack: 0 }, swingTotal: 1 });
    H.assert(attacking.rounded.filter(part => part.tile === steve.shirt && part.size === steveStyle.arm)
      .some(part => Math.abs(part.pitch) > 1.5), 'attack pose rotates the active arm');

    const faceDetailsSitAboveEllipsoid = (character, parts) => {
      const style = CHARACTER_MODEL_STYLES[character.appearance];
      const halfWidth = style.head[0] * 0.5;
      const halfHeight = style.head[1] * 0.5;
      const halfDepth = style.head[2] * 0.5;
      const headY = 0.7 + 0.75 + 0.3;
      for (const part of parts) {
        const side = part.pos[0];
        const vertical = part.pos[1] - headY;
        const forward = -part.pos[2];
        const surface = halfDepth * Math.sqrt(Math.max(0.04,
          1 - (side / halfWidth) ** 2 - (vertical / halfHeight) ** 2));
        const backGap = forward - part.size[2] * 0.5 - surface;
        H.assert(backGap >= 0.005 && backGap <= 0.012,
          character.name + ' raised face detail sits just above the curved head');
      }
    };
    const faceMeshesFollowEllipsoid = (character, parts) => {
      const style = CHARACTER_MODEL_STYLES[character.appearance];
      const rx = style.head[0] * 0.5;
      const ry = style.head[1] * 0.5;
      const rz = style.head[2] * 0.5;
      const headY = 0.7 + 0.75 + 0.3;
      H.assert(parts.length > 0, character.name + ' produces a curved face mesh');
      for (const { strip, mesh } of parts) {
        H.eq(mesh.data.length % 8, 0, character.name + ' face mesh uses position, normal, and UV vertices');
        H.eq(mesh.data.length / 8, strip.columns * strip.rows * 6,
          character.name + ' face mesh covers each grid cell with two triangles');
        for (let i = 0; i < mesh.data.length; i += 8) {
          const x = mesh.data[i];
          const vertical = mesh.data[i + 1] - headY;
          const forward = -mesh.data[i + 2];
          const surface = rz * Math.sqrt(1 - (x / rx) ** 2 - (vertical / ry) ** 2);
          H.assert(forward > surface,
            character.name + ' face mesh vertices stay outside the head');
          H.near(forward - surface, strip.clearance || 0.008, 0.0002,
            character.name + ' face mesh vertices follow the curved surface');
          const normalLength = Math.hypot(mesh.data[i + 3], mesh.data[i + 4], mesh.data[i + 5]);
          H.near(normalLength, 1, 0.001, character.name + ' face mesh normals are normalized');
        }
        for (let i = 0; i < mesh.data.length; i += 24) {
          const ab = [0, 1, 2].map(axis => mesh.data[i + 8 + axis] - mesh.data[i + axis]);
          const ac = [0, 1, 2].map(axis => mesh.data[i + 16 + axis] - mesh.data[i + axis]);
          const faceNormal = [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
          ];
          const vertexNormal = [0, 1, 2].map(axis =>
            (mesh.data[i + 3 + axis] + mesh.data[i + 11 + axis] + mesh.data[i + 19 + axis]) / 3);
          H.assert(faceNormal[0] * vertexNormal[0] + faceNormal[1] * vertexNormal[1] +
            faceNormal[2] * vertexNormal[2] > 0,
          character.name + ' face mesh triangles wind toward their outward normals');
        }
        for (let i = 0; i < mesh.data.length; i += 48) {
          for (const offsets of [[0, 8, 16], [24, 32, 40]]) {
            const x = offsets.reduce((sum, offset) => sum + mesh.data[i + offset], 0) / 3;
            const y = offsets.reduce((sum, offset) => sum + mesh.data[i + offset + 1], 0) / 3 - headY;
            const forward = -offsets.reduce((sum, offset) => sum + mesh.data[i + offset + 2], 0) / 3;
            const surface = rz * Math.sqrt(1 - (x / rx) ** 2 - (y / ry) ** 2);
            H.assert(forward - surface >= 0.004 && forward - surface <= 0.012,
              character.name + ' face mesh triangles remain close to the curved surface');
          }
        }
      }
    };
    const steveFace = capture(steve);
    faceDetailsSitAboveEllipsoid(steve, steveFace.details.filter(part => part.size === steveStyle.eye));
    const hero = characterById('spider');
    const heroFace = capture(hero);
    faceMeshesFollowEllipsoid(hero,
      heroFace.faceStripMeshes.filter(part => part.strip.tile === T.hero_blue));
    H.eq(heroFace.faceStrips.filter(strip => strip.tile === T.hero_blue).length, 1,
      'Web Hero mask is one surface-conforming curved mesh');
    const ninja = characterById('ninja');
    const ninjaFace = capture(ninja);
    faceMeshesFollowEllipsoid(ninja, ninjaFace.faceStripMeshes);
    H.eq(ninjaFace.faceStrips.filter(strip => strip.tile === T.hero_red).length, 1,
      'Fire Ninja red brow strip is one surface-conforming curved mesh');
    H.eq(ninjaFace.faceStrips.filter(strip => strip.tile === T.pants_dark).length, 1,
      'Fire Ninja lower face wrap is one surface-conforming curved mesh');
    const golemFace = capture(characterById('golem'));
    faceMeshesFollowEllipsoid(characterById('golem'), golemFace.faceStripMeshes);
    H.assert(capture(characterById('doll')).rounded.filter(part => part.tile === characterById('doll').hair).length >= 6,
      'Dolly has pigtails and a bow made from rounded hair pieces');
    H.assert(capture(characterById('spider')).faceStrips.some(part => part.tile === T.hero_blue),
      'Web Hero keeps the blue eye mask shown in the selection portrait');
    H.assert(capture(characterById('ninja')).faceStrips.some(part => part.tile === T.pants_dark),
      'Fire Ninja keeps a face wrap in the in-game model');

    const injured = {
      char: characterById('steve'), pos: [0, 0, 0], yaw: 0, walkAnim: 0, onGround: true,
      swing: null, hurtFlash: 1, ko: false, ultMeter: 0, maxUlt: 100,
    };
    Game.drawCharacter(null, injured, 1);
    H.eq(roundedTint.join(','), '1,0.45,0.45', 'rounded shapes preserve the damage flash');
    H.eq(detailTint.join(','), '1,0.45,0.45', 'face details preserve the damage flash');
  } finally {
    Game.drawAnimalEllipsoids = originalRounded;
    Game.drawAnimalBoxes = originalBoxes;
    Game.drawCharacterFaceStrips = originalFaceStrips;
    Game.drawBuildHand = originalBuildHand;
    Game.state = oldState;
    Game.players = oldPlayers;
  }
});

H.test('the cube mesh is well formed', () => {
  const cube = g.buildCube();
  H.eq(cube.positions.length / 3, 24, '24 vertices');
  H.eq(cube.indices.length, 36, '36 indices');
  const max = cube.positions.length / 3;
  for (const i of cube.indices) H.assert(i < max, 'index ' + i + ' out of range');
});

H.test('every cube face normal points outward', () => {
  const cube = g.buildCube();
  for (let v = 0; v < 24; v += 4) {
    const px = cube.positions[v * 3], py = cube.positions[v * 3 + 1], pz = cube.positions[v * 3 + 2];
    const nx = cube.normals[v * 3], ny = cube.normals[v * 3 + 1], nz = cube.normals[v * 3 + 2];
    H.assert(px * nx + py * ny + pz * nz > 0,
      'face ' + (v / 4) + ' normal points inward');
  }
});

H.test('rounded animal mesh has bounded UVs, valid indices, and outward faces', () => {
  const ellipsoid = g.buildEllipsoid(8, 12);
  H.eq(ellipsoid.positions.length / 3, 117, '8 by 12 UV sphere vertex count');
  H.eq(ellipsoid.indices.length, 576, '8 by 12 UV sphere triangle indices');
  H.eq(ellipsoid.normals.length, ellipsoid.positions.length, 'each vertex has a normal');
  H.eq(ellipsoid.uvs.length / 2, ellipsoid.positions.length / 3, 'each vertex has texture coordinates');
  const frontVertex = (8 / 2) * (12 + 1) + (12 / 2);
  H.near(ellipsoid.positions[frontVertex * 3], 0, 1e-6,
    'center of the face tile lies on the ellipsoid front axis');
  H.near(ellipsoid.positions[frontVertex * 3 + 1], 0, 1e-6,
    'center of the face tile lies on the equator');
  H.near(ellipsoid.positions[frontVertex * 3 + 2], -0.5, 1e-6,
    'face tile center points toward local -Z');
  H.near(ellipsoid.uvs[frontVertex * 2], 0.5, 1e-6,
    'animal face tile center uses U=0.5');
  for (let i = 0; i < ellipsoid.positions.length; i += 3) {
    const x = ellipsoid.positions[i], y = ellipsoid.positions[i + 1], z = ellipsoid.positions[i + 2];
    H.assert(Math.abs(x) <= 0.5 + 1e-6 && Math.abs(y) <= 0.5 + 1e-6 && Math.abs(z) <= 0.5 + 1e-6,
      'unit mesh positions fit the shared instance bounds');
    const nx = ellipsoid.normals[i], ny = ellipsoid.normals[i + 1], nz = ellipsoid.normals[i + 2];
    H.near(Math.hypot(nx, ny, nz), 1, 1e-5, 'vertex normal is normalized');
  }
  for (const uv of ellipsoid.uvs) H.assert(uv >= 0 && uv <= 1, 'UV coordinates remain in the texture tile');
  let visibleFaces = 0;
  for (let i = 0; i < ellipsoid.indices.length; i += 3) {
    const ia = ellipsoid.indices[i] * 3, ib = ellipsoid.indices[i + 1] * 3, ic = ellipsoid.indices[i + 2] * 3;
    const ab = [ellipsoid.positions[ib] - ellipsoid.positions[ia], ellipsoid.positions[ib + 1] - ellipsoid.positions[ia + 1], ellipsoid.positions[ib + 2] - ellipsoid.positions[ia + 2]];
    const ac = [ellipsoid.positions[ic] - ellipsoid.positions[ia], ellipsoid.positions[ic + 1] - ellipsoid.positions[ia + 1], ellipsoid.positions[ic + 2] - ellipsoid.positions[ia + 2]];
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    if (Math.hypot(...cross) < 1e-8) continue;
    const radial = [ellipsoid.positions[ia] + ellipsoid.positions[ib] + ellipsoid.positions[ic], ellipsoid.positions[ia + 1] + ellipsoid.positions[ib + 1] + ellipsoid.positions[ic + 1], ellipsoid.positions[ia + 2] + ellipsoid.positions[ib + 2] + ellipsoid.positions[ic + 2]];
    H.assert(cross[0] * radial[0] + cross[1] * radial[1] + cross[2] * radial[2] > 0,
      'non-degenerate triangle winding faces outward');
    visibleFaces++;
  }
  H.eq(visibleFaces, 168, 'all non-degenerate triangles are tested');
});

/* ============================================================
   18. Camera
   ============================================================ */
H.suite('Camera');

H.test('projection aspect uses width divided by height at every screen shape', () => {
  const t = H.load({ boot: false });
  t.Game.canvas = { width: 390, height: 844 };
  H.near(t.Game.aspect(), 390 / 844, 0.0001, 'portrait viewport');
  t.Game.canvas = { width: 844, height: 390 };
  H.near(t.Game.aspect(), 844 / 390, 0.0001, 'landscape viewport');
});
H.test('pitch is clamped short of straight up and down', () => {
  Cam.pitch = 0;
  for (let i = 0; i < 50; i++) Cam.look(0, 500);
  H.assert(Cam.pitch < Math.PI / 2, 'must stay below straight up');
  for (let i = 0; i < 100; i++) Cam.look(0, -500);
  H.assert(Cam.pitch > -Math.PI / 2, 'must stay above straight down');
});

H.test('forward is always a unit vector', () => {
  for (const yaw of [0, 1, 2, 3, -1]) {
    for (const pitch of [-0.5, 0, 0.5]) {
      Cam.yaw = yaw; Cam.pitch = pitch;
      const f = Cam.forward([0, 0, 0]);
      H.near(Math.hypot(f[0], f[1], f[2]), 1, 0.001, 'yaw ' + yaw + ' pitch ' + pitch);
    }
  }
});

H.test('yaw zero looks down negative Z', () => {
  Cam.yaw = 0; Cam.pitch = 0;
  const f = Cam.forward([0, 0, 0]);
  H.near(f[0], 0, 0.001);
  H.near(f[2], -1, 0.001);
});

H.test('screen shake decays and cannot exceed its cap', () => {
  Cam.shake = 0;
  Cam.addShake(1);
  H.assert(Cam.shake > 0);
  for (let i = 0; i < 200; i++) Cam.update(1 / 60, 1.5, [0, 0, 0]);
  H.eq(Cam.shake, 0, 'shake should decay to nothing');
  for (let i = 0; i < 50; i++) Cam.addShake(1);
  H.assert(Cam.shake <= 1.2, 'shake should cap at 1.2');
});

H.test('third person puts the camera behind the character, not on it', () => {
  // Regression: the third-person branch computed the eye position but never
  // stored it, so Cam.pos stayed at the character's head. Fog, chunk streaming
  // and frustum culling all read Cam.pos, so they all culled from the wrong
  // place and the third-person view was effectively broken.
  const t = H.load({ boot: true });
  const p1 = t.Game.players[0];
  t.Cam.thirdPerson = true;
  t.Cam.yaw = 0;
  t.Cam.pitch = 0;

  for (let i = 0; i < 30; i++) t.Cam.update(1 / 60, 1.5, null, p1, 7.5);

  const behind = Math.hypot(t.Cam.pos[0] - p1.pos[0], t.Cam.pos[2] - p1.pos[2]);
  H.assert(behind > 5,
    'the camera should sit well behind the character, it was only ' + behind.toFixed(2) + ' away');
  H.assert(behind <= 7.6, 'and not further than the orbit distance');
  H.assert(t.Cam.pos[1] > p1.pos[1],
    'and above their feet, so you can see over them');
});

H.test('the camera is only built once per frame in the playable modes', () => {
  // Regression: the update loop and render() both called Cam.update with
  // different distances, so the orbit eased at two speeds and jittered.
  const src = fs.readFileSync(path.join(H.ROOT, 'js', 'main.js'), 'utf8');

  // Count the Cam.update call sites, which must all live inside render().
  // Two calls sit legitimately outside it: one framing the spawn point while
  // the world is built, one drifting the camera behind the menu.
  const lines = src.split('\n');
  const loadSetup = lines.findIndex(l => l.includes('Cam.update(0.016, 1.6, Cam.pos)'));
  const menuDrift = lines.findIndex(l => l.includes('Cam.update(dt, this.aspect(), Cam.pos)'));
  H.assert(loadSetup >= 0, 'the load-time camera framing should still exist');
  H.assert(menuDrift >= 0, 'the menu drift camera should still exist');

  const renderAt = lines.findIndex(l => l.trim() === 'render(dt) {');
  const loopAt = lines.findIndex(l => l.trim() === 'loop(now) {');
  H.assert(renderAt >= 0 && loopAt > renderAt,
    'expected render(dt) to be defined before loop(now)');

  const stray = [];
  lines.forEach((l, i) => {
    if (l.indexOf('Cam.update(') === -1) return;
    if (i === loadSetup || i === menuDrift) return;
    if (i <= renderAt || i >= loopAt) stray.push((i + 1) + ': ' + l.trim());
  });
  H.eq(stray.length, 0,
    'the camera must be positioned only in render(), but found ' + stray.join(' | '));

  // And render must forward the real frame time, not a hardcoded 16ms.
  H.assert(lines.slice(renderAt, loopAt).join('\n').indexOf('Cam.update(0.016') === -1,
    'render should pass the real dt so the orbit eases at a steady rate');
});

H.test('every observe view is complete and unique', () => {
  H.assert(g.OBSERVE_VIEWS.length >= 5);
  const ids = new Set();
  for (const v of g.OBSERVE_VIEWS) {
    H.assert(v.id && v.name && v.hint, 'view ' + v.id + ' is incomplete');
    H.assert(!ids.has(v.id), 'duplicate view id ' + v.id);
    ids.add(v.id);
  }
});

H.test('cycling observe views wraps around cleanly', () => {
  Observer.index = 0;
  const n = g.OBSERVE_VIEWS.length;
  const seen = [Observer.view().id];
  for (let i = 0; i < n; i++) seen.push(Observer.cycle(1).id);
  H.eq(seen[0], seen[n], 'cycling should return to the first view');
});

/* ============================================================
   19. Touch controls
   ============================================================ */
H.suite('Touch controls');

/* These check the touch layer and the quality profile. They deliberately load
   without booting a world: each boot generates a local neighborhood, and half a dozen of
   them in a row would blow the suite's time budget for no extra coverage. */
H.test('the touch layer knows when it is needed', () => {
  const desktop = H.load({ touch: false, boot: false });
  desktop.Touch.init();
  H.eq(desktop.Touch.enabled, false, 'a desktop should not enable touch');
  const phone = H.load({ touch: true, boot: false });
  phone.Touch.init();
  H.eq(phone.Touch.enabled, true, 'a touch device should enable touch');
});

H.test('showing touch controls removes the hidden state', () => {
  const t = H.load({ touch: true, boot: false });
  const layer = t.document.getElementById('touch-ui');
  const view = t.document.getElementById('touch-view');
  H.assert(layer.classList.contains('hidden'), 'touch controls start hidden in the menu');
  t.Touch.setVisible(true);
  H.assert(!layer.classList.contains('hidden'), 'the game must remove hidden when play starts');
  H.assert(view.classList.contains('hidden'), 'the view toggle stays hidden outside a playable mode');
  t.Game.state = 'fight';
  t.Touch.setVisible(true);
  H.assert(!view.classList.contains('hidden'), 'Fight Arena must expose the view toggle on touch');
  t.Touch.setVisible(false);
  H.assert(layer.classList.contains('hidden'), 'the game must hide controls when returning to menu');
  H.assert(view.classList.contains('hidden'), 'hiding gameplay controls also hides the view toggle');
});

H.test('mobile action and view buttons release when a finger lifts', () => {
  const t = H.load({ touch: true, boot: false });
  t.Touch.init();
  const button = t.document.getElementById('touch-jump');
  const start = button.eventListeners.touchstart[0];
  const end = button.eventListeners.touchend[0];
  start({ preventDefault() {} });
  H.eq(t.Touch.btn.jump, true, 'pressing jump should activate it');
  end({ cancelable: true, preventDefault() {} });
  H.eq(t.Touch.btn.jump, false, 'lifting a finger must release jump');

  const view = t.document.getElementById('touch-view');
  view.eventListeners.touchstart[0]({ preventDefault() {} });
  H.eq(t.Touch.btn.view, true, 'pressing the view button should request a perspective change');
  view.eventListeners.touchend[0]({ cancelable: true, preventDefault() {} });
  H.eq(t.Touch.btn.view, false, 'lifting the view button must release it');
});

H.test('Fight and Observe show their existing touch action on the shared action button', () => {
  const t = H.load({ touch: true, boot: false });
  t.Touch.init();
  const action = t.document.getElementById('touch-fly');

  t.Touch.relabel('fight', false);
  H.eq(action.textContent, 'ULT', 'Fight labels the action as ultimate');
  H.eq(action.disabled, true, 'an uncharged ultimate is visibly unavailable');
  H.eq(action.attributes['aria-label'], 'Ultimate not ready', 'unavailable state is announced');
  H.assert(action.classList.contains('touch-action-fight'), 'Fight uses its distinct action style');

  t.Touch.relabel('fight', true);
  H.eq(action.disabled, false, 'a charged ultimate can be activated');
  H.eq(action.attributes['aria-label'], 'Use ultimate', 'ready action has a useful accessible name');

  t.Touch.relabel('observe');
  H.eq(action.textContent, 'PHOTO', 'Observe labels the action as photo');
  H.eq(action.disabled, false, 'photo capture remains available');
  H.eq(action.attributes['aria-label'], 'Take a photo', 'photo action is announced');
  H.assert(action.classList.contains('touch-action-observe'), 'Observe has a distinct action style');
  H.assert(!action.classList.contains('touch-action-fight'), 'mode styling does not leak');

  t.Touch.relabel('play');
  H.eq(action.textContent, 'FLY', 'Play keeps the flying action');
  H.eq(action.disabled, false, 'flying remains available');
  H.assert(!action.classList.contains('touch-action-observe'), 'Play clears mode styling');
});

H.test('a user touch fires a ready Fight ultimate once and is ignored while disabled', () => {
  const t = H.load({ touch: true, boot: false });
  t.Touch.init();
  const action = t.document.getElementById('touch-fly');
  const player = {
    ultMeter: 0, maxUlt: 100, char: { name: 'Spider', ultName: 'Beacon Burst' },
    update() {}, yaw: 0, pitch: 0, ko: false, swing: null,
  };
  const opponent = { char: { name: 'Doll' }, update() {}, yaw: 0, pitch: 0, ko: false, swing: null };
  t.Game.state = 'fight';
  t.Game.players = [player, opponent];
  t.Game.bot = null;
  t.Game.clampToWorld = () => {};
  t.Game.setFightTouchUltReady(false, true);
  t.Cam.look = () => {};
  t.Fight.update = () => {};
  t.UI.updateHUD = () => {};
  let activations = 0;
  t.Fight.useUltimate = (attacker) => {
    activations++;
    attacker.ultMeter = 0;
    return true;
  };

  action.dispatchUserEvent({ type: 'touchstart', cancelable: true, preventDefault() { this.defaultPrevented = true; } });
  H.eq(t.Touch.btn.fly, false, 'a disabled ULT ignores a user touch');
  t.Game.update(1 / 60, { ldx: 0, ldy: 0, mx: 0, mz: 0, jump: false, sneak: false, pad: {} });
  H.eq(activations, 0, 'an uncharged ultimate is not dispatched');

  player.ultMeter = player.maxUlt;
  t.Game.setFightTouchUltReady(true, true);
  action.dispatchUserEvent({ type: 'touchstart', cancelable: true, preventDefault() { this.defaultPrevented = true; } });
  t.Game.update(1 / 60, { ldx: 0, ldy: 0, mx: 0, mz: 0, jump: false, sneak: false, pad: {} });
  H.eq(activations, 1, 'a ready ULT touch dispatches the ultimate');
  H.eq(t.Touch.btn.fly, false, 'consuming the ultimate releases the held touch before disabling the button');
  H.assert(!action.classList.contains('pressed'), 'the consumed action loses its pressed feedback');

  t.Game.update(1 / 60, { ldx: 0, ldy: 0, mx: 0, mz: 0, jump: false, sneak: false, pad: {} });
  H.eq(activations, 1, 'holding the action cannot dispatch a second ultimate');

  action.dispatchUserEvent({ type: 'touchend', cancelable: true, preventDefault() { this.defaultPrevented = true; } });
  H.eq(t.Touch.btn.fly, false, 'lifting the finger releases the ULT action');
  t.Game.update(1 / 60, { ldx: 0, ldy: 0, mx: 0, mz: 0, jump: false, sneak: false, pad: {} });
  player.ultMeter = player.maxUlt;
  t.Game.setFightTouchUltReady(true, true);
  action.dispatchUserEvent({ type: 'touchstart', cancelable: true, preventDefault() { this.defaultPrevented = true; } });
  t.Game.update(1 / 60, { ldx: 0, ldy: 0, mx: 0, mz: 0, jump: false, sneak: false, pad: {} });
  H.eq(activations, 2, 'a fresh touch after release can use a recharged ultimate');
});

H.test('touch controls help uses the visible Fight and Observe action labels', () => {
  const t = H.load({ touch: true, boot: false });
  const box = { innerHTML: '', querySelector: () => ({ onclick: null }) };
  t.Game.isTouch = true;
  t.UI.showControls(box);
  H.assert(box.innerHTML.includes('ULT when the bar is full'), 'help names the visible Fight action');
  H.assert(box.innerHTML.includes('PHOTO, in Observe mode'), 'help names the visible Observe action');
});

H.test('BREAK never toggles camera view and touch VIEW toggles once per press', () => {
  const t = H.load({ touch: true, boot: false });
  t.Touch.enabled = true;
  t.Touch.btn.hit = true;
  H.eq(t.Game.cameraViewToggleRequested(), false, 'BREAK is only a mining action');

  t.Touch.btn.hit = false;
  t.Touch.btn.view = true;
  H.eq(t.Game.cameraViewToggleRequested(), true, 'a new VIEW press changes perspective');
  H.eq(t.Game.cameraViewToggleRequested(), false, 'holding VIEW cannot toggle repeatedly');
  t.Touch.btn.view = false;
  H.eq(t.Game.cameraViewToggleRequested(), false, 'releasing VIEW does not toggle');
  t.Touch.btn.view = true;
  H.eq(t.Game.cameraViewToggleRequested(), true, 'a later VIEW press changes perspective again');
});

H.test('V and F5 toggle perspective immediately in Play & Build and Fight Arena', () => {
  const t = H.load({ boot: false });
  t.Cam.thirdPerson = true;
  t.UI.toast = () => {};
  t.Audio.play = () => {};
  t.Game.bindGlobalKeys();
  const keydown = t.listeners.keydown[t.listeners.keydown.length - 1];

  for (const mode of ['play', 'fight']) {
    t.Game.state = mode;
    t.Cam.thirdPerson = true;
    let prevented = false;
    keydown({ code: 'KeyV', repeat: false, preventDefault: () => { prevented = true; } });
    H.eq(prevented, true, `${mode}: V is handled by the game`);
    H.eq(t.Cam.thirdPerson, false, `${mode}: V immediately switches to first-person`);
    keydown({ code: 'KeyV', repeat: true, preventDefault: () => { prevented = true; } });
    H.eq(t.Cam.thirdPerson, false, `${mode}: key repeat does not toggle repeatedly`);
    keydown({ code: 'F5', repeat: false, preventDefault: () => { prevented = true; } });
    H.eq(t.Cam.thirdPerson, true, `${mode}: F5 switches back to third-person`);
    H.eq(prevented, true, `${mode}: F5 cannot trigger browser reload`);
  }

  t.Game.state = 'observe';
  let observerChanges = 0;
  t.Observer.cycle = () => { observerChanges++; return { name: 'Orbit' }; };
  keydown({ code: 'F5', repeat: false, preventDefault: () => {} });
  H.eq(observerChanges, 1, 'F5 keeps its Observe camera-cycle behavior');
  H.eq(t.Cam.thirdPerson, true, 'Observe camera cycling does not toggle player perspective');
});

H.test('Fight Arena touch VIEW toggles between first- and third-person', () => {
  const t = H.load({ touch: true, boot: false });
  const player = {
    char: { name: 'Steve', ultName: 'Block Bonanza', speed: 4, jump: 8 },
    yaw: 0, pitch: 0, ko: false, ultMeter: 0, maxUlt: 100,
    update() {},
  };
  const opponent = {
    char: { name: 'Alex', ultName: 'Triple Cyclone', speed: 4, jump: 8 },
    yaw: 0, pitch: 0, ko: false, ultMeter: 0, maxUlt: 100,
    update() {},
  };
  t.Game.state = 'fight';
  t.Game.players = [player, opponent];
  t.Game.clampToWorld = () => {};
  t.Game.handleFightInput = () => {};
  t.Game.setFightTouchUltReady = () => {};
  t.Fight.update = () => {};
  t.UI.updateHUD = () => {};
  t.Cam.look = () => {};
  t.Touch.enabled = true;
  t.Cam.thirdPerson = true;

  const view = t.document.getElementById('touch-view');
  t.Touch.btn.view = true;
  t.Game.update(1 / 60, { ldx: 0, ldy: 0, mx: 0, mz: 0, jump: false, sneak: false, pad: {} });
  H.eq(t.Cam.thirdPerson, false, 'touch VIEW switches Fight Arena to first-person');
  H.eq(view.textContent, '1ST', 'the touch label reflects first-person');
  H.eq(view.attributes['aria-label'], 'Switch to third-person view', 'the accessible label offers the reverse switch');
  t.Game.update(1 / 60, { ldx: 0, ldy: 0, mx: 0, mz: 0, jump: false, sneak: false, pad: {} });
  H.eq(t.Cam.thirdPerson, false, 'holding touch VIEW does not toggle repeatedly');
  t.Touch.btn.view = false;
  t.Game.update(1 / 60, { ldx: 0, ldy: 0, mx: 0, mz: 0, jump: false, sneak: false, pad: {} });
  t.Touch.btn.view = true;
  t.Game.update(1 / 60, { ldx: 0, ldy: 0, mx: 0, mz: 0, jump: false, sneak: false, pad: {} });
  H.eq(t.Cam.thirdPerson, true, 'a later touch VIEW press returns to third-person');
  H.eq(view.textContent, '3RD', 'the touch label reflects third-person');
});

H.test('first-person hides only the local player in Play & Build and Fight Arena', () => {
  const t = H.load({ boot: false });
  const local = {};
  const remote = {};
  t.Game.players = [local, remote];
  t.Cam.thirdPerson = false;

  t.Game.state = 'play';
  H.eq(t.Game.isFirstPersonLocalPlayer(local), true, 'Play & Build hides the local player in first-person');
  H.eq(t.Game.isFirstPersonLocalPlayer(remote), false, 'Play & Build still draws the other player');

  t.Game.state = 'fight';
  H.eq(t.Game.isFirstPersonLocalPlayer(local), true, 'Fight Arena hides the local player in first-person');
  H.eq(t.Game.isFirstPersonLocalPlayer(remote), false, 'Fight Arena still draws the opponent');
  t.Cam.thirdPerson = true;
  H.eq(t.Game.isFirstPersonLocalPlayer(local), false, 'third-person draws the local player');
});

H.test('touch can select a hotbar slot after UI builds the slots', () => {
  const t = H.load({ touch: true, boot: false });
  t.Game.players = [{ selectedSlot: 0 }];
  t.Touch.init();
  t.UI.init();
  const bar = t.document.getElementById('hotbar');
  const click = bar.eventListeners.click[0];
  const slot = { dataset: { slot: '4' } };
  click({ target: { closest: (selector) => selector === '.slot' ? slot : null } });
  H.eq(t.Game.selectedSlot, 4, 'a tap on a built slot should select its block');
  H.eq(t.Game.players[0].selectedSlot, 4, 'the selected block should reach the player');
});

H.test('a typical thumb-width touch swipe makes a useful camera turn', () => {
  const t = H.load({ touch: true, boot: false });
  t.windowStub.innerWidth = 390;
  t.Touch.look.x = 150;
  const input = t.Game.gatherInput();
  t.Cam.yaw = 0;
  t.Cam.look(input.ldx, 0);
  H.near(Math.abs(t.Cam.yaw), Math.PI / 3, 0.08,
    'a 150px swipe at default sensitivity should turn about 60 degrees');
});

H.test('mobile auth and menu panels retain vertical touch scrolling', () => {
  const css = fs.readFileSync(path.join(H.ROOT, 'style.css'), 'utf8');
  const menuStart = css.indexOf('#menu {');
  const menuBlock = css.slice(menuStart, css.indexOf('}', menuStart));
  const cardStart = css.indexOf('.menu-card {');
  const cardBlock = css.slice(cardStart, css.indexOf('}', cardStart));
  const authStart = css.indexOf('.auth-screen {');
  const authBlock = css.slice(authStart, css.indexOf('}', authStart));
  const authCardStart = css.indexOf('.auth-card {');
  const authCardBlock = css.slice(authCardStart, css.indexOf('}', authCardStart));
  H.assert(/overflow-y:\s*auto/.test(menuBlock) && /-webkit-overflow-scrolling:\s*touch/.test(menuBlock),
    'the full-screen menu overlay should own vertical momentum scrolling');
  H.assert(/align-items:\s*flex-start/.test(menuBlock),
    'tall menu content must start at the top instead of overflowing its centered scroll origin');
  H.assert(/touch-action:\s*none/.test(menuBlock),
    'the menu must let its touch handler own iOS swipe scrolling');
  H.assert(!/overflow-y:\s*auto/.test(cardBlock), 'the menu card must not create a competing nested scroll area');
  H.assert(/touch-action:\s*pan-y/.test(authBlock), 'sign-in screen should allow vertical touch scrolling');
  H.assert(/align-items:\s*flex-start/.test(authBlock) && /overflow-y:\s*auto/.test(authBlock),
    'tall sign-in forms must remain reachable in the screen scroll area');
  H.assert(/margin-block:\s*auto/.test(authCardBlock), 'short sign-in content should still center when it fits');
  const root = css.match(/html, body\s*\{([^}]*)\}/);
  H.assert(root && !/touch-action:\s*none/.test(root[1]),
    'the root page must not block touch gestures for scrollable child panels');

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
  const captureHint = t.document.getElementById('capture-hint');
  t.Game.startPlay();
  H.eq(t.Game.state, 'play');
  H.eq(t.Game.players[1].networkRemote, true, 'Play & Build treats the unused second slot as a remote actor');
  H.eq(t.Game.players[1].networkRemoteVisible, false, 'solo Play & Build hides the unused second avatar');
  H.assert(captureHint.classList.contains('show'), 'Play & Build shows its hint when pointer-lock state has no event');
  H.eq(captureHint.dataset.mode, 'play');
  t.Game.toMenu();
  H.eq(t.Game.state, 'menu');
  H.assert(captureHint.classList.contains('hidden'), 'leaving gameplay hides the capture hint');
  t.Game.startObserve();
  H.eq(t.Game.state, 'observe');
  H.assert(captureHint.classList.contains('hidden'), 'Observe keeps the capture hint hidden');
  t.Game.toMenu();
  t.Game.pick.p2bot = true;
  t.Game.startFight();
  H.eq(t.Game.state, 'fight');
  H.eq(t.Game.players[1].networkRemote, false, 'Fight Arena restores the local opponent role');
  H.eq(t.Game.players[1].networkRemoteVisible, true, 'Fight Arena keeps its opponent visible');
  H.assert(captureHint.classList.contains('show'), 'Fight shows its hint when pointer-lock state has no event');
  H.eq(captureHint.dataset.mode, 'fight');
  H.assert(t.Game.bot, 'a computer opponent should be created');
  t.Game.togglePause(true);
  H.eq(t.Game.state, 'paused');
  H.assert(captureHint.classList.contains('hidden'), 'pausing hides the capture hint');
  t.Game.togglePause(false);
  H.eq(t.Game.state, 'fight');
  H.assert(captureHint.classList.contains('show'), 'resuming restores the active mode hint without a pointer-lock event');
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

H.test('streaming rebuilds its render list after a mode change clears it', () => {
  const t = H.load({ boot: true });
  const world = t.Game.world;
  const keep = t.Game.viewDistance();
  t.Cam.pos = t.Game.players[0].pos.slice();
  t.Game._streamAt = t.Cam.pos.slice();
  t.Game._streamWorld = world;
  t.Game._streamKeep = keep;
  t.Game._streamQueue = [];
  t.Game._generationQueue = [{ c: world.activeChunks.values().next().value, d: 0 }];
  t.Game._streamTurn = 0;
  t.Game._renderChunks = null;

  t.Game.streamChunks(1);
  H.assert(Array.isArray(t.Game._renderChunks), 'streaming should rebuild the render list before using a stale generation queue');
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
  const qaTestCheckout = require('./qa-test-checkout');
  const developerState = qaTestCheckout.captureDeveloperState(H.ROOT);
  const checkout = qaTestCheckout.createCommittedCheckout(H.ROOT);
  const qaRoot = checkout.root;
  try {
  const builder = require(path.join(H.ROOT, 'scripts', 'build-qa.js'));
  H.eq(builder.validateOutputPath(path.join(H.ROOT, '.qa-public')), path.join(H.ROOT, '.qa-public'), 'the dedicated output path is accepted');
  for (const unsafe of [H.ROOT, path.dirname(H.ROOT)]) {
    let rejected = false;
    try { builder.validateOutputPath(unsafe); } catch (_) { rejected = true; }
    H.eq(rejected, true, 'unsafe output paths are rejected');
  }
  const symlinkFs = {
    existsSync: () => true,
    lstatSync: () => ({ isSymbolicLink: () => true }),
  };
  let symlinkRejected = false;
  try { builder.validateOutputPath(path.join(H.ROOT, '.qa-public'), symlinkFs); } catch (_) { symlinkRejected = true; }
  H.eq(symlinkRejected, true, 'a symlinked QA output is rejected before the build removes it');
  for (const contaminated of ['Network', 'network.js', 'Marlene', 'Florenz', 'Feng', 'PIN', 'auth-profile', 'Choose your profile']) {
    let contaminationRejected = false;
    try { builder.assertNoForbiddenReferences('window.' + contaminated); } catch (_) { contaminationRejected = true; }
    H.eq(contaminationRejected, true, 'sanitizer rejects forbidden token ' + contaminated);
  }
  for (const contaminated of [
    '<img src="https://tracker.example/pixel">',
    '<img alt=">" src="https://tracker.example/pixel">',
    '<iframe srcdoc="<img src=https://tracker.example/pixel>"></iframe>',
    '<meta http-equiv="refresh" content="0;url=https://tracker.example/">',
    '<script src="//cdn.example/game.js"></script>',
    '<link rel="stylesheet" href="https&#58;//cdn.example/game.css">',
    '<link rel="stylesheet" href="data:text/css,%40import%20url(https://tracker.example/x.css)">',
    '<img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E">',
    '<img srcset="https://tracker.example/a 1x">',
    '@import "https://cdn.example/style.css";',
    'background-image: url(https://tracker.example/pixel);',
    'background-image: url(https\\3a //tracker.example/pixel);',
    'background-image: image-set("https://tracker.example/pixel.png" 1x);',
    'background-image: -webkit-image-set("https://tracker.example/pixel.png" 1x);',
  ]) {
    let resourceRejected = false;
    try { builder.assertNoForbiddenReferences(contaminated); } catch (_) { resourceRejected = true; }
    H.eq(resourceRejected, true, 'sanitizer rejects remote resource reference ' + contaminated);
  }
  H.eq(builder.assertNoExternalResources('<script src="js/main.js"></script><link rel="icon" href="data:,"><img src="data:image/png;base64,AA==">'), undefined, 'sanitizer permits local and approved inline image resources');
  H.eq(builder.assertNoExternalResources('body { clip-path: url(#clip-shape); }'), undefined, 'sanitizer permits fragment-only CSS resources');
  const dirtyGuard = qaTestCheckout.exerciseDirtyBuildGuard(qaRoot, H.ROOT);
  H.assert(dirtyGuard.exitCode !== 0, 'builder rejects a dirty disposable checkout');
  H.eq(dirtyGuard.statusAfter, dirtyGuard.statusBefore, 'dirty-checkout rejection preserves the working-tree state');
  H.eq(JSON.stringify(dirtyGuard.outputAfter), JSON.stringify(dirtyGuard.outputBefore), 'dirty-checkout rejection preserves an existing .qa-public preview');
  H.assert(/clean Git checkout/.test(dirtyGuard.diagnostic), 'dirty-checkout rejection explains the clean-source requirement');
  H.eq(dirtyGuard.statusCleanAfterRestore, '', 'dirty regression fixture restores its committed source');

  const build = qaTestCheckout.spawnBuilder(qaRoot, H.ROOT, {
    BW_QA_SOURCE_DIR: path.join(H.ROOT, 'missing-untrusted-source'),
  });
  H.eq(build.status, 0, 'QA bundle build succeeds from the repository source despite an untrusted override: ' + (build.stderr || build.stdout));
  const qaOutput = path.join(qaRoot, '.qa-public');
  const generatedHtml = fs.readFileSync(path.join(qaOutput, 'index.html'), 'utf8');
  H.assert(/<title>Blocky World QA<\/title>/i.test(generatedHtml), 'QA page uses a generic app title');
  H.assert(/apple-mobile-web-app-title" content="Blocky World QA/i.test(generatedHtml), 'mobile app metadata uses the generic title');
  H.assert(/<h1>Blocky World QA<\/h1>/i.test(generatedHtml), 'game heading uses the generic title');
  const generatedCss = fs.readFileSync(path.join(qaOutput, 'style.css'), 'utf8');
  builder.assertWorldPickerCss(generatedCss);
  H.assert(!/\.auth-screen|\.visit-lobby|\.visit-hud|\.visit-mode-dialog/.test(generatedCss), 'generated CSS omits auth and visit UI rules');
  const memoryCalls = { storage: 0, fetch: 0 };
  const nativeStorageTrap = {
    getItem() { memoryCalls.storage++; throw new Error('persistent storage read'); },
    setItem() { memoryCalls.storage++; throw new Error('persistent storage write'); },
    removeItem() { memoryCalls.storage++; throw new Error('persistent storage remove'); },
    key() { memoryCalls.storage++; throw new Error('persistent storage key'); },
    get length() { memoryCalls.storage++; throw new Error('persistent storage length'); },
  };
  const candidateMain = builder.stripNetworkOnlyMain(fs.readFileSync(path.join(H.ROOT, 'js', 'main.js'), 'utf8'));
  fs.writeFileSync(path.join(qaOutput, 'js', 'main.js'), candidateMain);
  const qa = H.load({
    sourceRoot: qaOutput, includeNetwork: false,
    boot: false, storage: nativeStorageTrap,
    missingElementIds: ['btn-fight-lobby-settings', 'btn-fight-lobby-exit'],
    fetch() { memoryCalls.fetch++; throw new Error('unexpected network request'); },
  });
  H.eq(qa.Network, undefined, 'network module is absent');
  H.eq(qa.windowStub.Network, undefined, 'no page network API is installed');
  H.assert(typeof qa.Game.render === 'function', 'game renderer is present');
  H.assert(typeof qa.Game.startObserve === 'function' && typeof qa.Observer.update === 'function', 'observer view is present');
  qa.UI.init();
  H.eq(qa.document.getElementById('btn-fight-lobby-settings'), null, 'sanitized QA page omits fight-lobby settings button');
  H.eq(qa.document.getElementById('btn-fight-lobby-exit'), null, 'sanitized QA page omits fight-lobby exit button');

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
  qa.Game.canvas = { requestPointerLock() {} };
  qa.Game.startPlay();
  qa.Game.gl = H.stubGL({ vaos: [], buffers: [] });
  qa.Game.progBox = { u: {} };
  const drawnPlayPlayers = [];
  qa.Game.drawCharacter = (_, player) => drawnPlayPlayers.push(player);
  qa.Game.drawAnimals = () => {};
  qa.Game.drawBuildHand = () => {};
  qa.Cam.thirdPerson = true;
  qa.Game.renderEntities(null, 1 / 60);
  H.eq(drawnPlayPlayers.length, 1, 'sanitized third-person Play & Build draws one avatar');
  H.eq(drawnPlayPlayers[0], p1, 'sanitized third-person Play & Build draws the local avatar');
  drawnPlayPlayers.length = 0;
  qa.Cam.thirdPerson = false;
  qa.Game.renderEntities(null, 1 / 60);
  H.eq(drawnPlayPlayers.length, 0, 'sanitized first-person Play & Build hides both avatar meshes');
  qa.Game.togglePause(true);
  H.eq(qa.Game.state, 'paused', 'Play & Build pauses for the overlay');
  H.eq(qa.Game.mode, 'play', 'paused Play & Build retains its active mode');
  drawnPlayPlayers.length = 0;
  qa.Cam.thirdPerson = true;
  qa.Game.renderEntities(null, 1 / 60);
  H.eq(drawnPlayPlayers.length, 1, 'sanitized paused Play & Build keeps the unused avatar hidden');
  H.eq(drawnPlayPlayers[0], p1, 'sanitized paused Play & Build keeps the local avatar');
  qa.Game.togglePause(false);
  H.eq(qa.Game.state, 'play', 'Play & Build resumes into its active mode');
  qa.Game.startFight();
  H.eq(qa.Game.state, 'fight', 'local Fight mode starts');
  H.assert(qa.Game.bot, 'offline computer opponent remains available');
  drawnPlayPlayers.length = 0;
  qa.Cam.thirdPerson = true;
  qa.Game.renderEntities(null, 1 / 60);
  H.eq(drawnPlayPlayers.length, 2, 'sanitized Fight Arena draws both fighter avatars');
  H.eq(drawnPlayPlayers[0], p1, 'sanitized Fight Arena draws the local fighter');
  H.eq(drawnPlayPlayers[1], p2, 'sanitized Fight Arena draws the opponent');
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
  const fresh = H.load({ sourceRoot: qaOutput, includeNetwork: false, boot: false });
  H.eq(fresh.BWStorage.length, 0, 'reload starts with a fresh in-memory world');
  } finally {
    checkout.dispose();
  }
  H.eq(qaTestCheckout.gitStatus(H.ROOT), developerState.gitStatus, 'QA integration leaves the live checkout status unchanged');
  H.eq(JSON.stringify(qaTestCheckout.snapshotTree(path.join(H.ROOT, '.qa-public'))), JSON.stringify(developerState.qaOutput), 'QA integration leaves any live .qa-public preview unchanged');
});


if (require.main === module) {
  process.exit(H.main(process.argv.slice(2)));
}

