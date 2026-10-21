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

   Preserve the established color families. The representative plank and
   projectile sample changes pixel motifs and contrast, not the palette.
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

function patternedCloth(base, variance, draw) {
  return function (d, r) {
    speckle(base, variance)(d, r);
    draw(d, r);
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

T.grass_top = pushTile('grass_top', pixelArtTile(PAL.grassTop, [
  { x: 0, y: 0, rows: ['   d  ', '  ddll', ' dddll', 'ddllll', '  lll ', '   l  '], colors: { d: grassDark, l: grassLight } },
  { x: 8, y: 0, rows: ['d   d', 'ddddl', 'dllld', '  lll', '  ll '], colors: { d: grassDark, l: grassLight } },
  { x: 2, y: 9, rows: ['  d ', ' ddl', 'ddll', ' lll', '  l '], colors: { d: grassDark, l: grassLight } },
  { x: 10, y: 10, rows: ['  l  ', ' lll ', 'llgll', ' lgl ', '  l  '], colors: { l: grassLight, g: PAL.sand } },
  // One broad, stepped tuft gives the top a readable grass silhouette at distance.
  { x: 1, y: 1, rows: ['    dddddd  ', '   dddddddd ', '  ddddllllll', ' ddddlllllll', 'ddddllllllll', '  lllllllll ', '   llllllll  '], colors: { d: grassDark, l: grassLight } },
]));
// A stepped turf edge with connected roots and layered earth instead of confetti.
T.grass_side = pushTile('grass_side', function (d) {
  fillTile(d, PAL.dirt);
  const edge = [3, 2, 2, 3, 4, 3, 2, 2, 3, 4, 3, 2, 2, 3, 4, 3];
  for (let x = 0; x < TILE; x++) {
    for (let y = 0; y < edge[x]; y++) setPx(d, x, y, PAL.grassTop[0], PAL.grassTop[1], PAL.grassTop[2]);
    setPx(d, x, edge[x], grassDark[0], grassDark[1], grassDark[2]);
  }
  stampTile(d, 1, 0, ['  l ', ' hhl', 'dd  '], { l: grassLight, h: PAL.grassTop, d: grassDark });
  stampTile(d, 9, 0, [' l  ', 'hhdl', '  dd'], { l: grassLight, h: PAL.grassTop, d: grassDark });
  stampTile(d, 3, 6, ['ddddd  ', '  llll ', '    dd '], { d: dirtDark, l: dirtLight });
  stampTile(d, 10, 10, ['  lllll', ' ddlll ', '   dddd'], { d: dirtDark, l: dirtLight });
});
T.dirt = pushTile('dirt', pixelArtTile(PAL.dirt, [
  { x: 0, y: 1, rows: ['  ddddd ', ' dllllld', 'ddlllhd ', ' dddddd '], colors: { d: dirtDark, l: dirtLight, h: PAL.dirt } },
  { x: 8, y: 5, rows: [' dddddd', 'ddlllld', 'dllllhd', ' dddddd'], colors: { d: dirtDark, l: dirtLight, h: PAL.dirt } },
  { x: 2, y: 11, rows: [' ddddd ', 'ddlllld', ' dddddd'], colors: { d: dirtDark, l: dirtLight } },
  { x: 11, y: 12, rows: ['ddd ', 'dllld', ' ddd'], colors: { d: dirtDark, l: dirtLight } },
  // A broad, irregular sediment seam reads as a single crafted earth layer.
  { x: 0, y: 4, rows: ['  lllllllll   ', ' llllllllllll ', 'llllllllllllll', 'dddddddddddddd', ' ddddddddddd  ', '  lllllllll   '], colors: { d: dirtDark, l: dirtLight } },
]));
T.stone = pushTile('stone', pixelArtTile(PAL.stone, [
  { x: 0, y: 0, rows: ['  llll d', ' lllldd ', 'llll d  ', ' dd     '], colors: { l: stoneLight, d: stoneDark } },
  { x: 8, y: 4, rows: ['dd     ', ' dllll ', '  dllll', '   dd  '], colors: { l: stoneLight, d: stoneDark } },
  { x: 1, y: 10, rows: ['   ddd ', ' ddllld', 'dlllld ', '  dd   '], colors: { l: stoneLight, d: stoneDark } },
  { x: 11, y: 12, rows: ['llldd', ' dd  ', '  d  '], colors: { l: stoneLight, d: stoneDark } },
  // A stepped seam with a bright upper lip makes the stone strata legible.
  { x: 0, y: 5, rows: ['   dddddddddd  ', ' dddddddddddddd', 'dddddddddddddd ', '  ddddddddddd  ', '    lllllllll '], colors: { d: stoneDark, l: stoneLight } },
]));
T.cobble = pushTile('cobble', pixelArtTile(shadeColor(PAL.cobble, -38), [
  { x: 0, y: 0, rows: ['  ffffff ', ' ffllllf ', 'fflllllf ', ' ffffff  '], colors: { f: PAL.cobble, l: shadeColor(PAL.cobble, 22) } },
  { x: 8, y: 0, rows: [' ffffff  ', 'ffllllff ', ' flllllf ', '  ffffff '], colors: { f: PAL.cobble, l: shadeColor(PAL.cobble, 22) } },
  { x: 2, y: 6, rows: [' ffffff ', 'ffllllff', ' fllllf ', '  ffff  '], colors: { f: PAL.cobble, l: shadeColor(PAL.cobble, 22) } },
  { x: 9, y: 7, rows: ['  fffff ', ' ffllllf', 'flllllf ', ' ffffff '], colors: { f: PAL.cobble, l: shadeColor(PAL.cobble, 22) } },
  { x: 0, y: 12, rows: [' ffffff ', 'ffllllff', ' ffffff '], colors: { f: PAL.cobble, l: shadeColor(PAL.cobble, 22) } },
]));
T.sand = pushTile('sand', pixelArtTile(PAL.sand, [
  { x: 0, y: 1, rows: ['  hhhhhh', 'hhhh    ', '   lllll', '  lll   '], colors: { h: shadeColor(PAL.sand, 20), l: shadeColor(PAL.sand, -22) } },
  { x: 8, y: 4, rows: ['  hhhhhh', 'hhhhh   ', '   lllll', '  llll  '], colors: { h: shadeColor(PAL.sand, 20), l: shadeColor(PAL.sand, -22) } },
  { x: 0, y: 9, rows: ['   hhhh ', ' hhhhhh ', 'llll    ', '  lllll '], colors: { h: shadeColor(PAL.sand, 20), l: shadeColor(PAL.sand, -22) } },
  { x: 10, y: 12, rows: ['  lll ', ' hhhh ', '  llll'], colors: { h: shadeColor(PAL.sand, 20), l: shadeColor(PAL.sand, -22) } },
  // A continuous stepped dune catches the light across most of the tile.
  { x: 0, y: 6, rows: ['hhhhhhhhhhhhhhh ', ' hhhhhhhhhhhhhhh', '  lllllllllllll ', ' lllllllllllllll'], colors: { h: shadeColor(PAL.sand, 20), l: shadeColor(PAL.sand, -22) } },
]));
// Offset courses, recessed mortar, and broad chipped brick faces.
T.brick = pushTile('brick', function (d) {
  fillTile(d, PAL.brickJoint);
  const hi = shadeColor(PAL.brick, 18), face = PAL.brick, shade = shadeColor(PAL.brick, -24);
  for (let row = 0; row < 4; row++) {
    const y = row * 4, offset = (row % 2) * 4;
    for (let x = -offset; x < TILE; x += 8) {
      for (let py = 0; py < 3; py++) for (let px = 0; px < 7; px++) {
        const xx = x + px;
        if (xx < 0 || xx >= TILE) continue;
        let c = py === 0 ? hi : face;
        if ((px === 6 && py === 2) || (px === 0 && py === 1 && row % 2)) c = shade;
        setPx(d, xx, y + py, c[0], c[1], c[2]);
      }
    }
  }
  stampTile(d, 1, 1, ['  hh ', ' hffh', '  ff '], { h: hi, f: face });
  stampTile(d, 9, 9, [' fff ', 'hfffh', ' fff '], { h: hi, f: face });
});
T.log_side = pushTile('log_side', function (d) {
  fillTile(d, PAL.logSide);
  const groove = shadeColor(PAL.logSide, -25), ridge = shadeColor(PAL.logSide, 24);
  // Bark reads as long, split grain with a few broad knots rather than thin noise.
  for (const [x, w, c] of [[1, 2, groove], [3, 2, ridge], [7, 1, groove], [10, 3, ridge], [14, 1, groove]]) {
    for (let y = 0; y < TILE; y++) for (let dx = 0; dx < w; dx++) {
      if ((x + dx === 3 || x + dx === 11) && (y % 7 === 2 || y % 7 === 3)) continue;
      setPx(d, x + dx, y, c[0], c[1], c[2]);
    }
  }
  stampTile(d, 5, 3, ['  dddd  ', ' ddllld ', 'dlllllld', ' ddllld ', '  dddd  '],
    { d: groove, l: ridge });
  stampTile(d, 0, 11, ['  dd ', ' dllld', '  dd '], { d: groove, l: ridge });
});
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
  const plankShadow = shadeColor(PAL.planks, -42);
  const plankHighlight = shadeColor(PAL.planks, 32);
  // Staggered board ends and long grain run across each course; retain the sample's three violet tones.
  for (let y = 0; y < TILE; y++) {
    const courseY = y & 7, jointX = y < 8 ? 8 : 4;
    if (courseY === 0) {
      for (let x = 0; x < TILE; x++) setPx(d, x, y, plankHighlight[0], plankHighlight[1], plankHighlight[2]);
    } else if (courseY === 7) {
      for (let x = 0; x < TILE; x++) setPx(d, x, y, plankShadow[0], plankShadow[1], plankShadow[2]);
    } else {
      setPx(d, jointX, y, plankShadow[0], plankShadow[1], plankShadow[2]);
      setPx(d, (jointX + 1) & 15, y, plankHighlight[0], plankHighlight[1], plankHighlight[2]);
    }
  }
  stampTile(d, 1, 2, ['lllll ', 'llbbll', '  bbbb', '  bll '], { l: plankHighlight, b: plankShadow });
  stampTile(d, 9, 3, ['  lllll', 'llbb  ', '  bbbb ', '   ll  '], { l: plankHighlight, b: plankShadow });
  stampTile(d, 3, 10, ['llll  ', 'llbbll', '  bbbb'], { l: plankHighlight, b: plankShadow });
  // Wider oval knots interrupt the long board grain without adding noisy colors.
  stampTile(d, 0, 1, ['  lllll ', ' llbblll', 'llbbbbbb', ' llbblll', '  lllll '], { l: plankHighlight, b: plankShadow });
  stampTile(d, 9, 9, ['  lllll ', ' llbblll', 'llbbbbbb', ' llbblll', '  lllll '], { l: plankHighlight, b: plankShadow });
});
// A ragged canopy silhouette with chunky leaf masses and visible gaps.
T.leaves = pushTile('leaves', function (d) {
  const dark = shadeColor(PAL.leaves, -38), light = shadeColor(PAL.leaves, 28), mid = PAL.leaves;
  const canopy = [
    '   00000000     ',
    '  00000000000   ',
    ' 0000000000000  ',
    '000000000000000 ',
    '000000000000000 ',
    '000000000000000 ',
    '000000000000000 ',
    '000000000000000 ',
    '000000000000000 ',
    ' 00000000000000 ',
    '  0000000000000 ',
    '   00000000000  ',
    '    000000000   ',
    '     0000000    ',
    '      00000     ',
    '       000      ',
  ];
  fillTile(d, mid, 0);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    if (canopy[y][x] === '0') setPx(d, x, y, mid[0], mid[1], mid[2], 255);
  }
  const shade = { g: dark, l: light, m: mid };
  stampTile(d, 0, 1, ['  ggggg ', ' ggmmllg', 'gmmllllg', ' ggggg  '], shade);
  stampTile(d, 7, 0, [' ggggg ', 'ggmmllg', ' ggggg '], shade);
  stampTile(d, 8, 6, ['  ggggg ', ' ggmmllg', 'gmmllllg', '  gggg  '], shade);
  stampTile(d, 1, 10, [' ggggg ', 'ggmmllg', ' ggggg '], shade);
  stampTile(d, 11, 11, [' gggg ', 'ggmllg', ' gggg '], shade);
  // Larger connected leaf bunches make the canopy read as foliage, not flecks.
  stampTile(d, 1, 4, ['  ggggggg ', ' gggmmllg ', 'gggmmlllg ', ' ggggggg  '], shade);
  stampTile(d, 8, 8, [' ggggggg ', 'gggmmllg ', ' ggggggg  '], shade);
  // Restore transparent canopy gaps after the color clusters are stamped.
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    if (canopy[y][x] !== '0') d[(y * TILE + x) * 4 + 3] = 0;
  }
});
T.glass = pushTile('glass', function (d) {
  fillTile(d, [120, 208, 232], 42);
  const frame = [178, 246, 255], shine = [226, 252, 255], reflection = [164, 232, 248];
  for (let p = 0; p < TILE; p++) {
    setPx(d, p, 0, frame[0], frame[1], frame[2], 210);
    setPx(d, p, 15, frame[0], frame[1], frame[2], 210);
    setPx(d, 0, p, frame[0], frame[1], frame[2], 210);
    setPx(d, 15, p, frame[0], frame[1], frame[2], 210);
  }
  stampTile(d, 2, 2, ['  ss  ', ' ssss ', 'ss  ss', '  ss  '], { s: shine }, 225);
  stampTile(d, 9, 8, ['   rrrr', '  rrrr ', ' rrr   '], { r: reflection }, 190);
});
T.glowstone = pushTile('glowstone', function (d) {
  fillTile(d, PAL.glow);
  const edge = shadeColor(PAL.glow, -34), core = PAL.glowCore;
  // Broad crystal clusters with a warm pixel glint make this emissive tile read at a glance.
  stampTile(d, 0, 1, ['   eee   ', '  eccce  ', ' eecccee ', 'eeccgccce', ' eecccee ', '  eccce  ', '   eee   '],
    { e: edge, c: core, g: PAL.gold });
  stampTile(d, 10, 9, ['  eee ', ' eccce', 'eccgce', ' eccce', '  eee '],
    { e: edge, c: core, g: PAL.gold });
  // A large crystal face and stepped rim make the emissive center read clearly.
  stampTile(d, 3, 1, ['    eeee   ', '   ecccce  ', '  ecccccc e', ' eeccccccce', 'eecccgcccee', ' eecccccc e', '  eccccc   ', '   eccc    '],
    { e: edge, c: core, g: PAL.gold });
});
// Broad stepped caustics form two continuous pixel-wave ribbons.
T.water = pushTile('water', function (d) {
  fillTile(d, PAL.water, 186);
  const lit = shadeColor(PAL.water, 24), dark = shadeColor(PAL.water, -22);
  const waveA = [3,3,3,4,4,5,5,4,4,3,3,2,2,3,3,3];
  const waveB = [10,10,11,11,12,12,11,10,10,9,9,10,10,11,11,10];
  for (let x = 0; x < TILE; x++) {
    for (let w = 0; w < 3; w++) {
      if ((x + w) % 7 !== 6) setPx(d, x, waveA[x] + w, lit[0], lit[1], lit[2], 220);
    }
    setPx(d, x, waveA[x] + 3, dark[0], dark[1], dark[2], 186);
    setPx(d, x, waveB[x], lit[0], lit[1], lit[2], 220);
    setPx(d, x, waveB[x] + 1, dark[0], dark[1], dark[2], 186);
  }
  stampTile(d, 1, 1, [' llll ', 'llllll', '  llll'], { l: lit }, 220);
  stampTile(d, 9, 7, [' lllll ', 'llllll ', '  llll '], { l: lit }, 220);
});
T.snow = pushTile('snow', pixelArtTile(PAL.snow, [
  { x: 0, y: 0, rows: ['   bbb   ', '   bbb   ', 'bbbhbbbbb', '  bbbbb  ', '   bbb   ', '   bbb   '], colors: { b: shadeColor(PAL.snow, -24), h: shadeColor(PAL.snow, 15) } },
  { x: 9, y: 7, rows: ['  bb  ', ' bbbb ', 'bbhbbb', ' bbbb ', '  bb  '], colors: { b: shadeColor(PAL.snow, -24), h: shadeColor(PAL.snow, 15) } },
  { x: 1, y: 12, rows: ['  bbbb ', 'bbbhbb ', '  bbbb '], colors: { b: shadeColor(PAL.snow, -24), h: shadeColor(PAL.snow, 15) } },
]));
T.bedrock = pushTile('bedrock', pixelArtTile(PAL.bedrock, [
  { x: 0, y: 0, rows: ['ddd   ', ' ddd  ', '  ddd ', '   ddd'], colors: { d: shadeColor(PAL.bedrock, 22) } },
  { x: 7, y: 2, rows: ['   llll', ' lll   ', 'll     ', '  llll '], colors: { l: shadeColor(PAL.bedrock, -16) } },
  { x: 2, y: 8, rows: ['  dddd ', ' dd  ddd', 'ddd  dd ', ' dddd  '], colors: { d: shadeColor(PAL.bedrock, 22) } },
  { x: 10, y: 12, rows: ['lllll ', '   lll', 'llll  '], colors: { l: shadeColor(PAL.bedrock, -16) } },
  // A broad fault line anchors the smaller mineral facets.
  { x: 0, y: 5, rows: ['dddddddddddd', 'dddddddddddd', '  dddddddddd  '], colors: { d: shadeColor(PAL.bedrock, -16) } },
]));
T.pumpkin = pushTile('pumpkin', function (d) {
  fillTile(d, PAL.pumpkin);
  const shadow = shadeColor(PAL.pumpkin, -34), shine = shadeColor(PAL.pumpkin, 22);
  // Thick alternating ribs and faceted lobes make the pumpkin silhouette clear on every face.
  const ribs = [0, 3, 6, 9, 12, 15];
  for (const x of ribs) for (let y = 0; y < TILE; y++) {
    const c = (x === 6 || x === 9) ? shine : shadow;
    setPx(d, x, y, c[0], c[1], c[2]);
    if (x > 0 && x < 15) setPx(d, x - 1, y, PAL.pumpkin[0], PAL.pumpkin[1], PAL.pumpkin[2]);
  }
  stampTile(d, 2, 2, ['  ss  ', ' ssss ', 'ssssss', ' ssss '], { s: shine });
  stampTile(d, 9, 10, ['ssss ', ' ssss', '  ss '], { s: shine });
});
T.ice = pushTile('ice', pixelArtTile(PAL.ice, [
  { x: 0, y: 0, rows: ['lll   ', ' lll  ', '  lll d', '   ddd ', '    dd '], colors: { l: shadeColor(PAL.ice, 28), d: shadeColor(PAL.ice, -32) } },
  { x: 8, y: 2, rows: ['   llll', '  lllld', ' lll dd', 'ddddd  '], colors: { l: shadeColor(PAL.ice, 28), d: shadeColor(PAL.ice, -32) } },
  { x: 1, y: 9, rows: ['dd  ', '  lll', ' lll ', '  dd '], colors: { l: shadeColor(PAL.ice, 28), d: shadeColor(PAL.ice, -32) } },
  { x: 11, y: 12, rows: ['ll ', 'lll d', ' dd '], colors: { l: shadeColor(PAL.ice, 28), d: shadeColor(PAL.ice, -32) } },
  // A wide diagonal facet reads as a single cut crystal at gameplay scale.
  { x: 0, y: 1, rows: ['lll             ', ' lllll          ', '   llllll       ', '     lllllllll  ', '       lllllllll', '         lllll  ', '           lll  '], colors: { l: shadeColor(PAL.ice, 28) } },
]));
function flowerTile(name, petals, center) {
  return pushTile(name, function (d) {
    fillTile(d, [0, 0, 0], 0);
    const stem = [62, 156, 105], leaf = [84, 190, 126];
    stampTile(d, 4, 2, ['   ppppp   ', '  ppppppp  ', ' ppppppppp ', 'pppppcppppp', ' ppppppppp ', '  ppppppp  ', '   ppppp   '],
      { p: petals, c: center });
    stampTile(d, 7, 9, [' s ', ' s ', ' s ', 'sls', ' ss', '  s'],
      { s: stem, l: leaf });
  });
}
T.flower_rose = flowerTile('flower_rose', [238, 116, 146], [255, 220, 112]);
T.flower_sun = flowerTile('flower_sun', [255, 208, 74], [255, 242, 196]);
T.flower_blue = flowerTile('flower_blue', [122, 190, 246], [255, 220, 112]);

