'use strict';
/* ============================================================
   world.js — chunked voxel world + terrain generation
   ============================================================ */

const CHUNK = 16;          // chunk footprint in blocks

// World dimensions, as asked for: 200 long x 200 wide x 100 high.
// 200 is not a multiple of 16, so the loaded chunk grid is rounded up to
// 13x13 (208 blocks) and the playable area is clamped to the true 200.
const WORLD_SIZE = 200;
const WORLD_H = 100;
const SEA_LEVEL = 20;

const CHUNKS_PER_SIDE = Math.ceil(WORLD_SIZE / CHUNK);          // 13
const CENTRE_CHUNK = Math.floor(CHUNKS_PER_SIDE / 2);           // 6
// Centre of the playable square, in blocks.
const WORLD_CENTRE = CENTRE_CHUNK * CHUNK + CHUNK / 2;          // 104
// Keep block edits and spawning inside the chunk grid.
const MIN_EDGE = CENTRE_CHUNK * CHUNK;                         // 96
const MAX_EDGE = MIN_EDGE + CHUNKS_PER_SIDE * CHUNK;           // 304

const inWorldXZ = (x, z) =>
  x >= MIN_EDGE && x < MAX_EDGE && z >= MIN_EDGE && z < MAX_EDGE;

/* ---------- value noise (fast, deterministic, no deps) ---------- */
function hash2(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t) { return t * t * (3 - 2 * t); }

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
    this.blocks = new Uint8Array(CHUNK * WORLD_H * CHUNK);
    this.light = new Uint8Array(CHUNK * WORLD_H * CHUNK);   // sunlight 0-15
    this.blockLight = new Uint8Array(CHUNK * WORLD_H * CHUNK);
    this.generated = false;
    this.dirty = true;
    this.mesh = null;       // opaque mesh
    this.meshWater = null;  // transparent mesh
  }

  static idx(x, y, z) { return (y * CHUNK + z) * CHUNK + x; }

  get(x, y, z) {
    if (y < 0 || y >= WORLD_H) return 0;
    return this.blocks[Chunk.idx(x, y, z)];
  }

  set(x, y, z, id) {
    if (y < 0 || y >= WORLD_H) return;
    this.blocks[Chunk.idx(x, y, z)] = id;
  }
}

/* ============================================================
   World
   ============================================================ */
class World {
  constructor(seed, savedEdits) {
    this.seed = (seed === undefined || seed === null) ? 1337 : (seed | 0);
    this.chunks = new Map();
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

  // True when a block coordinate lies inside the playable square. The
  // playable area is 200x200 centred on WORLD_CENTRE; the surrounding chunk
  // ring exists only so lighting and meshing have valid neighbours.
  isInsideWorld(x, z) {
    const half = WORLD_SIZE / 2;
    return Math.abs(x - WORLD_CENTRE) <= half && Math.abs(z - WORLD_CENTRE) <= half;
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
    c.blocks[Chunk.idx(x - cx * CHUNK, y, z - cz * CHUNK)] = id;
    this.recordEdit(x, y, z, id);
    if (window.Network && Network.serverMode) Network.queueSharedEdit(x, y, z, id);
    c.dirty = true;
    this.markNeighbourChunksDirty(x, y, z);
    // relight the column and neighbours
    this.relightColumn(x, z);
    return true;
  }

  applyRemoteEdit(x, y, z, id) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (!inWorldXZ(x, z) || y < 1 || y >= WORLD_H || !Number.isInteger(id) || id < 0 || id > 255) return false;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.getChunk(cx, cz, false);
    this.recordEdit(x, y, z, id);
    if (c && c.generated) {
      c.blocks[Chunk.idx(x - cx * CHUNK, y, z - cz * CHUNK)] = id;
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
  heightAt(x, z) {
    const s = this.seed;
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
    const ox = c.cx * CHUNK, oz = c.cz * CHUNK;
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) {
        const wx = ox + x, wz = oz + z;
        const h = this.heightAt(wx, wz);
        const beach = h <= SEA_LEVEL + 1;
        for (let y = 0; y <= h; y++) {
          let id;
          if (y === 0) id = 17;                        // bedrock floor
          else if (y === h) id = beach ? 5 : 1;       // grass or sand
          else if (y > h - 4) id = beach ? 5 : 2;     // dirt/sand under grass
          else id = 3;                                 // stone
          c.set(x, y, z, id);
        }
        for (let y = h + 1; y <= SEA_LEVEL; y++) {
          c.set(x, y, z, 12);                          // water fill
        }
        // snow on high peaks
        if (h > SEA_LEVEL + 22) {
          for (let y = h - 1; y <= h; y++) {
            if (c.get(x, y, z) === 1) c.set(x, y, z, 13);
          }
        }
      }
    }
    this.decorate(c);
    const overrides = this.editsByChunk.get(this.key(c.cx, c.cz));
    if (overrides) for (const [index, id] of overrides) c.blocks[index] = id;
    this.computeLight(c);
    c.generated = true;
    c.dirty = true;
  }

