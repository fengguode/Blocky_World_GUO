'use strict';
/* ============================================================
   tests/harness.js
   Loads the real game source files into a sandbox with a stubbed
   DOM and a stubbed WebGL2 context, so the tests exercise the
   exact code that ships rather than a re-implementation.

   Usage from a test file:
     const H = require('./harness');
     const g = H.load();          // the sandbox globals
     H.test('name', () => { ... });
     H.run();
   ============================================================ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* ---------- stub WebGL2 ---------- */
function stubGL(record) {
  let nextId = 1;
  const id = () => nextId++;
  const noop = () => {};
  const gl = {
    // constants (values are arbitrary but distinct)
    DEPTH_TEST: 1, CULL_FACE: 2, BLEND: 3,
    BACK: 4, FRONT: 5,
    ARRAY_BUFFER: 6, ELEMENT_ARRAY_BUFFER: 7, STATIC_DRAW: 8,
    FLOAT: 9, TRIANGLES: 10, UNSIGNED_INT: 11, UNSIGNED_SHORT: 12,
    TEXTURE_2D: 13, TEXTURE_2D_ARRAY: 14,
    TEXTURE_MAG_FILTER: 15, TEXTURE_MIN_FILTER: 16,
    TEXTURE_WRAP_S: 17, TEXTURE_WRAP_T: 18,
    NEAREST: 19, LINEAR_MIPMAP_LINEAR: 20, CLAMP_TO_EDGE: 21,
    RGBA: 22, RGBA8: 23, UNSIGNED_BYTE: 24,
    TEXTURE_MAX_ANISOTROPY_EXT: 25,
    COMPILE_STATUS: 26, LINK_STATUS: 27,
    VERTEX_SHADER: 28, FRAGMENT_SHADER: 29,
    ACTIVE_UNIFORMS: 30, ACTIVE_ATTRIBUTES: 31,

    // calls the game makes
    createTexture: () => ({ id: id(), kind: 'texture' }),
    bindTexture: noop,
    texImage3D(target, level, internal, w, h, d, border, fmt, type, data) {
      if (record) record.texImage3D = { w, h, d };
    },
    texSubImage3D: noop,
    generateMipmap: noop,
    texParameteri: noop,
    texParameterf: noop,
    getExtension: () => null,
    getParameter: () => 8,

    createVertexArray: () => {
      const vao = { id: id(), kind: 'vao', buffers: [] };
      if (record) record.vaos.push(vao);
      return vao;
    },
    bindVertexArray: (v) => { if (record) record.boundVAO = v; },
    deleteVertexArray: (v) => { if (record && v) v.deleted = true; },
    createBuffer: () => {
      const b = { id: id(), kind: 'buffer', data: null };
      if (record) record.buffers.push(b);
      return b;
    },
    bindBuffer: noop,
    bufferData(target, data) {
      if (record && data) record.lastBufferBytes = data.byteLength;
    },
    bufferSubData: noop,
    enableVertexAttribArray: noop,
    vertexAttribPointer: noop,
    drawElements: noop,
    drawArrays: noop,
    enable: noop,
    disable: noop,
    blendFunc: noop,
    depthMask: noop,
    cullFace: noop,
    viewport: noop,
    clearColor: noop,
    clear: noop,
    activeTexture: noop,
    useProgram: noop,
    getError: () => 0,

    // program creation is not under test; return a stub with a uniform table
    createShader: () => ({ id: id() }),
    shaderSource: noop,
    compileShader: noop,
    getShaderParameter: () => 1,
    getShaderInfoLog: () => '',
    deleteShader: noop,
    createProgram: () => ({ id: id(), u: {}, a: {} }),
    attachShader: noop,
    linkProgram: noop,
    getProgramParameter: () => 0,
    getProgramInfoLog: () => '',
    getActiveUniform: () => ({ name: 'u' }),
    getActiveAttrib: () => ({ name: 'a' }),
    getUniformLocation: () => ({}),
    getAttribLocation: () => 0,
    uniform1f: noop, uniform1i: noop, uniform2f: noop,
    uniform3f: noop, uniform4f: noop, uniformMatrix4fv: noop,
    readPixels: noop,
    deleteBuffer: noop,
    deleteTexture: noop,
    deleteProgram: noop,
  };
  return gl;
}