T.gold = pushTile('gold', pixelArtTile(PAL.gold, [
  { x: 0, y: 1, rows: ['  vv  ', ' vllv ', 'vvllvv', '  vv  '], colors: { v: shadeColor(PAL.gold, -42), l: shadeColor(PAL.gold, 18) } },
  { x: 8, y: 0, rows: ['  vv  ', ' vvllv', 'vllvv ', ' vv   '], colors: { v: shadeColor(PAL.gold, -42), l: shadeColor(PAL.gold, 18) } },
  { x: 1, y: 8, rows: ['  vvv ', ' vvllv', 'vlllv ', ' vv   '], colors: { v: shadeColor(PAL.gold, -42), l: shadeColor(PAL.gold, 18) } },
  { x: 10, y: 10, rows: [' vvv ', 'vvllv', ' vvv '], colors: { v: shadeColor(PAL.gold, -42), l: shadeColor(PAL.gold, 18) } },
  // Veins join into two generous stepped lodes instead of isolated nuggets.
  { x: 1, y: 1, rows: ['   vvvvv   ', '  vvvvvvv  ', ' vvvvvvvvv ', 'vvvvvllvvvv', ' vvvvllllvv', '  vvvvllvv ', '   vvvvv   '], colors: { v: shadeColor(PAL.gold, -42), l: shadeColor(PAL.gold, 18) } },
  { x: 9, y: 9, rows: ['  vvvvv ', ' vvvvvvv', 'vvvvllll', ' vvvvll ', '  vvvvv '], colors: { v: shadeColor(PAL.gold, -42), l: shadeColor(PAL.gold, 18) } },
]));
T.steel = pushTile('steel', pixelArtTile(PAL.steel, [
  { x: 0, y: 3, rows: ['hhhhhhhhhhhhhhhh'], colors: { h: shadeColor(PAL.steel, 22) } },
  { x: 0, y: 5, rows: ['dddddddddddddddd'], colors: { d: shadeColor(PAL.steel, -28) } },
  { x: 2, y: 8, rows: ['ss   ss   ss   s', ' s   s    s   s '], colors: { s: shadeColor(PAL.steel, -38) } },
  { x: 0, y: 13, rows: ['dddddddddddddddd'], colors: { d: shadeColor(PAL.steel, -22) } },
]));