  // Trees, pumpkins and glowstone clusters. Deterministic per world position.
  decorate(c) {
    const ox = c.cx * CHUNK, oz = c.cz * CHUNK;
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) {
        const wx = ox + x, wz = oz + z;
        const r = hash2(wx, wz, this.seed + 4242);
        const surfaceY = this.surfaceY(c, x, z);
        if (surfaceY < 0) continue;
        const ground = c.get(x, surfaceY, z);

        // trees on grass, away from water
        if (r > 0.986 && ground === 1 && surfaceY + 7 < WORLD_H) {
          this.placeTree(c, x, surfaceY + 1, z);
        }
        // pumpkins
        else if (r > 0.978 && r < 0.984 && ground === 1) {
          c.set(x, surfaceY + 1, z, 14);
        }
        // glowstone underground pockets
        else if (r > 0.973 && r < 0.9765 && surfaceY > 6) {
          const gy = 2 + ((hash2(wx, wz, this.seed + 7) * (surfaceY - 4)) | 0);
          if (c.get(x, gy, z) === 3) c.set(x, gy, z, 11);
        }
      }
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
          else if (id === 12 || id === 9) level = Math.max(0, level - 1);
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
      const target = (id === 0 || id === 12 || id === 9) ? level : Math.min(level, lightOf(id) - 1);
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
            if (id !== 0 && id !== 12 && id !== 9) continue;
            const nb = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,-1,0]];
            for (const [dx, dy, dz] of nb) {
              const nx = x + dx, ny = y + dy, nz = z + dz;
              if (nx < 0 || nx >= CHUNK || nz < 0 || nz >= CHUNK || ny < 0 || ny >= WORLD_H) continue;
              const j = Chunk.idx(nx, ny, nz);
              const nid = c.blocks[j];
              if (nid !== 0 && nid !== 12 && nid !== 9) continue;
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
      else if (id === 12 || id === 9) level = Math.max(0, level - 1);
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
     Generates the full 13x13 chunk grid covering the world. The render
     distance then controls how much of it is drawn, rather than how much
     of it exists. A 100 block tall column also holds far more water and
     rock than before, so the height budget was raised. */
  generateRadius(c0x, c0z, radius, onProgress) {
    void radius;   // the whole world is always generated
    this.setCentre(CENTRE_CHUNK, CENTRE_CHUNK);
    let done = 0;
    const total = CHUNKS_PER_SIDE * CHUNKS_PER_SIDE;
    for (let cz = 0; cz < CHUNKS_PER_SIDE; cz++) {
      for (let cx = 0; cx < CHUNKS_PER_SIDE; cx++) {
        const c = this.getChunk(cx, cz, true);
        if (!c.generated) this.generateChunk(c);
        done++;
        if (onProgress) onProgress(done / total);
      }
    }
    // Now that every neighbour exists, recompute lighting for the interior so
    // it is correct from the very first frame rather than filling in later.
    const lo = MIN_EDGE / CHUNK;
    const hi = MAX_EDGE / CHUNK;
    for (let cz = lo + 1; cz < hi - 1; cz++) {
      for (let cx = lo + 1; cx < hi - 1; cx++) {
        const c = this.getChunk(cx, cz, false);
        if (c && c.generated) { this.computeLight(c); c.dirty = true; }
      }
    }
    void c0x; void c0z;
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
