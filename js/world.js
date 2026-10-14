'use strict';
/* ============================================================
   world.js — chunked voxel world + terrain generation
   ============================================================ */

const CHUNK = 16;          // chunk footprint in blocks

// The playable world is 200000 x 200000 x 100. Chunks are generated around the
// player on demand so the full map remains practical on phones and tablets.
const WORLD_SIZE = 200000;
const WORLD_H = 100;
const SEA_LEVEL = 20;

const CHUNKS_PER_SIDE = Math.ceil(WORLD_SIZE / CHUNK);          // 12500
const CENTRE_CHUNK = Math.floor(CHUNKS_PER_SIDE / 2);           // 6250
// Centre of the playable square, in blocks.
const WORLD_CENTRE = CENTRE_CHUNK * CHUNK + CHUNK / 2;          // 100008

const STORYBOOK_SEED = 1337;
const STORYBOOK_CLEAR_RADIUS = 40;
const STORYBOOK_BLEND_RADIUS = 82;
const STORYBOOK_GROUND = 29;
const STORYBOOK_FLOWER_PATCHES = [
  [-28, -5, 22, 4], [-24, 2, 23, 3], [-19, 18, 24, 3], [-3, 23, 22, 4],
  [10, 20, 23, 3], [26, 12, 24, 4], [24, -26, 22, 4], [1, -25, 23, 3],
  [-24, -29, 23, 3], [15, -31, 22, 4],
];
const STORYBOOK_TREES = [
  [-28, -7, 9, 1], [-30, 13, 8, 0], [-18, 28, 9, 2],
  [4, 32, 8, 1], [26, 21, 10, 2], [31, -5, 8, 0],
  [23, -25, 9, 1], [-25, -24, 10, 2], [7, -29, 8, 0],
];
const STORYBOOK_HOUSES = [
  { x: -22, z: -12, halfWidth: 3, halfDepth: 3, wallHeight: 3, roof: 6 },
  { x: 12, z: -18, halfWidth: 4, halfDepth: 3, wallHeight: 3, roof: 8 },
];
const STORYBOOK_TREEHOUSE = { x: -9, z: -24, halfWidth: 3, halfDepth: 3, wallHeight: 3, roof: 6 };
const STORYBOOK_TREEHOUSE_TRUNK = 9;
const STORYBOOK_CANOPIES = [
  [3, 4, 3, 2, 1],
  [3, 5, 4, 3, 2],
  [4, 5, 4, 3, 1],
];
const STORYBOOK_TREEHOUSE_CANOPY = [4, 5, 4, 3, 2];
const STORYBOOK_PATHS = [
  [[0, -3], [-1, -5], [-5, -9], [-12, -11], [-19, -11], [-22, -12]],
  [[-12, -11], [-6, -13], [1, -15], [7, -18], [12, -18]],
  [[-9, -12], [-11, -17], [-10, -21], [-9, -24]],
];
const STORYBOOK_BRIDGE = { minX: -11, maxX: -10, minZ: -20, maxZ: -9, deckY: STORYBOOK_GROUND };
const STORYBOOK_FEATURE_COLUMNS = new Set();
function markStorybookRect(cx, cz, rx, rz) {
  for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) STORYBOOK_FEATURE_COLUMNS.add(x * 256 + z);
  }
}
for (const house of STORYBOOK_HOUSES) markStorybookRect(house.x, house.z, house.halfWidth + 1, house.halfDepth + 1);
markStorybookRect(STORYBOOK_TREEHOUSE.x, STORYBOOK_TREEHOUSE.z, 7, 7);
for (const [x, z] of STORYBOOK_TREES) markStorybookRect(x, z, 6, 6);
markStorybookRect((STORYBOOK_BRIDGE.minX + STORYBOOK_BRIDGE.maxX) / 2,
  (STORYBOOK_BRIDGE.minZ + STORYBOOK_BRIDGE.maxZ) / 2,
  (STORYBOOK_BRIDGE.maxX - STORYBOOK_BRIDGE.minX) / 2,
  (STORYBOOK_BRIDGE.maxZ - STORYBOOK_BRIDGE.minZ) / 2);
for (const path of STORYBOOK_PATHS) {
  for (let i = 1; i < path.length; i++) {
    const [x0, z0] = path[i - 1], [x1, z1] = path[i];
    markStorybookRect((x0 + x1) / 2, (z0 + z1) / 2,
      Math.ceil(Math.abs(x1 - x0) / 2) + 2, Math.ceil(Math.abs(z1 - z0) / 2) + 2);
  }
}
for (const [x, z, , size] of STORYBOOK_FLOWER_PATCHES) markStorybookRect(x, z, size + 1, size + 1);
const MIN_EDGE = 0;
const MAX_EDGE = CHUNKS_PER_SIDE * CHUNK;                      // 200000

const inWorldXZ = (x, z) =>
  x >= MIN_EDGE && x < MAX_EDGE && z >= MIN_EDGE && z < MAX_EDGE;

/* ---------- value noise (fast, deterministic, no deps) ---------- */
function hash2(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t) { return t * t * (3 - 2 * t); }

const STORYBOOK_CLEAR_RADIUS_SQ = STORYBOOK_CLEAR_RADIUS * STORYBOOK_CLEAR_RADIUS;
const STORYBOOK_BLEND_RADIUS_SQ = STORYBOOK_BLEND_RADIUS * STORYBOOK_BLEND_RADIUS;
const SUN_SPREAD_DX = [1,-1,0,0,0];
const SUN_SPREAD_DY = [0,0,0,0,-1];
const SUN_SPREAD_DZ = [0,0,1,-1,0];
const STORYBOOK_BLEND_BY_RADIUS = new Float32Array(STORYBOOK_BLEND_RADIUS_SQ + 1);
for (let r2 = STORYBOOK_CLEAR_RADIUS_SQ + 1; r2 <= STORYBOOK_BLEND_RADIUS_SQ; r2++) {
  STORYBOOK_BLEND_BY_RADIUS[r2] = smooth((Math.sqrt(r2) - STORYBOOK_CLEAR_RADIUS) /
    (STORYBOOK_BLEND_RADIUS - STORYBOOK_CLEAR_RADIUS));
}
const STORYBOOK_STREAM_Z = new Int8Array(63);
for (let dx = -31; dx <= 31; dx++) STORYBOOK_STREAM_Z[dx + 31] = -14 + Math.round(Math.sin(dx * 0.12) * 2);

