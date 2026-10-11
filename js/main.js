'use strict';
/* ============================================================
   main.js — game state, rendering, and the frame loop
   ============================================================ */

const SAVE_KEY = 'blocky-world-local-save-v1';
const ACTIVE_WORLD_KEY = 'blocky-world-selected-type';

const Game = {
  state: 'loading',       // loading | menu | play | fight | observe | paused
  canvas: null,
  gl: null,
  world: null,
  activeWorldType: 'normal',
  players: [],
  animals: [],
  mode: 'play',
  paused: false,
  showDebug: false,
  renderDist: 5,
  lastTime: 0,
  lastFrameAt: null,
  frameInterval: 1000 / 60,
  fpsWindowStart: 0,
  fpsWindowFrames: 0,
  measuredFps: 0,
  debugLastUpdate: 0,
  _boxModel: M4.create(),
  _boxMvp: M4.create(),
  time: 0,                // world time, seconds
  dayPhase: 0.32,         // 0 = midnight, 0.5 = noon
  selectedSlot: 0,
  pick: { p1: 'steve', p2: 'golem', p2bot: true, botLevel: 1 },
  settings: {
    sensitivity: 0.0024,
    renderDist: 5,
    dayNight: true,
    sfx: true,
    // True until the player moves the "how far you can see" slider. Auto
    // quality is only allowed to choose a value while this is false, so an
    // explicit choice is never overwritten on the next load.
    renderDistAuto: true,
  },
  isTouch: false,
  quality: 'auto',         // auto | high | low
  bot: null,

  /* ============================================================
     boot
     ============================================================ */
  async boot() {
    this.canvas = document.getElementById('gl-canvas');
    this.isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

    this.gl = createGL(this.canvas);
    if (!this.gl) {
      document.getElementById('loading').innerHTML =
        '<div class="title">Oh no</div><div class="msg">This game needs WebGL2. Try a recent Chrome, Edge, Firefox or Safari.</div>';
      return;
    }

    this.load();
    this.applyQuality();
    this.setupGL();
    Input.init(this.canvas);
    Touch.init();
    UI.init();
    Audio.init();
    this.bindResize();
    this.bindGlobalKeys();
    this.bindCanvasClick();

    // resume audio on the first real interaction (browser autoplay rule)
    const kick = () => { Audio.init(); Audio.ctx && Audio.ctx.resume(); };
    window.addEventListener('pointerdown', kick, { once: true });
    window.addEventListener('touchstart', kick, { once: true });
    window.addEventListener('keydown', kick, { once: true });

    await this.buildWorld(this.settings.renderDist);

    this.state = 'menu';
    UI.show('loading', false);
    UI.showMainMenu();
    Touch.setVisible(false);
    if (this.isTouch) Touch.relabel('play');
    this.scheduleFrame();
  },

  /* ============================================================
     Performance profile
     iPhones and older iPads have much less GPU headroom than a
     desktop, so we trim resolution and view distance up front
     rather than letting the frame rate collapse.
     ============================================================ */
  /* Pick a render distance and pixel ratio that suit the device.

     The device profile may only choose the render distance while it is still
     automatic. Once the player has dragged the slider, their number is theirs:
     previously applyQuality() ran after load() and reset it every session, so
     the setting silently reverted to the profile default on every reload. */
  applyQuality() {
    if (this.quality !== 'auto') return;   // the user pinned a setting
    const mem = navigator.deviceMemory || (this.isTouch ? 4 : 8);
    const cores = navigator.hardwareConcurrency || 4;
    // Desktop GPUs rarely benefit from rendering a 2x device-pixel buffer
    // for this low-poly scene. A 1.5x cap cuts pixel work by about 44%.
    let dprCap = this.isTouch ? 2 : 1.5;
    let dist = this.settings.renderDist;

    if (!this.settings.renderDistAuto) {
      // Keep the player's choice; still tune the pixel ratio for the screen.
      this.dprCap = this.isTouch
        ? (window.innerWidth < 500 ? 1.5 : 2)
        : (mem <= 4 || cores <= 4 ? 1.25 : 1.5);
      return;
    }

    if (this.isTouch) {
      // Retina iPhones can push a 3x buffer; we never need more than 2x,
      // and a 1.5x cap on small screens buys back a lot of fill rate.
      dprCap = (window.innerWidth < 500) ? 1.5 : 2;
      if (mem <= 4 || cores <= 4) {
        dist = 4;
        dprCap = 1.25;
      } else {
        dist = 5;
      }
    } else {
      if (mem <= 4 || cores <= 4) { dist = 4; dprCap = 1.25; }
    }

    this.dprCap = dprCap;
    this.settings.renderDist = dist;
  },

  /* ---------- frame scheduling ----------
     Use the browser's monotonic animation clock and render at most 60 frames
     per second. A single rAF source avoids the timer/rAF race that produced
     zero-length deltas and misleading 1000 FPS readings. */
  scheduleFrame() {
    requestAnimationFrame((now) => {
      if (this.lastFrameAt === null) {
        this.lastFrameAt = now;
      } else {
        const elapsed = now - this.lastFrameAt;
        if (elapsed >= this.frameInterval) {
          // Preserve the 60 Hz phase on 120/144 Hz displays instead of
          // drifting with the display's faster callback interval.
          const intervals = Math.max(1, Math.floor(elapsed / this.frameInterval));
          this.lastFrameAt += intervals * this.frameInterval;
          this.loop(now);
        }
      }
      this.scheduleFrame();
    });
  },

  setupGL() {
    const gl = this.gl;

    this.prog = createProgram(gl,
      `#version 300 es
      layout(location=0) in vec3 aPos;
      layout(location=1) in vec2 aUV;
      layout(location=2) in float aTile;
      layout(location=3) in float aLight;
      layout(location=4) in float aAO;
      layout(location=5) in float aFlags;

      uniform mat4 uVP;
      uniform vec3 uCamPos;
      uniform float uFogNear;
      uniform float uFogFar;
      uniform vec3 uFogColor;
      uniform float uDayLight;
      out vec2 vUV;
      out float vTile;
      out float vLight;
      out float vFog;
      out vec3 vWorld;

      void main() {
        vec4 wp = vec4(aPos, 1.0);
        gl_Position = uVP * wp;
        vWorld = aPos;
        vUV = aUV;
        vTile = aTile;
        // combine baked light, AO and the time-of-day factor
        vLight = aLight * aAO * mix(0.32, 1.0, uDayLight) + aFlags * 0.06;
        float d = distance(uCamPos, aPos);
        vFog = clamp((d - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
      }`,
      `#version 300 es
      precision highp float;
      precision highp sampler2DArray;
      in vec2 vUV;
      in float vTile;
      in float vLight;
      in float vFog;
      in vec3 vWorld;
      uniform sampler2DArray uTex;
      uniform vec3 uFogColor;
      uniform float uAlphaCut;
      uniform float uIsLiquid;
      uniform float uTintR;
      uniform float uTintG;
      uniform float uTintB;
      out vec4 frag;

      void main() {
        vec4 c = texture(uTex, vec3(vUV, vTile));
        if (c.a < uAlphaCut) discard;
        vec3 col = c.rgb * vLight;
        col *= vec3(uTintR, uTintG, uTintB);
        if (uIsLiquid > 0.5) {
          // gentle wave on liquid surfaces
          col *= 1.0 + 0.06 * sin(vWorld.x * 1.7 + vWorld.z * 1.1);
        }
        col = mix(col, uFogColor, vFog);
        frag = vec4(col, c.a);
      }`
    );

    this.progBox = createProgram(gl,
      `#version 300 es
      layout(location=0) in vec3 aPos;
      layout(location=1) in vec3 aNormal;
      layout(location=2) in vec2 aUV;

      uniform mat4 uMVP;
      uniform float uTile;
      uniform vec3 uCamPos;
      uniform float uFogNear;
      uniform float uFogFar;
      uniform vec3 uFogColor;
      uniform float uDayLight;
      out vec2 vUV;
      out float vTile;
      out vec3 vNormal;
      out vec3 vWorld;
      out float vFog;
      out float vShade;

      void main() {
        vUV = aUV;
        vTile = uTile;
        vNormal = aNormal;
        vWorld = aPos;
        // simple directional shading so boxy characters read as 3D
        float key = 0.45 + 0.55 * max(0.0, dot(aNormal, normalize(vec3(0.4, 0.9, 0.35))));
        vShade = key * mix(0.45, 1.0, uDayLight);
        float d = distance(uCamPos, aPos);
        vFog = clamp((d - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
        gl_Position = uMVP * vec4(aPos, 1.0);
      }`,
      `#version 300 es
      precision highp float;
      precision highp sampler2DArray;
      in vec2 vUV;
      in float vTile;
      in vec3 vNormal;
      in vec3 vWorld;
      in float vFog;
      in float vShade;
      uniform sampler2DArray uTex;
      uniform vec3 uFogColor;
      uniform vec3 uTint;
      uniform float uAlpha;
      uniform float uUseTex;
      out vec4 frag;

      void main() {
        vec4 c;
        if (uUseTex > 0.5) {
          c = texture(uTex, vec3(vUV, vTile));
          if (c.a < 0.3) discard;
        } else {
          c = vec4(1.0);
        }
        vec3 col = c.rgb * uTint * vShade;
        col = mix(col, uFogColor, vFog);
        frag = vec4(col, uAlpha * c.a);
      }`
    );

    // simple flat-colour program for the sky
    this.skyProg = createProgram(gl,
      `#version 300 es
      layout(location=0) in vec3 aPos;
      out vec2 vNdc;
      void main() { vNdc = aPos.xy; gl_Position = vec4(aPos.xy, 1.0, 1.0); }`,
      `#version 300 es
      precision highp float;
      in vec2 vNdc;
      uniform vec3 uTop;
      uniform vec3 uBottom;
      uniform vec3 uSunDir;
      uniform float uStar;
      out vec4 frag;

      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

      void main() {
        float t = clamp(vNdc.y * 0.5 + 0.5, 0.0, 1.0);
        // indigo at the zenith easing into violet at the horizon
        vec3 col = mix(uBottom, uTop, pow(t, 0.65));

        vec3 dir = normalize(vec3(vNdc, 0.55));
        float d = max(0.0, dot(dir, uSunDir));

        // warm counter-glow opposite the cool sky
        col += vec3(1.0, 0.72, 0.45) * pow(d, 6.0) * 0.13;
        col += vec3(1.0, 0.90, 0.72) * pow(d, 60.0) * 0.55;

        // a thin bright band right at the horizon
        float horizon = 1.0 - smoothstep(0.0, 0.16, abs(vNdc.y));
        col += vec3(0.35, 0.75, 1.0) * horizon * 0.10;

        // starfield
        if (uStar > 0.01) {
          vec2 g = floor(vNdc * 110.0);
          float h = hash(g);
          if (h > 0.982) {
            float tw = 0.6 + 0.4 * hash(g + 3.7);
            col += vec3(0.75, 0.92, 1.0) * uStar * (h - 0.982) * 55.0 * tw;
          }
        }
        frag = vec4(col, 1.0);
      }`
    );

    this.quadVAO = gl.createVertexArray();
    gl.bindVertexArray(this.quadVAO);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,0, 3,-1,0, -1,3,0]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.cube = this.uploadMesh(buildCube());
    this.quad = this.uploadMesh(buildQuad());
    this.sprite = this.uploadMesh(buildSprite());

    this.blockTex = buildBlockTexture(gl);
  },

  uploadMesh(m) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, m.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    const nbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nbo);
    gl.bufferData(gl.ARRAY_BUFFER, m.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    const ubo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ubo);
    gl.bufferData(gl.ARRAY_BUFFER, m.uvs, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);

    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    return { vao, count: m.indices.length };
  },

  bindResize() {
    const resize = () => {
      const cap = this.dprCap || 2;
      const dpr = Math.min(window.devicePixelRatio || 1, cap);
      const w = Math.max(1, Math.floor(window.innerWidth * dpr));
      const h = Math.max(1, Math.floor(window.innerHeight * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
    };
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 250));
    resize();
  },

  bindGlobalKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') { this.showDebug = !this.showDebug; e.preventDefault(); }
      if (e.code === 'F10') { e.preventDefault(); this.togglePause(this.state !== 'paused'); }
      if (e.code === 'Escape') {
        if (this.state === 'play' || this.state === 'fight' || this.state === 'observe') {
          this.togglePause(this.state !== 'paused');
        } else if (this.state === 'paused') {
          this.togglePause(false);
        }
      }
      // F5 / photo only matter in observe mode
      if (e.code === 'F5' && this.state === 'observe') {
        e.preventDefault();
        const v = Observer.cycle(1);
        Audio.play('view');
        UI.toast('View: ' + v.name);
      }
      if (e.code === 'KeyP' && this.state === 'observe') {
        this.shotPending = true;
        UI.toast('Photo saved!');
      }
      // number keys for the hotbar
      if (this.state === 'play' && /^Digit[1-9]$/.test(e.code)) {
        const n = parseInt(e.code.slice(5), 10) - 1;
        this.selectSlot(n);
      }
    });
  },

  /* ============================================================
     world
     ============================================================ */
  async buildWorld(radius) {
    const loadEl = document.getElementById('loading');
    const fill = document.getElementById('load-fill');
    const msg = document.getElementById('load-msg');
    UI.show('loading', true);

    const seed = this.pendingSeed !== undefined ? this.pendingSeed : (this.saved ? this.saved.seed : 1337);
    const worldType = this.pendingWorldType || this.activeWorldType || 'normal';
    World.world = new World(seed, this.saved && this.saved.edits, worldType);
    this.world = World.world;

    // hand the world to the camera helper
    await new Promise((resolve) => {
      World.world.generateRadius(8, 8, radius, (p) => {
        fill.style.width = Math.round(p * 100) + '%';
        if (msg) msg.textContent = 'Carving the world… ' + Math.round(p * 100) + '%';
      });
      resolve();
    });

    if (msg) msg.textContent = 'Building shapes…';
    await frame();
    if (msg) {
      msg.textContent = 'Building shapes… ' + CHUNKS_PER_SIDE + '×' + CHUNKS_PER_SIDE + ' chunks';
    }
    await frame();

    // Only mesh what is actually visible from the spawn. The rest is built on
    // demand by streamChunks as the player walks around, which keeps both the
    // loading time and the GPU memory down to what is on screen.
    this.renderDist = this.settings.renderDist;
    const spawnHint = this.world.findSurfaceY(this.world.originX, this.world.originZ);
    Cam.pos = [this.world.originX, spawnHint + 14, this.world.originZ];
    Cam.yaw = 0.6;
    Cam.pitch = -0.3;
    Cam.update(0.016, 1.6, Cam.pos);
    this.updateFrustum();

    const near = [];
    this.world.chunks.forEach((c) => { if (c.generated && this.chunkInRange(c)) near.push(c); });
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      c.mesh = buildChunkMesh(this.gl, this.world, c);
      c.dirty = false;
      if ((i & 3) === 0) {
        fill.style.width = Math.round((i / near.length) * 100) + '%';
        if (msg) msg.textContent = 'Building shapes… ' + Math.round((i / near.length) * 100) + '%';
        await frame();
      }
    }

    // players
    const spawn = this.world.findSpawn();
    const c1 = characterById(this.pick.p1);
    const c2 = characterById(this.pick.p2);

    this.players = [];
    const p1 = new Player(this.world, c1, false);
    p1.pos = spawn.slice();
    p1.spawn = spawn.slice();
    p1.creative = true;
    p1.flying = true;
    this.players.push(p1);

    const p2 = new Player(this.world, c2, true);
    p2.pos = [spawn[0] + 2, spawn[1], spawn[2]];
    p2.spawn = p2.pos.slice();
    p2.creative = true;
    p2.flying = true;
    this.players.push(p2);

    this.spawnAnimals(16);

    // restore saved position if we reloaded
    if (this.saved && this.saved.player1) {
      const s = this.saved.player1;
      if (this.world.getBlock(s[0], s[1], s[2]) !== undefined) {
        p1.pos = s.slice();
      }
      if (this.saved.pick) { this.pick = this.saved.pick; }
    }

    fill.style.width = '100%';
    await frame();
    UI.show('loading', false);
  },

  // Rebuild one dirty chunk per frame. Keeping this to a small budget is
  // what stops placing a block from stuttering the whole game. Chunks that
  // were never meshed are skipped: streamChunks will pick them up when the
  // player actually gets close enough to see them.
  updateDirtyChunks(budget) {
    const gl = this.gl;
    let n = 0;
    this.world.chunks.forEach((c) => {
      if (n >= budget) return;
      if (!c.dirty || !c.generated) return;
      if (c.mesh) {
        disposeMesh(gl, c.mesh);
        c.mesh = buildChunkMesh(gl, this.world, c);
        c.dirty = false;
        n++;
      } else {
        c.dirty = false;   // leave it to the streamer
      }
    });
  },

  spawnAnimals(count) {
    this.animals = [];
    const defs = ANIMALS;
    const ox = this.world.originX, oz = this.world.originZ;
    const reach = Math.max(12, Math.min(70, this.renderDist * CHUNK - 8));
    for (let i = 0; i < count; i++) {
      const def = defs[(Math.random() * defs.length) | 0];
      let placed = false;
      for (let tries = 0; tries < 60 && !placed; tries++) {
        const a = Math.random() * Math.PI * 2;
        const r = 5 + Math.random() * reach;
        const x = Math.floor(ox + Math.cos(a) * r);
        const z = Math.floor(oz + Math.sin(a) * r);
        if (this.world.isStandable(x, z)) {
          this.animals.push(new Animal(def, x + 0.5, this.world.findSurfaceY(x, z) + 1, z + 0.5));
          placed = true;
        }
      }
    }
  },

  /* ============================================================
     state transitions
     ============================================================ */
  startPlay() {
    this.mode = 'play';
    this.state = 'play';
    this.paused = false;
    document.body.classList.add('playing');
    document.getElementById('menu').classList.add('hidden');
    UI.show('hud', true);
    document.getElementById('observe-hud').classList.remove('show');
    document.getElementById('pause').classList.remove('show');
    Touch.setVisible(true);
    Touch.relabel('play');
    Input.requestLock(this.canvas);
    this.players[0].creative = true;
    this.players[0].flying = true;
    this.players[0].flying = false;   // start on the ground so kids can just walk
    if (window.Network && Network.visitRole) {
      this.players[1].networkRemote = true;
      this.players[1].networkRemoteVisible = !!Network.remotePlayerState;
    }
    Cam.thirdPerson = true;
    Audio.play('select');
    UI.toast('Tap BREAK to mine, PLACE to build. V changes the view.');
  },

  startFight() {
    this.mode = 'fight';
    this.state = 'fight';
    this.paused = false;
    document.body.classList.add('playing');
    document.getElementById('menu').classList.add('hidden');
    UI.show('hud', true);
    document.getElementById('observe-hud').classList.remove('show');
    document.getElementById('pause').classList.remove('show');
    Touch.setVisible(true);
    Touch.relabel('fight');

    this.players[0].char = characterById(this.pick.p1);
    this.players[1].char = characterById(this.pick.p2);
    this.players[0].maxHp = this.players[0].char.hp;
    this.players[1].maxHp = this.players[1].char.hp;

    // On a phone the second player is the computer, because there is no
    // room for a second pair of thumbs. A pad or keyboard still wins if present.
    this.bot = null;
    const pad = Input.pad();
    if (this.pick.p2bot && !pad) {
      this.bot = new Bot(this.players[1], this.pick.botLevel);
    }

    const ax = Math.floor(this.world.originX);
    const az = Math.floor(this.world.originZ);
    this.world.buildArena(ax, az, 16);
    Fight.reset(this.players[0], this.players[1]);
    Cam.yaw = Math.PI / 2;
    Cam.pitch = -0.12;
    Input.requestLock(this.canvas);
    Audio.play('select');
  },

  startObserve() {
    this.mode = 'observe';
    this.state = 'observe';
    this.paused = false;
    document.body.classList.remove('playing');
    document.getElementById('menu').classList.add('hidden');
    UI.show('hud', false);
    document.getElementById('observe-hud').classList.add('show');
    document.getElementById('pause').classList.remove('show');
    Touch.setVisible(true);
    Touch.relabel('observe');

    // put the camera above whatever the players have built
    const p = this.players[0];
    Observer.snapTo([p.pos[0], p.pos[1] + 14, p.pos[2] + 18], [p.pos[0], p.pos[1], p.pos[2]]);
    Observer.orbitRadius = this.isTouch ? 11 : 16;
    Observer.orbitHeight = this.isTouch ? 7 : 9;
    Cam.pitch = -0.3;
    Input.releaseLock();
    Audio.play('view');
    UI.toast(this.isTouch
      ? 'Drag to look · ▲▼ height · JUMP changes view · FLY takes a photo'
      : 'F5 changes view · P takes a photo');
  },

  toMenu() {
    if (window.Network && Network.serverMode && Network.visitRole) {
      Network.endVisit();
      return;
    }
    this.state = 'menu';
    this.paused = false;
    Input.releaseLock();
    Touch.setVisible(false);
    document.body.classList.remove('playing');
    document.getElementById('pause').classList.remove('show');
    document.getElementById('observe-hud').classList.remove('show');
    UI.show('hud', false);
    if (this.players[1]) {
      this.players[1].networkRemote = false;
      this.players[1].networkRemoteVisible = true;
    }
    UI.showMainMenu();
    this.save();
  },

  togglePause(on) {
    if (this.state === 'menu' || this.state === 'loading') return;
    if (on) {
      this.state = 'paused';
      this.paused = true;
      document.getElementById('pause').classList.add('show');
      document.getElementById('menu-extra').innerHTML = '';
      Input.releaseLock();
    } else {
      this.paused = false;
      this.state = this.mode;
      document.getElementById('pause').classList.remove('show');
      Input.requestLock(this.canvas);
    }
  },

  onPointerLockChange(locked) {
    // Show a prompt when the mouse is free, so the camera never looks broken.
    const hint = document.getElementById('capture-hint');
    if (!hint) return;
    const playing = (this.state === 'play' || this.state === 'fight') && !this.paused;
    const needsPrompt = playing && !this.isTouch && !locked;
    hint.classList.toggle('show', needsPrompt);
    hint.classList.toggle('hidden', !playing);
  },

  // The canvas is the natural click target for re-capturing the mouse.
  bindCanvasClick() {
    this.canvas.addEventListener('mousedown', () => {
      if (this.isTouch) return;
      if (this.state === 'play' || this.state === 'fight') Input.requestLock(this.canvas);
    });
  },

  selectSlot(i) {
    this.selectedSlot = Math.max(0, Math.min(HOTBAR_BLOCKS.length - 1, i));
    this.players[0].selectedSlot = this.selectedSlot;
    UI.setActiveSlot(this.selectedSlot);
    Audio.play('select');
  },

  newWorld() {
    const seed = Math.floor(Math.random() * 100000);
    this.pendingSeed = seed;
    this.saved = null;
    if (!window.Network || !Network.serverMode) localStorage.removeItem(this.saveKey(this.activeWorldType));
    this.state = 'loading';
    this.buildWorld(this.settings.renderDist).then(() => {
      this.state = 'menu';
      this.save(true);
      UI.showMainMenu();
      UI.toast('New world ready — seed ' + seed);
    });
  },

  saveKey(worldType) {
    return worldType === 'flat' ? SAVE_KEY + ':flat' : SAVE_KEY;
  },

  async selectWorld(worldType) {
    worldType = worldType === 'flat' ? 'flat' : 'normal';
    if (window.Network && Network.visitActive) {
      UI.toast('End the visit before switching worlds.');
      return;
    }
    if (worldType === this.activeWorldType) { UI.showMainMenu(); return; }
    this.save();
    if (window.Network && Network.serverMode) {
      try {
        this.saved = await Network.activateWorld(worldType);
      } catch (error) {
        UI.toast(error.message || 'Could not open that world.');
        return;
      }
    } else {
      const raw = localStorage.getItem(this.saveKey(worldType));
      this.saved = raw ? JSON.parse(raw) : null;
      Network.activeWorldType = worldType;
      try { localStorage.setItem(ACTIVE_WORLD_KEY, worldType); } catch (_) {}
    }
    this.activeWorldType = worldType;
    if (this.saved && this.saved.settings) {
      this.settings = Object.assign({}, this.settings, this.saved.settings);
      Input.sensitivity = this.settings.sensitivity;
      this.renderDist = this.settings.renderDist;
    }
    if (this.saved && this.saved.pick) this.pick = this.saved.pick;
    if (this.saved && Number.isInteger(this.saved.slot)) this.selectedSlot = this.saved.slot;
    this.pendingWorldType = worldType;
    this.pendingSeed = this.saved ? this.saved.seed : Math.floor(Math.random() * 100000);
    this.state = 'loading';
    await this.buildWorld(this.settings.renderDist);
    this.pendingSeed = undefined;
    this.pendingWorldType = undefined;
    this.state = 'menu';
    if (!this.saved) this.save(true);
    UI.showMainMenu();
    UI.toast(worldType === 'flat' ? 'Flat world ready.' : 'Normal world ready.');
  },

  async enterSharedWorld(sharedWorld) {
    const localPick = this.pick.p1;
    this.activeWorldType = sharedWorld.worldType === 'flat' ? 'flat' : 'normal';
    this.pendingWorldType = this.activeWorldType;
    Network.activeWorldType = this.activeWorldType;
    this.saved = Object.assign({}, sharedWorld, { player1: null, pick: null });
    this.pendingSeed = sharedWorld.seed;
    await this.buildWorld(this.settings.renderDist);
    this.pendingSeed = undefined;
    this.pendingWorldType = undefined;
    this.saved = Network.savedWorld;
    this.pick.p1 = localPick;
    this.players[0].char = characterById(localPick);
    this.players[0].maxHp = this.players[0].char.hp;
    this.players[1].networkRemote = true;
    this.players[1].networkRemoteVisible = !!Network.remotePlayerState;
    this.players[1].networkRemoteInitialized = false;
    if (Network.remotePlayerState) {
      const other = Network.remotePlayerState.pos;
      this.players[0].pos = [other[0] + 2, other[1], other[2]];
      this.players[0].spawn = this.players[0].pos.slice();
      this.players[1].pos = other.slice();
      this.players[1].yaw = Network.remotePlayerState.yaw;
      this.players[1].networkRemoteInitialized = true;
    } else {
      const spawn = this.players[0].spawn;
      this.players[1].pos = [spawn[0] + 3, spawn[1], spawn[2]];
    }
    this.state = 'menu';
    this.startPlay();
  },

  async restorePersonalWorld() {
    if (!window.Network || !Network.savedWorld) return;
    this.state = 'loading';
    this.paused = true;
    this.saved = Network.savedWorld;
    this.activeWorldType = this.saved.worldType === 'flat' ? 'flat' : 'normal';
    Network.activeWorldType = this.activeWorldType;
    this.pendingWorldType = this.activeWorldType;
    this.pendingSeed = this.saved.seed;
    if (this.saved.settings) this.settings = Object.assign(this.settings, this.saved.settings);
    if (this.saved.pick) this.pick = this.saved.pick;
    if (Number.isInteger(this.saved.slot)) this.selectedSlot = this.saved.slot;
    await this.buildWorld(this.settings.renderDist);
    this.pendingSeed = undefined;
    this.pendingWorldType = undefined;
    this.saved = Network.savedWorld;
    this.players[1].networkRemote = false;
    this.state = 'menu';
    this.paused = false;
    document.body.classList.remove('playing');
    Touch.setVisible(false);
    UI.show('hud', false);
    UI.showMainMenu();
  },

  /* ============================================================
     save / load
     ============================================================ */
  save(resetEdits) {
    try {
      const p = this.players[0];
      const snapshot = {
        worldType: this.activeWorldType,
        seed: this.world ? this.world.seed : 1337,
        player1: p ? p.pos.slice() : null,
        slot: this.selectedSlot,
        pick: this.pick,
        settings: this.settings,
        edits: this.world ? Array.from(this.world.edits, (entry) => {
          const xyz = entry[0].split(',').map(Number);
          return [xyz[0], xyz[1], xyz[2], entry[1]];
        }) : [],
      };
      if (window.Network && Network.serverMode) {
        if (Network.visitRole === 'owner' && Network.visitActive) return;
        Network.saveWorld(snapshot, { resetEdits: !!resetEdits });
      } else localStorage.setItem(this.saveKey(this.activeWorldType), JSON.stringify(snapshot));
    } catch (e) { /* storage may be blocked; the game still works */ }
  },

  load() {
    try {
      this.activeWorldType = localStorage.getItem(ACTIVE_WORLD_KEY) === 'flat' ? 'flat' : 'normal';
      this.pendingWorldType = this.activeWorldType;
      let raw = window.Network && Network.serverMode ? null : localStorage.getItem(this.saveKey(this.activeWorldType));
      if (window.Network && Network.serverMode) {
        this.saved = Network.savedWorld;
      } else if (raw) {
        this.saved = JSON.parse(raw);
      } else if (this.activeWorldType === 'normal' && !(window.Network && Network.serverMode)) {
        // Migrate a prior local save by its game-specific data shape while
        // leaving the original browser entry untouched.
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key === ACTIVE_WORLD_KEY || key === this.saveKey('flat')) continue;
          const candidate = localStorage.getItem(key);
          try {
            const value = JSON.parse(candidate);
            if (value && Number.isInteger(value.seed) && value.pick && typeof value.pick === 'object' &&
                value.settings && typeof value.settings === 'object' && Number.isInteger(value.slot)) {
              this.saved = value;
              localStorage.setItem(SAVE_KEY, candidate);
              break;
            }
          } catch (_) { /* this browser entry is not a game save */ }
        }
      }
      if (this.saved) {
        if (this.saved.settings) {
          this.settings = Object.assign(this.settings, this.saved.settings);
          Input.sensitivity = this.settings.sensitivity;
          this.renderDist = this.settings.renderDist;
        }
        if (this.saved.pick) this.pick = this.saved.pick;
        if (this.saved.slot !== undefined) this.selectedSlot = this.saved.slot;
      }
    } catch (e) { this.saved = null; }
  },

  /* Keep a player inside the playable square. The world's bedrock floor
     stops falls, but the 8 block margin between the 200x200 playfield and
     the chunk edge needs a hard wall or you could walk into unmeshed
     terrain and fall through. */
  clampToWorld(p) {
    const half = WORLD_SIZE / 2 - 1;
    const lo = WORLD_CENTRE - half;
    const hi = WORLD_CENTRE + half;
    if (p.pos[0] < lo) { p.pos[0] = lo; p.vel[0] = 0; }
    if (p.pos[0] > hi) { p.pos[0] = hi; p.vel[0] = 0; }
    if (p.pos[2] < lo) { p.pos[2] = lo; p.vel[2] = 0; }
    if (p.pos[2] > hi) { p.pos[2] = hi; p.vel[2] = 0; }
  },

  /* ============================================================
     block interaction
     ============================================================ */
  handleBlockActions(p1, p2, dt) {
    if (this.state !== 'play') return;
    const p = p1;
    const world = this.world;

    // mouse wheel + touch slot taps
    if (Input.mouse.wheel) this.selectSlot(this.selectedSlot + Input.mouse.wheel);

    const fwd = p.forwardVec([0, 0, 0]);
    const eye = [p.pos[0], p.eyeY, p.pos[2]];
    const hit = world.raycast(eye[0], eye[1], eye[2], fwd[0], fwd[1], fwd[2], 7);
    this.currentTarget = hit.hit ? hit : null;

    // The big button is BREAK while building, and HIT while fighting, so it
    // only means "break a block" in this mode.
    const breakHeld = Input.mouse.left || Touch.btn.hit;
    const breakJustPressed = Input.mouse.leftPressed || (Touch.btn.hit && !this._breakHeld);
    const placeJustPressed = Input.mouse.rightPressed || (Touch.btn.use && !this._useHeld);

    if (hit.hit) {
      const b = BLOCKS[hit.id];
      if (breakJustPressed) {
        if (b && b.unbreakable) {
          UI.toast('That block is too tough to break!');
        } else if (!p.creative && b && b.hardness && p.breakProgress !== hit.id) {
          // survival-ish timing
          p.breakProgress = hit.id;
          p.breakTime = (p.breakTime || 0) + dt;
          const need = 0.25 + (b.hardness || 0.4);
          if (p.breakTime >= need) {
            if (world.setBlock(hit.x, hit.y, hit.z, 0)) this.save();
            Audio.play('break');
            Particles.burst([hit.x + 0.5, hit.y + 0.5, hit.z + 0.5], { tile: b.side, size: 0.1 }, 12, 0.8);
            p.breakTime = 0;
          }
        } else {
          if (world.setBlock(hit.x, hit.y, hit.z, 0)) this.save();
          Audio.play('break');
          Particles.burst([hit.x + 0.5, hit.y + 0.5, hit.z + 0.5], { tile: b ? b.side : T.dirt, size: 0.1 }, 12, 0.8);
          p.breakTime = 0;
        }
      }

      // place
      if (placeJustPressed) {
        const nx = hit.x + hit.nx, ny = hit.y + hit.ny, nz = hit.z + hit.nz;
        const target = world.getBlock(nx, ny, nz);
        if (target === 0 || isLiquid(target)) {
          const id = HOTBAR_BLOCKS[this.selectedSlot];
          // don't place a block inside a player
          const wouldHitPlayer = this.players.some(pl =>
            nx + 1 > pl.pos[0] - 0.32 && nx < pl.pos[0] + 0.32 &&
            ny + 1 > pl.pos[1] && ny < pl.pos[1] + 1.78 &&
            nz + 1 > pl.pos[2] - 0.32 && nz < pl.pos[2] + 0.32);
          if (!wouldHitPlayer) {
            if (world.setBlock(nx, ny, nz, id)) this.save();
            Audio.play('place');
          }
        }
      }

      // middle-click / Q picks the block you're looking at
      if (Input.hit('KeyQ')) {
        const idx = HOTBAR_BLOCKS.indexOf(hit.id);
        if (idx >= 0) this.selectSlot(idx);
      }
    } else {
      p.breakTime = 0;
    }
    this._breakHeld = Touch.btn.hit;
    this._useHeld = Touch.btn.use;
    void breakHeld;
  },

  /* ============================================================
     input -> players
     ============================================================ */
  gatherInput() {
    // --- Player 1: keyboard + mouse, or thumbstick + drag-look on touch ---
    let mx = 0, mz = 0;
    let jump = false, sneak = false;
    let ldx = 0, ldy = 0;

    if (Input.down('KeyW')) mz += 1;
    if (Input.down('KeyS')) mz -= 1;
    if (Input.down('KeyA')) mx -= 1;
    if (Input.down('KeyD')) mx += 1;
    jump = Input.down('Space');
    sneak = Input.down('ShiftLeft') || Input.down('ShiftRight');
    ldx += Input.mouse.dx;
    ldy += Input.mouse.dy;

    if (Touch.enabled) {
      mx += Touch.move.x;
      mz += -Touch.move.y;
      jump = jump || Touch.btn.jump;
      sneak = sneak || Touch.btn.use;
      const l = Touch.consumeLook();
      // Touch dragging is in CSS pixels, so scale by canvas size to keep
      // the feel consistent from a small phone up to a desktop monitor.
      const gain = 26 / Math.max(400, window.innerWidth);
      ldx += l.x * gain;
      ldy += l.y * gain;
    }

    const pad = Input.readPad();
    Input.latchPad(pad);
    this.padDown = pad;

    return { mx, mz, jump, sneak, ldx, ldy, pad };
  },

  // Player 2: the computer opponent by default on touch devices;
  // a gamepad or the keyboard takes over when one is present.
  gatherInput2(dt) {
    const p2 = this.players[1];
    const pad = Input.pad();
    if (pad) {
      return {
        mx: pad.moveX, mz: -pad.moveY,
        jump: pad.jump, sneak: pad.sprint,
        attack: Input.padHit(pad, 'attack') || pad.attack,
        special: Input.padHit(pad, 'special') || pad.special,
        ult: Input.padHit(pad, 'ult') || pad.ult,
        turn: 0,
      };
    }
    if (this.bot) {
      const o = this.players[0];
      const cmd = this.bot.think_opponent(o, dt || 0.016);
      // a bot can look around freely, so drive yaw directly
      return {
        mx: cmd.mx, mz: cmd.mz,
        jump: cmd.jump, sneak: false,
        attack: cmd.attack, special: cmd.special, ult: cmd.ult,
        turn: 0,
      };
    }
    let mx = 0, mz = 0;
    if (Input.down('ArrowUp')) mz += 1;
    if (Input.down('ArrowDown')) mz -= 1;
    if (Input.down('ArrowLeft')) mx -= 1;
    if (Input.down('ArrowRight')) mx += 1;
    const turnL = Input.down('KeyQ') ? 1 : 0;
    const turnR = Input.down('KeyE') ? 1 : 0;
    return {
      mx, mz,
      turn: turnL - turnR,
      jump: Input.down('Numpad0') || Input.down('Numpad5'),
      sneak: Input.down('NumpadDecimal'),
      attack: Input.down('Numpad1'),
      special: Input.down('Numpad2'),
      ult: Input.down('Numpad3'),
    };
  },

  /* ============================================================
     update
     ============================================================ */
  update(dt, inp) {
    this.time += dt;
    const p1 = this.players[0];
    const p2 = this.players[1];
    if (!p1) return;

    // day / night
    if (this.settings.dayNight) {
      this.dayPhase = (this.dayPhase + dt / 300) % 1;
    }

    if (this.state === 'play') {
      // camera follows player 1
      Cam.look(inp.ldx, inp.ldy);
      p1.yaw = Cam.yaw;
      p1.pitch = Cam.pitch;

      // Camera view toggle: third person shows your character, first person
      // puts the camera in their eyes. Default is third person because you can
      // see who you are and where you are going.
      const wantThird = Input.hit('KeyV') ||
        (Touch.btn.hit && Touch.enabled && !this._camToggleHeld);
      if (wantThird) {
        Cam.thirdPerson = !Cam.thirdPerson;
        UI.toast(Cam.thirdPerson ? 'Third person' : 'First person');
        Audio.play('view');
      }
      this._camToggleHeld = Touch.btn.hit;

      // flight toggle — the FLY button on touch, the F key on desktop
      const flyToggle = Input.hit('KeyF') || (Touch.btn.fly && !this._flyHeld);
      if (flyToggle && p1.creative) {
        p1.flying = !p1.flying;
        UI.toast(p1.flying ? 'Flying on' : 'Flying off');
        Audio.play('select');
      }
      this._flyHeld = Touch.btn.fly;

      p1.update(dt, inp.mx, inp.mz, inp.jump, inp.sneak);
      if (window.Network && Network.visitRole && (Network.visitRole === 'owner' || Network.visitRole === 'visitor')) Network.updateRemotePlayer(p2, dt);
      else p2.update(dt, 0, 0, false, false);
      this.clampToWorld(p1);
      this.clampToWorld(p2);
      this.handleBlockActions(p1, p2, dt);

      // footsteps
      if (p1.onGround && Math.hypot(p1.vel[0], p1.vel[2]) > 1) {
        this.stepTimer = (this.stepTimer || 0) - dt;
        if (this.stepTimer <= 0) { Audio.play('step'); this.stepTimer = 0.34; }
      }

      // animals wander around
      for (const a of this.animals) a.update(dt, this.world);
      Particles.update(dt, this.world);

      // Stop anyone walking off the edge of the world, and catch anyone who
      // falls through the floor.
      if (p1.pos[1] < -5) p1.respawn();
      this.clampToWorld(p1);

      UI.updateHUD(p1, 'play',
        'Playing as <b>' + p1.char.name + '</b><br>Blocks: <b>' + Object.keys(this.world.chunks).length +
        '</b> chunks<br>Fly: <b>' + (p1.flying ? 'on' : 'off') + '</b>');

    } else if (this.state === 'fight') {
      // P1: mouse look + WASD
      Cam.look(inp.ldx, inp.ldy);
      p1.yaw = Cam.yaw;
      p1.pitch = Cam.pitch;
      p1.update(dt, inp.mx, inp.mz, inp.jump, inp.sneak);

      // inp.pad is null when no controller is attached, so read it defensively
      const pad = inp.pad || {};
      // P1 attacks: mouse buttons on desktop, the big HIT/SKILL buttons on touch
      const p1Attack = Input.mouse.leftPressed || Input.mouse.left || pad.attack || (Touch.btn.hit && !this._hitHeld);
      const p1Special = Input.mouse.rightPressed || pad.special || (Touch.btn.use && !this._useHeld);
      const p1Ult = Input.down('KeyL') || pad.ult || (Touch.btn.fly && !this._flyHeld);
      this._hitHeld = Touch.btn.hit;
      this._useHeld = Touch.btn.use;
      this._flyHeld = Touch.btn.fly;

      this.handleFightInput(p1, p2, {
        attack: p1Attack,
        special: p1Special,
        ult: p1Ult,
        altAttack: Input.down('KeyK'),
      });

      // P2: gamepad, computer opponent, or keyboard
      const i2 = this.gatherInput2(dt);
      if (i2.turn) p2.yaw += i2.turn * 2.4 * dt;
      p2.update(dt, i2.mx, i2.mz, i2.jump, i2.sneak);
      this.clampToWorld(p1);
      this.clampToWorld(p2);
      this.handleFightInput(p2, p1, i2);

      Fight.update(dt, p1, p2);

      // The camera itself is positioned once per frame in render(), so that
      // there is exactly one owner of the view matrices. Doing it here as well
      // ran Cam.update twice a frame with different distances, which made the
      // third-person orbit settle at two speeds and could never settle at all.

      const ultReady = p1.ultMeter >= p1.maxUlt;
      const vsName = p2.char.name + (this.bot ? ' (computer)' : '');
      UI.updateHUD(p1, 'fight',
        '<b>' + p1.char.name + '</b> vs <b>' + vsName + '</b><br>' +
        (this.isTouch
          ? p1.char.ultName + ': <b>' + (ultReady ? 'READY — tap FLY!' : Math.round(p1.ultMeter) + '%') + '</b>'
          : p1.char.ultName + ': <b>' + (ultReady ? 'READY! press L' : Math.round(p1.ultMeter) + '%') + '</b>'));

    } else if (this.state === 'observe') {
      // touch: the stick flies, the ▲▼ buttons raise and lower the camera,
      // and a tap on the look area (with no drag) snaps to the next view.
      if (this.isTouch) {
        const rise = (Touch.btn.hit ? 1 : 0) - (Touch.btn.use ? 1 : 0);
        if (rise !== 0) {
          Observer.pos[1] += rise * 22 * dt;
          Observer.orbitHeight += rise * 14 * dt;
        }
        if (Touch.btn.jump && !this._obsJumpHeld) {
          const nv = Observer.cycle(1);
          Audio.play('view');
          UI.toast('View: ' + nv.name);
        }
        this._obsJumpHeld = Touch.btn.jump;
        if (Touch.btn.fly && !this._obsFlyHeld) {
          this.shotPending = true;
          UI.toast('Photo saved!');
        }
        this._obsFlyHeld = Touch.btn.fly;
      }

      Observer.update(dt, this.aspect());
      const v = Observer.view();
      document.getElementById('obs-view-name').textContent = v.name;
      document.getElementById('obs-coords').textContent =
        'x ' + Observer.pos[0].toFixed(1) + '   y ' + Observer.pos[1].toFixed(1) + '   z ' + Observer.pos[2].toFixed(1);
      document.getElementById('obs-hint').textContent =
        this.isTouch ? '▲▼ height · tap JUMP to change view · FLY to photo' : v.hint + ' · P photo · F10 menu';
      // keep the world alive so animals still wander
      for (const a of this.animals) a.update(dt, this.world);
      Particles.update(dt, this.world);
    }
  },

  handleFightInput(attacker, defender, i) {
    if (attacker.ko) return;
    if (attacker.swing) return;   // busy with the current swing

    if (i.ult) { Fight.useUltimate(attacker, defender); return; }

    if (i.altAttack) {
      const idx = attacker.char.attacks.length > 2 ? 2 : 1;
      this.doAttack(attacker, idx);
      return;
    }
    if (i.special) {
      // the SKILL button throws the character's ranged move when it has one
      const rangedIdx = attacker.char.attacks.findIndex(a => a.type === 'ranged');
      this.doAttack(attacker, rangedIdx >= 0 ? rangedIdx : 1);
      return;
    }
    if (i.attack) {
      // tapping HIT cycles light -> heavy for a bit of combo variety
      attacker.comboStep = ((attacker.comboStep || 0) + 1) % 3;
      this.doAttack(attacker, attacker.comboStep === 2 ? 2 : 0);
    }
  },

  doAttack(p, index) {
    const a = p.char.attacks[index];
    if (!a) return;
    if (a.type === 'ranged') Fight.tryRanged(p, index);
    else Fight.tryMelee(p, index, null);
    Audio.play('swing', { gain: 0.4 });
  },

  /* ============================================================
     render
     ============================================================ */
  aspect() {
    return this.canvas.height / Math.max(1, this.canvas.width);
  },

  dayLightFactor() {
    if (!this.settings.dayNight) return 1;
    // 0 at night, 1 at noon
    const p = this.dayPhase;
    const s = Math.sin(p * Math.PI * 2);
    return Math.max(0.12, Math.min(1, s * 0.62 + 0.52));
  },

  /* A cool futurist sky: indigo zenith fading to a violet horizon, with a
     warm amber counter-glow where the sun sits. Two moons, because one
     looked lonely against all that cyan. */
  skyColors() {
    const f = this.dayLightFactor();
    const night = 1 - f;
    const top = [
      0.03 + f * 0.10,
      0.05 + f * 0.22,
      0.13 + f * 0.46,
    ];
    const bottom = [
      0.14 + f * 0.30,
      0.10 + f * 0.28,
      0.30 + f * 0.36,
    ];
    return { top, bottom, star: Math.max(0, night - 0.3) * 1.7, night };
  },

  render(dt) {
    const gl = this.gl;
    if (!gl) return;
    const aspect = this.aspect();
    const p1 = this.players[0];
    // Use the real frame time, not an assumed 16ms. The third-person orbit
    // eases with dt, so a wrong dt makes it lag on a slow frame and snap on a
    // fast one.
    const step = dt === undefined ? 0.016 : dt;

    // This is the single place the view is built, for both playable modes.
    // Third person is the default so you can see your own character.
    if (this.state === 'play' || this.state === 'fight') {
      if (Cam.thirdPerson) {
        // A fight is easier to read from a little further back.
        const dist = (this.state === 'fight')
          ? (this.isTouch ? Cam.thirdPersonDist + 1 : Cam.thirdPersonDist)
          : Cam.thirdPersonDist;
        Cam.update(step, aspect, null, p1, dist);
      } else {
        // First person: the camera sits in the character's eyes.
        Cam.update(step, aspect, [p1.pos[0], p1.eyeY, p1.pos[2]]);
      }
    } else if (this.state === 'observe') {
      // Observer.update already set up the matrices
    } else if (this.state === 'menu' || this.state === 'paused') {
      // keep the last matrices so a paused frame still draws correctly
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.5, 0.7, 0.9, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const sky = this.skyColors();
    const dayF = this.dayLightFactor();
    this._frameDayLight = dayF;
    const sunAngle = this.dayPhase * Math.PI * 2;
    const sunDir = [Math.cos(sunAngle) * 0.4, Math.sin(sunAngle), Math.cos(sunAngle) * 0.6];

    // --- sky ---
    gl.useProgram(this.skyProg);
    gl.uniform3f(this.skyProg.u.uTop, sky.top[0], sky.top[1], sky.top[2]);
    gl.uniform3f(this.skyProg.u.uBottom, sky.bottom[0], sky.bottom[1], sky.bottom[2]);
    gl.uniform3f(this.skyProg.u.uSunDir, sunDir[0], sunDir[1], sunDir[2]);
    gl.uniform1f(this.skyProg.u.uStar, sky.star);
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);

    // --- terrain ---
    const prog = this.prog;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.blockTex);
    gl.uniform1i(prog.u.uTex, 0);
    gl.uniformMatrix4fv(prog.u.uVP, false, Cam.viewProj);
    const camPos = (this.state === 'observe') ? Observer.pos : Cam.pos;
    gl.uniform3f(prog.u.uCamPos, camPos[0], camPos[1], camPos[2]);
    // Fog ends exactly at the streaming radius, so a chunk is always meshed
    // before it can appear out of the haze.
    const fogFar = this.viewDistance();
    gl.uniform1f(prog.u.uFogNear, fogFar * 0.45);
    gl.uniform1f(prog.u.uFogFar, fogFar);
    gl.uniform3f(prog.u.uFogColor, sky.bottom[0], sky.bottom[1], sky.bottom[2]);
    gl.uniform1f(prog.u.uDayLight, dayF);

    // opaque
    gl.uniform1f(prog.u.uAlphaCut, 0.5);
    gl.uniform1f(prog.u.uIsLiquid, 0);
    gl.uniform1f(prog.u.uTintR, 1);
    gl.uniform1f(prog.u.uTintG, 1);
    gl.uniform1f(prog.u.uTintB, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    this.world.chunks.forEach((c) => {
      if (!c.mesh || !c.mesh.opaque) return;
      if (!this.chunkInRange(c)) return;
      gl.bindVertexArray(c.mesh.opaque.vao);
      gl.drawElements(gl.TRIANGLES, c.mesh.opaque.count, gl.UNSIGNED_INT, 0);
    });

    // --- characters, animals, particles (uses its own program internally) ---
    this.renderEntities(prog, dayF);

    // --- transparent: water and cutout last, blended ---
    // renderEntities switches to progBox for the characters, so we have to
    // re-bind the terrain program and restore every uniform it uses before
    // drawing water. Forgetting this leaves the uniforms pointing at the
    // wrong program, which WebGL reports as INVALID_OPERATION.
    gl.useProgram(prog);
    gl.uniformMatrix4fv(prog.u.uVP, false, Cam.viewProj);
    gl.uniform3f(prog.u.uCamPos, camPos[0], camPos[1], camPos[2]);
    gl.uniform3f(prog.u.uFogColor, sky.bottom[0], sky.bottom[1], sky.bottom[2]);
    gl.uniform1f(prog.u.uDayLight, dayF);
    gl.uniform1f(prog.u.uTintR, 1);
    gl.uniform1f(prog.u.uTintG, 1);
    gl.uniform1f(prog.u.uTintB, 1);
    gl.uniform1i(prog.u.uTex, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.uniform1f(prog.u.uAlphaCut, 0.02);
    gl.uniform1f(prog.u.uIsLiquid, 1);

    this.world.chunks.forEach((c) => {
      if (!c.mesh || !c.mesh.trans) return;
      if (!this.chunkInRange(c)) return;
      gl.bindVertexArray(c.mesh.trans.vao);
      gl.drawElements(gl.TRIANGLES, c.mesh.trans.count, gl.UNSIGNED_INT, 0);
    });

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);

    if (this.shotPending) {
      this.shotPending = false;
      this.saveScreenshot();
    }
  },

  /* ---- frustum culling ------------------------------------------------
     Six planes extracted from the view-projection matrix. A chunk is drawn
     only if its bounding box is on the near side of all six, which removes
     the ~60% of the world that is behind the camera. Without this every
     chunk in range was submitted every frame. */
  updateFrustum() {
    const m = Cam.viewProj;
    const f = this._frustum || (this._frustum = new Float32Array(24));
    // Row-vector extraction: a point is inside when it satisfies all six.
    const rows = [
      [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],   // left
      [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],   // right
      [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],   // bottom
      [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],   // top
      [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],  // near
      [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],  // far
    ];
    for (let i = 0; i < 6; i++) {
      const r = rows[i];
      const len = Math.hypot(r[0], r[1], r[2]) || 1;
      f[i * 4] = r[0] / len;
      f[i * 4 + 1] = r[1] / len;
      f[i * 4 + 2] = r[2] / len;
      f[i * 4 + 3] = r[3] / len;
    }
  },

  // Axis aligned box test against the frustum. The box is the chunk's column.
  boxInFrustum(minX, minY, minZ, maxX, maxY, maxZ) {
    const f = this._frustum;
    if (!f) return true;
    for (let i = 0; i < 6; i++) {
      const a = f[i * 4], b = f[i * 4 + 1], c = f[i * 4 + 2], d = f[i * 4 + 3];
      // Pick the box corner furthest along the plane normal. If even that
      // corner is behind the plane, the whole box is outside.
      const x = a >= 0 ? maxX : minX;
      const y = b >= 0 ? maxY : minY;
      const z = c >= 0 ? maxZ : minZ;
      if (a * x + b * y + c * z + d < 0) return false;
    }
    return true;
  },

  chunkInRange(c) {
    const camPos = (this.state === 'observe') ? Observer.pos : Cam.pos;
    const minX = c.cx * CHUNK, minZ = c.cz * CHUNK;
    const cx = minX + CHUNK / 2, cz = minZ + CHUNK / 2;

    // Distance from the camera to the nearest point on the chunk column.
    const dx = Math.max(minX - camPos[0], 0, camPos[0] - (minX + CHUNK));
    const dz = Math.max(minZ - camPos[2], 0, camPos[2] - (minZ + CHUNK));
    const dy = camPos[1] < 0 ? -camPos[1] : (camPos[1] > WORLD_H ? camPos[1] - WORLD_H : 0);
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > this.viewDistance()) return false;

    return this.boxInFrustum(minX, 0, minZ, minX + CHUNK, WORLD_H, minZ + CHUNK);
  },

  // How far we can actually see. Fog is tuned to end just inside this, so
  // nothing pops in while still visible.
  viewDistance() {
    return 28 + this.renderDist * CHUNK * 0.8;
  },

  /* ---- chunk streaming -------------------------------------------------
     The world is only 200x200, so all of it is generated up front. Meshing
     all 169 chunks at load was slow and held far more GPU memory than the
     view needs. Instead we mesh chunks as the player approaches and release
     the buffers for chunks well behind.

     The budget is in milliseconds, not in chunks. A single chunk mesh costs
     around 13ms on this hardware, so "two chunks per frame" silently meant
     26ms frames. Timing the work keeps a hitch from turning into a stall no
     matter how fast the machine is. */
  streamChunks(msBudget) {
    const camPos = (this.state === 'observe') ? Observer.pos : Cam.pos;
    const keep = this.viewDistance();
    // Release a little beyond the visible radius so walking back and forth
    // does not thrash the buffers, but still bounds GPU memory.
    const drop = keep * 1.35;
    const budget = msBudget === undefined ? 6 : msBudget;

    // nearest first, so the chunks you are about to see are built first
    const wanted = [];
    for (const c of this.world.chunks.values()) {
      if (!c.generated) continue;
      const minX = c.cx * CHUNK, minZ = c.cz * CHUNK;
      const d = Math.hypot(minX + CHUNK / 2 - camPos[0], minZ + CHUNK / 2 - camPos[2]);
      if (d > keep) {
        // far away: release the mesh to free memory, but keep the data
        if (c.mesh && d > drop) { disposeMesh(this.gl, c.mesh); c.mesh = null; }
        continue;
      }
      if (!c.mesh) wanted.push({ c, d });
    }
    wanted.sort((a, b) => a.d - b.d);
    if (!wanted.length) return 0;

    // The leftover list is cached so walking around does not re-sort every
    // frame; it is invalidated whenever the queue empties or the camera moves
    // far enough that priorities could have changed.
    const moved = !this._streamAt ||
      Math.hypot(camPos[0] - this._streamAt[0], camPos[2] - this._streamAt[2]) > CHUNK;
    if (moved || !this._streamQueue || !this._streamQueue.length) {
      this._streamQueue = wanted;
      this._streamAt = [camPos[0], camPos[1], camPos[2]];
    }

    const start = performance.now();
    let built = 0;
    // Always build at least one, otherwise a single expensive chunk could
    // never be scheduled at all and the gap would stay missing forever.
    do {
      const next = this._streamQueue.shift();
      if (!next || next.c.mesh) break;
      next.c.mesh = buildChunkMesh(this.gl, this.world, next.c);
      next.c.dirty = false;
      built++;
    } while (this._streamQueue.length &&
      performance.now() - start < budget);

    return built;
  },

  // Draw a textured box at a world position with Y rotation.
  // alpha < 1 makes it translucent (used for auras, sparks and the block outline).
  drawBox(prog, center, size, tile, tint, rotY, alpha) {
    const gl = this.gl;
    const p = this.progBox;
    gl.useProgram(p);

    const model = M4.composeTRS(this._boxModel, center, size, rotY || 0);
    const mvp = M4.multiply(this._boxMvp, Cam.viewProj, model);

    const camPos = (this.state === 'observe') ? Observer.pos : Cam.pos;
    const fogFar = 40 + this.renderDist * CHUNK * 0.85;

    gl.uniformMatrix4fv(p.u.uMVP, false, mvp);
    gl.uniform3f(p.u.uCamPos, camPos[0], camPos[1], camPos[2]);
    gl.uniform1f(p.u.uFogNear, fogFar * 0.42);
    gl.uniform1f(p.u.uFogFar, fogFar);
    gl.uniform3f(p.u.uFogColor, 0.72, 0.82, 0.95);
    gl.uniform1f(p.u.uDayLight, this._frameDayLight);
    gl.uniform3f(p.u.uTint, tint[0], tint[1], tint[2]);
    gl.uniform1f(p.u.uAlpha, alpha === undefined ? 1 : alpha);
    gl.uniform1f(p.u.uTile, tile || 0);
    gl.uniform1f(p.u.uUseTex, tile === undefined || tile === null ? 0 : 1);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.blockTex);
    gl.uniform1i(p.u.uTex, 0);

    gl.bindVertexArray(this.cube.vao);
    gl.drawElements(gl.TRIANGLES, this.cube.count, gl.UNSIGNED_SHORT, 0);
  },

  renderEntities(prog, dayF) {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // the block we're about to break — a glowing outline
    if (this.state === 'play' && this.currentTarget && this.currentTarget.hit) {
      const t = this.currentTarget;
      const pulse = 0.26 + Math.sin(this.time * 9) * 0.07;
      this.drawBox(prog,
        [t.x + 0.5, t.y + 0.5, t.z + 0.5],
        [1.03, 1.03, 1.03], null, [1, 0.95, 0.4], 0, pulse);
    }

    // players
    for (const p of this.players) {
      if (p.networkRemote && !p.networkRemoteVisible) continue;
      this.drawCharacter(prog, p, dayF);
    }

    // animals
    for (const a of this.animals) {
      this.drawAnimal(prog, a, dayF);
    }

    // projectiles
    for (const pr of Fight.projectiles) {
      this.drawProjectile(prog, pr);
    }

    // particles
    for (const p of Particles.list) {
      const s = p.size * Math.min(1, p.life * 2.2);
      this.drawBox(prog, p.pos, [s, s, s], p.def.tile, [1, 1, 1], p.spin, Math.min(1, p.life * 2));
    }

    gl.disable(gl.BLEND);
  },

  drawCharacter(prog, p, dayF) {
    if (!p) return;
    const c = p.char;
    const swing = p.swing ? Math.min(1, p.swing.t / Math.max(0.01, p.swingTotal)) : 0;
    const attacking = !!p.swing;
    const atk = p.swing ? p.swing.attack : 0;
    // arm swing
    const walk = Math.sin(p.walkAnim) * (p.onGround ? 0.9 : 0.2);
    let armL = walk * 0.8;
    let armR = -walk * 0.8;
    if (attacking) {
      const k = Math.sin(swing * Math.PI);
      if (atk === 0) { armR = -k * 2.2; armL = k * 0.6; }
      else if (atk === 1) { armL = k * 2.0; armR = -k * 0.8; }
      else { armR = -k * 2.6; armL = -k * 2.6; }
    }
    let legL = -walk * 0.7, legR = walk * 0.7;
    if (p.ko) { legL = 0.9; legR = 0.9; }

    const yaw = p.yaw;
    const flash = p.hurtFlash > 0 ? 1 : 0;
    const tint = flash ? [1, 0.45, 0.45] : [1, 1, 1];
    const bob = p.onGround ? Math.abs(Math.sin(p.walkAnim)) * 0.06 : 0;
    const base = [p.pos[0], p.pos[1] + bob, p.pos[2]];
    const bodyH = 0.75, legH = 0.75;
    // facing vectors, needed for the eyes, hair and doll details
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const point = (forward, side, y) => [
      base[0] + fx * forward + rx * side,
      base[1] + y,
      base[2] + fz * forward + rz * side,
    ];

    // legs
    this.drawLimb(prog, base, yaw, [-0.15, legH, 0], legL, [0.25, legH, 0.28], c.pants, tint, dayF);
    this.drawLimb(prog, base, yaw, [0.15, legH, 0], legR, [0.25, legH, 0.28], c.pants, tint, dayF);
    // body
    this.drawBox(prog, [base[0], base[1] + legH + bodyH / 2, base[2]],
      [0.52, bodyH, 0.3], c.shirt, tint, yaw, 1);
    // Small chest pixels give every character a second accent colour and a clearer identity.
    if (c.accent) {
      const chestY = legH + bodyH * 0.58;
      this.drawBox(prog, point(0.17, 0, chestY), [0.15, 0.16, 0.035], c.accent, tint, yaw, 1);
      this.drawBox(prog, point(0.193, -0.025, chestY + 0.055), [0.045, 0.045, 0.018], T.wool, tint, yaw, 1);
      this.drawBox(prog, point(0.193, 0.025, chestY - 0.055), [0.045, 0.045, 0.018], c.shirt, tint, yaw, 1);
    }
    // arms
    this.drawLimb(prog, base, yaw, [-0.36, legH + bodyH - 0.15, 0], armL, [0.22, 0.62, 0.24], c.shirt, tint, dayF);
    this.drawLimb(prog, base, yaw, [0.36, legH + bodyH - 0.15, 0], armR, [0.22, 0.62, 0.24], c.shirt, tint, dayF);
    // head
    const headY = base[1] + legH + bodyH + 0.3;
    this.drawBox(prog, [base[0], headY, base[2]], [0.5, 0.5, 0.5], c.skin, tint, yaw, 1);

    // Hair: a full cap for most characters. The doll gets a rounder, softer
    // shape with a fringe so she reads as a doll rather than a person.
    if (c.dollFace) {
      this.drawBox(prog, [base[0], headY + 0.16, base[2]], [0.58, 0.3, 0.58], c.hair, tint, yaw, 1);
      // fringe across the forehead
      this.drawBox(prog, [
        base[0] + fx * 0.2, headY + 0.11, base[2] + fz * 0.2,
      ], [0.54, 0.16, 0.16], c.hair, tint, yaw, 1);
      // two pigtails
      for (const s of [-1, 1]) {
        this.drawBox(prog, [
          base[0] + rx * s * 0.34, headY + 0.06, base[2] + rz * s * 0.34,
        ], [0.2, 0.34, 0.2], c.hair, tint, yaw, 1);
      }
    } else {
      this.drawBox(prog, [base[0], headY + 0.19, base[2]], [0.54, 0.16, 0.54], c.hair, tint, yaw, 1);
    }

    // eyes on the front face
    const eyeOff = c.dollFace ? 0.15 : 0.13;
    const eyeSize = c.dollFace ? 0.11 : 0.07;
    for (const s of [-1, 1]) {
      this.drawBox(prog, [
        base[0] + fx * 0.26 + rx * s * eyeOff,
        headY + (c.dollFace ? 0.0 : 0.02),
        base[2] + fz * 0.26 + rz * s * eyeOff,
      ], [eyeSize, c.dollFace ? 0.13 : 0.09, 0.03], T.eye, tint, yaw, 1);
    }

    // glowing outline when an ultimate is ready
    if (p.ultMeter >= p.maxUlt && !p.ko) {
      this.drawBox(prog, [base[0], base[1] + 1.0, base[2]], [0.8, 1.9, 0.8], T.glowstone,
        [0.4, 0.9, 0.5], 0, 0.14);
    }
  },

  // One arm or leg, rotated about the shoulder/hip.
  drawLimb(prog, base, yaw, offset, angle, size, tile, tint, dayF) {
    const gl = this.gl;
    const pivotY = offset[1];
    const ca = Math.cos(angle), sa = Math.sin(angle);
    // rotate the limb forward/back around its top pivot
    const len = size[1];
    const midY = pivotY - len / 2 * ca;
    const midZ = len / 2 * sa;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const cx = base[0] + rx * offset[0];
    const cz = base[2] + rz * offset[0];
    this.drawBox(prog, [cx, base[1] + midY, cz + midZ], size, tile, tint, yaw, 1);
  },

  drawProjectile(prog, projectile) {
    const d = projectile.def;
    const [x, y, z] = projectile.pos;
    const size = d.size * (projectile.big ? 1.55 : 1);
    const spin = projectile.spin;

    if (d.kind === 'web') {
      // A bright pixel lattice reads as a web shot instead of a plain glass cube.
      this.drawBox(prog, [x, y, z], [size * 0.56, size * 0.56, size * 0.56], T.glass, [1, 1, 1], spin, 1);
      this.drawBox(prog, [x, y, z], [size * 1.45, size * 0.16, size * 0.16], T.shirt_cyan, [1, 1, 1], spin, 1);
      this.drawBox(prog, [x, y, z], [size * 0.16, size * 1.45, size * 0.16], T.shirt_cyan, [1, 1, 1], spin, 1);
      this.drawBox(prog, [x, y, z], [size * 1.05, size * 0.12, size * 0.12], T.wool, [1, 1, 1], spin + 0.78, 1);
      return;
    }

    if (d.kind === 'star') {
      // Staggered bars make a chunky four-point star with a warm pixel core.
      this.drawBox(prog, [x, y, z], [size * 0.38, size * 1.45, size * 0.32], T.glowstone, [1, 1, 1], spin, 1);
      this.drawBox(prog, [x, y, z], [size * 1.45, size * 0.38, size * 0.32], T.glowstone, [1, 1, 1], spin, 1);
      this.drawBox(prog, [x, y, z], [size * 0.62, size * 0.62, size * 0.38], T.beak, [1, 1, 1], spin, 1);
      this.drawBox(prog, [x, y, z], [size * 0.20, size * 0.20, size * 0.42], T.wool, [1, 1, 1], spin, 1);
      return;
    }

    if (d.kind === 'shuriken') {
      // Two crossed steel blades and a hot centre make the spinning weapon legible at a glance.
      this.drawBox(prog, [x, y, z], [size * 1.5, size * 0.2, size * 0.18], T.steel, [1, 1, 1], spin + 0.78, 1);
      this.drawBox(prog, [x, y, z], [size * 1.5, size * 0.2, size * 0.18], T.steel, [1, 1, 1], spin - 0.78, 1);
      this.drawBox(prog, [x, y, z], [size * 0.34, size * 0.34, size * 0.24], T.hero_red, [1, 1, 1], spin, 1);
      return;
    }

    // Block Bonanza and other special shots retain their material, with a crisp inset pixel.
    this.drawBox(prog, [x, y, z], [size, size, size], d.tile, [1, 1, 1], spin, 1);
    if (size > 0.4) {
      this.drawBox(prog, [x, y, z], [size * 0.34, size * 0.34, size * 0.34], T.wool, [1, 1, 1], spin, 1);
    }
  },

  drawAnimal(prog, a, dayF) {
    const d = a.def;
    const s = a.scale;
    const yaw = a.yaw;
    const walk = Math.sin(a.walkAnim) * 0.7;
    const base = a.pos;
    const legH = d.h * 0.45;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const point = (forward, side, y) => [
      base[0] + fx * forward * s + rx * side * s,
      y,
      base[2] + fz * forward * s + rz * side * s,
    ];

    // legs
    for (const [ox, ang] of [[-0.22, walk], [0.22, -walk]]) {
      this.drawBox(prog,
        [base[0] + rx * ox * s, base[1] + legH / 2, base[2] + rz * ox * s],
        [0.16 * s, legH, 0.16 * s], d.leg, [1, 1, 1], yaw, 1);
    }
    // body
    this.drawBox(prog,
      [base[0], base[1] + legH + d.h * 0.32, base[2]],
      [d.w * s, d.h * 0.64, d.d * s], d.body, [1, 1, 1], yaw, 1);

    // Distinct pixel patches, wool tufts and wings break up the one-colour body shapes.
    if (d.id === 'pig') {
      for (const side of [-1, 1]) {
        this.drawBox(prog, point(-0.12, side * (d.w * 0.5 + 0.012), base[1] + legH + d.h * 0.36),
          [0.025 * s, 0.2 * s, 0.28 * s], d.accent, [1, 1, 1], yaw, 1);
      }
    } else if (d.id === 'sheep') {
      for (const [forward, side] of [[-0.28, 0], [0.08, -0.31], [0.08, 0.31]]) {
        this.drawBox(prog, point(forward, side, base[1] + legH + d.h * 0.68),
          [0.27 * s, 0.18 * s, 0.24 * s], d.body, [1, 1, 1], yaw, 1);
      }
    } else if (d.id === 'chick') {
      for (const side of [-1, 1]) {
        this.drawBox(prog, point(-0.02, side * (d.w * 0.5 + 0.018), base[1] + legH + d.h * 0.34),
          [0.04 * s, 0.2 * s, 0.24 * s], d.accent, [1, 1, 1], yaw, 1);
      }
    }

    // head
    const headY = base[1] + legH + d.h * 0.78;
    const headForward = d.d * 0.4;
    const headWidth = d.w * 0.7;
    const headHeight = d.h * 0.5;
    const headDepth = d.w * 0.6;
    this.drawBox(prog, point(headForward, 0, headY),
      [headWidth * s, headHeight * s, headDepth * s], d.face, [1, 1, 1], yaw, 1);

    const headFront = headForward + headDepth * 0.5 + 0.02;
    const eyeY = headY + headHeight * 0.08 * s;
    const eyeSide = headWidth * 0.27;
    for (const side of [-1, 1]) {
      this.drawBox(prog, point(headFront, side * eyeSide, eyeY),
        [0.085 * s, 0.095 * s, 0.03 * s], T.eye, [1, 1, 1], yaw, 1);
    }

    if (d.id === 'pig') {
      // Two upright pixels and a broad snout make the pig's face unmistakable.
      for (const side of [-1, 1]) {
        this.drawBox(prog, point(headForward - 0.015, side * headWidth * 0.36,
          headY + headHeight * 0.55 * s), [0.11 * s, 0.16 * s, 0.1 * s], d.accent, [1, 1, 1], yaw, 1);
      }
      const snoutY = headY - headHeight * 0.16 * s;
      this.drawBox(prog, point(headFront + 0.025, 0, snoutY),
        [0.24 * s, 0.17 * s, 0.08 * s], d.accent, [1, 1, 1], yaw, 1);
      for (const side of [-1, 1]) {
        this.drawBox(prog, point(headFront + 0.07, side * 0.055, snoutY),
          [0.035 * s, 0.06 * s, 0.02 * s], T.eye, [1, 1, 1], yaw, 1);
      }
    } else if (d.id === 'sheep') {
      for (const side of [-1, 1]) {
        this.drawBox(prog, point(headForward, side * headWidth * 0.55, headY + 0.015),
          [0.12 * s, 0.08 * s, 0.13 * s], d.accent, [1, 1, 1], yaw, 1);
      }
      this.drawBox(prog, point(headFront + 0.025, 0, headY - headHeight * 0.22 * s),
        [0.16 * s, 0.12 * s, 0.06 * s], d.accent, [1, 1, 1], yaw, 1);
    } else if (d.id === 'chick') {
      // A stepped crest and orange beak give the chick a clear little silhouette.
      this.drawBox(prog, point(headForward - 0.015, 0, headY + headHeight * 0.55 * s),
        [0.1 * s, 0.12 * s, 0.1 * s], d.accent, [1, 1, 1], yaw, 1);
      this.drawBox(prog, point(headFront + 0.05, 0, headY - headHeight * 0.16 * s),
        [0.14 * s, 0.1 * s, 0.12 * s], d.beak, [1, 1, 1], yaw, 1);
    }
  },

  saveScreenshot() {
    try {
      const url = this.canvas.toDataURL('image/png');
      const a = document.createElement('a');
      const name = 'blocky-world-' + Date.now() + '.png';
      a.href = url;
      a.download = name;
      a.click();
      UI.toast('Saved ' + name);
    } catch (e) {
      UI.toast('Could not save the photo on this browser');
    }
  },

  /* ============================================================
     loop
     ============================================================ */
  loop(now) {
    const dt = Math.min(0.05, (now - this.lastTime) / 1000 || 0.016);
    this.lastTime = now;
    this.frameCount = (this.frameCount || 0) + 1;

    const inp = this.gatherInput();

    if (!this.paused && this.state !== 'menu' && this.state !== 'loading') {
      this.update(dt, inp);
    } else if (this.state === 'menu') {
      // slow camera drift over the world behind the menu
      this.time += dt;
      const a = this.time * 0.05;
      Cam.yaw = a;
      Cam.pitch = -0.28;
      const o = this.world.originX;
      Cam.pos = [o + Math.cos(a) * 34, SEA_LEVEL + 30, o + Math.sin(a) * 34];
      Cam.update(dt, this.aspect(), Cam.pos);
    }

    // Rebuild edited chunks first, then top up the view with new ones.
    this.updateDirtyChunks(1);
    if (this.state !== 'menu') this.streamChunks();
    this.updateFrustum();
    this.render(dt);

    // This is the measured rAF rate over a full second, not the reciprocal of
    // one possibly jittery frame delta. It therefore stays informative while
    // the renderer is capped at 60 FPS.
    if (this.fpsWindowStart === 0) this.fpsWindowStart = now;
    this.fpsWindowFrames++;
    const fpsElapsed = now - this.fpsWindowStart;
    if (fpsElapsed >= 1000) {
      this.measuredFps = Math.round(this.fpsWindowFrames * 1000 / fpsElapsed);
      this.fpsWindowStart = now;
      this.fpsWindowFrames = 0;
    }

    // debug overlay
    if (this.showDebug && (this.debugLastUpdate === 0 || now - this.debugLastUpdate >= 250)) {
      const p1 = this.players[0];
      UI.debug(
        'fps ' + this.measuredFps + ' / 60' +
        '\nstate ' + this.state +
        '\npos ' + (p1 ? p1.pos.map(v => v.toFixed(1)).join(' ') : '-') +
        '\nchunks ' + this.world.chunks.size +
        '\nday ' + this.dayLightFactor().toFixed(2) +
        '\nparts ' + Particles.list.length,
        true);
      this.debugLastUpdate = now;
    } else if (!this.showDebug && this.debugLastUpdate !== 0) {
      UI.debug('', false);
      this.debugLastUpdate = 0;
    }

    Input.endFrame();

    if (this.state === 'play') {
      UI.setActiveSlot(this.selectedSlot);
    }
  },
};

/* Yield to the browser between heavy chunks.
   We race requestAnimationFrame against a timer, because rAF is
   throttled to a standstill in a backgrounded tab — the loading
   screen would otherwise freeze while the world is still building. */
function frame() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(finish);
    setTimeout(finish, 24);
  });
}

/* ---------- go ---------- */
window.addEventListener('load', () => {
  const start = window.Network ? Network.startGameIfAllowed() : Game.boot();
  Promise.resolve(start).catch((e) => {
    console.error(e);
    const el = document.getElementById('loading');
    if (el) el.innerHTML = '<div class="title">Something broke</div><div class="msg">' +
      (e && e.message ? e.message : e) + '</div>';
  });
});
