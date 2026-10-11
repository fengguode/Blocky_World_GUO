'use strict';
/* ============================================================
   blocks.js — block table + procedural pixel textures
   Every texture is generated in code, so there are no image
   files to load and the game works completely offline.
   ============================================================ */

const TILE = 16;
const ATLAS = [];   // [{ name, data:Uint8Array(TILE*TILE*4) }]

function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pushTile(name, fn) {
  const data = new Uint8Array(TILE * TILE * 4);
  const r = rng(0x9e3779b9 ^ ((ATLAS.length + 1) * 2654435761));
  fn(data, r);
  ATLAS.push({ name, data });
  return ATLAS.length - 1;
}

function setPx(d, x, y, r, g, b, a) {
  const i = (y * TILE + x) * 4;
  d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a === undefined ? 255 : a;
}

function tileFillRect(d, x, y, w, h, color) {
  for (let py = Math.max(0, y); py < Math.min(TILE, y + h); py++) {
    for (let px = Math.max(0, x); px < Math.min(TILE, x + w); px++) {
      setPx(d, px, py, color[0], color[1], color[2]);
    }
  }
}

function tileLine(d, x0, y0, x1, y1, color) {
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    if (x0 >= 0 && x0 < TILE && y0 >= 0 && y0 < TILE) setPx(d, x0, y0, color[0], color[1], color[2]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function patternedCloth(base, variance, draw) {
  return function (d, r) {
    speckle(base, variance)(d, r);
    draw(d, r);
  };
}

/* ============================================================
   Texture palette

   Deliberately not the muddy earth-and-moss look people expect from a voxel
   game. Everything is graded toward a cool, luminous futurist palette: deep
   slate and violet for earth, teal and emerald for growth, cyan as the
   signature accent. Tones are [r,g,b] bases; the speckle pass adds tonal
   variation on top of each.
   ============================================================ */
const PAL = {
  grassTop:   [58, 196, 150],  // luminous emerald teal
  dirt:       [74, 62, 96],     // deep slate violet
  stone:      [96, 108, 134],   // blue slate
  cobble:     [110, 124, 152],
  sand:       [214, 198, 150],  // pale gold
  brick:      [138, 86, 190],   // violet composite
  brickJoint: [66, 54, 92],
  logSide:    [86, 62, 106],    // plum
  logTop:     [156, 116, 196],
  planks:     [132, 100, 168],
  leaves:     [46, 178, 138],   // emerald
  glass:      [140, 236, 255],
  glow:       [120, 246, 255],  // cyan white, reads as emissive
  glowCore:   [216, 254, 255],
  water:      [40, 132, 200],   // deep cyan
  snow:       [226, 242, 250],
  bedrock:    [38, 40, 54],
  pumpkin:    [232, 126, 74],
  ice:        [150, 220, 245],
  gold:       [255, 208, 74],
  steel:      [178, 190, 210],
};

/* ---------- texture helpers ---------- */

// Fill with a base colour + per-pixel brightness noise.
function speckle(base, variance) {
  return function (d, r) {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = (r() - 0.5) * variance;
        setPx(d, x, y,
          clamp255(base[0] + n), clamp255(base[1] + n), clamp255(base[2] + n));
      }
    }
  };
}

// Blocky blotches — used for cobblestone, leaves, etc.
function blotch(base, count, size, variance) {
  return function (d, r) {
    speckle(base, variance * 0.5)(d, r);
    for (let i = 0; i < count; i++) {
      const cx = (r() * TILE) | 0, cy = (r() * TILE) | 0;
      const n = (r() - 0.5) * variance;
      const s = 1 + ((r() * size) | 0);
      for (let y = cy; y < cy + s; y++) {
        for (let x = cx; x < cx + s; x++) {
          if (x >= TILE || y >= TILE) continue;
          setPx(d, x, y, clamp255(base[0] + n), clamp255(base[1] + n), clamp255(base[2] + n));
        }
      }
    }
  };
}

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