// The clearing shape depends only on block offsets. Precompute it once so streamed
// chunks do not redo radius, creek and pond calculations for every terrain column.
const STORYBOOK_PROFILE_SIZE = STORYBOOK_BLEND_RADIUS * 2 + 1;
const STORYBOOK_PROFILE_LENGTH = STORYBOOK_PROFILE_SIZE * STORYBOOK_PROFILE_SIZE;
const STORYBOOK_PROFILE_VALID = new Uint8Array(STORYBOOK_PROFILE_LENGTH);
const STORYBOOK_PROFILE_BLEND = new Float32Array(STORYBOOK_PROFILE_LENGTH);
const STORYBOOK_PROFILE_TARGET = new Uint8Array(STORYBOOK_PROFILE_LENGTH);
const STORYBOOK_PROFILE_STREAM = new Uint8Array(STORYBOOK_PROFILE_LENGTH);
const STORYBOOK_PROFILE_CLEARING = new Uint8Array(STORYBOOK_PROFILE_LENGTH);
for (let dx = -STORYBOOK_BLEND_RADIUS; dx <= STORYBOOK_BLEND_RADIUS; dx++) {
  for (let dz = -STORYBOOK_BLEND_RADIUS; dz <= STORYBOOK_BLEND_RADIUS; dz++) {
    const radiusSquared = dx * dx + dz * dz;
    if (radiusSquared > STORYBOOK_BLEND_RADIUS_SQ) continue;
    const streamZ = Math.abs(dx) <= 31 ? STORYBOOK_STREAM_Z[dx + 31] : 0;
    const pond = dx > 20 && dx < 32 && (dx - 25) * (dx - 25) + (dz - streamZ) * (dz - streamZ) < 49;
    let streamLevel = 0;
    if (Math.abs(dx) <= 31 && (Math.abs(dz - streamZ) <= 3 || pond)) {
      streamLevel = dx < -8 ? STORYBOOK_GROUND : STORYBOOK_GROUND - 5;
    }
    const index = (dx + STORYBOOK_BLEND_RADIUS) * STORYBOOK_PROFILE_SIZE + dz + STORYBOOK_BLEND_RADIUS;
    STORYBOOK_PROFILE_VALID[index] = 1;
    STORYBOOK_PROFILE_BLEND[index] = radiusSquared <= STORYBOOK_CLEAR_RADIUS_SQ ? 0 : STORYBOOK_BLEND_BY_RADIUS[radiusSquared];
    STORYBOOK_PROFILE_TARGET[index] = streamLevel ? streamLevel - 3 : STORYBOOK_GROUND;
    STORYBOOK_PROFILE_STREAM[index] = streamLevel;
    STORYBOOK_PROFILE_CLEARING[index] = radiusSquared <= STORYBOOK_CLEAR_RADIUS_SQ ? 1 : 0;
  }
}

function noise2(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf;
}

function fbm(x, y, seed, octaves) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < (octaves || 4); i++) {
    sum += noise2(x * freq, y * freq, seed + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/* ============================================================
   Chunk
   ============================================================ */
class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    // Queued chunks can be discarded before generation; defer their ~75 KB
    // voxel storage until generateChunk actually starts filling them.
    this.blocks = null;
    this.light = null;
    this.blockLight = null;
    this.maxY = 0;
    this.generated = false;
    this.dirty = true;
    this.mesh = null;       // opaque mesh
    this.meshWater = null;  // transparent mesh
  }

  allocate() {
    if (this.blocks) return;
    this.blocks = new Uint8Array(CHUNK * WORLD_H * CHUNK);
    this.light = new Uint8Array(CHUNK * WORLD_H * CHUNK);
    this.blockLight = new Uint8Array(CHUNK * WORLD_H * CHUNK);
    this.maxY = WORLD_H - 1;
  }

  release() {
    this.blocks = null;
    this.light = null;
    this.blockLight = null;
    this.maxY = 0;
    this.generated = false;
    this.dirty = true;
  }

  static idx(x, y, z) { return (y * CHUNK + z) * CHUNK + x; }

  get(x, y, z) {
    if (y < 0 || y >= WORLD_H) return 0;
    if (!this.blocks) return 0;
    return this.blocks[Chunk.idx(x, y, z)];
  }

  set(x, y, z, id) {
    if (y < 0 || y >= WORLD_H) return;
    if (!this.blocks) return;
    this.blocks[Chunk.idx(x, y, z)] = id;
    if (id !== 0 && y > this.maxY) this.maxY = y;
  }
}

/* ============================================================
   World
   ============================================================ */
class World {
  constructor(seed, savedEdits, worldType) {
    this.seed = (seed === undefined || seed === null) ? 1337 : (seed | 0);
    this.worldType = worldType === 'flat' ? 'flat' : 'normal';
    this.chunks = new Map();
    this.activeChunks = new Set();
    this.edits = new Map();
    this.editsByChunk = new Map();
    if (Array.isArray(savedEdits)) {
      for (const edit of savedEdits) {
        if (!Array.isArray(edit) || edit.length !== 4 || !edit.every(Number.isInteger)) continue;
        const [x, y, z, id] = edit;
        if (!inWorldXZ(x, z) || y < 1 || y >= WORLD_H || id < 0 || id > 255) continue;
        this.recordEdit(x, y, z, id);
      }
    }
    this.players = [];   // spawn spots
    this.arena = null;   // fight arena info
    // The loaded area is centred on the middle of the world, not on the true
    // block origin, so the whole playfield is always covered by chunks.
    this.centreChunkX = CENTRE_CHUNK;
    this.centreChunkZ = CENTRE_CHUNK;
    this.originX = WORLD_CENTRE;
    this.originZ = WORLD_CENTRE;
  }

  setCentre(cx, cz) {
    this.centreChunkX = cx;
    this.centreChunkZ = cz;
    this.originX = cx * CHUNK + CHUNK / 2;
    this.originZ = cz * CHUNK + CHUNK / 2;
  }

