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
const previewOutput = path.join(root, '.preview-public');
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
  assert.equal(builder.validateOutputPath(previewOutput, undefined, 'preview'), previewOutput);
  rejects(() => builder.validateOutputPath(root), 'builder refuses repository root as output');
  rejects(() => builder.validateOutputPath(root, undefined, 'preview'), 'preview builder refuses repository root as output');
  assert(!builder.assetAllowlist('preview').has('js/qa-fixture.js'), 'playable preview excludes the frozen observer fixture');
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
  assert.deepEqual(manifest.qaFixture, builder.QA_FIXTURE, 'manifest records the Storybook seed and observer setup');
  assert(manifest.transforms.includes('add a deterministic QA-only Storybook world and observer fixture'));
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
  assert.match(html, /<script src="js\/qa-fixture\.js"><\/script>\s*<script src="js\/main\.js"><\/script>/);
  assert.doesNotMatch(builder.qaFixtureSource(), /localStorage|sessionStorage|indexedDB|WebSocket|\bNetwork\b|https?:\/\//i);

  function runFixtureSetup() {
    const memory = new Map();
    const fixtureWindow = { addEventListener() {} };
    const game = {
      state: 'menu', world: {}, players: [{ pos: [1, 2, 3] }, { pos: [4, 5, 6] }],
      time: 99, showDebug: true, update() { return 'moving'; }, aspect() { return 1; },
      startObserve() { this.state = 'observe'; }, updateAnimals() {},
    };
    const observer = {}, cam = { update(...args) { this.updateArgs = args; } };
    const context = {
      Map, Math: Object.create(Math), JSON, window: fixtureWindow,
      BWStorage: { setItem(key, value) { memory.set(key, String(value)); }, getItem(key) { return memory.get(key) || null; } },
      Game: game, Observer: observer, Cam: cam, setTimeout() {},
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(output, 'js/qa-fixture.js'), 'utf8'), context);
    const randomSamples = [context.Math.random(), context.Math.random(), context.Math.random()];
    assert.equal(fixtureWindow.BW_QA.applySetup(), true);
    return JSON.parse(JSON.stringify({
      save: JSON.parse(memory.get('blocky-world-local-save-v1')),
      activeWorld: memory.get('blocky-world-selected-type'),
      fixture: JSON.parse(JSON.stringify(fixtureWindow.BW_QA.fixture)),
      randomSamples,
      state: game.state, players: game.players.map((player) => player.pos), updateResult: game.update(),
      dayPhase: game.dayPhase, showDebug: game.showDebug,
      camera: {
        index: observer.index, target: observer.target, position: observer.pos, yaw: cam.yaw, pitch: cam.pitch,
        camPosition: cam.pos, updateArgs: cam.updateArgs,
      },
      time: game.time,
    }));
  }
  const fixtureRun1 = runFixtureSetup(), fixtureRun2 = runFixtureSetup();
  assert.deepEqual(fixtureRun1, fixtureRun2, 'repeated fixture setup has identical world and camera state');
  assert.equal(fixtureRun1.save.seed, 1337);
  assert.equal(fixtureRun1.fixture.randomSeed, 0x21f1337);
  assert.equal(fixtureRun1.camera.index, 0);
  assert.deepEqual(fixtureRun1.camera.target, [100008, 29, 100008]);
  assert.deepEqual(fixtureRun1.camera.position, [100042, 59, 100042]);
  assert.equal(fixtureRun1.camera.yaw, Math.PI / 4);
  assert.equal(fixtureRun1.camera.pitch, -0.54);
  assert.deepEqual(fixtureRun1.camera.updateArgs, [0, 1, [100042, 59, 100042]]);
  assert.equal(fixtureRun1.updateResult, undefined, 'the fixture freezes game updates for a stable render');
  assert.equal(fixtureRun1.dayPhase, 0.25);
  assert.equal(fixtureRun1.showDebug, false);

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
  await builder.build('preview');
  const previewFirst = Object.fromEntries(walk(previewOutput).map((file) => [file, digest(fs.readFileSync(path.join(previewOutput, file)))]));
  const previewManifest = JSON.parse(fs.readFileSync(path.join(previewOutput, 'provenance.json'), 'utf8'));
  assert.equal(previewManifest.mode, 'preview');
  assert.deepEqual(previewManifest.playablePreview, { startsAt: 'main-menu', storage: 'page-memory-only' });
  assert(!Object.hasOwn(previewManifest, 'qaFixture'), 'playable preview has no observer fixture provenance');
  assert(previewManifest.transforms.includes('leave the normal game menu interactive and start a fresh page-memory-only world when Play & Build is selected'));
  builder.assertSanitizedOutput(previewOutput, 'preview');
  const previewHtml = fs.readFileSync(path.join(previewOutput, 'index.html'), 'utf8');
  assert.match(previewHtml, /<title>Blocky World Preview<\/title>/i);
  assert.match(previewHtml, /id="btn-play"/);
  assert.doesNotMatch(previewHtml, /qa-fixture|observe-hud.*show/i);
  assert(!fs.existsSync(path.join(previewOutput, 'js', 'qa-fixture.js')));
  assert.deepEqual(walk(path.join(previewOutput, 'js')).map((file) => 'js/' + file).sort(), [...builder.assetAllowlist('preview')].sort());
  await builder.build('preview');
  const previewSecond = Object.fromEntries(walk(previewOutput).map((file) => [file, digest(fs.readFileSync(path.join(previewOutput, file)))]));
  assert.deepEqual(previewSecond, previewFirst, 'repeated playable-preview builds are byte-identical');
  console.log('Sanitized builds passed (denylist, allowlists, frozen QA fixture, interactive preview, output scan, provenance, dirty-checkout protection, reproducibility).');
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