// Dedicated three-tone projectile tiles add crisp motifs while preserving
// the game's existing cyan web, bright star, and steel/red shuriken colors.
const webBase = PAL.glass;
const webThread = [72, 194, 208];
const webHighlight = [226, 252, 255];
T.fx_web = pushTile('fx_web', pixelArtTile(webBase, [
  { x: 1, y: 1, rows: ['w      w', ' ww  ww ', '  www   ', '  hwwh  ', '  ww    '], colors: { w: webThread, h: webHighlight } },
  { x: 9, y: 1, rows: ['w    w', ' ww ww', '  hwwh', '   ww '], colors: { w: webThread, h: webHighlight } },
  { x: 2, y: 9, rows: ['  www  ', ' wwhww ', '   h   '], colors: { w: webThread, h: webHighlight } },
]));

const starBase = PAL.glow;
const starGold = PAL.gold;
const starCream = PAL.snow;
T.fx_star = pushTile('fx_star', pixelArtTile(starBase, [
  { x: 2, y: 1, rows: ['   c   ', '  ccc  ', 'ggcccgg', '  ccc  ', '   c   '], colors: { c: starCream, g: starGold } },
  { x: 10, y: 9, rows: ['  c ', ' gcc', 'ggc ', '  c '], colors: { c: starCream, g: starGold } },
  { x: 0, y: 12, rows: ['cc ', ' ggc', '  c'], colors: { c: starCream, g: starGold } },
]));

