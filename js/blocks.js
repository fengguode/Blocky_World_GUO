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

// World materials use deliberate pixel clusters, not independent per-pixel noise.
// Small row-pattern stamps keep each 16x16 tile readable when nearest-neighbour scaled.
function shadeColor(base, amount) {
  return [clamp255(base[0] + amount), clamp255(base[1] + amount), clamp255(base[2] + amount)];
}

function fillTile(d, color, alpha) {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) setPx(d, x, y, color[0], color[1], color[2], alpha === undefined ? 255 : alpha);
  }
}

function stampTile(d, x, y, rows, colors, alpha) {
  for (let py = 0; py < rows.length; py++) {
    for (let px = 0; px < rows[py].length; px++) {
      const color = colors[rows[py][px]];
      if (color && x + px >= 0 && x + px < TILE && y + py >= 0 && y + py < TILE) {
        setPx(d, x + px, y + py, color[0], color[1], color[2], alpha === undefined ? 255 : alpha);
      }
    }
  }
}

function pixelArtTile(base, motifs, alpha) {
  return function (d) {
    fillTile(d, base, alpha);
    for (const motif of motifs) stampTile(d, motif.x, motif.y, motif.rows, motif.colors, alpha);
  };
}

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

// Small deterministic drawing helpers for the character outfit tiles.
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

function patternedCloth(base, draw) {
  return function (d) {
    fillTile(d, base);
    draw(d);
  };
}

function speckle(base, variance) {
  return function (d, r) {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const n = (r() - 0.5) * variance;
      setPx(d, x, y, clamp255(base[0] + n), clamp255(base[1] + n), clamp255(base[2] + n));
    }
  };
}

function blotch(base, count, size, variance) {
  return function (d, r) {
    speckle(base, variance * 0.5)(d, r);
    for (let i = 0; i < count; i++) {
      const cx = (r() * TILE) | 0, cy = (r() * TILE) | 0;
      const n = (r() - 0.5) * variance, s = 1 + ((r() * size) | 0);
      for (let y = cy; y < cy + s; y++) for (let x = cx; x < cx + s; x++) {
        if (x >= TILE || y >= TILE) continue;
        setPx(d, x, y, clamp255(base[0] + n), clamp255(base[1] + n), clamp255(base[2] + n));
      }
    }
  };
}