// tiny deterministic 0..1 hash so textures look identical every run
function hashNoise(n) {
  let h = Math.imul(n ^ 0x27d4eb2d, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/* ---------- the tiles ---------- */
const T = {};

T.grass_top = pushTile('grass_top', speckle(PAL.grassTop, 26));
// grass side: dirt with a green fringe along the top edge
T.grass_side = pushTile('grass_side', function (d, r) {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const n = (r() - 0.5) * 26;
      // the turf fringe is a few pixels deep and wobbles a little per column
      const depth = 3 + ((hashNoise(x) * 2) | 0);
      const c = (y < depth) ? PAL.grassTop : PAL.dirt;
      setPx(d, x, y, clamp255(c[0] + n), clamp255(c[1] + n), clamp255(c[2] + n));
    }
  }
});
T.dirt       = pushTile('dirt',       speckle(PAL.dirt, 30));
T.stone      = pushTile('stone',      speckle(PAL.stone, 22));
T.cobble     = pushTile('cobble',     blotch(PAL.cobble, 16, 3, 34));
T.sand       = pushTile('sand',       speckle(PAL.sand, 20));
// Violet composite panel with a darker joint lattice.
T.brick      = pushTile('brick', function (d, r) {
  for (let y = 0; y < TILE; y++) {
    const row = (y / 4) | 0;
    const off = (row % 2) * 4;
    for (let x = 0; x < TILE; x++) {
      const inJoint = (y % 4 === 3) || ((x + off) % 8 === 7);
      const c = inJoint ? PAL.brickJoint : PAL.brick;
      const n = (r() - 0.5) * 16;
      setPx(d, x, y, clamp255(c[0] + n), clamp255(c[1] + n), clamp255(c[2] + n));
    }
  }
});
// Plum grain, running vertically.
T.log_side   = pushTile('log_side', function (d, r) {
  for (let x = 0; x < TILE; x++) {
    const stripe = ((x % 4) === 0) ? -22 : ((x % 4) === 1 ? 8 : 0);
    for (let y = 0; y < TILE; y++) {
      const n = (r() - 0.5) * 12;
      setPx(d, x, y,
        clamp255(PAL.logSide[0] + stripe + n),
        clamp255(PAL.logSide[1] + stripe + n),
        clamp255(PAL.logSide[2] + stripe + n));
    }
  }
});
// Concentric rings, as if cut from a crystal.
T.log_top    = pushTile('log_top', function (d, r) {
  const cxy = 7.5;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const dist = Math.hypot(x - cxy, y - cxy);
      const ring = Math.sin(dist * 2.2) * 14;
      const n = (r() - 0.5) * 10;
      setPx(d, x, y,
        clamp255(PAL.logTop[0] + ring + n),
        clamp255(PAL.logTop[1] + ring + n),
        clamp255(PAL.logTop[2] + ring + n));
    }
  }
});
// Amethyst panelling, so the common building block is not flat.
T.planks     = pushTile('planks', function (d, r) {
  for (let y = 0; y < TILE; y++) {
    const seam = (y % 4 === 3);
    for (let x = 0; x < TILE; x++) {
      const n = (r() - 0.5) * 14;
      let c = PAL.planks;
      if (seam) c = [PAL.planks[0] - 26, PAL.planks[1] - 26, PAL.planks[2] - 22];
      if ((y % 4 === 1) && (x % 8 === 5)) c = [PAL.planks[0] + 18, PAL.planks[1] + 14, PAL.planks[2] + 20];
      setPx(d, x, y, clamp255(c[0] + n), clamp255(c[1] + n), clamp255(c[2] + n));
    }
  }
});
// Emerald foliage, with a light rim so canopies glow at the edges.
T.leaves     = pushTile('leaves', function (d, r) {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      // ragged alpha edges so leaves read as foliage, not a solid cube
      const edge = (x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1);
      const holes = r() < 0.14;
      const rim = edge || (x === 1 || y === 1 || x === TILE - 2 || y === TILE - 2);
      const n = (r() - 0.5) * 30;
      const lift = rim ? 34 : 0;
      setPx(d, x, y,
        clamp255(PAL.leaves[0] + n + lift),
        clamp255(PAL.leaves[1] + n + lift),
        clamp255(PAL.leaves[2] + n + lift),
        (edge && r() < 0.4) || holes ? 0 : 255);
    }
  }
});
// Cyan-tinted pane with a bright frame and a diagonal highlight.
T.glass      = pushTile('glass', function (d) {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const border = (x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1);
      if (border) setPx(d, x, y, 178, 246, 255, 210);
      else {
        const shine = (x + y === 12 || x + y === 13);
        setPx(d, x, y,
          shine ? 226 : 120, shine ? 252 : 208, shine ? 255 : 232,
          shine ? 150 : 44);
      }
    }
  }
});
// An energy cell: bright cyan core inside a cooler casing.
T.glowstone  = pushTile('glowstone', function (d, r) {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const n = (r() - 0.5) * 26;
      const core = (Math.hypot(x - 4, y - 4) < 3) || (Math.hypot(x - 11, y - 10) < 2.5);
      const c = core ? PAL.glowCore : PAL.glow;
      setPx(d, x, y, clamp255(c[0] + n), clamp255(c[1] + n), clamp255(c[2] + n));
    }
  }
});
// Deep cyan with a travelling caustic, so water reads as lit from within.
T.water      = pushTile('water', function (d, r) {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const wave = Math.sin((x + y * 0.6) * 0.9) * 18;
      const n = (r() - 0.5) * 10;
      setPx(d, x, y,
        clamp255(PAL.water[0] + wave + n),
        clamp255(PAL.water[1] + wave + n),
        clamp255(PAL.water[2] + wave + n), 186);
    }
  }
});
T.snow       = pushTile('snow', speckle(PAL.snow, 14));
T.bedrock    = pushTile('bedrock', blotch(PAL.bedrock, 22, 4, 46));
// Warm amber pod, the one deliberately hot colour in the palette.
T.pumpkin    = pushTile('pumpkin', function (d, r) {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const rib = (x % 3 === 0) ? -26 : 0;
      const n = (r() - 0.5) * 12;
      setPx(d, x, y,
        clamp255(PAL.pumpkin[0] + rib + n),
        clamp255(PAL.pumpkin[1] + rib + n),
        clamp255(PAL.pumpkin[2] + n));
    }
  }
});
// Frosted cyan glass. Fully opaque so it belongs in the opaque pass.
T.ice        = pushTile('ice', function (d, r) {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const crack = (Math.abs((x * 3 + y * 5) % 17) < 1) ? -26 : 0;
      const n = (r() - 0.5) * 14;
      setPx(d, x, y,
        clamp255(PAL.ice[0] + crack + n),
        clamp255(PAL.ice[1] + crack + n),
        clamp255(PAL.ice[2] + n));
    }
  }
});
T.gold       = pushTile('gold', blotch(PAL.gold, 12, 3, 26));
T.steel      = pushTile('steel',      speckle(PAL.steel, 18));

