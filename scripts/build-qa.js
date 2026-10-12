const fs = require('node:fs');
const path = require('node:path');
const terser = require('terser');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = path.resolve(process.env.BW_QA_SOURCE_DIR || REPO_ROOT);
const OUT = path.resolve(process.env.BW_QA_OUT_DIR || path.join(REPO_ROOT, '.qa-public'));

function matchingBrace(source, open) {
  let depth = 0, quote = null, lineComment = false, blockComment = false, escaped = false;
  for (let i = open; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return i;
  }
  throw new Error('Unbalanced JavaScript block at byte ' + open);
}

function removeObjectMethod(source, name) {
  const re = new RegExp('^\\s{2}(?:async\\s+)?' + name + '\\s*\\([^\\n]*?\\)\\s*\\{', 'm');
  const match = re.exec(source);
  if (!match) throw new Error('Expected network-only Game method not found: ' + name);
  const start = match.index;
  const open = source.indexOf('{', start);
  const close = matchingBrace(source, open);
  let end = close + 1;
  while (end < source.length && (source[end] === ' ' || source[end] === '\t')) end++;
  if (source[end] === ',') end++;
  return source.slice(0, start) + source.slice(end);
}

function retainFinalElse(source, firstCondition, secondCondition) {
  const first = source.indexOf('if (' + firstCondition + ')');
  if (first < 0) throw new Error('Expected conditional not found: ' + firstCondition);
  const firstOpen = source.indexOf('{', first);
  const firstClose = matchingBrace(source, firstOpen);
  const second = source.indexOf('else if (' + secondCondition + ')', firstClose);
  if (second < 0) throw new Error('Expected nested branch not found: ' + secondCondition);
  const secondOpen = source.indexOf('{', second);
  const secondClose = matchingBrace(source, secondOpen);
  const final = source.indexOf('else {', secondClose);
  if (final < 0) throw new Error('Expected offline fallback branch not found');
  const finalOpen = source.indexOf('{', final);
  const finalClose = matchingBrace(source, finalOpen);
  return source.slice(0, first) + source.slice(finalOpen + 1, finalClose) + source.slice(finalClose + 1);
}

function removeIfBlock(source, condition) {
  const start = source.indexOf('if (' + condition + ')');
  if (start < 0) throw new Error('Expected QA-only block not found: ' + condition);
  const open = source.indexOf('{', start);
  const close = matchingBrace(source, open);
  let end = close + 1;
  if (source[end] === ',') end++;
  return source.slice(0, start) + source.slice(end);
}