  // True when a block coordinate lies inside the playable square.
  isInsideWorld(x, z) {
    return x >= MIN_EDGE && x < MAX_EDGE && z >= MIN_EDGE && z < MAX_EDGE;
  }

  key(cx, cz) { return cx + ',' + cz; }

  getChunk(cx, cz, create) {
    const k = this.key(cx, cz);
    let c = this.chunks.get(k);
    if (!c && create) {
      c = new Chunk(cx, cz);
      this.chunks.set(k, c);
    }
    return c;
  }

  // World-space block access. Outside loaded chunks returns bedrock-free air,
  // except below y=0 which is solid so players can't fall out of the world.
  getBlock(x, y, z) {
    if (y < 0) return 17;
    if (y >= WORLD_H) return 0;
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.getChunk(cx, cz, false);
    if (!c || !c.generated) return 0;
    return c.blocks[Chunk.idx(x - cx * CHUNK, y, z - cz * CHUNK)];
  }

  getLight(x, y, z) {
    if (y < 0 || y >= WORLD_H) return 15;
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.getChunk(cx, cz, false);
    if (!c || !c.generated) return 15;
    const i = Chunk.idx(x - cx * CHUNK, y, z - cz * CHUNK);
    return c.light[i];
  }

  getBlockLight(x, y, z) {
    if (y < 0 || y >= WORLD_H) return 0;
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.getChunk(cx, cz, false);
    if (!c || !c.generated) return 0;
    const i = Chunk.idx(x - cx * CHUNK, y, z - cz * CHUNK);
    return c.blockLight[i];
  }

  setBlock(x, y, z, id) {
    if (y < 1 || y >= WORLD_H) return false;
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (!inWorldXZ(x, z)) return false;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.getChunk(cx, cz, false);
    if (!c || !c.generated) return false;
    const previous = c.blocks[Chunk.idx(x - cx * CHUNK, y, z - cz * CHUNK)];
    c.blocks[Chunk.idx(x - cx * CHUNK, y, z - cz * CHUNK)] = id;
    if (id !== 0 && y > c.maxY) c.maxY = y;
    this.recordEdit(x, y, z, id);
    if (window.Network && Network.serverMode) Network.queueSharedEdit(x, y, z, id);
    c.dirty = true;
    this.markNeighbourChunksDirty(x, y, z);
    // Flow edits relight their unique columns once after the batch completes.
    if (this._flowingWater) this._waterRelightColumns.add(x + ',' + z);
    else this.relightColumn(x, z);
    // A normal edit next to water opens or displaces a cell. Adjacent source
    // or flow cells can refill nearby air; internal flow writes are guarded.
    if (!this._flowingWater && (id === 0 || isLiquid(previous) || isLiquid(id))) {
      const displaced = isLiquid(previous) && id !== 0 && !isLiquid(id) ? previous : 0;
      this.flowWaterNear(x, y, z, displaced);
    }
    return true;
  }

