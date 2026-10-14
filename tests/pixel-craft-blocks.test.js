'use strict';

// Focused visual-material regression checks for Issue #21. The shared test
// runner only discovers suites from logic.test.js, so run this file directly
// with `node tests/pixel-craft-blocks.test.js`.
const assert = require('node:assert/strict');
const g = require('./harness').load({ seed: 21 });

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

console.log('PASS  22 world block materials have readable connected motifs and retained palette samples');