/* ---------- stub 2D canvas (used for block icons) ---------- */
function stubCanvas2D() {
  const noop = () => {};
  return {
    imageSmoothingEnabled: false,
    fillStyle: '#000',
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop,
    drawImage: noop,
    fillRect: noop,
    strokeRect: noop,
    translate: noop,
    rotate: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    strokeStyle: '#000',
    lineWidth: 1,
    fill: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
  };
}

/* ---------- load the game into a sandbox ---------- */
function load(options) {
  options = options || {};
  const record = options.record || { vaos: [], buffers: [] };
  // Passing the same storage object across loads simulates a page reload.
  const storage = options.storage || makeStorage();

  const listeners = {};
  const documentListeners = {};
  // Every canvas handed out reports a stub GL context, so setupGL() works.
    const canvasStub = { width: 1280, height: 720, getContext: () => stubGL(record) };

  const makeEl = (tag) => {
    const classes = new Set();
    return {
      tagName: (tag || 'div').toUpperCase(),
      style: {},
      className: '',
      width: 0,
      height: 0,
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        toggle: (name, force) => {
          const on = force === undefined ? !classes.has(name) : !!force;
          if (on) classes.add(name); else classes.delete(name);
          return on;
        },
        contains: (name) => classes.has(name),
      },
      eventListeners: {},
      appendChild: noopOp,
      addEventListener(type, listener) {
        (this.eventListeners[type] || (this.eventListeners[type] = [])).push(listener);
      },
      getContext: () => stubCanvas2D(),
      querySelectorAll: () => [],
      querySelector: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }),
      focus: noopOp,
      setAttribute: noopOp,
      textContent: '',
      innerHTML: '',
      dataset: {},
    };
  };
  function noopOp() {}

  const elements = new Map();
  const touchLayer = makeEl('div');
  touchLayer.classList.add('hidden');
  elements.set('touch-ui', touchLayer);

  const documentStub = {
    createElement: makeEl,
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeEl('div'));
      return elements.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener(type, listener) {
      (documentListeners[type] || (documentListeners[type] = [])).push(listener);
    },
    body: makeEl('body'),
    documentElement: makeEl('html'),
    hidden: false,
    visibilityState: 'visible',
    exitPointerLock: noopOp,
    pointerLockElement: null,
    activeElement: null,
  };

  const windowStub = {
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: options.dpr || 1,
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener: noopOp,
    requestAnimationFrame: (f) => { return 0; },
    cancelAnimationFrame: noopOp,
    matchMedia: () => ({ matches: !!options.touch, addEventListener: noopOp }),
    localStorage: storage,
    setTimeout: (f) => { return 0; },
    clearTimeout: noopOp,
    setInterval: () => 0,
    clearInterval: noopOp,
    AudioContext: undefined,
    webkitAudioContext: undefined,
    navigator: undefined,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };

  const navigatorStub = {
    maxTouchPoints: options.touch ? 5 : 0,
    hardwareConcurrency: options.cores || 8,
    deviceMemory: options.mem || 8,
    getGamepads: options.gamepad ? () => [options.gamepad] : null,
    userAgent: 'harness',
  };

  function makeStorage() {
    const map = {};
    return {
      getItem: (k) => (k in map ? map[k] : null),
      setItem: (k, v) => { map[k] = String(v); },
      removeItem: (k) => { delete map[k]; },
      clear: () => { Object.keys(map).forEach((k) => delete map[k]); },
      _map: map,
    };
  }

  const sandbox = {
    console,
    window: windowStub,
    document: documentStub,
    navigator: navigatorStub,
    fetch: options.fetch || (() => Promise.reject(new Error('Unexpected network request in test'))),
    localStorage: windowStub.localStorage,
    sessionStorage: options.sessionStorage || makeStorage(),
    performance: { now: () => Date.now() },
    Math, JSON, Date, Object, Array, String, Number, Boolean, Error,
    Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int32Array, Float32Array, Float64Array,
    Set, Map, isNaN, isFinite, parseInt, parseFloat, NaN, Infinity, undefined,
    requestAnimationFrame: windowStub.requestAnimationFrame,
    setTimeout: windowStub.setTimeout,
    clearTimeout: windowStub.clearTimeout,
    setInterval: windowStub.setInterval,
    clearInterval: windowStub.clearInterval,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const ctx = vm.createContext(sandbox);

  // The game files are plain scripts (not modules) so they can be loaded from
  // file:// in a browser. Concatenating them into one script keeps every
  // top-level const/class in a shared scope, and the epilogue below exposes
  // the pieces the tests need as real globals.
  const FILES = [
    'js/blocks.js', 'js/gl.js', 'js/world.js', 'js/mesher.js',
    'js/chars.js', 'js/input.js', 'js/camera.js', 'js/entity.js',
    'js/bot.js', 'js/fight.js', 'js/touch.js', 'js/ui.js', 'js/main.js', 'js/network.js',
  ];

  const sources = FILES.map((f) => {
    const p = path.join(ROOT, f);
    return '/* ==== ' + f + ' ==== */\n' + fs.readFileSync(p, 'utf8');
  });

  // The files use 'use strict', so the export has to go through globalThis
  // rather than assigning to an undeclared name.
  const epilogue = `
;(function () {
  globalThis.__X = {
    ATLAS, T, BLOCKS, HOTBAR_BLOCKS, isSolid, isOpaque, isLiquid, isCutout, lightOf,
    clamp255, blockIconCanvas, buildBlockTexture,
    createGL, createProgram, M4, buildCube, buildQuad, buildSprite,
    CHUNK, WORLD_H, SEA_LEVEL, Chunk, World, noise2, fbm,
    WORLD_SIZE, CHUNKS_PER_SIDE, CENTRE_CHUNK, WORLD_CENTRE, MIN_EDGE, MAX_EDGE,
    FACES, VERT_FLOATS, buildChunkMesh, disposeMesh, pidx, aoAt, _padBlocks,
    CHARACTERS, characterById, ANIMALS, animalById, PAGE_AUTH_ID, pageAuthIdForLoad,
    Input, Cam, OBSERVE_VIEWS, Observer, Network,
    GRAVITY, Player, Animal, Projectile, Particles, PROJ_DEFS,
    Bot, Fight, Touch, UI, Audio, Game, migrateWorldSave,
    isTouch: isTouch, frame: frame,
  };
})();
`;

  const script = sources.join('\n') + epilogue;
  vm.runInContext(script, ctx, { filename: 'game-bundle.js' });

  sandbox.__X.record = record;
  sandbox.__X.listeners = listeners;
  sandbox.__X.documentListeners = documentListeners;
  sandbox.__X.windowStub = windowStub;
  sandbox.__X.document = documentStub;
  // The real storage object, so a test can read back what the game saved.
  sandbox.__X.storage = options.storage || storage;
  sandbox.__X.ownStorage = storage;
  sandbox.__X.sessionStorage = sandbox.sessionStorage;
  sandbox.__X.options = options;

  // Match the order boot() uses: read the save first, then let the device
  // profile decide anything the player has not chosen explicitly. Skipping
  // load() here meant the save/round-trip tests were asserting against
  // defaults rather than against what had actually been restored.
  {
    const X = sandbox.__X;
    X.Game.isTouch = !!options.touch;
    X.Touch.enabled = !!options.touch;
    if (options.touch) documentStub.body.classList.add('touch');
    if (options.load !== false) X.Game.load();
    X.Game.applyQuality();
  }

  // Bring the game up far enough to test it: a generated world, players, and
  // the mode-specific setup. Returns the same object, plus a few conveniences.
  if (options.boot !== false) {
    const X = sandbox.__X;
    X.Game.canvas = canvasStub;
    X.Game.gl = stubGL(record);
    X.Game.setupGL();
    X.Game.dprCap = X.Game.dprCap || 1;
    const w = new X.World(options.seed === undefined ? 1337 : options.seed);
    w.generateRadius(X.CENTRE_CHUNK, X.CENTRE_CHUNK, X.Game.settings.renderDist, null);
    const list = [];
    w.activeChunks.forEach((c) => list.push(c));
    for (const c of list) {
      c.mesh = X.buildChunkMesh(stubGL(record), w, c);
      c.dirty = false;
    }
    X.Game.world = w;
    X.World.world = w;
    const spawn = w.findSpawn();
    const p1 = new X.Player(w, X.characterById(X.Game.pick.p1), false);
    p1.pos = spawn.slice();
    p1.spawn = spawn.slice();
    p1.creative = true;
    p1.flying = true;
    const p2 = new X.Player(w, X.characterById(X.Game.pick.p2), true);
    p2.pos = [spawn[0] + 2, spawn[1], spawn[2]];
    p2.spawn = p2.pos.slice();
    p2.creative = true;
    p2.flying = true;
    X.Game.players = [p1, p2];
    X.Game.spawnAnimals(16);
    X.Game.buildWorldDone = true;
  }

  return sandbox.__X;
}
/* ---------- tiny test framework ----------
   Isolation lives in run.js, which supervises this file one suite per
   child process and kills anything that overruns. In here we only need to
   support two entry points:
     node logic.test.js                 run everything in this process
     node logic.test.js --suite "Name"  run one suite (used by the runner)
     node logic.test.js --print-suites  list suites as JSON
   ---------- */