// Character / mob skins -------------------------------------------------
T.skin       = pushTile('skin', speckle([226, 168, 130], 16));
T.skin_doll  = pushTile('skin_doll', speckle([244, 198, 176], 12));
T.hair_brown = pushTile('hair_brown', speckle([92, 62, 40], 18));
T.hair_blond = pushTile('hair_blond', speckle([214, 176, 92], 18));
T.hair_pink  = pushTile('hair_pink', speckle([236, 140, 190], 18));
T.hair_gold  = pushTile('hair_gold', speckle([246, 206, 84], 14));
T.shirt_blue = pushTile('shirt_blue', speckle([64, 108, 196], 14));
T.shirt_cyan = pushTile('shirt_cyan', speckle([72, 194, 208], 14));
T.shirt_red  = pushTile('shirt_red', speckle([206, 62, 62], 14));
T.shirt_pink = pushTile('shirt_pink', speckle([236, 128, 184], 14));
T.shirt_teal = pushTile('shirt_teal', speckle([58, 168, 148], 14));
T.pants      = pushTile('pants', speckle([62, 68, 122], 14));
T.pants_dark = pushTile('pants_dark', speckle([48, 52, 74], 14));
T.shoe       = pushTile('shoe', speckle([44, 44, 50], 14));
T.hero_red   = pushTile('hero_red', speckle([198, 44, 52], 16));
T.hero_blue  = pushTile('hero_blue', speckle([44, 82, 196], 16));
T.hair_ink   = pushTile('hair_ink', speckle([42, 51, 68], 14));
T.builder_shirt = pushTile('builder_shirt', patternedCloth([68, 126, 190], 18, function (d) {
  const seam = [34, 78, 132], check = [98, 160, 216], patch = [246, 194, 82];
  for (let x = 1; x < TILE; x += 5) tileLine(d, x, 0, x, TILE - 1, seam);
  for (let y = 3; y < TILE; y += 5) tileLine(d, 0, y, TILE - 1, y, seam);
  tileFillRect(d, 10, 5, 4, 4, check);
  tileFillRect(d, 11, 6, 2, 2, patch);
}));
T.ranger_shirt = pushTile('ranger_shirt', patternedCloth([40, 142, 126], 16, function (d) {
  tileLine(d, 2, 0, 10, 15, [24, 84, 85]);
  tileLine(d, 4, 0, 12, 15, [242, 184, 78]);
  tileFillRect(d, 10, 4, 5, 2, [28, 98, 94]);
  tileFillRect(d, 11, 5, 3, 1, [122, 212, 177]);
}));
T.climber_shirt = pushTile('climber_shirt', patternedCloth([30, 60, 80], 14, function (d) {
  const grip = [64, 218, 210], signal = [246, 204, 91];
  // Offset climbing lanes and grip pads: a parkour motif, with no web hub.
  tileLine(d, 1, 0, 6, 15, [38, 102, 120]);
  tileLine(d, 7, 0, 12, 15, [38, 102, 120]);
  tileLine(d, 2, 0, 7, 15, grip);
  tileLine(d, 8, 0, 13, 15, grip);
  tileFillRect(d, 0, 3, 3, 2, signal);
  tileFillRect(d, 9, 9, 3, 2, signal);
  tileFillRect(d, 13, 2, 2, 2, grip);
}));
T.dolly_dress = pushTile('dolly_dress', patternedCloth([178, 90, 172], 18, function (d) {
  const hem = [86, 206, 190], star = [255, 221, 112], highlight = [239, 157, 201];
  tileLine(d, 0, 12, 15, 12, hem);
  tileLine(d, 0, 14, 15, 14, [112, 72, 154]);
  tileFillRect(d, 3, 3, 2, 2, star); tileFillRect(d, 2, 4, 4, 1, star); tileFillRect(d, 3, 5, 2, 2, star);
  tileFillRect(d, 10, 6, 2, 2, highlight); tileFillRect(d, 9, 7, 4, 1, highlight); tileFillRect(d, 10, 8, 2, 2, highlight);
}));
T.dolly_leggings = pushTile('dolly_leggings', patternedCloth([106, 78, 154], 14, function (d) {
  tileFillRect(d, 2, 5, 3, 2, [91, 213, 197]);
  tileFillRect(d, 10, 5, 3, 2, [91, 213, 197]);
  tileLine(d, 0, 13, 15, 13, [222, 156, 222]);
}));
T.fire_ninja = pushTile('fire_ninja', patternedCloth([46, 42, 62], 16, function (d) {
  const flame = [246, 112, 54], ember = [255, 208, 98];
  tileLine(d, 1, 11, 4, 8, flame); tileLine(d, 4, 8, 6, 10, flame); tileLine(d, 6, 10, 9, 5, flame);
  tileLine(d, 9, 5, 12, 8, flame); tileLine(d, 12, 8, 15, 4, flame);
  tileFillRect(d, 3, 12, 2, 2, ember); tileFillRect(d, 10, 11, 2, 2, ember);
}));
T.eye        = pushTile('eye', function (d) {
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const dark = (x >= 5 && x <= 10 && y >= 5 && y <= 10);
    const iris = dark && (x === 5 || x === 10 || y === 5 || y === 10);
    setPx(d, x, y, iris ? 60 : (dark ? 28 : 0), iris ? 60 : (dark ? 28 : 0), iris ? 120 : (dark ? 28 : 0), dark ? 255 : 0);
  }
});
T.wool       = pushTile('wool', blotch([238, 238, 234], 10, 3, 18));
T.wolf       = pushTile('wolf', blotch([112, 122, 140], 12, 3, 22));
T.wolf_face  = pushTile('wolf_face', speckle([166, 174, 186], 18));
T.wolf_dark  = pushTile('wolf_dark', speckle([62, 73, 91], 14));
T.wolf_eye   = pushTile('wolf_eye', speckle([246, 199, 80], 8));
T.pig_skin   = pushTile('pig_skin', speckle([238, 150, 156], 16));
T.pig_snout  = pushTile('pig_snout', speckle([226, 118, 128], 14));
T.sheep_face = pushTile('sheep_face', speckle([158, 137, 119], 12));
T.chick      = pushTile('chick', speckle([246, 232, 148], 14));
T.chick_wing = pushTile('chick_wing', speckle([224, 197, 104], 12));
T.beak       = pushTile('beak', speckle([232, 168, 52], 14));

