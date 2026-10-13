const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const terser = require('terser');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUT = path.join(REPO_ROOT, '.qa-public');
const JS_FILES = [
  'blocks.js', 'gl.js', 'world.js', 'mesher.js', 'chars.js', 'input.js',
  'camera.js', 'entity.js', 'bot.js', 'fight.js', 'touch.js', 'ui.js', 'main.js',
];
const JS_ASSET_ALLOWLIST = new Set([...JS_FILES.map((file) => 'js/' + file), 'js/storage.js', 'js/qa-fixture.js']);
const QA_FIXTURE = Object.freeze({
  seed: 1337,
  randomSeed: 0x51f15e,
  worldType: 'normal',
  player: [100008, 30, 100008],
  camera: {
    viewIndex: 1, orbitAngle: 0.62, orbitRadius: 48, orbitHeight: 28, zoom: 1,
    target: [100008, 30, 100008], yaw: 0.62, pitch: -Math.atan2(28, 48),
    position: [100008 + Math.sin(0.62) * 48, 58, 100008 + Math.cos(0.62) * 48],
  },
});

function qaFixtureSource() {
  return [
    "'use strict';",
    '(function () {',
    '  const fixture = ' + JSON.stringify(QA_FIXTURE) + ';',
    '  let state = fixture.randomSeed | 0;',
    '  Math.random = function () {',
    '    state = (state + 0x6D2B79F5) | 0;',
    '    let value = state;',
    '    value = Math.imul(value ^ (value >>> 15), value | 1);',
    '    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);',
    '    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;',
    '  };',
    "  BWStorage.setItem('blocky-world-selected-type', fixture.worldType);",
    "  BWStorage.setItem('blocky-world-local-save-v1', JSON.stringify({",
    '    worldType: fixture.worldType, seed: fixture.seed, worldSize: 200000, player1: fixture.player,',
    "    slot: 0, pick: { p1: 'steve', p2: 'golem', p2bot: true, botLevel: 1 },",
    '    settings: { sensitivity: 0.0024, renderDist: 5, dayNight: true, sfx: false, renderDistAuto: false },',
    '    inventory: { apple: 0, meat: 0 }, edits: [],',
    '  }));',
    '  const qa = window.BW_QA = { fixture: fixture, ready: false, applySetup: applySetup };',
    '  function applySetup() {',
    "    if (typeof Game === 'undefined' || !Game.world || Game.state !== 'menu') return false;",
    '    Object.defineProperty(Game, "dayPhase", { configurable: true, get: function () { return 0.25; }, set: function () {} });',
    '    Game.startObserve();',
    '    Game.animals.forEach(function (animal) { animal.update = function () {}; });',
    '    Game.updateAnimals = function () {};',
    '    Game.players.forEach(function (player) { player.pos = fixture.player.slice(); });',
    '    Observer.index = fixture.camera.viewIndex;',
    '    Observer.orbitAngle = fixture.camera.orbitAngle;',
    '    Observer.orbitRadius = fixture.camera.orbitRadius;',
    '    Observer.orbitHeight = fixture.camera.orbitHeight;',
    '    Observer.zoom = fixture.camera.zoom;',
    '    Observer.target = fixture.camera.target.slice();',
    '    Observer.pos = fixture.camera.position.slice();',
    '    Cam.yaw = fixture.camera.yaw;',
    '    Cam.pitch = fixture.camera.pitch;',
    '    Game.time = 0;',
    '    qa.ready = true;',
    '    return true;',
    '  }',
    '  window.addEventListener("load", function () {',
    '    let attempts = 0;',
    '    const poll = function () {',
    '      if (applySetup()) return;',
    '      if (++attempts < 600) setTimeout(poll, 100);',
    '    };',
    '    poll();',
    '  });',
    '})();',
    '',
  ].join('\n');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function gitValue(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function readSource(file) {
  return execFileSync('git', ['show', 'HEAD:' + file], { cwd: REPO_ROOT, encoding: 'utf8' });
}

function assertCleanCheckout(status) {
  if (String(status).trim()) {
    throw new Error('QA builds require a clean Git checkout so the recorded source commit matches every input');
  }
}

function walkFiles(root, prefix = '') {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(root, entry.name);
    return entry.isDirectory() ? walkFiles(absolute, relative) : [relative];
  }).sort();
}

