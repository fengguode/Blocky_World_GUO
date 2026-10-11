'use strict';
/* ============================================================
   camera.js — first person, follow, free-fly observation modes
   ============================================================ */

const Cam = {
  pos: [0, 40, 0],
  yaw: 0,          // radians, 0 looks toward -Z
  pitch: 0,
  fov: 70 * Math.PI / 180,
  view: M4.create(),
  proj: M4.create(),
  viewProj: M4.create(),
  shake: 0,
  shakeDecay: 4,

  // Third person: the camera trails behind the character instead of sitting
  // in their eyes, so you can actually see who you are playing. Fighting is
  // much easier to read this way, so it is the default.
  thirdPerson: true,
  thirdPersonDist: 7.5,
  thirdPersonHeight: 1.7,
  // Smoothly interpolate the orbit so switching views does not snap.
  orbit: 0,

  look(dx, dy, sens) {
    this.yaw -= dx * (sens || Input.sensitivity);
    this.pitch -= dy * (sens || Input.sensitivity);
    const lim = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  },

  forward(out) {
    const cp = Math.cos(this.pitch);
    out[0] = -Math.sin(this.yaw) * cp;
    out[1] = Math.sin(this.pitch);
    out[2] = -Math.cos(this.yaw) * cp;
    return out;
  },

  rightVec(out) {
    out[0] = Math.cos(this.yaw);
    out[1] = 0;
    out[2] = -Math.sin(this.yaw);
    return out;
  },

  addShake(amount) {
    this.shake = Math.min(1.2, this.shake + amount);
  },

  update(dt, aspect, eyeOverride, targetOverride, dist) {
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * this.shakeDecay);
      const s = this.shake * this.shake * 0.35;
      this.pos[0] += (Math.random() - 0.5) * s;
      this.pos[1] += (Math.random() - 0.5) * s;
      this.pos[2] += (Math.random() - 0.5) * s;
    }

    const fwd = [0, 0, 0];
    this.forward(fwd);
    let ex, ey, ez, cx, cy, cz;

    if (targetOverride) {
      // Third person: sit behind and slightly above the character, looking
      // at their chest. The distance eases in so toggling does not snap.
      const t = targetOverride;
      const want = dist === undefined ? this.thirdPersonDist : dist;
      this.orbit += (want - this.orbit) * Math.min(1, dt * 7);
      const d = Math.max(0.6, this.orbit);

      const head = t.pos[1] + this.thirdPersonHeight;
      const wantX = t.pos[0] - fwd[0] * d;
      const wantY = head - fwd[1] * d + 0.5;
      const wantZ = t.pos[2] - fwd[2] * d;

      ex = wantX; ey = wantY; ez = wantZ;
      cx = t.pos[0];
      cy = head;
      cz = t.pos[2];

      // Pull the camera in if terrain would clip it, rather than letting the
      // player end up inside a hillside.
      let guard = 0;
      while (this.insideSolid(ex, ey, ez) && guard++ < 30) {
        ex += (cx - ex) * 0.2;
        ey += (cy - ey) * 0.2;
        ez += (cz - ez) * 0.2;
      }
      if (ey < 0.4) ey = 0.4;

      // Publish the resolved eye position. Everything downstream — fog, the
      // chunk streamer and the frustum culler — reads Cam.pos, so leaving this
      // stale made the camera look like it was sitting on the player while the
      // view matrix was actually correct.
      this.pos[0] = ex;
      this.pos[1] = ey;
      this.pos[2] = ez;
    } else {
      const e = eyeOverride || this.pos;
      ex = e[0]; ey = e[1]; ez = e[2];
      cx = ex + fwd[0]; cy = ey + fwd[1]; cz = ez + fwd[2];
      this.pos[0] = ex;
      this.pos[1] = ey;
      this.pos[2] = ez;
    }

    M4.lookAt(this.view, [ex, ey, ez], [cx, cy, cz], [0, 1, 0]);
    M4.perspective(this.proj, this.fov, aspect, 0.08, 900);
    M4.multiply(this.viewProj, this.proj, this.view);
  },

  insideSolid(x, y, z) {
    if (typeof World === 'undefined' || !World.world) return false;
    return isSolid(World.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)));
  },
};

/* ============================================================
   Observation mode — inspect the world from every angle
   ============================================================ */
const OBSERVE_VIEWS = [
  { id: 'free',   name: 'Free Cam',  hint: 'WASD fly · Space up · Shift down · Q/E turn' },
  { id: 'orbit',  name: 'Orbit',     hint: 'Circles your build · drag to orbit · wheel zooms' },
  { id: 'high',   name: 'Top View',  hint: 'Straight down, like a map of what you built' },
  { id: 'front',  name: 'Front View',hint: 'Looking at your build from the front' },
  { id: 'cinema', name: 'Cinematic', hint: 'Slow auto-orbit, great for photos' },
  { id: 'close',  name: 'Close Up',  hint: 'Right in on your build' },
];