/* ============================================================
   Block table
   ============================================================ */
const AIR = 0;

// flags: solid(collides), opaque(blocks light+culling), cutout(alpha test), liquid, light(emission)
const BLOCKS = [
  { id: 0,  name: 'Air',      solid: false, opaque: false },
  { id: 1,  name: 'Grass',    solid: true,  opaque: true,  tiles: { top: T.grass_top, side: T.grass_side, bottom: T.dirt }, grass: true, hardness: 0.5 },
  { id: 2,  name: 'Dirt',     solid: true,  opaque: true,  tiles: { all: T.dirt } },
  { id: 3,  name: 'Stone',    solid: true,  opaque: true,  tiles: { all: T.stone } },
  { id: 4,  name: 'Cobble',   solid: true,  opaque: true,  tiles: { all: T.cobble }, hardness: 1.2 },
  { id: 5,  name: 'Sand',     solid: true,  opaque: true,  tiles: { all: T.sand } },
  { id: 6,  name: 'Bricks',   solid: true,  opaque: true,  tiles: { all: T.brick } },
  { id: 7,  name: 'Log',      solid: true,  opaque: true,  tiles: { top: T.log_top, side: T.log_side, bottom: T.log_top } },
  { id: 8,  name: 'Planks',   solid: true,  opaque: true,  tiles: { all: T.planks } },
  { id: 9,  name: 'Leaves',   solid: true,  opaque: false, cutout: true, tiles: { all: T.leaves } },
  { id: 10, name: 'Glass',    solid: true,  opaque: false, cutout: true, tiles: { all: T.glass } },
  { id: 11, name: 'Glowstone',solid: true,  opaque: true,  tiles: { all: T.glowstone }, light: 14 },
  { id: 12, name: 'Water',    solid: false, opaque: false, liquid: true, tiles: { all: T.water } },
  { id: 13, name: 'Snow',     solid: true,  opaque: true,  tiles: { all: T.snow } },
  { id: 14, name: 'Pumpkin',  solid: true,  opaque: true,  tiles: { all: T.pumpkin } },
  { id: 15, name: 'Ice',      solid: true,  opaque: true,  tiles: { all: T.ice } },
  { id: 16, name: 'Gold',     solid: true,  opaque: true,  tiles: { all: T.gold } },
  { id: 17, name: 'Bedrock',  solid: true,  opaque: true,  tiles: { all: T.bedrock }, unbreakable: true },
  // Flowing water stores its remaining horizontal reach in the block id.
  // These are internal states and are not offered in the hotbar.
  { id: 18, name: 'Flowing Water 4', solid: false, opaque: false, liquid: true, tiles: { all: T.water } },
  { id: 19, name: 'Flowing Water 3', solid: false, opaque: false, liquid: true, tiles: { all: T.water } },
  { id: 20, name: 'Flowing Water 2', solid: false, opaque: false, liquid: true, tiles: { all: T.water } },
  { id: 21, name: 'Flowing Water 1', solid: false, opaque: false, liquid: true, tiles: { all: T.water } },
];