const suites = [];
let currentSuite = null;

// Reported per-test so a hang can name the test that was in flight.
class TimeoutError extends Error {
  constructor(name) {
    super('test exceeded the time budget');
    this.name = 'TimeoutError';
    this.testName = name;
  }
}

function suite(name) {
  currentSuite = { name, tests: [] };
  suites.push(currentSuite);
  return currentSuite;
}

function test(name, fn) {
  if (!currentSuite) suite('general');
  currentSuite.tests.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error('assert failed' + (msg ? ': ' + msg : ''));
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error('expected ' + JSON.stringify(expected) + ' but got ' +
      JSON.stringify(actual) + (msg ? ' (' + msg + ')' : ''));
  }
}

function near(actual, expected, tol, msg) {
  if (Math.abs(actual - expected) > tol) {
    throw new Error('expected ' + expected + ' ±' + tol + ' but got ' + actual +
      (msg ? ' (' + msg + ')' : ''));
  }
}

function run(filter) {
  let pass = 0, fail = 0;
  const failures = [];
  const wanted = filter && filter.length ? suites.filter(
    (s) => filter.some((f) => s.name.toLowerCase().includes(f.toLowerCase()))) : suites;

  // Stream results as they happen, so a hanging test shows up as the last
  // line printed rather than the run simply stalling.
  for (const s of wanted) {
    console.log('\n' + s.name);
    for (const t of s.tests) {
      const started = Date.now();
      let status, message = '';
      try {
        t.fn();
        pass++;
        status = 'PASS';
      } catch (e) {
        fail++;
        status = 'FAIL';
        message = e.message;
        failures.push({ suite: s.name, test: t.name, err: e });
      }
      const ms = Date.now() - started;
      // Flag anything slow enough to threaten the frame budget.
      const slow = ms > 250 ? '   <-- ' + ms + 'ms' : '';
      console.log('  ' + status + '  ' + t.name + (message ? '\n          ' + message : '') + slow);
    }
  }
  console.log('\n' + '='.repeat(56));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(56));
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log('\n  [' + f.suite + '] ' + f.test);
      console.log('  ' + (f.err.stack || f.err.message).split('\n').slice(0, 4).join('\n  '));
    }
  }
  return fail === 0;
}