const Observer = {
  index: 0,
  pos: [8, 44, 8],
  target: [8, SEA_LEVEL, 8],
  orbitAngle: 0,
  orbitRadius: 16,
  orbitHeight: 10,
  zoom: 1,
  following: null,

  view() { return OBSERVE_VIEWS[this.index]; },

  cycle(dir) {
    this.index = (this.index + (dir || 1) + OBSERVE_VIEWS.length) % OBSERVE_VIEWS.length;
    return this.view();
  },

  snapTo(p, target) {
    this.pos = [p[0], p[1], p[2]];
    if (target) this.target = [target[0], target[1], target[2]];
  },

  update(dt, aspect) {
    const fwd = [0, 0, 0], right = [0, 0, 0];
    Cam.forward(fwd);
    Cam.rightVec(right);
    const sp = Input.down('ShiftLeft') || Input.down('ShiftRight') ? 42 : 16;
    let mx = 0, my = 0, mz = 0;

    if (Input.down('KeyW')) mz += 1;
    if (Input.down('KeyS')) mz -= 1;
    if (Input.down('KeyD')) mx += 1;
    if (Input.down('KeyA')) mx -= 1;
    if (Input.down('Space')) my += 1;
    if (Input.down('ControlLeft') || Input.down('KeyC')) my -= 1;

    // the thumbstick feeds the same axes in free-cam mode
    if (Touch.enabled) {
      mx += Touch.move.x;
      mz += -Touch.move.y;
    }

    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }

    this.pos[0] += (fwd[0] * mz + right[0] * mx) * sp * dt;
    this.pos[1] += (fwd[1] * mz + right[1] * mx) * sp * dt + my * sp * dt;
    this.pos[2] += (fwd[2] * mz + right[2] * mx) * sp * dt;

    // keep inside the playable square
    const max = WORLD_SIZE - 0.001;
    this.pos[0] = Math.max(0, Math.min(max, this.pos[0]));
    this.pos[2] = Math.max(0, Math.min(max, this.pos[2]));
    this.pos[1] = Math.max(1, Math.min(WORLD_H + 20, this.pos[1]));

    if (Input.mouse.wheel) {
      this.orbitRadius = Math.max(3, Math.min(70, this.orbitRadius - Input.mouse.wheel * 3));
    }
    if (Input.down('KeyR')) this.orbitRadius = Math.max(3, this.orbitRadius - dt * 22);
    if (Input.down('KeyF')) this.orbitRadius = Math.min(70, this.orbitRadius + dt * 22);

    // look with mouse / touch
    let ldx = Input.mouse.dx, ldy = Input.mouse.dy;
    if (Touch.enabled) { const l = Touch.consumeLook(); ldx += l.x * 0.6; ldy += l.y * 0.6; }
    const pad = Input.readPad();
    if (pad) { ldx += pad.lookX * 900; ldy += pad.lookY * 700; }
    if (ldx || ldy) Cam.look(ldx, ldy);

    const v = this.view();
    let eye = this.pos, target = null;

    switch (v.id) {
      case 'orbit':
      case 'cinema': {
        if (v.id === 'cinema') {
          this.orbitAngle += dt * 0.22;
          // slow breathing height drift for a nicer shot
          this.orbitHeight = 9 + Math.sin(performance.now() * 0.0004) * 3;
        }
        if (ldx) this.orbitAngle += ldx * 0.006;
        if (ldy) this.orbitHeight = Math.max(2, Math.min(50, this.orbitHeight - ldy * 0.03));
        const r = this.orbitRadius;
        eye = [
          this.target[0] + Math.sin(this.orbitAngle) * r,
          this.target[1] + this.orbitHeight,
          this.target[2] + Math.cos(this.orbitAngle) * r,
        ];
        target = this.target;
        // face the orbit point
        const dx = this.target[0] - eye[0], dy = this.target[1] - eye[1], dz = this.target[2] - eye[2];
        Cam.yaw = Math.atan2(-dx, -dz);
        Cam.pitch = Math.atan2(dy, Math.hypot(dx, dz));
        break;
      }
      case 'high': {
        eye = [this.target[0], this.target[1] + Math.max(12, this.orbitRadius * 0.9), this.target[2] + 0.001];
        target = this.target;
        Cam.pitch = -Math.PI / 2 + 0.02;
        Cam.yaw = 0;
        break;
      }
      case 'front': {
        const d = Math.max(8, this.orbitRadius);
        eye = [this.target[0], this.target[1] + this.orbitHeight * 0.4, this.target[2] + d];
        target = this.target;
        const dx = this.target[0] - eye[0], dy = this.target[1] - eye[1], dz = this.target[2] - eye[2];
        Cam.yaw = Math.atan2(-dx, -dz);
        Cam.pitch = Math.atan2(dy, Math.hypot(dx, dz));
        break;
      }
      case 'close': {
        const r = Math.min(this.orbitRadius, 6);
        eye = [
          this.target[0] + Math.sin(this.orbitAngle) * r,
          this.target[1] + this.orbitHeight * 0.35,
          this.target[2] + Math.cos(this.orbitAngle) * r,
        ];
        target = this.target;
        const dx = this.target[0] - eye[0], dy = this.target[1] - eye[1], dz = this.target[2] - eye[2];
        Cam.yaw = Math.atan2(-dx, -dz);
        Cam.pitch = Math.atan2(dy, Math.hypot(dx, dz));
        break;
      }
      default: {
        // free cam uses Cam.pos directly
        Cam.pos[0] = this.pos[0];
        Cam.pos[1] = this.pos[1];
        Cam.pos[2] = this.pos[2];
        break;
      }
    }

    if (v.id !== 'free') Cam.update(dt, aspect, null, { pos: target }, 0);
    else Cam.update(dt, aspect, eye);
  },
};