for (const b of BLOCKS) {
  const t = b.tiles || {};
  b.top = (t.top !== undefined) ? t.top : (t.all !== undefined ? t.all : T.stone);
  b.side = (t.side !== undefined) ? t.side : (t.all !== undefined ? t.all : (t.top !== undefined ? t.top : T.stone));
  b.bottom = (t.bottom !== undefined) ? t.bottom : (t.all !== undefined ? t.all : (t.top !== undefined ? t.top : T.stone));
  if (t.side === undefined && t.all === undefined && t.top !== undefined) b.side = t.top;
}

// Blocks offered in the hotbar, in order.
const HOTBAR_BLOCKS = [1, 3, 4, 2, 8, 7, 9, 11, 16];
// Append tools so saved block slot numbers keep their meaning.
const HOTBAR_ITEMS = HOTBAR_BLOCKS.map(id => ({ kind: 'block', id, name: BLOCKS[id].name }))
  .concat([{ kind: 'tool', id: 'shovel', name: 'Shovel' }]);

function isSolid(id)  { return BLOCKS[id] ? !!BLOCKS[id].solid : false; }
function isOpaque(id) { return BLOCKS[id] ? !!BLOCKS[id].opaque : false; }
function isLiquid(id) { return BLOCKS[id] ? !!BLOCKS[id].liquid : false; }
function isCutout(id) { return BLOCKS[id] ? !!BLOCKS[id].cutout : false; }
function isGrass(id)  { return BLOCKS[id] ? !!BLOCKS[id].grass : false; }
function lightOf(id)  { return BLOCKS[id] && BLOCKS[id].light ? BLOCKS[id].light : 0; }