function validateOutputPath(candidate, fileSystem = fs) {
  const resolved = path.resolve(candidate);
  if (resolved !== OUT || path.dirname(resolved) !== REPO_ROOT || path.basename(resolved) !== '.qa-public') {
    throw new Error('QA output must be the dedicated .qa-public directory');
  }
  if (fileSystem.existsSync(resolved) && fileSystem.lstatSync(resolved).isSymbolicLink()) {
    throw new Error('QA output directory must not be a symbolic link');
  }
  return resolved;
}

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
  if (!match) return source;
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

function removeHtmlElementById(html, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const opening = new RegExp('<([a-z][a-z0-9:-]*)\\b(?=[^>]*\\bid=["\\\']' + escaped + '["\\\'])[^>]*>', 'i');
  const match = opening.exec(html);
  if (!match) throw new Error('Expected network/auth UI element not found: ' + id);
  const tag = match[1];
  const tags = new RegExp('<\\/?' + tag + '\\b[^>]*>', 'gi');
  tags.lastIndex = match.index;
  let depth = 0, token;
  while ((token = tags.exec(html))) {
    if (/^<\//.test(token[0])) depth--;
    else if (!/\/>$/.test(token[0])) depth++;
    if (depth === 0) return html.slice(0, match.index) + html.slice(tags.lastIndex);
  }
  throw new Error('Unclosed network/auth UI element: ' + id);
}

function stripNetworkOnlyMain(source) {
  source = source.replace(/\bconst animalHit = breakJustPressed && \(this\.tryHitAnimal\(p\) \|\| this\.tryHitVisitingPlayer\(p\)\);/, 'const animalHit = breakJustPressed && this.tryHitAnimal(p);');
  const networkOnlyMethods = [
    'tryHitVisitingPlayer', 'startHostedFightPreview', 'openSharedFightChoice',
    'startSharedFight', 'serializeSharedFightState', 'applySharedFightState',
    'enterSharedWorld', 'restorePersonalWorld', 'enterSharedMode',
  ];
  for (const name of networkOnlyMethods) source = removeObjectMethod(source, name);
  for (const name of networkOnlyMethods) {
    if (new RegExp('^\\s{2}(?:async\\s+)?' + name + '\\s*\\(', 'm').test(source)) {
      throw new Error('Network-only Game method remains in QA output: ' + name);
    }
  }
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
  source = source.replace(/^\s*document\.getElementById\(['\"]shared-fight-dialog['\"]\)\.classList\.(?:add|remove)\(['\"]hidden['\"]\);\r?\n/gm, '');
  source = source.replace(/\.auth-screen,?\s*/g, '');
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
  validateOutputPath(OUT);
  assertCleanCheckout(gitValue(['status', '--porcelain', '--untracked-files=all']));
  const stage = path.join(REPO_ROOT, '.qa-public.tmp-' + process.pid);
  const backup = path.join(REPO_ROOT, '.qa-public.previous-' + process.pid);
  for (const candidate of [stage, backup]) {
    if (fs.existsSync(candidate)) throw new Error('Refusing to reuse an existing QA build path: ' + candidate);
  }
  fs.mkdirSync(stage, { recursive: true });
  try {
  let html = readSource('index.html')
    .replace(/\s*<script src="js\/network\.js"><\/script>\s*/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '');
  for (const id of ['auth-screen', 'visit-lobby', 'visit-hud', 'visit-mode-dialog', 'shared-fight-dialog']) {
    html = removeHtmlElementById(html, id);
  }
  html = html.replace(/\s*<div class="session-row">[\s\S]*?<\/div>\s*/g, '\n');
  html = html.replace(/Marlene\s*&amp;\s*Florenz's Game/gi, 'Blocky World QA');
  html = html.replace(/\b(?:Marlene|Florenz|Feng)\b/gi, 'Player');
  fs.writeFileSync(path.join(stage, 'index.html'), html);
  const sourceCss = readSource('style.css');
  const cssStart = sourceCss.indexOf('/* ---------- local profile sign-in ---------- */');
  const cssEnd = sourceCss.indexOf('/* Shared visibility state for gameplay buttons and nested panels. */', cssStart);
  const worldCssStart = sourceCss.indexOf('.world-label {', cssStart);
  const worldCssEnd = sourceCss.indexOf('.visit-lobby {', worldCssStart);
  if (cssStart < 0 || cssEnd < 0 || worldCssStart < 0 || worldCssEnd < 0) throw new Error('Expected auth/visit/world-picker CSS boundaries were not found');
  const worldPickerCss = sourceCss.slice(worldCssStart, worldCssEnd);
  const css = sourceCss.slice(0, cssStart) + worldPickerCss + sourceCss.slice(cssEnd);
  assertWorldPickerCss(css);
  fs.writeFileSync(path.join(stage, 'style.css'), css);

  fs.mkdirSync(path.join(stage, 'js'), { recursive: true });
  for (const file of JS_FILES) {
    let source = readSource('js/' + file);
    if (file === 'main.js') source = stripNetworkOnlyMain(source);
    source = source.replace(/\.auth-screen,?\s*/g, '');
    const result = await terser.minify(source, {
      compress: { global_defs: { 'window.Network': false, 'window.BW_QA_MEMORY_ONLY': true, Network: false }, passes: 8 },
      mangle: false,
      format: { comments: false },
    });
    fs.writeFileSync(path.join(stage, 'js', file), result.code + '\n');
  }
  fs.writeFileSync(path.join(stage, 'js', 'storage.js'), [
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
  fs.writeFileSync(path.join(stage, 'js', 'qa-fixture.js'), qaFixtureSource());
  html = html.replace('<script src="js/main.js"></script>', '<script src="js/qa-fixture.js"></script>\n<script src="js/main.js"></script>');
  fs.writeFileSync(path.join(stage, 'index.html'), html);
  assertSanitizedOutput(stage);
  const sourceFiles = ['index.html', 'style.css', ...JS_FILES.map((file) => path.join('js', file))];
  const sourceHashes = Object.fromEntries(sourceFiles.map((file) => [
    file.split(path.sep).join('/'), sha256(readSource(file.split(path.sep).join('/'))),
  ]));
  const sourceBlobs = Object.fromEntries(sourceFiles.map((file) => {
    const relative = file.split(path.sep).join('/');
    return [relative, gitValue(['rev-parse', 'HEAD:' + relative])];
  }));
  const outputFiles = walkFiles(stage);
  const manifest = {
    schemaVersion: 1,
    source: { commit: gitValue(['rev-parse', 'HEAD']), tree: gitValue(['rev-parse', 'HEAD^{tree}']) },
    tool: {
      name: 'blocky-world-sanitized-qa-builder',
      version: require(path.join(REPO_ROOT, 'package.json')).version,
      terserVersion: require(path.join(REPO_ROOT, 'package.json')).devDependencies.terser,
      node: process.version,
      sanitizerSha256: sha256(fs.readFileSync(__filename)),
      packageSha256: sha256(fs.readFileSync(path.join(REPO_ROOT, 'package.json'))),
      lockfileSha256: sha256(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'))),
    },
    transforms: [
      'remove family profile, PIN, setup, visit, and server UI from HTML and CSS',
      'omit network.js and whitelist only the required local game modules',
      'remove network-only game branches and compile Network references out',
      'replace persistent browser storage with page-memory-only BWStorage',
      'minify JavaScript using the pinned Terser dependency',
      'add a deterministic QA-only Storybook world and observer fixture',
    ],
    qaFixture: QA_FIXTURE,
    inputSha256: sourceHashes,
    inputGitBlobs: sourceBlobs,
    assets: Object.fromEntries(outputFiles.map((file) => [file, {
      sha256: sha256(fs.readFileSync(path.join(stage, file))),
      bytes: fs.statSync(path.join(stage, file)).size,
    }])),
  };
  fs.writeFileSync(path.join(stage, 'provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
  assertSanitizedOutput(stage);

  let movedOld = false;
  try {
    if (fs.existsSync(OUT)) {
      fs.renameSync(OUT, backup);
      movedOld = true;
    }
    fs.renameSync(stage, OUT);
  } catch (error) {
    if (movedOld && !fs.existsSync(OUT)) fs.renameSync(backup, OUT);
    throw error;
  }
  if (movedOld) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function assertNoForbiddenReferences(text, resourceText) {
  const forbidden = [
    ['server/network/auth UI', /\bserver\b|\bNetwork\b|network\.js|networkRemote|auth-screen|login-form|visit-lobby|visit-hud|visit-mode-dialog|shared-fight-dialog|session-row/i],
    ['identifying profile/PIN UI', /\b(?:Marlene|Florenz|Feng)\b|\bPIN\b|auth-profile|profile-setup|login-form|choose your profile|sign in/i],
    ['server/visit mode', /serverMode|visitRole|visitActive|visit\/|sharedFight|sharedMode/i],
    ['persistent storage', /localStorage|sessionStorage|indexedDB/i],
    ['network transport', /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|serviceWorker|RTCPeerConnection|WebTransport|\bimport\s*\(|importScripts|\/api\/|https?:\/\/|wss?:\/\//i],
    ['dynamic resource loader', /document\.createElement\s*\(\s*['"](?:script|iframe|img|link)|new\s+(?:Worker|SharedWorker|Image)\b/i],
  ];
  for (const [label, pattern] of forbidden) {
    const match = pattern.exec(text);
    if (match) throw new Error('Sanitized QA output contains ' + label + ' token ' + JSON.stringify(match[0]) + ': ' + text.slice(Math.max(0, match.index - 50), match.index + 100));
  }
  assertNoExternalResources(resourceText === undefined ? text : resourceText);
}

function assertNoExternalResources(text) {
  const decodeCssEscapes = (value) => value
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\([^\r\n])/g, '$1')
    .replace(/\\(?:\r\n|[\n\r\f])/g, '');
  const remoteUrl = (value) => {
    const normalized = decodeCssEscapes(value).trim().replace(/\\/g, '/');
    if (!normalized || normalized[0] === '#' || /^data:/i.test(normalized)) return false;
    return /^(?:\/\/|[a-z][a-z0-9+.-]*:)/i.test(normalized);
  };
  const htmlUrlAttribute = /\b(srcset|imagesrcset|srcdoc|style|src|href|poster|background|data|archive|classid|codebase|cite|longdesc|manifest|profile|usemap|ping|xml:base|action|formaction|xlink:href|http-equiv)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  const htmlTags = [];
  for (let offset = 0; offset < text.length;) {
    const start = text.indexOf('<', offset);
    if (start < 0) break;
    if (text.startsWith('<!--', start)) {
      const endComment = text.indexOf('-->', start + 4);
      if (endComment < 0) throw new Error('Sanitized QA output contains an unterminated HTML comment');
      offset = endComment + 3;
      continue;
    }
    let cursor = start + 1;
    if (text[cursor] === '/') cursor++;
    if (!/[a-z]/i.test(text[cursor] || '')) { offset = start + 1; continue; }
    let quote = '';
    let end = -1;
    for (let i = cursor + 1; i < text.length; i++) {
      const ch = text[i];
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') { end = i; break; }
    }
    if (end < 0) throw new Error('Sanitized QA output contains an unterminated HTML tag');
    htmlTags.push(text.slice(start, end + 1));
    offset = end + 1;
  }

  for (const tag of htmlTags) {
    const tagName = /^<\/?([a-z][a-z0-9-]*)/i.exec(tag)[1].toLowerCase();
    if (/^(?:base|embed|frame|frameset|iframe|object|applet|portal)$/.test(tagName)) {
      throw new Error('Sanitized QA output contains an unsupported resource-capable HTML element: ' + tagName);
    }
    const isMetaTag = /^<meta\b/i.test(tag);
    if (isMetaTag && tag.includes('&')) throw new Error('Sanitized QA output contains an encoded HTML meta attribute');
    htmlUrlAttribute.lastIndex = 0;
    let attribute;
    while ((attribute = htmlUrlAttribute.exec(tag))) {
      const name = attribute[1].toLowerCase();
      const value = attribute[2] || attribute[3] || attribute[4] || '';
      if (name === 'srcdoc') throw new Error('Sanitized QA output contains an unsupported embedded HTML document');
      if (isMetaTag && name === 'http-equiv') throw new Error('Sanitized QA output contains an unsupported HTML meta http-equiv directive');
      if (name === 'srcset' || name === 'imagesrcset') throw new Error('Sanitized QA output contains an unreviewed HTML responsive image attribute');
      if (name === 'action' || name === 'formaction' || name === 'ping' || name === 'xml:base') throw new Error('Sanitized QA output contains an unsupported HTML navigation or request attribute: ' + name);
      if (value.includes('&')) throw new Error('Sanitized QA output contains an encoded HTML resource/style value: ' + value);
      if (name !== 'src' && name !== 'href' && name !== 'style') throw new Error('Sanitized QA output contains an unsupported HTML resource attribute: ' + name);
      if (name !== 'style' && remoteUrl(value)) throw new Error('Sanitized QA output contains an external HTML resource URL: ' + value);
      if (name === 'src' && !JS_ASSET_ALLOWLIST.has(value) && !/^data:image\/(?:png|gif|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(value)) throw new Error('Sanitized QA output contains an unapproved local source URL: ' + value);
      if (name === 'href' && value !== 'data:,' && value !== 'style.css' && value[0] !== '#') throw new Error('Sanitized QA output contains an unapproved local link URL: ' + value);
      if (name === 'style') assertNoCssResources(value);
    }
  }
  assertNoCssResources(text.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ''));
}

function assertNoCssResources(css) {
  const decodeCssEscapes = (value) => value
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\([^\r\n])/g, '$1')
    .replace(/\\(?:\r\n|[\n\r\f])/g, '');
  const decoded = decodeCssEscapes(css).replace(/\/\*[\s\S]*?\*\//g, '');
  if (/@import\b/i.test(decoded)) throw new Error('Sanitized QA output contains a CSS @import rule');
  if (/image-set\s*\(/i.test(decoded)) throw new Error('Sanitized QA output contains an unsupported CSS image-set resource');
  const url = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
  let match;
  while ((match = url.exec(decoded))) {
    const value = (match[1] || match[2] || match[3] || '').trim();
    const normalized = decodeCssEscapes(value).trim();
    if (normalized && !/^#[a-z0-9_.:-]+$/i.test(normalized)) {
      throw new Error('Sanitized QA output contains a CSS resource outside the fragment-only allowlist: ' + value);
    }
  }
}

function assertWorldPickerCss(css) {
  const required = [
    ['world cards use a responsive grid', /\.world-cards\s*\{[^}]*display:\s*grid/i],
    ['world cards retain their flex layout', /\.world-card\s*\{[^}]*display:\s*flex/i],
    ['world cards collapse to one column on narrow screens', /@media\s*\(max-width:\s*420px\)\s*\{\s*\.world-cards\s*\{\s*grid-template-columns:\s*1fr/i],
  ];
  for (const [label, pattern] of required) {
    if (!pattern.test(css)) throw new Error('Generated QA CSS is missing required world-picker layout: ' + label);
  }
}

function assertSanitizedOutput(root = OUT) {
  const allFiles = walkFiles(root).filter((file) => file !== 'provenance.json');
  const expectedFiles = ['index.html', 'style.css', ...JS_ASSET_ALLOWLIST].sort();
  if (JSON.stringify(allFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('Sanitized QA output does not match the complete asset allowlist: ' + allFiles.join(', '));
  }
  for (const file of allFiles) {
    if (file.startsWith('js/') && !JS_ASSET_ALLOWLIST.has(file)) throw new Error('Sanitized QA output contains an unapproved script asset: ' + file);
  }
  const files = allFiles.filter((file) => file.startsWith('js/')).map((file) => path.join(root, file));
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  assertNoExternalResources(html);
  assertNoCssResources(css);
  const text = html + '\n' + css + '\n' + files.map((p) => fs.readFileSync(p, 'utf8')).join('\n');
  assertNoForbiddenReferences(text, html);
}

if (require.main === module) build().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { matchingBrace, removeObjectMethod, retainFinalElse, stripNetworkOnlyMain, assertSanitizedOutput, assertNoForbiddenReferences, assertNoExternalResources, assertNoCssResources, assertWorldPickerCss, validateOutputPath, assertCleanCheckout, JS_ASSET_ALLOWLIST, QA_FIXTURE, qaFixtureSource, build };
