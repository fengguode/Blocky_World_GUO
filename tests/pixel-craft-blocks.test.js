'use strict';

// Focused visual-material regression checks for Issue #21. The shared test
// runner only discovers suites from logic.test.js, so run this file directly
// with `node tests/pixel-craft-blocks.test.js`.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const g = require('./harness').load({ seed: 21 });

// These signatures pin the changed motifs to the exact 16x16 pixels produced
// by the accepted candidate. Running this test against the current main atlas
// fails on the old pixels; candidate hashes must match exactly.
const craftedMotifs = {
  grass_top: { motifs: 'stepped tuft', candidate: '87dd9099eea6a42c7592d0ba4c5ff3735ee23ec0a5c3572bea52ef5ad597ce09' },
  dirt: { motifs: 'sediment seam', candidate: 'b83e353b1a87d596879054e3b4a13b0d8b6073380fa6df9110e7af4ce0f698b9' },
  stone: { motifs: 'stepped seam and bright lip', candidate: '41fb3ec6298b8e6b2e510cf5b29b59db88ecf2752d518fefd7298f82508891c0' },
  sand: { motifs: 'stepped dune', candidate: 'ade879915ef486532f4bdb77b5c5179ea9e5c965c697a46997254c383dbc0e1a' },
  planks: { motifs: 'two oval knots', candidate: 'b38fe3be11ca7dcf135cbdc050ebbe238b801017606033fa34ec256fc1a510b0' },
  leaves: { motifs: 'two canopy clumps', candidate: '178ac8733b1f9e0efaab00106645b8163ce9fd1876513d401284c205986dacbb' },
  glowstone: { motifs: 'large crystal', candidate: '49f7edb5280ec68cddb7c6cd2d2524c414dc42cfa0a0c6db7cb03c62e467d05f' },
  bedrock: { motifs: 'broad fault line anchoring mineral facets', candidate: '48e8f10c66adf213e34fc1569bfdb1b378a3b73c79c2009f08108d2aeb834090' },
  ice: { motifs: 'diagonal facet', candidate: '7cba4c317d7c1357a53dde67914b1d8ed8ccfeebe7214a772c82b523f2de1670' },
  flower_rose: { motifs: 'rose blossom and stem', candidate: '5e88cee0a2cdfaa4fbeb8676dcc2072c721a9d2ee598b48414621fcb18d4d897' },
  flower_sun: { motifs: 'sun blossom and stem', candidate: '56f74b0458ed4e27b011852ba6c9513abc2b462a37d51b66dafed8162a7759c1' },
  flower_blue: { motifs: 'blue blossom and stem', candidate: '0f5617c57d251392f7f45c842b6faab2d2a6f788716a51451f016c51e64091fa' },
  gold: { motifs: 'two mineral lodes', candidate: 'd3357db71f4af970bfdc172f3b88897558ca20387186f7c9af49259052166388' },
};

function tileSignature(data) {
  return crypto.createHash('sha256').update(Buffer.from(data)).digest('hex');
}

function colorAt(data, index) {
  const offset = index * 4;
  return data[offset] + ',' + data[offset + 1] + ',' + data[offset + 2] + ',' + data[offset + 3];
}