  flowWaterNear(x, y, z, displacedWaterId) {
    if (this._flowingWater) return;
    const directions = [[0,-1,0], [1,0,0], [-1,0,0], [0,0,1], [0,0,-1], [0,1,0]];
    const strengthOf = id => id === 12 ? 5 : (id >= 18 && id <= 21 ? 22 - id : 0);
    const flowId = strength => 22 - Math.min(strength, 4);
    const flowCells = new Map();
    const sources = new Map();
    const scan = [];
    const scanned = new Set();
    const addScan = (wx, wy, wz) => {
      const id = this.getBlock(wx, wy, wz);
      const key = wx + ',' + wy + ',' + wz;
      if (id === 12) {
        sources.set(key, [wx, wy, wz]);
        return;
      }
      if (id < 18 || id > 21 || scanned.has(key)) return;
      scanned.add(key);
      scan.push([wx, wy, wz]);
    };
    addScan(x, y, z);
    for (const [dx, dy, dz] of directions) addScan(x + dx, y + dy, z + dz);
    let overflow = false;
    for (let cursor = 0; cursor < scan.length; cursor++) {
      if (cursor >= 12000) { overflow = true; break; }
      const [wx, wy, wz] = scan[cursor];
      flowCells.set(wx + ',' + wy + ',' + wz, [wx, wy, wz]);
      for (const [dx, dy, dz] of directions) addScan(wx + dx, wy + dy, wz + dz);
    }
    // Never partially drain a large connected flow network. It remains safe
    // to leave the existing water untouched if the bounded scan is exceeded.
    if (overflow) return;
    if (!flowCells.size && !sources.size && displacedWaterId !== 12) return;

    const queue = [];
    const queued = new Map();
    const add = (wx, wy, wz, strength) => {
      const key = wx + ',' + wy + ',' + wz;
      if (strength <= (queued.get(key) || 0)) return;
      queued.set(key, strength);
      queue.push([wx, wy, wz, strength]);
    };

    this._flowingWater = true;
    this._waterRelightColumns = new Set();
    try {
      // Rebuild the connected flow from surviving source blocks. This retracts
      // water whose source was removed while keeping branches with another source.
      for (const [wx, wy, wz] of flowCells.values()) this.setBlock(wx, wy, wz, 0);
      for (const [wx, wy, wz] of sources.values()) add(wx, wy, wz, 5);
      if (this.getBlock(x, y, z) === 12) add(x, y, z, 5);
      if (!sources.size && displacedWaterId === 12) {
        // Covering a source moves it to the nearest open cell, so removing
        // the placed block can reconnect to the same water source.
        for (const [dx, dy, dz] of [[1,0,0], [-1,0,0], [0,0,1], [0,0,-1], [0,-1,0], [0,1,0]]) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (this.getBlock(nx, ny, nz) !== 0) continue;
          if (this.setBlock(nx, ny, nz, 12)) add(nx, ny, nz, 5);
          break;
        }
      }

      // Flow-only branches without a surviving source were removed above.
      for (let cursor = 0; cursor < queue.length && cursor < 12000; cursor++) {
        const [wx, wy, wz, strength] = queue[cursor];
        if (!isLiquid(this.getBlock(wx, wy, wz))) continue;
        const below = this.getBlock(wx, wy - 1, wz);
        if (wy > 1 && below === 0) {
          if (this.setBlock(wx, wy - 1, wz, flowId(strength))) add(wx, wy - 1, wz, strength);
          continue;
        }
        // Water prefers falling. Once supported, it spreads over a surface,
        // losing one reach unit per horizontal block (four max per source).
        if (strength <= 1) continue;
        for (const [dx, dz] of [[1,0], [-1,0], [0,1], [0,-1]]) {
          const nx = wx + dx, nz = wz + dz;
          const target = this.getBlock(nx, wy, nz);
          if (target === 0) {
            if (this.setBlock(nx, wy, nz, flowId(strength - 1))) add(nx, wy, nz, strength - 1);
          } else if (isLiquid(target) && strengthOf(target) < strength - 1) {
            if (this.setBlock(nx, wy, nz, flowId(strength - 1))) add(nx, wy, nz, strength - 1);
          }
        }
      }
    } finally {
      this._flowingWater = false;
      for (const column of this._waterRelightColumns) {
        const [wx, wz] = column.split(',').map(Number);
        this.relightColumn(wx, wz);
      }
      this._waterRelightColumns = null;
    }
  }

  applyRemoteEdit(x, y, z, id) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (!inWorldXZ(x, z) || y < 1 || y >= WORLD_H || !Number.isInteger(id) || id < 0 || id > 255) return false;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.getChunk(cx, cz, false);
    this.recordEdit(x, y, z, id);
    if (c && c.generated) {
      c.blocks[Chunk.idx(x - cx * CHUNK, y, z - cz * CHUNK)] = id;
      if (id !== 0 && y > c.maxY) c.maxY = y;
      c.dirty = true;
      this.markNeighbourChunksDirty(x, y, z);
      this.relightColumn(x, z);
    }
    return true;
  }

  recordEdit(x, y, z, id) {
    const key = x + ',' + y + ',' + z;
    this.edits.set(key, id);
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const chunkKey = this.key(cx, cz);
    let overrides = this.editsByChunk.get(chunkKey);
    if (!overrides) { overrides = new Map(); this.editsByChunk.set(chunkKey, overrides); }
    overrides.set(Chunk.idx(x - cx * CHUNK, y, z - cz * CHUNK), id);
  }

  markNeighbourChunksDirty(x, y, z) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    const sides = [];
    if (lx === 0) sides.push([cx - 1, cz]);
    if (lx === CHUNK - 1) sides.push([cx + 1, cz]);
    if (lz === 0) sides.push([cx, cz - 1]);
    if (lz === CHUNK - 1) sides.push([cx, cz + 1]);
    if (lx === 0 && lz === 0) sides.push([cx - 1, cz - 1]);
    if (lx === 0 && lz === CHUNK - 1) sides.push([cx - 1, cz + 1]);
    if (lx === CHUNK - 1 && lz === 0) sides.push([cx + 1, cz - 1]);
    if (lx === CHUNK - 1 && lz === CHUNK - 1) sides.push([cx + 1, cz + 1]);
    for (const [sx, sz] of sides) {
      const sc = this.getChunk(sx, sz, false);
      if (sc && sc.generated) sc.dirty = true;
    }
  }

  /* ---------- terrain ---------- */
  storybookColumn(x, z, naturalHeight) {
    if (this.worldType === 'flat' || this.seed !== STORYBOOK_SEED) return null;
    const dx = Math.floor(x) - WORLD_CENTRE;
    const dz = Math.floor(z) - WORLD_CENTRE;
    if (Math.abs(dx) > STORYBOOK_BLEND_RADIUS || Math.abs(dz) > STORYBOOK_BLEND_RADIUS) return null;
    const index = (dx + STORYBOOK_BLEND_RADIUS) * STORYBOOK_PROFILE_SIZE + dz + STORYBOOK_BLEND_RADIUS;
    if (!STORYBOOK_PROFILE_VALID[index]) return null;

    const targetHeight = STORYBOOK_PROFILE_TARGET[index];
    const streamLevel = STORYBOOK_PROFILE_STREAM[index];
    const blend = STORYBOOK_PROFILE_BLEND[index];
    const inClearing = STORYBOOK_PROFILE_CLEARING[index] !== 0;
    const groundY = Math.max(2, Math.floor(targetHeight * (1 - blend) + naturalHeight * blend));
    const resolvedStream = streamLevel ? Math.max(1, Math.floor(streamLevel * (1 - blend) + SEA_LEVEL * blend)) : 0;
    // Store per-column story metadata in one integer to avoid short-lived objects during chunk generation.
    return (groundY << 8) | (resolvedStream << 1) | (inClearing ? 1 : 0);
  }

  heightAt(x, z) {
    if (this.worldType === 'flat') return SEA_LEVEL;
    const s = this.seed;
    // Keep the old 200x200 terrain centred in the expanded map, and extend
    // the same deterministic noise field outward in every direction.
    x += 104 - WORLD_CENTRE;
    z += 104 - WORLD_CENTRE;
    // Rolling hills, plus a separate low-frequency shape that decides where
    // high ground and low ground sit. Using two different scales keeps the
    // peaks spread out instead of bunched into one corner.
    const hills = fbm(x * 0.022, z * 0.022, s, 4);
    const massifs = fbm(x * 0.006, z * 0.006, s + 999, 2);
    // Mountains: a medium-frequency ridge mask.
    const ridge = fbm(x * 0.011, z * 0.011, s + 4242, 3);

    let height = SEA_LEVEL + 2 + (hills - 0.5) * 14;
    // Broad highlands: positive deviation lifts whole regions.
    height += Math.max(0, massifs - 0.46) * 120;
    // Sharp peaks, only where a region is already high.
    height += Math.max(0, ridge - 0.52) * 90;

    // Keep the extremes inside the 100 block column with headroom to build.
    return Math.max(2, Math.min(WORLD_H - 22, Math.floor(height)));
  }

  generateChunk(c) {
    c.allocate();
    c.maxY = 0;
    const hasStorybook = this.worldType !== 'flat' && this.seed === STORYBOOK_SEED;
    const storyColumns = hasStorybook ? new Uint32Array(CHUNK * CHUNK) : null;
    const ox = c.cx * CHUNK, oz = c.cz * CHUNK;
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) {
        const wx = ox + x, wz = oz + z;
        let story = 0, fixedStoryGround = false, storyDx = 0, storyDz = 0;
        if (hasStorybook) {
          storyDx = wx - WORLD_CENTRE; storyDz = wz - WORLD_CENTRE;
          fixedStoryGround = storyDx * storyDx + storyDz * storyDz <= STORYBOOK_CLEAR_RADIUS_SQ;
          // The fixed meadow and creek bank fully replace natural height in the clearing.
        }
        const naturalHeight = fixedStoryGround ? 0 : this.heightAt(wx, wz);
        if (hasStorybook) {
          if (storyDx >= -STORYBOOK_BLEND_RADIUS && storyDx <= STORYBOOK_BLEND_RADIUS &&
              storyDz >= -STORYBOOK_BLEND_RADIUS && storyDz <= STORYBOOK_BLEND_RADIUS) {
            const profileIndex = (storyDx + STORYBOOK_BLEND_RADIUS) * STORYBOOK_PROFILE_SIZE + storyDz + STORYBOOK_BLEND_RADIUS;
            if (STORYBOOK_PROFILE_VALID[profileIndex]) {
              const streamLevel = STORYBOOK_PROFILE_STREAM[profileIndex];
              const blend = STORYBOOK_PROFILE_BLEND[profileIndex];
              const groundY = Math.max(2, Math.floor(STORYBOOK_PROFILE_TARGET[profileIndex] * (1 - blend) + naturalHeight * blend));
              const resolvedStream = streamLevel ? Math.max(1, Math.floor(streamLevel * (1 - blend) + SEA_LEVEL * blend)) : 0;
              story = (groundY << 8) | (resolvedStream << 1) | STORYBOOK_PROFILE_CLEARING[profileIndex];
            }
          }
          storyColumns[z * CHUNK + x] = story;
        }
        const storyGround = story ? story >>> 8 : naturalHeight;
        const storyStream = story ? (story >>> 1) & 0x7f : 0;
        const h = storyGround;
        const channel = storyStream > 0;
        const beach = channel || (this.worldType !== 'flat' && h <= SEA_LEVEL + 1);
        for (let y = 0; y <= h; y++) {
          let id;
          if (y === 0) id = 17;                        // bedrock floor
          else if (y === h) id = beach ? 5 : 1;       // grass or sand
          else if (y > h - 4) id = beach ? 5 : 2;     // dirt/sand under grass
          else id = 3;                                 // stone
          c.set(x, y, z, id);
        }
        const waterTop = channel ? storyStream : SEA_LEVEL;
        for (let y = h + 1; y <= waterTop; y++) {
          c.set(x, y, z, 12);                          // sea fill or welcome stream
        }
        // snow on high peaks
        if (h > SEA_LEVEL + 22) {
          for (let y = h - 1; y <= h; y++) {
            if (c.get(x, y, z) === 1) c.set(x, y, z, 13);
          }
        }
      }
    }
    this.decorate(c, storyColumns);
    const overrides = this.editsByChunk.get(this.key(c.cx, c.cz));
    if (overrides) for (const [index, id] of overrides) {
      c.blocks[index] = id;
      if (id !== 0) c.maxY = Math.max(c.maxY, Math.floor(index / (CHUNK * CHUNK)));
    }
    this.computeLight(c);
    c.generated = true;
    c.dirty = true;
    this.activeChunks.add(c);
  }

  // Trees, pumpkins and glowstone clusters. Deterministic per world position.
  decorate(c, storyColumns) {
    const ox = c.cx * CHUNK, oz = c.cz * CHUNK;
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) {
        const wx = ox + x, wz = oz + z;
        const r = hash2(wx + 104 - WORLD_CENTRE, wz + 104 - WORLD_CENTRE, this.seed + 4242);
        const surfaceY = this.surfaceY(c, x, z);
        if (surfaceY < 0) continue;
        const ground = c.get(x, surfaceY, z);
        const story = storyColumns ? storyColumns[z * CHUNK + x] : 0;
        const inClearing = !!(story & 1);
        if (this.worldType !== 'flat' && !inClearing &&
            r > 0.986 && ground === 1 && surfaceY + 7 < WORLD_H) {
          this.placeTree(c, x, surfaceY + 1, z);
        } else if (!inClearing && r > 0.978 && r < 0.984 && ground === 1) {
          c.set(x, surfaceY + 1, z, 14);
        }
        else if (r > 0.973 && r < 0.9765 && surfaceY > 6) {
          const gy = 2 + ((hash2(wx + 104 - WORLD_CENTRE, wz + 104 - WORLD_CENTRE, this.seed + 7) * (surfaceY - 4)) | 0);
          if (c.get(x, gy, z) === 3) c.set(x, gy, z, 11);
        }
        if (inClearing) this.decorateStorybookColumn(c, x, z, wx, wz, surfaceY);
      }
    }
  }

  storybookHouseBlock(dx, dz, y, house) {
    const localX = dx - house.x, localZ = dz - house.z;
    if (Math.abs(localX) > house.halfWidth || Math.abs(localZ) > house.halfDepth) return null;
    const base = STORYBOOK_GROUND;
    if (y === base) return 8;
    const level = y - base;
    const edge = Math.abs(localX) === house.halfWidth || Math.abs(localZ) === house.halfDepth;
    if (level >= 1 && level <= house.wallHeight && edge) {
      if (localX === 0 && localZ === house.halfDepth && level <= 2) return 0;
      if (level === 2 && Math.abs(localX) === house.halfWidth && localZ === 0) return 10;
      if (Math.abs(localX) === house.halfWidth && Math.abs(localZ) === house.halfDepth) return 7;
      return 8;
    }
    const roofLevel = level - house.wallHeight;
    if (roofLevel >= 1 && roofLevel <= house.halfWidth + 1 &&
        Math.abs(localX) <= house.halfWidth + 1 - roofLevel &&
        Math.abs(localZ) <= house.halfDepth + 1) return house.roof;
    return null;
  }

  storybookFeatureAt(dx, dz, y, surfaceY) {
    for (const house of STORYBOOK_HOUSES) {
      const block = this.storybookHouseBlock(dx, dz, y, house);
      if (block !== null) return block;
    }

    const { x: tx, z: tz } = STORYBOOK_TREEHOUSE, base = STORYBOOK_GROUND;
    const treeX = dx - tx, treeZ = dz - tz;
    const treehouseTrunk = (treeX === 0 && treeZ === 0) ||
      (Math.abs(treeX) === 3 && Math.abs(treeZ) === 3);
    if (treehouseTrunk && y >= base && y < base + STORYBOOK_TREEHOUSE_TRUNK) return 7;
    if (y === base + STORYBOOK_TREEHOUSE_TRUNK && Math.abs(treeX) <= 4 && Math.abs(treeZ) <= 4) return 8;
    const elevated = this.storybookHouseBlock(dx, dz, y - STORYBOOK_TREEHOUSE_TRUNK, STORYBOOK_TREEHOUSE);
    if (elevated !== null) return elevated;
    for (let layer = 0; layer < 5; layer++) {
      const leafY = base + STORYBOOK_TREEHOUSE_TRUNK + 1 + layer;
      const spread = STORYBOOK_TREEHOUSE_CANOPY[layer];
      if (y === leafY && Math.max(Math.abs(treeX), Math.abs(treeZ)) <= spread &&
          !(Math.abs(treeX) <= 2 && Math.abs(treeZ) <= 2 && layer < 3)) return 9;
    }

    for (const [cx, cz, height, canopyId] of STORYBOOK_TREES) {
      const ox = dx - cx, oz = dz - cz;
      if (ox === 0 && oz === 0 && y >= base && y < base + height) return 7;
      const layer = y - (base + height);
      const canopy = STORYBOOK_CANOPIES[canopyId];
      const spread = canopy[layer];
      if (spread !== undefined && Math.abs(ox) <= spread && Math.abs(oz) <= spread &&
          !(Math.abs(ox) === spread && Math.abs(oz) === spread && spread > 2)) return 9;
    }

    const inBridge = dx >= STORYBOOK_BRIDGE.minX && dx <= STORYBOOK_BRIDGE.maxX &&
      dz >= STORYBOOK_BRIDGE.minZ && dz <= STORYBOOK_BRIDGE.maxZ;
    if (inBridge) {
      const bridgeEdge = dx === STORYBOOK_BRIDGE.minX || dx === STORYBOOK_BRIDGE.maxX;
      const bridgePier = bridgeEdge && (dz === STORYBOOK_BRIDGE.minZ || dz === STORYBOOK_BRIDGE.maxZ ||
        (dz - STORYBOOK_BRIDGE.minZ) % 3 === 0);
      if (y === STORYBOOK_BRIDGE.deckY) return 8;
      if (bridgePier && y > surfaceY && y < STORYBOOK_BRIDGE.deckY) return 7;
      if (bridgePier && y === STORYBOOK_BRIDGE.deckY + 1) return 7;
    }

    if (y === surfaceY && !inBridge) {
      for (const path of STORYBOOK_PATHS) {
        for (let i = 1; i < path.length; i++) {
          const [x0, z0] = path[i - 1], [x1, z1] = path[i];
          const vx = x1 - x0, vz = z1 - z0;
          const lengthSquared = vx * vx + vz * vz || 1;
          const t = Math.max(0, Math.min(1, ((dx - x0) * vx + (dz - z0) * vz) / lengthSquared));
          const nearestX = x0 + vx * t, nearestZ = z0 + vz * t;
          if ((dx - nearestX) ** 2 + (dz - nearestZ) ** 2 <= 1.7) return 4;
        }
      }
    }

    for (let i = 0; i < STORYBOOK_FLOWER_PATCHES.length; i++) {
      const [px, pz, id, spread] = STORYBOOK_FLOWER_PATCHES[i];
      const fx = dx - px, fz = dz - pz;
      if (y === surfaceY + 1 && Math.abs(fx) <= spread && Math.abs(fz) <= spread &&
          Math.abs(fx) + Math.abs(fz) <= spread + 2) return id;
    }
    return null;
  }

  decorateStorybookColumn(c, x, z, wx, wz, surfaceY) {
    const dx = wx - WORLD_CENTRE, dz = wz - WORLD_CENTRE;
    if (!STORYBOOK_FEATURE_COLUMNS.has(dx * 256 + dz)) return;
    const lx = wx - c.cx * CHUNK, lz = wz - c.cz * CHUNK;
    for (let y = STORYBOOK_GROUND - 3; y <= STORYBOOK_GROUND + 18; y++) {
      const block = this.storybookFeatureAt(dx, dz, y, surfaceY);
      if (block !== null) c.set(lx, y, lz, block);
    }
  }

  placeTree(c, x, y, z) {
    const h = 4 + ((hash2(x, z, this.seed + 5) * 3) | 0);
    for (let i = 0; i < h; i++) {
      if (y + i < WORLD_H) c.set(x, y + i, z, 7);
    }
    // leaf canopy: two wide layers then a small cap
    for (let ly = 0; ly < 3; ly++) {
      const r = (ly === 0) ? 2 : (ly === 1 ? 2 : 1);
      const yy = y + h - 1 + ly;
      if (yy >= WORLD_H) continue;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx === 0 && dz === 0 && ly < 2) continue;
          // round off the corners of the widest layers
          if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
          const px = x + dx, pz = z + dz;
          if (px < 0 || px >= CHUNK || pz < 0 || pz >= CHUNK) continue;
          if (c.get(px, yy, pz) === 0) c.set(px, yy, pz, 9);
        }
      }
    }
    if (y + h + 2 < WORLD_H) c.set(x, y + h, z, 9);
  }

  // Highest solid, non-leaf block in this chunk column.
  surfaceY(c, x, z) {
    for (let y = WORLD_H - 1; y >= 0; y--) {
      const id = c.get(x, y, z);
      if (id !== 0 && id !== 12 && id !== 9) return y;
    }
    return -1;
  }

  // The same idea in world coordinates, skipping water, leaves and other
  // see-through blocks. Returns -1 for an empty column.
  findSurfaceY(x, z) {
    x = Math.floor(x);
    z = Math.floor(z);
    for (let y = WORLD_H - 1; y >= 0; y--) {
      const id = this.getBlock(x, y, z);
      if (id !== 0 && !isLiquid(id) && id !== 9) return y;
    }
    return -1;
  }

  // True when a player can stand here: solid ground with two blocks of clear
  // air above it. Used by spawn placement and animal scattering.
  isStandable(x, z) {
    const y = this.findSurfaceY(x, z);
    if (y < 0 || y + 2 >= WORLD_H) return false;
    return this.getBlock(x, y + 1, z) === 0 && this.getBlock(x, y + 2, z) === 0;
  }

  /* ---------- lighting ---------- */
  computeLight(c) {
    const ox = c.cx * CHUNK, oz = c.cz * CHUNK;
    // sunlight: full above the surface, fading under overhangs
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) {
        let level = 15;
        for (let y = WORLD_H - 1; y >= 0; y--) {
          const i = Chunk.idx(x, y, z);
          const id = c.blocks[i];
          if (id !== 0 && isOpaque(id)) level = 0;
          else if (isLiquid(id) || id === 9) level = Math.max(0, level - 1);
          c.light[i] = level;
        }
      }
    }
    this.bspreadSun(c);

    // block light from glowstone
    c.blockLight.fill(0);
    for (let y = 0; y < WORLD_H; y++) {
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          const id = c.blocks[Chunk.idx(x, y, z)];
          const l = lightOf(id);
          if (l > 0) {
            c.blockLight[Chunk.idx(x, y, z)] = l;
            this.pushBlockLight(c, x, y, z, l);
          }
        }
      }
    }
  }

  pushBlockLight(c, x, y, z, level) {
    if (level <= 1) return;
    level--;
    const nb = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    for (const [dx, dy, dz] of nb) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < 0 || nx >= CHUNK || nz < 0 || nz >= CHUNK || ny < 0 || ny >= WORLD_H) continue;
      const i = Chunk.idx(nx, ny, nz);
      const id = c.blocks[i];
      const target = (id === 0 || isLiquid(id) || id === 9) ? level : Math.min(level, lightOf(id) - 1);
      if (c.blockLight[i] < target) {
        c.blockLight[i] = Math.max(0, target);
        this.pushBlockLight(c, nx, ny, nz, c.blockLight[i]);
      }
    }
  }

  // Spread sunlight sideways into caves/overhangs.
  bspreadSun(c) {
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 40) {
      changed = false;
      for (let y = WORLD_H - 1; y >= 0; y--) {
        for (let z = 0; z < CHUNK; z++) {
          for (let x = 0; x < CHUNK; x++) {
            const i = Chunk.idx(x, y, z);
            if (c.light[i] === 0) continue;
            const id = c.blocks[i];
            if (id !== 0 && !isLiquid(id) && id !== 9) continue;
            for (let n = 0; n < SUN_SPREAD_DX.length; n++) {
              const nx = x + SUN_SPREAD_DX[n];
              const ny = y + SUN_SPREAD_DY[n];
              const nz = z + SUN_SPREAD_DZ[n];
              if (nx < 0 || nx >= CHUNK || nz < 0 || nz >= CHUNK || ny < 0 || ny >= WORLD_H) continue;
              const j = Chunk.idx(nx, ny, nz);
              const nid = c.blocks[j];
              if (nid !== 0 && !isLiquid(nid) && nid !== 9) continue;
              const next = c.light[i] - 1;
              if (next > c.light[j]) { c.light[j] = next; changed = true; }
            }
          }
        }
      }
    }
  }

  // After an edit, recompute lighting for the affected columns.
  relightColumn(x, z) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.getChunk(cx, cz, false);
    if (!c || !c.generated) return;
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;

    // sunlight for this column
    let level = 15;
    for (let y = WORLD_H - 1; y >= 0; y--) {
      const i = Chunk.idx(lx, y, lz);
      const id = c.blocks[i];
      if (id !== 0 && isOpaque(id)) level = 0;
      else if (isLiquid(id) || id === 9) level = Math.max(0, level - 1);
      c.light[i] = level;
    }
    this.bspreadSun(c);

    // rebuild block light for the whole chunk (glowstone is rare, this stays cheap)
    c.blockLight.fill(0);
    for (let y = 0; y < WORLD_H; y++) {
      for (let z = 0; z < CHUNK; z++) {
        for (let xx = 0; xx < CHUNK; xx++) {
          const l = lightOf(c.blocks[Chunk.idx(xx, y, z)]);
          if (l > 0) {
            c.blockLight[Chunk.idx(xx, y, z)] = l;
            this.pushBlockLight(c, xx, y, z, l);
          }
        }
      }
    }
  }

  /* ---------- build a flat arena for the fight mode ----------
     This writes tens of thousands of blocks, so it bypasses setBlock and
     its per-column relight. Lighting is recomputed once per touched chunk
     at the end, which turns ~70,000 relights into about 25. */
  buildArena(centerX, centerZ, radius) {
    radius = radius || 16;
    const baseY = SEA_LEVEL + 4;
    const touched = new Set();

    const put = (x, y, z, id) => {
      const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
      const c = this.getChunk(cx, cz, false);
      if (!c || !c.generated) return;
      const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
      if (y < 0 || y >= WORLD_H) return;
      c.blocks[Chunk.idx(lx, y, lz)] = id;
      if (id !== 0 && y > c.maxY) c.maxY = y;
      c.dirty = true;
      touched.add(this.key(cx, cz));
      // an edit on a chunk seam means the neighbour needs a re-mesh too
      if (lx === 0 || lx === CHUNK - 1 || lz === 0 || lz === CHUNK - 1) {
        const nx = lx === 0 ? cx - 1 : (lx === CHUNK - 1 ? cx + 1 : cx);
        const nz = lz === 0 ? cz - 1 : (lz === CHUNK - 1 ? cz + 1 : cz);
        const nc = this.getChunk(nx, nz, false);
        if (nc && nc.generated) { nc.dirty = true; touched.add(this.key(nx, nz)); }
      }
    };

    const outer = radius + 2;
    for (let dz = -outer; dz <= outer; dz++) {
      for (let dx = -outer; dx <= outer; dx++) {
        const d = Math.hypot(dx, dz);
        // clear the whole column, so leftover terrain never forms a ceiling
        for (let y = 0; y < WORLD_H; y++) put(centerX + dx, y, centerZ + dz, 0);
        if (d <= radius) {
          // Two solid floor blocks: baseY and baseY+1, leaving baseY+2 as the
          // surface the fighters stand on.
          for (let y = baseY; y <= baseY + 1; y++) put(centerX + dx, y, centerZ + dz, 4);
          if (d > radius - 1.5) {
            // low wall so nobody walks straight off the edge
            for (let y = baseY + 2; y <= baseY + 3; y++) put(centerX + dx, y, centerZ + dz, 4);
          }
        }
      }
    }

    // Pillars for cover. They must start above head height: a fighter is
    // 1.78 blocks tall standing on the surface at baseY+2, so the lowest
    // cover block belongs at baseY+4. Starting lower would put a solid block
    // where players spawn and walk.
    const pillars = [[-8, -8], [8, -8], [-8, 8], [8, 8], [0, 0]];
    for (const [dx, dz] of pillars) {
      const x = centerX + dx, z = centerZ + dz;
      for (let y = baseY + 4; y <= baseY + 6; y++) put(x, y, z, 6);
      put(x, baseY + 7, z, 11);
    }

    // one lighting pass per affected chunk
    touched.forEach((k) => {
      const c = this.chunks.get(k);
      if (c && c.generated) this.computeLight(c);
    });

    // y is the surface players stand on: the first block of clear air above
    // the floor, which is what a player's feet rest at.
    this.arena = {
      x: centerX, z: centerZ,
      y: baseY + 2,
      floorY: baseY + 1,
      wallY: baseY + 2,
      radius,
    };
    return this.arena;
  }

  // A flat, solid platform in the middle of the loaded area — safe spawn.
  findSpawn() {
    const ox = this.originX, oz = this.originZ;
    for (let r = 0; r < 30; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = Math.floor(ox) + dx, z = Math.floor(oz) + dz;
          if (this.isStandable(x, z)) {
            return [x + 0.5, this.findSurfaceY(x, z) + 1, z + 0.5];
          }
        }
      }
    }
    // Fallback: build a small platform so nobody spawns in mid-air.
    const fx = Math.floor(ox), fz = Math.floor(oz);
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        for (let y = SEA_LEVEL; y <= SEA_LEVEL + 3; y++) {
          this.setBlock(fx + dx, y, fz + dz, 0);
        }
        this.setBlock(fx + dx, SEA_LEVEL - 1, fz + dz, 2);
      }
    }
    return [fx + 0.5, SEA_LEVEL, fz + 0.5];
  }

  /* ---------- generation driver ----------
     Generate only a local region at startup. The renderer generates chunks
     as the player travels, then releases their arrays when far behind. */
  generateRadius(c0x, c0z, radius, onProgress) {
    this.setCentre(c0x, c0z);
    const loX = Math.max(0, Math.floor(c0x - radius));
    const hiX = Math.min(CHUNKS_PER_SIDE - 1, Math.floor(c0x + radius));
    const loZ = Math.max(0, Math.floor(c0z - radius));
    const hiZ = Math.min(CHUNKS_PER_SIDE - 1, Math.floor(c0z + radius));
    const total = (hiX - loX + 1) * (hiZ - loZ + 1);
    let done = 0;
    for (let cz = loZ; cz <= hiZ; cz++) {
      for (let cx = loX; cx <= hiX; cx++) {
        const c = this.getChunk(cx, cz, true);
        if (!c.generated) this.generateChunk(c);
        done++;
        if (onProgress) onProgress(done / total);
      }
    }
  }

  async generateRadiusAsync(c0x, c0z, radius, onProgress, circular) {
    this.setCentre(c0x, c0z);
    const loX = Math.max(0, Math.floor(c0x - radius));
    const hiX = Math.min(CHUNKS_PER_SIDE - 1, Math.floor(c0x + radius));
    const loZ = Math.max(0, Math.floor(c0z - radius));
    const hiZ = Math.min(CHUNKS_PER_SIDE - 1, Math.floor(c0z + radius));
    let total = 0;
    for (let cz = loZ; cz <= hiZ; cz++) {
      for (let cx = loX; cx <= hiX; cx++) {
        const dx = cx - c0x, dz = cz - c0z;
        if (!circular || dx * dx + dz * dz <= radius * radius) total++;
      }
    }
    let done = 0;
    for (let cz = loZ; cz <= hiZ; cz++) {
      for (let cx = loX; cx <= hiX; cx++) {
        const dx = cx - c0x, dz = cz - c0z;
        if (circular && dx * dx + dz * dz > radius * radius) continue;
        const c = this.getChunk(cx, cz, true);
        if (!c.generated) this.generateChunk(c);
        done++;
        if (onProgress) onProgress(done / total);
        if ((done & 1) === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }

  /* ---------- raycast for block picking ---------- */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
    const tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
    const tDeltaZ = dz === 0 ? Infinity : Math.abs(1 / dz);
    let tMaxX = dx === 0 ? Infinity : ((dx > 0 ? (x + 1 - ox) : (ox - x)) * tDeltaX);
    let tMaxY = dy === 0 ? Infinity : ((dy > 0 ? (y + 1 - oy) : (oy - y)) * tDeltaY);
    let tMaxZ = dz === 0 ? Infinity : ((dz > 0 ? (z + 1 - oz) : (oz - z)) * tDeltaZ);
    let nx = 0, ny = 0, nz = 0;
    let t = 0;

    for (let i = 0; i < 256 && t <= maxDist; i++) {
      const id = this.getBlock(x, y, z);
      if (id !== 0 && !isLiquid(id)) {
        return { hit: true, x, y, z, nx, ny, nz, dist: t, id };
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
      }
    }
    return { hit: false };
  }
}