// The storage object a sandbox shares, so a test can inspect what was saved.
// makeStorage attaches a non-enumerable handle to avoid polluting the map.
const STORAGE_HANDLE = Symbol('storageHandle');

// A standalone localStorage stand-in. Tests that simulate a page reload need
// one real store object shared across two `load()` calls; a plain {} is not a
// valid localStorage and the game will not be able to read or write it.
function makeStorage() {
  const map = {};
  return {
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => { map[k] = String(v); },
    removeItem: (k) => { delete map[k]; },
    clear: () => { Object.keys(map).forEach((k) => delete map[k]); },
    _map: map,
  };
}

module.exports = {
  load, suite, test, assert, eq, near, run, ROOT, TimeoutError, makeStorage, stubGL,
  // Inspect the localStorage a booted sandbox wrote to.
  savedData(storage) {
    if (!storage) return null;
    const raw = storage.getItem('blocky-world-local-save-v1');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  },
  // Entry point for the test file. Kept here rather than in harness so that
  // it works no matter which file is the process entry point.
  main(argv) {
    const args = argv || process.argv.slice(2);
    if (args.indexOf('--print-suites') !== -1) {
      process.stdout.write(JSON.stringify(
        suites.map((s) => ({ name: s.name, tests: s.tests.map((t) => t.name) }))
      ));
      return 0;
    }
    const suiteArg = args.indexOf('--suite');
    const filter = suiteArg !== -1
      ? [args[suiteArg + 1]]
      : args.filter((a) => a[0] !== '-');
    return run(filter) ? 0 : 1;
  },
};