// tiny deterministic 0..1 hash for the legacy character skin textures
function hashNoise(n) {
  let h = Math.imul(n ^ 0x27d4eb2d, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/* ---------- the tiles ---------- */
const T = {};

const grassDark = shadeColor(PAL.grassTop, -40);
const grassLight = shadeColor(PAL.grassTop, 25);
const dirtDark = shadeColor(PAL.dirt, -22);
const dirtLight = shadeColor(PAL.dirt, 18);
const stoneDark = shadeColor(PAL.stone, -34);
const stoneLight = shadeColor(PAL.stone, 24);
const woodDark = shadeColor(PAL.logSide, -25);
const woodLight = shadeColor(PAL.logSide, 24);
const plankDark = shadeColor(PAL.planks, -28);
const plankLight = shadeColor(PAL.planks, 24);

T.grass_top = pushTile('grass_top', pixelArtTile(PAL.grassTop, [
  { x: 0, y: 0, rows: ['  l  ', ' lhl ', 'dhhdh', ' dhd '], colors: { l: grassLight, h: PAL.grassTop, d: grassDark } },
  { x: 9, y: 1, rows: [' l ', 'hhl', 'dhd', ' h '], colors: { l: grassLight, h: PAL.grassTop, d: grassDark } },
  { x: 4, y: 9, rows: ['  l ', ' dhd', 'hhdh', '  h '], colors: { l: grassLight, h: PAL.grassTop, d: grassDark } },
  { x: 12, y: 11, rows: [' l ', 'hhd', ' dh', ' h '], colors: { l: grassLight, h: PAL.grassTop, d: grassDark } },
  { x: 1, y: 13, rows: ['  l ', ' dhd', 'hhdh'], colors: { l: grassLight, h: PAL.grassTop, d: grassDark } },
]));
// A stepped turf edge with tufts above layered earth.
T.grass_side = pushTile('grass_side', function (d) {
  fillTile(d, PAL.dirt);
  const edge = [3, 2, 3, 4, 3, 2, 3, 3, 4, 3, 2, 3, 4, 3, 2, 3];
  for (let x = 0; x < TILE; x++) {
    for (let y = 0; y < edge[x]; y++) setPx(d, x, y, PAL.grassTop[0], PAL.grassTop[1], PAL.grassTop[2]);
    setPx(d, x, edge[x], grassDark[0], grassDark[1], grassDark[2]);
  }
  stampTile(d, 1, 0, ['  l ', ' hhd', 'dd  '], { l: grassLight, h: PAL.grassTop, d: grassDark });
  stampTile(d, 10, 0, [' l  ', 'hhd ', '  d '], { l: grassLight, h: PAL.grassTop, d: grassDark });
  const strata = [
    { x: 0, y: 7, rows: ['ddddd', ' hhhh'], colors: { d: dirtDark, h: dirtLight } },
    { x: 8, y: 11, rows: [' hhhhhh', 'ddddddd'], colors: { d: dirtDark, h: dirtLight } },
    { x: 2, y: 14, rows: [' ddddd'], colors: { d: dirtDark } },
  ];
  for (const motif of strata) stampTile(d, motif.x, motif.y, motif.rows, motif.colors);
});
T.dirt = pushTile('dirt', pixelArtTile(PAL.dirt, [
  { x: 1, y: 2, rows: ['ddddd', 'dlll ', ' dhd '], colors: { d: dirtDark, l: dirtLight, h: PAL.dirt } },
  { x: 9, y: 5, rows: ['  dddd', ' lll d', ' d h  '], colors: { d: dirtDark, l: dirtLight, h: PAL.dirt } },
  { x: 3, y: 11, rows: [' dddd ', 'dllll', ' dhd '], colors: { d: dirtDark, l: dirtLight, h: PAL.dirt } },
  { x: 12, y: 13, rows: ['ddd ', 'llld'], colors: { d: dirtDark, l: dirtLight } },
]));
T.stone = pushTile('stone', pixelArtTile(PAL.stone, [
  { x: 2, y: 2, rows: ['lllldd', 'llldd ', ' dd   '], colors: { l: stoneLight, d: stoneDark } },
  { x: 9, y: 5, rows: ['dd   ', ' ddll', '  llll'], colors: { l: stoneLight, d: stoneDark } },
  { x: 1, y: 11, rows: ['   dd', 'ddll ', ' llll'], colors: { l: stoneLight, d: stoneDark } },
  { x: 11, y: 12, rows: ['llldd', ' dd  '], colors: { l: stoneLight, d: stoneDark } },
]));
T.cobble = pushTile('cobble', pixelArtTile(shadeColor(PAL.cobble, -38), [
  { x: 0, y: 0, rows: [' hhhh  ', 'hllllh ', 'hllllhh', ' hhhhhh'], colors: { h: PAL.cobble, l: shadeColor(PAL.cobble, 22) } },
  { x: 8, y: 1, rows: [' hhhh  ', 'hllllhh', 'hllllh ', ' hhhh  '], colors: { h: PAL.cobble, l: shadeColor(PAL.cobble, 22) } },
  { x: 3, y: 7, rows: [' hhhh  ', 'hllllh ', 'hllllhh', ' hhhhhh'], colors: { h: PAL.cobble, l: shadeColor(PAL.cobble, 22) } },
  { x: 11, y: 9, rows: [' hhhh ', 'hllllh', 'hllllh', ' hhhh '], colors: { h: PAL.cobble, l: shadeColor(PAL.cobble, 22) } },
  { x: 0, y: 12, rows: [' hhhh ', 'hllllh', ' hhhh '], colors: { h: PAL.cobble, l: shadeColor(PAL.cobble, 22) } },
  { x: 7, y: 13, rows: [' hhhh ', 'hllllh', ' hhhh '], colors: { h: PAL.cobble, l: shadeColor(PAL.cobble, 22) } },
]));
T.sand = pushTile('sand', pixelArtTile(PAL.sand, [
  { x: 0, y: 2, rows: ['  hhhhhh', 'hhhhh   ', '   llll '], colors: { h: shadeColor(PAL.sand, 20), l: shadeColor(PAL.sand, -22) } },
  { x: 7, y: 7, rows: ['  hhhhhhh', 'hhhhh    ', '   lllll '], colors: { h: shadeColor(PAL.sand, 20), l: shadeColor(PAL.sand, -22) } },
  { x: 1, y: 12, rows: ['  hhhhhh', 'hhhhh   ', '   llll '], colors: { h: shadeColor(PAL.sand, 20), l: shadeColor(PAL.sand, -22) } },
  { x: 11, y: 0, rows: ['lll', ' hh'], colors: { l: shadeColor(PAL.sand, -22), h: shadeColor(PAL.sand, 20) } },
]));
// Staggered masonry with violet faces, deep joints, and a one-pixel top highlight.
T.brick = pushTile('brick', function (d) {
  fillTile(d, PAL.brickJoint);
  for (let row = 0; row < 4; row++) {
    const y = row * 4;
    const offset = (row % 2) * 4;
    for (let x = -offset; x < TILE; x += 8) {
      for (let py = 0; py < 3; py++) {
        for (let px = 0; px < 7; px++) {
          const xx = x + px;
          if (xx < 0 || xx >= TILE) continue;
          const c = py === 0 ? shadeColor(PAL.brick, 18) : PAL.brick;
          setPx(d, xx, y + py, c[0], c[1], c[2]);
        }
      }
    }
  }
});
T.log_side = pushTile('log_side', pixelArtTile(PAL.logSide, [
  { x: 1, y: 0, rows: ['dd', 'll', 'dd', '  ', 'dd', 'll', 'dd', '  '], colors: { d: woodDark, l: woodLight } },
  { x: 6, y: 2, rows: ['dd', 'll', 'dd', '  ', 'dd', 'll', 'dd', '  '], colors: { d: woodDark, l: woodLight } },
  { x: 12, y: 0, rows: ['dd', 'll', 'dd', '  ', 'dd', 'll', 'dd', '  '], colors: { d: woodDark, l: woodLight } },
  { x: 4, y: 6, rows: ['  lllll ', ' lhhhhh l', '  lllll ', '   dd   '], colors: { l: woodLight, h: PAL.logSide, d: woodDark } },
]));
// Square growth rings and a stepped centre knot.
T.log_top = pushTile('log_top', function (d) {
  const shades = [PAL.logTop, shadeColor(PAL.logTop, -18), shadeColor(PAL.logTop, 14), shadeColor(PAL.logTop, -30)];
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const ring = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5)) | 0;
      const c = shades[Math.floor(ring / 2) % shades.length];
      setPx(d, x, y, c[0], c[1], c[2]);
    }
  }
  stampTile(d, 6, 6, ['dd', 'dk'], { d: shadeColor(PAL.logTop, -30), k: shadeColor(PAL.logTop, 22) });
});
T.planks = pushTile('planks', function (d) {
  fillTile(d, PAL.planks);
  for (let y = 0; y < TILE; y++) {
    if (y % 5 === 4) {
      for (let x = 0; x < TILE; x++) {
        const c = shadeColor(PAL.planks, -34);
        setPx(d, x, y, c[0], c[1], c[2]);
      }
    } else {
      for (let x = 0; x < TILE; x += 8) {
        if ((y % 5 === 2) && (x === 0 || x === 8)) {
          setPx(d, x, y, plankDark[0], plankDark[1], plankDark[2]);
        }
      }
      if (y % 5 === 1) {
        for (let x = 1; x < 7; x++) setPx(d, x, y, plankLight[0], plankLight[1], plankLight[2]);
        for (let x = 9; x < 15; x++) setPx(d, x, y, plankLight[0], plankLight[1], plankLight[2]);
      }
    }
  }
  stampTile(d, 3, 6, ['ddd', 'dhh', 'ddd'], { d: plankDark, h: plankLight });
  stampTile(d, 12, 11, ['ddd', 'dhh', 'ddd'], { d: plankDark, h: plankLight });
});
// Leaf clusters use a fixed cutout silhouette and bright pixel clusters.
T.leaves = pushTile('leaves', function (d) {
  const dark = shadeColor(PAL.leaves, -38);
  const light = shadeColor(PAL.leaves, 28);
  const mid = PAL.leaves;
  const holes = [
    '   000000000   ',
    '  00000000000  ',
    ' 0000000000000 ',
    '000000000000000',
    '000000000000000',
    '000000000000000',
    '000000000000000',
    '000000000000000',
    '000000000000000',
    ' 0000000000000 ',
    '  00000000000  ',
    '   000000000   ',
    '    0000000    ',
    '     00000     ',
    '      000      ',
    '       0       ',
  ];
  const clusters = [
    ['  ggg ', ' glllg', 'glllgg', 'gggg  '],
    [' ggg ', 'glllg', 'gggg '],
    ['  ggg ', ' glllg', '  ggg '],
    [' gggg ', 'gllggg', ' ggg  '],
  ];
  fillTile(d, mid, 255);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      if (holes[y][x] === '0') setPx(d, x, y, mid[0], mid[1], mid[2], 0);
    }
  }
  const palette = { g: dark, l: light };
  stampTile(d, 0, 1, clusters[0], palette);
  stampTile(d, 7, 0, clusters[1], palette);
  stampTile(d, 10, 7, clusters[2], palette);
  stampTile(d, 2, 10, clusters[3], palette);
  stampTile(d, 12, 12, ['  gg ', ' gllg', '  gg '], palette);
});
T.glass = pushTile('glass', function (d) {
  fillTile(d, [120, 208, 232], 42);
  const frame = [178, 246, 255];
  const shine = [226, 252, 255];
  for (let p = 0; p < TILE; p++) {
    setPx(d, p, 0, frame[0], frame[1], frame[2], 210);
    setPx(d, p, 15, frame[0], frame[1], frame[2], 210);
    setPx(d, 0, p, frame[0], frame[1], frame[2], 210);
    setPx(d, 15, p, frame[0], frame[1], frame[2], 210);
  }
  stampTile(d, 3, 3, ['s ', 'ss', ' s'], { s: shine }, 225);
  stampTile(d, 10, 9, ['s ', 'ss'], { s: shine }, 225);
  stampTile(d, 5, 6, ['  ss', 'ss  '], { s: [164, 232, 248] }, 190);
});
T.glowstone = pushTile('glowstone', pixelArtTile(PAL.glow, [
  { x: 1, y: 1, rows: ['   c   ', '  ccc  ', ' ccc c ', 'ccccccc', ' ccc c ', '  ccc  ', '   c   '], colors: { c: PAL.glowCore } },
  { x: 10, y: 9, rows: ['  c  ', ' ccc ', 'ccccc', ' ccc ', '  c  '], colors: { c: PAL.glowCore } },
]));
// Stacked stepped caustics make the water reads as deliberate pixel waves.
T.water = pushTile('water', function (d) {
  fillTile(d, PAL.water, 186);
  const lit = shadeColor(PAL.water, 24);
  const dark = shadeColor(PAL.water, -22);
  const waveA = [3, 3, 4, 4, 5, 5, 4, 4, 3, 3, 2, 2, 3, 3, 4, 4];
  const waveB = [10, 11, 11, 12, 12, 11, 10, 10, 9, 9, 10, 10, 11, 11, 10, 10];
  for (let x = 0; x < TILE; x++) {
    setPx(d, x, waveA[x], lit[0], lit[1], lit[2], 220);
    setPx(d, x, waveA[x] + 1, dark[0], dark[1], dark[2], 186);
    setPx(d, x, waveB[x], lit[0], lit[1], lit[2], 220);
    if (x % 4 < 2) setPx(d, x, waveB[x] + 1, dark[0], dark[1], dark[2], 186);
  }
  stampTile(d, 2, 2, ['ll  ', '  ll'], { l: lit }, 220);
  stampTile(d, 11, 7, [' ll ', 'll  '], { l: lit }, 220);
});
T.snow = pushTile('snow', pixelArtTile(PAL.snow, [
  { x: 1, y: 2, rows: ['  b  ', '  b  ', 'bbhbb', '  b  ', '  b  '], colors: { b: shadeColor(PAL.snow, -24), h: shadeColor(PAL.snow, 15) } },
  { x: 9, y: 0, rows: [' b ', 'b b', ' bh', 'b b', ' b '], colors: { b: shadeColor(PAL.snow, -24), h: shadeColor(PAL.snow, 15) } },
  { x: 9, y: 10, rows: ['  bb ', 'bbhbb', '  bb '], colors: { b: shadeColor(PAL.snow, -24), h: shadeColor(PAL.snow, 15) } },
  { x: 0, y: 13, rows: ['bb ', ' hh', '  bb'], colors: { b: shadeColor(PAL.snow, -24), h: shadeColor(PAL.snow, 15) } },
]));
T.bedrock = pushTile('bedrock', pixelArtTile(PAL.bedrock, [
  { x: 0, y: 2, rows: ['ddddd  ', '   dddd', ' ddd   '], colors: { d: shadeColor(PAL.bedrock, 22) } },
  { x: 7, y: 6, rows: ['  dddddd', 'dddd    ', '   dddd '], colors: { d: shadeColor(PAL.bedrock, -16) } },
  { x: 1, y: 12, rows: ['dddddd  ', '    dddd', ' dd    '], colors: { d: shadeColor(PAL.bedrock, 22) } },
]));
T.pumpkin = pushTile('pumpkin', function (d) {
  fillTile(d, PAL.pumpkin);
  const shadow = shadeColor(PAL.pumpkin, -34);
  const shine = shadeColor(PAL.pumpkin, 22);
  const ribs = [1, 4, 7, 10, 13];
  for (const x of ribs) {
    for (let y = 0; y < TILE; y++) {
      const c = x === 7 ? shine : shadow;
      setPx(d, x, y, c[0], c[1], c[2]);
      if (x > 0) setPx(d, x - 1, y, PAL.pumpkin[0], PAL.pumpkin[1], PAL.pumpkin[2]);
    }
  }
  stampTile(d, 5, 2, ['  ss  ', ' ssss ', 'ss  ss'], { s: shine });
  stampTile(d, 9, 10, ['ss ', ' ss', '  s'], { s: shine });
});
T.ice = pushTile('ice', pixelArtTile(PAL.ice, [
  { x: 1, y: 2, rows: ['ll   ', '  ll ', '   dd', '  d  '], colors: { l: shadeColor(PAL.ice, 28), d: shadeColor(PAL.ice, -32) } },
  { x: 8, y: 1, rows: ['  dd  ', ' ll d ', '   ll ', ' dd   '], colors: { l: shadeColor(PAL.ice, 28), d: shadeColor(PAL.ice, -32) } },
  { x: 2, y: 10, rows: ['dd  ', '  ll', '   d'], colors: { l: shadeColor(PAL.ice, 28), d: shadeColor(PAL.ice, -32) } },
  { x: 12, y: 12, rows: ['ll ', '  dd', ' ll '], colors: { l: shadeColor(PAL.ice, 28), d: shadeColor(PAL.ice, -32) } },
]));
T.gold = pushTile('gold', pixelArtTile(PAL.gold, [
  { x: 0, y: 2, rows: ['  vv ', ' vllv', 'vvll  ', '  vv '], colors: { v: shadeColor(PAL.gold, -42), l: shadeColor(PAL.gold, 18) } },
  { x: 8, y: 0, rows: [' vv  ', 'vllv ', ' vv  '], colors: { v: shadeColor(PAL.gold, -42), l: shadeColor(PAL.gold, 18) } },
  { x: 9, y: 8, rows: ['  vv ', ' vvll', 'vllv ', ' vv  '], colors: { v: shadeColor(PAL.gold, -42), l: shadeColor(PAL.gold, 18) } },
  { x: 1, y: 12, rows: ['vv ', 'llv', ' vv'], colors: { v: shadeColor(PAL.gold, -42), l: shadeColor(PAL.gold, 18) } },
]));
T.steel = pushTile('steel', pixelArtTile(PAL.steel, [
  { x: 0, y: 3, rows: ['hhhhhhhhhhhhhhhh'], colors: { h: shadeColor(PAL.steel, 22) } },
  { x: 0, y: 5, rows: ['dddddddddddddddd'], colors: { d: shadeColor(PAL.steel, -28) } },
  { x: 2, y: 8, rows: ['ss   ss   ss   s', ' s   s    s   s '], colors: { s: shadeColor(PAL.steel, -38) } },
  { x: 0, y: 13, rows: ['dddddddddddddddd'], colors: { d: shadeColor(PAL.steel, -22) } },
]));

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
T.builder_shirt = pushTile('builder_shirt', patternedCloth([68, 126, 190], function (d) {
  const seam = [34, 78, 132], check = [98, 160, 216], patch = [246, 194, 82];
  for (let x = 1; x < TILE; x += 5) tileLine(d, x, 0, x, TILE - 1, seam);
  for (let y = 3; y < TILE; y += 5) tileLine(d, 0, y, TILE - 1, y, seam);
  tileFillRect(d, 10, 5, 4, 4, check);
  tileFillRect(d, 11, 6, 2, 2, patch);
}));
T.ranger_shirt = pushTile('ranger_shirt', patternedCloth([40, 142, 126], function (d) {
  tileLine(d, 2, 0, 10, 15, [24, 84, 85]);
  tileLine(d, 4, 0, 12, 15, [242, 184, 78]);
  tileFillRect(d, 10, 4, 5, 2, [28, 98, 94]);
  tileFillRect(d, 11, 5, 3, 1, [122, 212, 177]);
}));
T.climber_shirt = pushTile('climber_shirt', patternedCloth([30, 60, 80], function (d) {
  const grip = [64, 218, 210], signal = [246, 204, 91];
  tileLine(d, 1, 0, 6, 15, [38, 102, 120]);
  tileLine(d, 7, 0, 12, 15, [38, 102, 120]);
  tileLine(d, 2, 0, 7, 15, grip);
  tileLine(d, 8, 0, 13, 15, grip);
  tileFillRect(d, 0, 3, 3, 2, signal);
  tileFillRect(d, 9, 9, 3, 2, signal);
  tileFillRect(d, 13, 2, 2, 2, grip);
}));
T.dolly_dress = pushTile('dolly_dress', patternedCloth([178, 90, 172], function (d) {
  const hem = [86, 206, 190], star = [255, 221, 112], highlight = [239, 157, 201];
  tileLine(d, 0, 12, 15, 12, hem);
  tileLine(d, 0, 14, 15, 14, [112, 72, 154]);
  tileFillRect(d, 3, 3, 2, 2, star); tileFillRect(d, 2, 4, 4, 1, star); tileFillRect(d, 3, 5, 2, 2, star);
  tileFillRect(d, 10, 6, 2, 2, highlight); tileFillRect(d, 9, 7, 4, 1, highlight); tileFillRect(d, 10, 8, 2, 2, highlight);
}));
T.dolly_leggings = pushTile('dolly_leggings', patternedCloth([106, 78, 154], function (d) {
  tileFillRect(d, 2, 5, 3, 2, [91, 213, 197]);
  tileFillRect(d, 10, 5, 3, 2, [91, 213, 197]);
  tileLine(d, 0, 13, 15, 13, [222, 156, 222]);
}));
T.fire_ninja = pushTile('fire_ninja', patternedCloth([46, 42, 62], function (d) {
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
T.wool       = pushTile('wool', pixelArtTile([238, 238, 234], [
  { x: 1, y: 1, rows: ['  ww  ', ' wwwww', 'wwwww '], colors: { w: shadeColor([238,238,234], 12) } },
  { x: 8, y: 7, rows: [' www ', 'wwwww', ' www '], colors: { w: shadeColor([238,238,234], -18) } },
  { x: 1, y: 12, rows: ['wwww ', ' wwwww'], colors: { w: shadeColor([238,238,234], 12) } },
]));
T.wolf = pushTile('wolf', pixelArtTile([112, 122, 140], [
  { x: 1, y: 2, rows: [' ff  ', 'fffff', ' fff '], colors: { f: shadeColor([112,122,140], 24) } },
  { x: 9, y: 9, rows: ['  dd ', ' ddd ', '  dd '], colors: { d: shadeColor([112,122,140], -28) } },
]));
T.wolf_face = pushTile('wolf_face', pixelArtTile([166, 174, 186], [
  { x: 3, y: 4, rows: ['  ll  ', ' llll ', '  dd  '], colors: { l: shadeColor([166,174,186], 18), d: shadeColor([166,174,186], -38) } },
]));
T.wolf_dark = pushTile('wolf_dark', pixelArtTile([62, 73, 91], [
  { x: 2, y: 2, rows: [' ddd ', 'ddddd', ' ddd '], colors: { d: shadeColor([62,73,91], -20) } },
]));
T.wolf_eye = pushTile('wolf_eye', pixelArtTile([246, 199, 80], [
  { x: 5, y: 5, rows: ['  gg  ', ' gggg ', 'gggggg', 'gggggg', ' gggg ', '  gg  '], colors: { g: shadeColor([246,199,80], -26) } },
 ]));
T.pig_skin = pushTile('pig_skin', pixelArtTile([238, 150, 156], [
  { x: 2, y: 3, rows: [' pp ', 'pppp', ' pp '], colors: { p: shadeColor([238,150,156], 14) } },
  { x: 10, y: 10, rows: [' pp ', 'pppp', ' pp '], colors: { p: shadeColor([238,150,156], -16) } },
]));
T.pig_snout = pushTile('pig_snout', pixelArtTile([226, 118, 128], [
  { x: 3, y: 4, rows: [' nn ', 'n  n', ' nn '], colors: { n: shadeColor([226,118,128], -28) } },
]));
T.sheep_face = pushTile('sheep_face', pixelArtTile([158, 137, 119], [
  { x: 3, y: 3, rows: ['  fff ', ' ffffd', '  fffd'], colors: { f: shadeColor([158,137,119], 18), d: shadeColor([158,137,119], -28) } },
]));
T.chick = pushTile('chick', pixelArtTile([246, 232, 148], [
  { x: 2, y: 3, rows: ['  yyy ', ' yyy  ', '  yy  '], colors: { y: shadeColor([246,232,148], 12) } },
  { x: 10, y: 10, rows: [' yy ', 'yyyy', ' yy '], colors: { y: shadeColor([246,232,148], -18) } },
]));
T.chick_wing = pushTile('chick_wing', pixelArtTile([224, 197, 104], [
  { x: 2, y: 4, rows: ['  wwww', 'wwwww ', '  ww  '], colors: { w: shadeColor([224,197,104], 14) } },
]));
T.beak = pushTile('beak', pixelArtTile([232, 168, 52], [
  { x: 4, y: 4, rows: ['  bb ', 'bbbb', '  bb '], colors: { b: shadeColor([232,168,52], -26) } },
]));

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
