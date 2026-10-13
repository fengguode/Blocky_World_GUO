'use strict';

// Focused smoke checks for the UI-owned pixel portraits. This stays separate
// from the game logic harness, which intentionally does not provide a browser DOM.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const draws = [];
const context2d = {
  clearRect() {},
  fillRect(x, y, width, height) { draws.push({ color: this.fillStyle, x, y, width, height }); },
};
const sandbox = {
  console,
  document: { getElementById() { return null; } },
  window: {},
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8'), sandbox);
const drawCharacterPortrait = vm.runInContext('UI.drawCharacterPortrait', sandbox);

function portrait(id) {
  draws.length = 0;
  const canvas = {
    width: 48,
    height: 64,
    getContext(kind) { return kind === '2d' ? context2d : null; },
  };
  drawCharacterPortrait(canvas, { id, name: id, color: '#123456' });
  assert.strictEqual(context2d.imageSmoothingEnabled, false, 'portraits retain crisp pixels');
  assert(draws.length >= 15, id + ' portrait has visible pixel detail');
  draws.forEach((pixel) => {
    assert(pixel.x >= 0 && pixel.y >= 0 && pixel.x + pixel.width <= 48 && pixel.y + pixel.height <= 64,
      id + ' portrait pixels fit the canvas');
  });
  return { colors: draws.map((pixel) => pixel.color), geometry: draws.map(({ x, y, width, height }) => `${x},${y},${width},${height}`).join('|') };
}

const ids = ['steve', 'alex', 'spider', 'doll', 'golem', 'ninja'];
const portraits = ids.map(portrait);
const shirtColors = portraits.map(({ colors }) => colors.find((color) => color === '#4b91ce' || color === '#54aa83' || color === '#c94f50' || color === '#e875b6' || color === '#969789' || color === '#d16b35'));
assert.strictEqual(new Set(shirtColors).size, ids.length, 'each roster character has a distinct shirt palette');
assert.strictEqual(new Set(portraits.map(({ geometry }) => geometry)).size, ids.length, 'each roster character has a distinct pixel silhouette');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8');
assert.match(html, /id="menu-character-preview"/, 'main menu includes the selected character preview');
assert.match(html, /id="touch-view"/, 'touch HUD keeps a dedicated camera control');
assert.match(css, /env\(safe-area-inset-bottom\)/, 'touch HUD honors the device home indicator inset');
assert.match(css, /#menu\s*\{[^}]*touch-action:\s*none/s, 'the intro menu preserves its custom touch-scroll gesture');
assert.match(fs.readFileSync(path.join(root, 'js/touch.js'), 'utf8'), /menu\.scrollTop\s*=\s*Math\.max/, 'the touch handler scrolls long menu content directly');
assert.match(css, /#touch-buttons\s*\{[\s\S]*?pointer-events:\s*none/, 'touch actions keep the action group from blocking look input');
assert.match(ui, /role="button" tabindex="0" aria-pressed=/, 'fight character cards can receive keyboard focus');
assert.match(ui, /event\.key === 'Enter' \|\| event\.key === ' '/, 'fight character cards activate with Enter or Space');
assert.match(ui, /const selectedCard = box\.querySelector\('\.char-card\[data-id="' \+ card\.dataset\.id \+ '"\]'\);\s*if \(selectedCard\) selectedCard\.focus\(\);/, 'fight character focus returns to the selected card after rerender');
assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*?animation-iteration-count:\s*1\s*!important/, 'reduced-motion mode prevents rapid infinite animation loops');

const worldChooser = { innerHTML: '', buttons: {} };
worldChooser.querySelector = (selector) => worldChooser.buttons[selector];
sandbox.document.getElementById = (id) => id === 'menu-extra' ? worldChooser : null;
let selectedWorld = null;
sandbox.Game = { activeWorldType: 'normal', selectWorld(type) { selectedWorld = type; } };
worldChooser.buttons['#choose-normal'] = { onclick: null };
worldChooser.buttons['#choose-flat'] = { onclick: null };
worldChooser.buttons['#world-select-back'] = { onclick: null };
vm.runInContext('UI.showWorldSelect()', sandbox);
assert.match(worldChooser.innerHTML, /You can switch worlds later; each keeps its own blocks and progress\./,
  'world choice reassures players that they can switch and keep progress');
worldChooser.buttons['#choose-normal'].onclick();
assert.strictEqual(selectedWorld, 'normal', 'normal world still selects its existing save');
worldChooser.buttons['#choose-flat'].onclick();
assert.strictEqual(selectedWorld, 'flat', 'flat world still selects its existing save');

console.log('Portrait rendering passed for 6 characters; 15 UI structure checks passed.');
