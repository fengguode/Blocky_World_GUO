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
  btn: { jump: false, hit: false, use: false, fly: false, view: false },
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
    const touchCapable = isTouch();
    this.enabled = touchCapable;
    // Show the touch pad on any touch device, but also allow forcing it on
    // from the options menu for testing on a desktop.
    if (touchCapable) document.body.classList.add('touch');

    window.addEventListener('blur', () => this.reset());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.reset(); });
    // Stop Safari's own gestures.
    const stop = (e) => e.preventDefault();
    document.addEventListener('gesturestart', stop, { passive: false });
    document.addEventListener('gesturechange', stop, { passive: false });
    document.addEventListener('contextmenu', stop);
    document.addEventListener('touchmove', (e) => {
      // Let native scrolling and synthesized click events work for UI panels.
      if (e.target.closest && e.target.closest('#menu, .menu-card, .auth-screen, #hotbar')) return;
      e.preventDefault();
    }, { passive: false });
    // iOS Safari can fail to scroll fixed overlays inside the fixed game page.
    // Move the intro menu explicitly with the finger so every menu option stays reachable.
    const menu = document.getElementById('menu');
    let menuTouch = null;
    if (menu) {
      menu.addEventListener('touchstart', (e) => {
        if (menu.classList.contains('hidden')) return;
        const t = e.changedTouches[0];
        if (t) menuTouch = { id: t.identifier, x: t.clientX, y: t.clientY, scrollTop: menu.scrollTop };
      }, { passive: true });
      menu.addEventListener('touchmove', (e) => {
        if (!menuTouch || menu.scrollHeight <= menu.clientHeight + 1) return;
        let t = null;
        for (const changed of e.changedTouches) {
          if (changed.identifier === menuTouch.id) { t = changed; break; }
        }
        if (!t) return;
        const delta = menuTouch.y - t.clientY;
        const horizontalDelta = t.clientX - menuTouch.x;
        // Ignore finger drift and horizontal swipes so a button tap still clicks.
        if (Math.abs(delta) < 10 || Math.abs(delta) <= Math.abs(horizontalDelta)) return;
        if (e.cancelable) e.preventDefault();
        menu.scrollTop = Math.max(0, Math.min(menu.scrollHeight - menu.clientHeight, menuTouch.scrollTop + delta));
      }, { passive: false });
      const endMenuScroll = (e) => {
        if (!menuTouch) return;
        for (const changed of e.changedTouches) {
          if (changed.identifier === menuTouch.id) { menuTouch = null; break; }
        }
      };
      menu.addEventListener('touchend', endMenuScroll, { passive: true });
      menu.addEventListener('touchcancel', endMenuScroll, { passive: true });
    }
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
      let handledTouch = false;
      for (const t of e.changedTouches) {
        if (t.identifier === this.stickId) {
          handledTouch = true;
          setStick(t.clientX - this.ox, t.clientY - this.oy);
        } else if (t.identifier === this.lookId) {
          handledTouch = true;
          const dx = t.clientX - this.lx;
          const dy = t.clientY - this.ly;
          this.look.x += dx;
          this.look.y += dy;
          this.lookMoved += Math.abs(dx) + Math.abs(dy);
          this.lx = t.clientX;
          this.ly = t.clientY;
        }
      }
      // Only cancel browser gestures for touches owned by the game controls.
      // Menu, auth, and setup panels must keep native vertical scrolling on iOS.
      if (handledTouch && e.cancelable) e.preventDefault();
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
    const bind = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('touchstart', (e) => {
        this.btn[key] = true;
        el.classList.add('pressed');
        e.preventDefault();
      }, { passive: false });
      const up = (e) => {
        this.btn[key] = false;
        el.classList.remove('pressed');
        if (e.cancelable) e.preventDefault();
      };
      el.addEventListener('touchend', up);
      el.addEventListener('touchcancel', up);
      el.addEventListener('touchleave', up);
    };

    bind('touch-jump', 'jump');
    bind('touch-hit', 'hit');
    bind('touch-use', 'use');
    bind('touch-fly', 'fly');
    bind('touch-view', 'view');

  },

  reset() {
    this.stickId = this.lookId = null;
    this.stickActive = false;
    this.move.x = this.move.y = this.look.x = this.look.y = 0;
    for (const key of Object.keys(this.btn)) this.btn[key] = false;
    document.querySelectorAll('.tbtn.pressed').forEach(el => el.classList.remove('pressed'));
    const knob = document.getElementById('touch-knob');
    if (knob) knob.style.transform = 'translate(0px,0px)';
    const base = document.getElementById('touch-stick');
    if (base) { base.style.left = ''; base.style.top = ''; }
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
    if (el) {
      el.classList.toggle('hidden', !on);
      el.style.display = '';
    }
    const view = document.getElementById('touch-view');
    if (view) view.classList.toggle('hidden', !on || !Game || Game.state !== 'play');
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
