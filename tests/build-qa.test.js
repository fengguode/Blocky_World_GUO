'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const terser = require('terser');
const builder = require('../scripts/build-qa');

const root = path.join(__dirname, '..');
const output = path.join(root, '.qa-public');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

function rejects(fn, message) {
  assert.throws(fn, undefined, message);
}

function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name);
    return entry.isDirectory() ? walk(path.join(dir, entry.name), relative) : [relative];
  }).sort();
}

async function run() {
  for (const token of [
    'Network', 'network.js', 'Florenz', 'Marlene', 'Feng', 'PIN', 'auth-profile',
    'profile-setup', 'login-form', 'serverMode', 'visitRole', 'localStorage',
    'sessionStorage', 'indexedDB', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource',
    'sendBeacon', 'serviceWorker', 'RTCPeerConnection', 'WebTransport', 'import(', 'importScripts', '/api/',
  ]) rejects(() => builder.assertNoForbiddenReferences('window.' + token), 'denylist rejects ' + token);

  for (const resource of [
    '<script src="https://bad.example/a.js"></script>',
    '<link rel="stylesheet" href="//bad.example/a.css">',
    '<iframe srcdoc="<script src=https://bad.example/x></script>"></iframe>',
    '<img srcset="local.png 1x, https://bad.example/a.png 2x">',
    '<div style="background:url(https://bad.example/a.png)"></div>',
    '<script src="js/not-allowlisted.js"></script>',
    '<object data="local.bin"></object>',
  ]) rejects(() => builder.assertNoExternalResources(resource), 'resource denylist rejects ' + resource);

  builder.assertNoExternalResources('<script src="js/main.js"></script><link rel="stylesheet" href="style.css"><link rel="icon" href="data:,">');
  builder.assertNoCssResources('clip-path: url(#clip-shape);');
  for (const css of [
    '@import "https://bad.example/a.css";',
    'x { background: url(//bad.example/a.png); }',
    'x { background: url(/api/profile); }',
    'x { background: url(unlisted.png); }',
    'x { background: image-set(url(local.png) 1x); }',
    'x { background: url(data:text/html;base64,PHNjcmlwdD4=); }',
  ]) rejects(() => builder.assertNoCssResources(css), 'CSS denylist rejects ' + css);

  const allowed = [...builder.JS_ASSET_ALLOWLIST].sort();
  assert(allowed.includes('js/main.js'));
  assert(allowed.includes('js/storage.js'));
  assert(!allowed.includes('js/network.js'));
  assert.equal(builder.validateOutputPath(output), output);
  rejects(() => builder.validateOutputPath(root), 'builder refuses repository root as output');
  builder.assertCleanCheckout('');
  rejects(() => builder.assertCleanCheckout(' M js/main.js'), 'builder refuses inputs that differ from recorded HEAD');

  await builder.build();
  const first = Object.fromEntries(walk(output).map((file) => [file, digest(fs.readFileSync(path.join(output, file)))]));
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'provenance.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.source.commit, /^[0-9a-f]{40}$/);
  assert.match(manifest.source.tree, /^[0-9a-f]{40}$/);
  assert.equal(manifest.tool.version, '1.0.0');
  assert.equal(manifest.tool.terserVersion, '5.43.1');
  assert(manifest.inputSha256['index.html']);
  assert(manifest.inputSha256['js/main.js']);
  assert.match(manifest.inputGitBlobs['js/main.js'], /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(manifest.inputGitBlobs).sort(), Object.keys(manifest.inputSha256).sort());
  assert.equal(manifest.assets['index.html'].sha256, first['index.html']);
  for (const [file, record] of Object.entries(manifest.assets)) {
    assert.equal(first[file], record.sha256, 'manifest hash covers ' + file);
    assert.equal(fs.statSync(path.join(output, file)).size, record.bytes, 'manifest byte count covers ' + file);
  }
  assert.deepEqual(Object.keys(manifest.assets).sort(), Object.keys(first).filter((file) => file !== 'provenance.json').sort());
  builder.assertSanitizedOutput(output);
  const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
  assert.match(html, /<title>Blocky World QA<\/title>/i);
  assert(!/auth-screen|login-form|profile-setup|network\.js|Florenz|Marlene|Feng|PIN/i.test(html));
  assert.deepEqual(walk(path.join(output, 'js')).map((file) => 'js/' + file).sort(), [...builder.JS_ASSET_ALLOWLIST].sort());

  let nativeStorageTouches = 0;
  const context = {
    Map,
    window: {},
    localStorage: new Proxy({}, { get() { nativeStorageTouches++; throw new Error('persistent storage accessed'); } }),
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(output, 'js/storage.js'), 'utf8'), context);
  context.window.BWStorage.setItem('world', 'memory-only');
  assert.equal(context.window.BWStorage.getItem('world'), 'memory-only');
  assert.equal(nativeStorageTouches, 0, 'the generated storage adapter never touches native browser storage');

  const minify = terser.minify;
  terser.minify = async () => { throw new Error('injected build failure'); };
  await assert.rejects(builder.build(), /injected build failure/);
  terser.minify = minify;
  const afterFailure = Object.fromEntries(walk(output).map((file) => [file, digest(fs.readFileSync(path.join(output, file)))]));
  assert.deepEqual(afterFailure, first, 'a failed staged build leaves the prior successful output intact');
  assert.deepEqual(fs.readdirSync(root).filter((name) => /^\.qa-public\.(?:tmp|previous)-/.test(name)), [], 'failed staging directories are cleaned');

  await builder.build();
  const second = Object.fromEntries(walk(output).map((file) => [file, digest(fs.readFileSync(path.join(output, file)))]));
  assert.deepEqual(second, first, 'repeated builds produce byte-identical output and provenance');
  console.log('QA sanitizer tests passed (denylist, allowlist, output scan, manifest, reproducibility).');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