/* ---------- build the GPU texture array ---------- */
function buildBlockTexture(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texImage3D(
    gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8,
    TILE, TILE, ATLAS.length, 0,
    gl.RGBA, gl.UNSIGNED_BYTE, null
  );
  for (let i = 0; i < ATLAS.length; i++) {
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, TILE, TILE, 1,
      gl.RGBA, gl.UNSIGNED_BYTE, ATLAS[i].data
    );
  }
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const ext = gl.getExtension('EXT_texture_filter_anisotropic');
  if (ext) {
    const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    gl.texParameterf(gl.TEXTURE_2D_ARRAY, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
  }
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  return tex;
}

// Render one block's icon into a small canvas for the hotbar UI.
function blockIconCanvas(id, size) {
  size = size || 38;
  const b = BLOCKS[id];
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const src = ATLAS[b.side].data;
  const tmp = document.createElement('canvas');
  tmp.width = TILE; tmp.height = TILE;
  const tctx = tmp.getContext('2d');
  const img = tctx.createImageData(TILE, TILE);
  img.data.set(src);
  tctx.putImageData(img, 0, 0);
  // fake top-down lighting so the icon reads as a cube
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, 'rgba(255,255,255,0.28)');
  g.addColorStop(0.5, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.drawImage(tmp, 0, 0, size, size);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}
