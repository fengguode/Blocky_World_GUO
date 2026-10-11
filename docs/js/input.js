'use strict';
/* ============================================================
   input.js — keyboard, mouse, gamepad and touch
   ============================================================ */

const Input = {
  keys: Object.create(null),
  pressed: Object.create(null),     // edge-triggered, cleared each frame
  mouse: { dx: 0, dy: 0, left: false, right: false, leftPressed: false, rightPressed: false, wheel: 0 },
  pointerLocked: false,
  gamepads: [],
  mode: 'play',        // play | fight | observe
  sensitivity: 0.0024,

  init(canvas) {
    window.addEventListener('keydown', (e) => {
      const k = e.code;
      if (!this.keys[k]) this.pressed[k] = true;
      this.keys[k] = true;
      // stop the page scrolling / space activating buttons
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Slash'].includes(k)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    window.addEventListener('blur', () => { this.keys = Object.create(null); });

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftPressed = true; }
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightPressed = true; }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', (e) => { this.mouse.wheel += Math.sign(e.deltaY); }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = (document.pointerLockElement === canvas);
      if (Game.onPointerLockChange) Game.onPointerLockChange(this.pointerLocked);
    });

    window.addEventListener('mousemove', (e) => {
      if (this.pointerLocked) {
        this.mouse.dx += e.movementX || 0;
        this.mouse.dy += e.movementY || 0;
      } else if (this.dragLook) {
        this.mouse.dx += e.movementX || 0;
        this.mouse.dy += e.movementY || 0;
      }
    });
    canvas.addEventListener('mousedown', () => { this.dragLook = true; });
    window.addEventListener('mouseup', () => { this.dragLook = false; });

    window.addEventListener('gamepadconnected', (e) => {
      this.gamepads.push(e.gamepad.index);
      UI.toast('Controller connected: ' + e.gamepad.id.slice(0, 28));
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      this.gamepads = this.gamepads.filter(i => i !== e.gamepad.index);
    });

    },

  requestLock(canvas) {
    // iOS Safari has no pointer lock and throws if you ask, so the touch
    // controls handle looking instead.
    if (isTouch()) return;
    if (!document.body || document.body.classList.contains('touch')) return;
    if (canvas.requestPointerLock) {
      try {
        const r = canvas.requestPointerLock();
        if (r && r.catch) r.catch(() => {});
      } catch (e) { /* not available here; drag-to-look still works */ }
    }
  },

  releaseLock() {
    if (document.exitPointerLock && this.pointerLocked) document.exitPointerLock();
  },

  down(code) { return !!this.keys[code]; },
  hit(code) { return !!this.pressed[code]; },

  /* ---------- gamepad ----------
     iOS has no Gamepad API, so everything here simply reports
     "no controller" and the CPU opponent takes over instead. */
  pad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) {
      if (p && p.connected) return p;
    }
    return null;
  },

  readPad() {
    if (!navigator.getGamepads) return null;
    const p = this.pad();
    if (!p) return null;
    const dead = (v) => (Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82);
    return {
      moveX: dead(p.axes[0] || 0),
      moveY: dead(p.axes[1] || 0),
      lookX: dead(p.axes[2] || 0),
      lookY: dead(p.axes[3] || 0),
      jump: (p.buttons[0] && p.buttons[0].pressed) || false,
      attack: (p.buttons[2] && p.buttons[2].pressed) || false,
      special: (p.buttons[1] && p.buttons[1].pressed) || false,
      ult: (p.buttons[3] && p.buttons[3].pressed) || false,
      sprint: (p.buttons[7] && p.buttons[7].value > 0.3) || false,
      interact: (p.buttons[5] && p.buttons[5].pressed) || false,
      prev: {
        jump: this._pJump || false,
        attack: this._pAtk || false,
        special: this._pSp || false,
        ult: this._pUlt || false,
      },
    };
  },

  latchPad(p) {
    if (!p) return;
    this._pJump = p.jump; this._pAtk = p.attack;
    this._pSp = p.special; this._pUlt = p.ult;
  },

  padHit(p, key) {
    return p && p[key] && !p.prev[key];
  },

  /* Touch input lives in touch.js so that all the iOS-specific
     behaviour (gesture suppression, safe areas, thumb zones) is in
     one place instead of split across two files. */

  endFrame() {
    this.pressed = Object.create(null);
    this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0;
    this.mouse.leftPressed = false; this.mouse.rightPressed = false;
  },
};

function isTouch() {
  // Detect the input capability the game needs, not an assumed phone/tablet
  // model. This covers iOS Safari, Android browsers, and touch-capable hybrids.
  return ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
}