function largestNonDominantColorCluster(data) {
  const counts = new Map();
  for (let i = 0; i < 256; i++) counts.set(colorAt(data, i), (counts.get(colorAt(data, i)) || 0) + 1);
  const dominant = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const seen = new Uint8Array(256);
  let largest = 0;
  for (let start = 0; start < 256; start++) {
    if (seen[start] || colorAt(data, start) === dominant) continue;
    const color = colorAt(data, start);
    const stack = [start];
    seen[start] = 1;
    let area = 0;
    while (stack.length) {
      const index = stack.pop();
      area++;
      const x = index & 15;
      const y = index >> 4;
      const neighbours = [x ? index - 1 : -1, x < 15 ? index + 1 : -1,
        y ? index - 16 : -1, y < 15 ? index + 16 : -1];
      for (const next of neighbours) {
        if (next >= 0 && !seen[next] && colorAt(data, next) === color) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    largest = Math.max(largest, area);
  }
  return largest;
}

assert.deepEqual(Array.from(g.HOTBAR_BLOCKS), [1, 3, 4, 2, 8, 7, 9, 11, 16], 'hotbar order stays unchanged');

const worldTileIds = new Set();
for (const block of g.BLOCKS) {
  if (block.id === 0) continue;
  worldTileIds.add(block.top);
  worldTileIds.add(block.side);
  worldTileIds.add(block.bottom);
}
assert.equal(worldTileIds.size, 22, 'every existing visible block material is covered');
const expectedTileNames = [
  'grass_top', 'grass_side', 'dirt', 'stone', 'cobble', 'sand', 'brick',
  'log_top', 'log_side', 'planks', 'leaves', 'glass', 'glowstone', 'water',
  'snow', 'pumpkin', 'ice', 'gold', 'bedrock', 'flower_rose', 'flower_sun', 'flower_blue',
].sort();
assert.deepEqual(Array.from(worldTileIds, (id) => g.ATLAS[id].name).sort(), expectedTileNames,
  'the material inventory covers every current block material');

const retainedPalettePixels = {
  grass_top: '58,196,150,255', grass_side: '74,62,96,255', dirt: '74,62,96,255',
  stone: '96,108,134,255', cobble: '72,86,114,255', sand: '214,198,150,255',
  brick: '66,54,92,255', log_top: '156,116,196,255', log_side: '86,62,106,255',
  planks: '132,100,168,255', leaves: '46,178,138,255', glass: '120,208,232,42',
  glowstone: '120,246,255,255', water: '40,132,200,186', snow: '226,242,250,255',
  pumpkin: '232,126,74,255', ice: '150,220,245,255', gold: '255,208,74,255',
  bedrock: '38,40,54,255', flower_rose: '238,116,146,255',
  flower_sun: '255,208,74,255', flower_blue: '122,190,246,255',
};

assert.deepEqual(Object.keys(craftedMotifs).sort(), Object.keys(craftedMotifs).filter((name) =>
  craftedMotifs[name] && g.ATLAS.find((tile) => tile.name === name)).sort(),
'every named crafted motif maps to an existing atlas tile');
for (const [name, expected] of Object.entries(craftedMotifs)) {
  const actual = tileSignature(g.ATLAS.find((tile) => tile.name === name).data);
  assert.equal(actual, expected.candidate,
    name + ' contains the approved ' + expected.motifs + ' pixel motif');
}

for (const id of worldTileIds) {
  const tile = g.ATLAS[id];
  const colors = new Set();
  for (let i = 0; i < tile.data.length; i += 4) colors.add(colorAt(tile.data, i >> 2));
  assert.ok(colors.size >= 3 && colors.size <= 12,
    tile.name + ' keeps a compact crafted palette, found ' + colors.size + ' colors');
  assert.ok(colors.has(retainedPalettePixels[tile.name]), tile.name + ' retains its existing palette color');
  const cluster = largestNonDominantColorCluster(tile.data);
  assert.ok(cluster >= 24,
    tile.name + ' needs a readable connected pixel-craft motif (largest accent cluster: ' + cluster + ')');
}

const alphaAt = (name, x, y) => g.ATLAS.find((tile) => tile.name === name).data[(y * 16 + x) * 4 + 3];
assert.equal(alphaAt('leaves', 0, 0), 0, 'leaf canopy keeps transparent corners');
assert.equal(alphaAt('leaves', 7, 7), 255, 'leaf canopy keeps opaque foliage');
assert.equal(alphaAt('glass', 4, 4), 42, 'glass keeps its translucent alpha');
assert.equal(alphaAt('water', 4, 0), 186, 'water keeps its translucent alpha');

console.log('PASS  13 changed tiles match their approved pixel signatures; all 22 materials retain palette samples and alpha behavior');
