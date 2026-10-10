'use strict';
/* ============================================================
   touch.js — iOS / tablet controls

   Design goals:
   - Works with no pointer lock (Safari has none)
   - Thumbstick left, look drag anywhere on the right
   - Big round buttons sized for small hands
   - Respect the notch / home indicator via safe-area insets
   - No page scroll, no rubber-band, no double-tap zoom
   ============================================================ */

const Touch = {
  enabled: false,
  move: { x: 0, y: 0 },
  look: { x: 0, y: 0 },
  btn: { jump: false, hit: false, use: false, fly: false },
  stickId: null,
  lookId: null,
  ox: 0, oy: 0,
  lx: 0, ly: 0,
  lookMoved: 0,
  lookStart: 0,

  /* ---- floating analog stick ----
     The stick rests in the lower left and is always visible while playing,
     so a child can see it before touching it. On touch it springs to land
     under the thumb, wherever that is inside the zone. */
  stickRadius: 62,      // how far the knob travels before it maxes out
  deadZone: 0.14,      // ignore tiny wobbles so walking is not jittery
  stickActive: false,

  init() {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const touchCapable = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    this.enabled = touchCapable;
    // Show the touch pad on any touch device, but also allow forcing it on
    // from the options menu for testing on a desktop.
    if (touchCapable) document.body.classList.add('touch');

    // Stop Safari's own gestures.
    const stop = (e) => e.preventDefault();
    document.addEventListener('gesturestart', stop, { passive: false });
    document.addEventListener('gesturechange', stop, { passive: false });
    document.addEventListener('contextmenu', stop);
    document.addEventListener('touchmove', (e) => {
      // allow scrolling inside the menu card only
      if (e.target.closest && e.target.closest('.menu-card')) return;
      e.preventDefault();
    }, { passive: false });
    let lastTouch = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouch < 320) e.preventDefault();   // kill double-tap zoom
      lastTouch = now;
    }, { passive: false });

    if (!touchCapable) return;

    const stickZone = document.getElementById('touch-move');
    const lookZone = document.getElementById('touch-look');
    const knob = document.getElementById('touch-knob');
    const stick = document.getElementById('touch-stick');
    if (!stickZone || !lookZone) return;

// Show the stick where the thumb went down, and move the base element
    // itself, not just the knob. Clearing these restores the resting spot
    // defined in the stylesheet.
    const base = document.getElementById('touch-stick');
    const setStickBase = (x, y) => {
      this.ox = x;
      this.oy = y;
      if (!base) return;
      base.style.left = x + 'px';
      base.style.top = y + 'px';
    };

    const setStick = (dx, dy) => {
      const r = this.stickRadius;
      const len = Math.hypot(dx, dy);
      // clamp to a circle so diagonal input is not faster than straight input
      if (len > r) { dx = dx / len * r; dy = dy / len * r; }
      let nx = dx / r;
      let ny = dy / r;
      // radial dead zone: rescale so the first movement is a smooth ramp
      const mag = Math.hypot(nx, ny);
      if (mag < this.deadZone) {
        nx = 0; ny = 0;
      } else {
        const scaled = (mag - this.deadZone) / (1 - this.deadZone);
        nx = (nx / mag) * scaled;
        ny = (ny / mag) * scaled;
      }
      this.move.x = nx;
      this.move.y = ny;
      if (knob) knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    };

    const resetStick = () => {
      this.stickId = null;
      this.stickActive = false;
      this.move.x = 0;
      this.move.y = 0;
      if (knob) knob.style.transform = 'translate(0px,0px)';
      if (base) {
        base.style.left = '';
        base.style.top = '';
      }
      if (stickZone) stickZone.classList.remove('active');
    };

    stickZone.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      this.stickId = t.identifier;
      this.stickActive = true;
      // The stick springs up under the thumb, wherever that is.
      setStickBase(t.clientX, t.clientY);
      setStick(0, 0);
      stickZone.classList.add('active');
      // Retire the coach mark the first time the child uses the stick.
      stickZone.classList.add('used');
      e.preventDefault();
    }, { passive: false });

    lookZone.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      this.lookId = t.identifier;
      this.lx = t.clientX;
      this.ly = t.clientY;
      this.lookStart = performance.now();
      this.lookMoved = 0;
      e.preventDefault();
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.stickId) {
          setStick(t.clientX - this.ox, t.clientY - this.oy);
        } else if (t.identifier === this.lookId) {
          const dx = t.clientX - this.lx;
          const dy = t.clientY - this.ly;
          this.look.x += dx;
          this.look.y += dy;
          this.lookMoved += Math.abs(dx) + Math.abs(dy);
          this.lx = t.clientX;
          this.ly = t.clientY;
        }
      }
      e.preventDefault();
    }, { passive: false });

    const end = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.stickId) {
          resetStick();
        }
        if (t.identifier === this.lookId) {
          this.lookId = null;
          // A quick tap on the look area breaks a block (same as a left click).
          if (this.lookMoved < 12 && performance.now() - this.lookStart < 260 && Game.state === 'play') {
            Input.mouse.leftPressed = true;
          }
        }
      }
    };
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);

    // --- buttons ---
    const bind = (id, key, tapOnly) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('touchstart', (e) => {
        this.btn[key] = true;
        el.classList.add('pressed');
        e.preventDefault();
      }, { passive: false });
      const up = (e) => {
        // tapOnly buttons fire once, held buttons track state
        if (tapOnly) this.btn[key] = false;
        el.classList.remove('pressed');
        if (e.cancelable) e.preventDefault();
      };
      el.addEventListener('touchend', up);
      el.addEventListener('touchcancel', up);
      el.addEventListener('touchleave', up);
    };

    bind('touch-jump', 'jump', false);
    bind('touch-hit', 'hit', false);
    bind('touch-use', 'use', true);
    bind('touch-fly', 'fly', true);

    // tap the hotbar directly
    document.querySelectorAll('#hotbar .slot').forEach((slot, i) => {
      slot.style.pointerEvents = 'auto';
      slot.addEventListener('touchstart', (e) => {
        Game.selectSlot(i);
        e.preventDefault();
      }, { passive: false });
    });
  },

  // Called once per frame by the game loop.
  consumeLook() {
    const out = { x: this.look.x, y: this.look.y };
    this.look.x = 0;
    this.look.y = 0;
    return out;
  },

  setVisible(on) {
    const el = document.getElementById('touch-ui');
    if (el) el.style.display = on ? '' : 'none';
  },

  relabel(mode) {
    const hit = document.getElementById('touch-hit');
    const use = document.getElementById('touch-use');
    const fly = document.getElementById('touch-fly');
    const jump = document.getElementById('touch-jump');
    if (!hit) return;
    if (mode === 'fight') {
      hit.textContent = 'HIT';
      use.textContent = 'SKILL';
      if (jump) jump.textContent = 'JUMP';
      if (fly) fly.style.display = 'none';
    } else if (mode === 'observe') {
      hit.textContent = '▲';
      use.textContent = '▼';
      if (jump) jump.textContent = 'FWD';
      if (fly) fly.style.display = 'none';
    } else {
      hit.textContent = 'BREAK';
      use.textContent = 'PLACE';
      if (jump) jump.textContent = 'JUMP';
      if (fly) fly.style.display = '';
    }
  },
};