function stripNetworkOnlyMain(source) {
  source = source.replace(/\bconst animalHit = breakJustPressed && \(this\.tryHitAnimal\(p\) \|\| this\.tryHitVisitingPlayer\(p\)\);/, 'const animalHit = breakJustPressed && this.tryHitAnimal(p);');
  for (const name of [
    'tryHitVisitingPlayer', 'startHostedFightPreview', 'openSharedFightChoice',
    'startSharedFight', 'serializeSharedFightState', 'applySharedFightState',
    'enterSharedWorld', 'restorePersonalWorld',
  ]) source = removeObjectMethod(source, name);
  source = removeObjectMethod(source, 'enterSharedMode');
  const enterMode = [
    '  enterMode(mode) {',
    "    const next = ['play', 'fight', 'observe'].includes(mode) ? mode : 'play';",
    "    if (next === 'play') this.startPlay();",
    "    else if (next === 'observe') this.startObserve();",
    '    else this.startFight();',
    '  },',
  ].join('\n');
  const insertBefore = source.indexOf('  toMenu() {');
  if (insertBefore < 0) throw new Error('Could not insert the offline mode selector');
  source = source.slice(0, insertBefore) + enterMode + '\n' + source.slice(insertBefore);
  source = source.replace(/this\.enterSharedMode\(/g, 'this.enterMode(');
  source = retainFinalElse(source, 'hostWaiting', 'connected');
  source = source.replace(/^\s*if \(p\.networkRemote && !p\.networkRemoteVisible\) continue;\r?\n/gm, '');
  source = source.replace(/^\s*this\.players\[1\]\.networkRemote(?:Visible|Initialized)?\s*=.*;\r?\n/gm, '');
  source = source.replace(/^\s*remote\.networkRemote(?:Visible|Initialized)?\s*=.*;\r?\n/gm, '');
  source = source.replace(/^\s*fighters\.networkRemote(?:Visible)?\s*=.*;\r?\n/gm, '');
  source = source.replace(/^\s*this\.(?:sharedFightStarted|hostedFightPreview|sharedFightWaiting)\s*=.*;\r?\n/gm, '');
  const sharedMatchup = source.indexOf('      const sharedCoop =');
  if (sharedMatchup < 0) throw new Error('Expected shared matchup branch not found');
  const hudUpdate = source.indexOf("      UI.updateHUD(p1, 'fight',", sharedMatchup);
  const fallback = source.lastIndexOf('        : ', hudUpdate);
  const fallbackEnd = source.indexOf(';', fallback);
  const localMatchup = source.slice(fallback + 10, fallbackEnd).trim();
  source = source.slice(0, sharedMatchup) + '      const matchup = ' + localMatchup + ';\n' + source.slice(hudUpdate);
  source = removeIfBlock(source, 'this.sharedFightWaiting && window.Network && Network.visitRole && Network.sharedMode === \'fight\'');
  return source;
}

async function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace(/\s*<script src="js\/network\.js"><\/script>\s*/g, '\n');
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  fs.copyFileSync(path.join(ROOT, 'style.css'), path.join(OUT, 'style.css'));

  const files = [
    'blocks.js', 'gl.js', 'world.js', 'mesher.js', 'chars.js', 'input.js',
    'camera.js', 'entity.js', 'bot.js', 'fight.js', 'touch.js', 'ui.js', 'main.js',
  ];
  fs.mkdirSync(path.join(OUT, 'js'), { recursive: true });
  for (const file of files) {
    let source = fs.readFileSync(path.join(ROOT, 'js', file), 'utf8');
    if (file === 'main.js') source = stripNetworkOnlyMain(source);
    const result = await terser.minify(source, {
      compress: { global_defs: { 'window.Network': false, 'window.BW_QA_MEMORY_ONLY': true, Network: false }, passes: 8 },
      mangle: false,
      format: { comments: false },
    });
    fs.writeFileSync(path.join(OUT, 'js', file), result.code + '\n');
  }
  fs.writeFileSync(path.join(OUT, 'js', 'storage.js'), [
    "'use strict';",
    'const BWStorage = (() => {',
    '  const pageData = new Map();',
    '  return {',
    '    getItem(key) { key = String(key); return pageData.has(key) ? pageData.get(key) : null; },',
    '    setItem(key, value) { pageData.set(String(key), String(value)); },',
    '    removeItem(key) { pageData.delete(String(key)); },',
    '    key(index) { return Array.from(pageData.keys())[index] ?? null; },',
    '    get length() { return pageData.size; },',
    '    clear() { pageData.clear(); },',
    '  };',
    '})();',
    'window.BWStorage = BWStorage;',
    '',
  ].join('\n'));
  assertSanitizedOutput();
}

function assertSanitizedOutput() {
  const files = fs.readdirSync(path.join(OUT, 'js')).map((name) => path.join(OUT, 'js', name));
  const text = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8') + '\n' + files.map((p) => fs.readFileSync(p, 'utf8')).join('\n');
  const forbidden = [
    ['network module/API', /\bNetwork\b|network\.js|networkRemote/i],
    ['server/visit mode', /serverMode|visitRole|visitActive|visit\/|sharedFight|sharedMode/i],
    ['persistent storage', /localStorage|sessionStorage|indexedDB/i],
    ['network transport', /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|\/api\//i],
  ];
  for (const [label, pattern] of forbidden) {
    const match = pattern.exec(text);
    if (match) throw new Error('Sanitized QA output contains ' + label + ' token ' + JSON.stringify(match[0]) + ': ' + text.slice(Math.max(0, match.index - 50), match.index + 100));
  }
}

if (require.main === module) build().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { matchingBrace, removeObjectMethod, retainFinalElse, stripNetworkOnlyMain, assertSanitizedOutput, build };

