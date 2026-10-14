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
assert.match(html, /<div class="cap-sub">Use <kbd>W A S D<\/kbd> to move · move the mouse to look · <kbd>Space<\/kbd> to jump<br><span data-capture-mode="play">Play &amp; Build: <kbd>Left click<\/kbd> mines blocks or attacks animals or visitors · <kbd>Right click<\/kbd> places a block or uses the selected item · click a hotbar slot to select an item or press <kbd>1–9<\/kbd> for a block · <kbd>V<\/kbd> changes view<\/span><span data-capture-mode="fight">Fight: <kbd>Left click<\/kbd> attacks · <kbd>Right click<\/kbd> uses a special move<\/span><\/div>/,
  'first-use desktop prompt separates the Play & Build and Fight instructions');
assert.match(fs.readFileSync(path.join(root, 'js/main.js'), 'utf8'), /section\.hidden = section\.dataset\.captureMode !== this\.mode;/,
  'first-use desktop prompt shows only the active mode instructions');
assert.match(css, /env\(safe-area-inset-bottom\)/, 'touch HUD honors the device home indicator inset');
const mobileMedia = css.match(/@media \(max-width: 760px\) \{([\s\S]*?)^\}/m);
assert(mobileMedia, 'the mobile media query exists');
assert.match(mobileMedia[1], /\.slot \{ width: 44px; height: 44px; flex: 0 0 44px; scroll-snap-align: center; \}/,
  'mobile hotbar slots remain thumb-sized and snap after a horizontal swipe');
assert.match(mobileMedia[1], /\.hotbar \{[^}]*scroll-snap-type: x proximity/,
  'mobile hotbar slots remain thumb-sized and settle into place after a horizontal swipe');
const hotbarRule = css.match(/(?:^|\n)\.hotbar\s*\{([^}]*)\}/);
assert(hotbarRule, 'the shared hotbar rule exists');
assert.match(hotbarRule[1], /(?:^|\n)\s*overflow-x:\s*auto\s*;/,
  'the hotbar keeps horizontal overflow so all 12 items remain reachable on mobile');
assert.match(hotbarRule[1], /(?:^|\n)\s*-webkit-overflow-scrolling:\s*touch\s*;/,
  'the hotbar retains iOS momentum scrolling');

// Render the real hotbar into a tiny deterministic DOM stub. This checks the
// available items and the slots UI.buildHotbar actually appends, not only the
// source array or a regex over its implementation.
const hotbarBar = {
  children: [],
  listeners: {},
  addEventListener(type, handler) { this.listeners[type] = handler; },
  appendChild(node) { this.children.push(node); return node; },
};
Object.defineProperty(hotbarBar, 'innerHTML', {
  set(value) { if (value === '') this.children.length = 0; },
});
function hotbarNode(tagName) {
  const context = {
    translate() {}, rotate() {}, fillRect() {}, strokeRect() {}, beginPath() {},
    moveTo() {}, lineTo() {}, fill() {}, drawImage() {}, createLinearGradient() {
      return { addColorStop() {} };
    },
  };
  return {
    tagName,
    children: [],
    dataset: {},
    attributes: {},
    addEventListener() {},
    appendChild(node) { this.children.push(node); return node; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getContext(kind) { return kind === '2d' ? context : null; },
  };
}
const hotbarSandbox = {
  console,
  document: {
    getElementById(id) { return id === 'hotbar' ? hotbarBar : null; },
    createElement: hotbarNode,
  },
  window: {},
  Game: { selectedSlot: 0, selectSlot() {} },
};
vm.createContext(hotbarSandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js/blocks.js'), 'utf8') +
  '\n;globalThis.__hotbarData = { blockIds: HOTBAR_BLOCKS.slice(), items: HOTBAR_ITEMS.map(({ kind, id, name }) => ({ kind, id, name })) };',
  hotbarSandbox);
vm.runInContext('blockIconCanvas = () => document.createElement("canvas")', hotbarSandbox);
vm.runInContext(ui, hotbarSandbox);
vm.runInContext('UI.buildHotbar()', hotbarSandbox);
const availableHotbarItems = Array.from(hotbarSandbox.__hotbarData.items,
  ({ kind, id, name }) => ({ kind, id, name }));
assert.strictEqual(hotbarSandbox.__hotbarData.blockIds.length, 9, 'the hotbar still offers nine blocks');
assert.strictEqual(availableHotbarItems.length, 12, 'the available hotbar inventory still has 12 items');
assert.deepStrictEqual(availableHotbarItems.slice(0, 9).map(({ kind }) => kind), Array(9).fill('block'),
  'slots 0-8 remain blocks');
assert.deepStrictEqual(availableHotbarItems.slice(9).map(({ id, name, kind }) => [id, name, kind]), [
  ['shovel', 'Shovel', 'tool'], ['apple', 'Apple', 'food'], ['meat', 'Meat', 'food'],
], 'slots 9-11 remain shovel, apple, and meat in that order');
assert.strictEqual(hotbarBar.children.length, 12, 'UI.buildHotbar renders all 12 available slots');
assert.deepStrictEqual(Array.from(hotbarBar.children, (slot) => Number(slot.dataset.slot)),
  Array.from({ length: 12 }, (_, i) => i), 'rendered slot indices cover 0 through 11');
assert.deepStrictEqual(hotbarBar.children.map((slot) => slot.title), [
  'Grass', 'Stone', 'Cobble', 'Dirt', 'Planks', 'Log', 'Leaves', 'Glowstone', 'Gold',
  'Shovel', 'Apple', 'Meat',
], 'all 12 rendered hotbar titles match the intended item order');
assert.deepStrictEqual(hotbarBar.children.slice(9).map((slot) => slot.title), ['Shovel', 'Apple', 'Meat'],
  'rendered slots 9-11 retain their tool and food labels');
assert.match(css, /#menu\s*\{[^}]*touch-action:\s*none/s, 'the intro menu preserves its custom touch-scroll gesture');
assert.match(css, /#btn-game-settings\s*\{[^}]*min-height:\s*44px/s, 'the in-game Settings action has a 44px minimum touch target');
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
assert.strictEqual(selectedWorld, 'normal', 'normal world still uses its existing selection handler');
worldChooser.buttons['#choose-flat'].onclick();
assert.strictEqual(selectedWorld, 'flat', 'flat world still uses its existing selection handler');

console.log('Portrait rendering passed for 6 characters; mobile overflow and all 12 rendered hotbar slots passed.');