const shurikenBase = PAL.steel;
const shurikenHighlight = shadeColor(PAL.steel, 22);
const shurikenRed = [198, 44, 52];
T.fx_shuriken = pushTile('fx_shuriken', pixelArtTile(shurikenBase, [
  { x: 1, y: 1, rows: ['   h   ', '   h   ', 'hhhrhhh', '   h   ', '   h   '], colors: { h: shurikenHighlight, r: shurikenRed } },
  { x: 8, y: 1, rows: ['  h  ', ' hhr ', 'rhhhr', '  hh ', '   r '], colors: { h: shurikenHighlight, r: shurikenRed } },
  { x: 1, y: 10, rows: ['hhrhh', '  r  ', '  h  '], colors: { h: shurikenHighlight, r: shurikenRed } },
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
T.rabbit = pushTile('rabbit', pixelArtTile([190, 176, 157], [
  { x: 1, y: 2, rows: ['  lll ', ' lllll', 'llllll', ' llll '], colors: { l: [224, 211, 190] } },
  { x: 9, y: 10, rows: [' ddd ', 'ddddd', ' ddd '], colors: { d: [158, 139, 121] } },
]));
T.rabbit_face = pushTile('rabbit_face', pixelArtTile([224, 211, 190], [
  { x: 2, y: 2, rows: ['  ddd ', ' dllll', 'ddllll', ' dddd '], colors: { d: [188, 169, 149], l: [242, 231, 213] } },
]));
T.rabbit_pink = pushTile('rabbit_pink', pixelArtTile([211, 145, 145], [
  { x: 4, y: 2, rows: ['  pp  ', ' pppp ', ' pppp ', '  pp  '], colors: { p: [235, 175, 171] } },
]));
T.fox = pushTile('fox', pixelArtTile([207, 112, 54], [
  { x: 1, y: 2, rows: ['  hhhh ', ' hhhhhh', 'hhhhhhh', ' hhhhhh'], colors: { h: [235, 148, 69] } },
  { x: 9, y: 10, rows: [' ddd ', 'ddddd', ' ddd '], colors: { d: [149, 74, 48] } },
]));
T.fox_face = pushTile('fox_face', pixelArtTile([228, 139, 63], [
  { x: 2, y: 2, rows: ['  ddd ', ' dllll', 'ddllll', ' dddd '], colors: { d: [183, 83, 48], l: [248, 224, 185] } },
]));
T.fox_cream = pushTile('fox_cream', pixelArtTile([241, 221, 187], [
  { x: 3, y: 3, rows: ['  ccc ', ' ccccc', 'cccccc', '  cc  '], colors: { c: [255, 240, 209] } },
]));
T.deer = pushTile('deer', pixelArtTile([167, 111, 69], [
  { x: 1, y: 2, rows: ['  hhhh ', ' hhhhhh', 'hhhhhhh', ' hhhhhh'], colors: { h: [196, 139, 84] } },
  { x: 9, y: 10, rows: ['  sss ', ' sssss', '  sss '], colors: { s: [224, 187, 132] } },
]));
T.deer_face = pushTile('deer_face', pixelArtTile([195, 140, 88], [
  { x: 2, y: 2, rows: ['  lll ', ' lllll', 'ddllld', '  ddd '], colors: { l: [237, 211, 167], d: [125, 77, 52] } },
]));
T.deer_dark = pushTile('deer_dark', pixelArtTile([109, 72, 49], [
  { x: 2, y: 2, rows: ['  ddd ', ' ddddd', '  ddd '], colors: { d: [78, 52, 42] } },
]));
T.deer_antler = pushTile('deer_antler', pixelArtTile([174, 132, 83], [
  { x: 1, y: 1, rows: ['d   d', 'dd dd', ' d d ', '  d  '], colors: { d: [214, 177, 119] } },
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
  { id: 22, name: 'Rose', solid: false, opaque: false, cutout: true, plant: true, tiles: { all: T.flower_rose } },
  { id: 23, name: 'Sunflower', solid: false, opaque: false, cutout: true, plant: true, tiles: { all: T.flower_sun } },
  { id: 24, name: 'Blue Flower', solid: false, opaque: false, cutout: true, plant: true, tiles: { all: T.flower_blue } },
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
  .concat([{ kind: 'tool', id: 'shovel', name: 'Shovel' },
    { kind: 'food', id: 'apple', name: 'Apple' },
    { kind: 'food', id: 'meat', name: 'Meat' }]);

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

