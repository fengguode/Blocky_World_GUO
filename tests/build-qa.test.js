'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const terser = require('terser');
const qaTestCheckout = require('./qa-test-checkout');

const isolatedChild = process.env.BW_QA_TEST_ISOLATED_CHECKOUT === '1';
const root = isolatedChild ? path.resolve(process.cwd()) : path.join(__dirname, '..');
const output = path.join(root, '.qa-public');
const builder = require(path.join(root, 'scripts', 'build-qa.js'));
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

if (isolatedChild && !qaTestCheckout.isDisposableCheckout(root, process.env.BW_QA_TEST_CHECKOUT_TOKEN, path.join(__dirname, '..'))) {
  throw new Error('Isolated QA test mode requires the private marker for its own disposable checkout');
}

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

  const dirtyGuard = qaTestCheckout.exerciseDirtyBuildGuard(root, path.join(__dirname, '..'));
  assert.notEqual(dirtyGuard.exitCode, 0, 'builder rejects a dirty checkout');
  assert.match(dirtyGuard.diagnostic, /clean Git checkout/);
  assert.equal(dirtyGuard.statusAfter, dirtyGuard.statusBefore, 'dirty build leaves checkout changes untouched');
  assert.deepEqual(dirtyGuard.outputAfter, dirtyGuard.outputBefore, 'dirty build leaves an existing .qa-public preview untouched');
  assert.equal(dirtyGuard.statusCleanAfterRestore, '', 'dirty build regression restores the committed source');

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
  const qaUi = fs.readFileSync(path.join(output, 'js/ui.js'), 'utf8');
  assert.match(html, /<title>Blocky World QA<\/title>/i);
  assert(!/auth-screen|login-form|profile-setup|network\.js|Florenz|Marlene|Feng|PIN/i.test(html));
  for (const id of ['btn-fight-lobby-settings', 'btn-fight-lobby-exit']) {
    assert(!html.includes('id="' + id + '"'), 'sanitized HTML removes ' + id);
    assert(!qaUi.includes(id), 'sanitized UI does not bind a control removed with shared-fight-dialog: ' + id);
  }
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
  console.log('QA sanitizer tests passed (denylist, allowlist, output scan, manifest, dirty-checkout protection, reproducibility).');
}

async function runWithoutTouchingDeveloperCheckout() {
  const sourceRoot = path.join(__dirname, '..');
  const developerState = qaTestCheckout.captureDeveloperState(sourceRoot);
  const forgedToken = 'f'.repeat(48);
  assert.equal(qaTestCheckout.isDisposableCheckout(sourceRoot, forgedToken, sourceRoot, {
    realpathSync: fs.realpathSync.bind(fs),
    readFileSync() { throw new Error('marker must not be read for the live checkout'); },
  }), false, 'a forged token cannot make the live checkout disposable');
  const forged = spawnSync(process.execPath, [__filename], {
    cwd: sourceRoot,
    encoding: 'utf8',
    timeout: 30000,
    env: qaTestCheckout.nodePathEnv(sourceRoot, {
      ...process.env,
      BW_QA_TEST_ISOLATED_CHECKOUT: '1',
      BW_QA_TEST_CHECKOUT_TOKEN: forgedToken,
    }),
  });
  assert.notEqual(forged.status, 0, 'isolated mode rejects a forged token from the live checkout root');
  assert.match(forged.stderr, /private marker for its own disposable checkout/);
  assert.deepEqual(qaTestCheckout.captureDeveloperState(sourceRoot), developerState,
    'forged live-root invocation fails before changing the worktree or existing .qa-public output');
  const checkout = qaTestCheckout.createCommittedCheckout(sourceRoot);
  try {
    const result = spawnSync(process.execPath, [__filename], {
      cwd: checkout.root,
      encoding: 'utf8',
      timeout: 180000,
      env: qaTestCheckout.nodePathEnv(sourceRoot, {
        ...process.env,
        BW_QA_TEST_ISOLATED_CHECKOUT: '1',
        BW_QA_TEST_CHECKOUT_TOKEN: checkout.token,
      }),
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.status !== 0) {
      throw new Error('Isolated QA sanitizer test failed: ' + (result.stderr || result.stdout || result.error || 'unknown child-process failure'));
    }
  } finally {
    checkout.dispose();
  }
  assert.deepEqual(qaTestCheckout.captureDeveloperState(sourceRoot), developerState,
    'QA test preserves the live checkout and any existing .qa-public preview');
  console.log('Live checkout and existing .qa-public preview preserved.');
}

if (isolatedChild) run().catch((error) => { console.error(error); process.exitCode = 1; });
else runWithoutTouchingDeveloperCheckout().catch((error) => { console.error(error); process.exitCode = 1; });
