'use strict';
/* ============================================================
   entity.js — player physics, blocky characters, animals,
   particles and projectiles
   ============================================================ */

const GRAVITY = 24;
const WATER_DRAG = 0.82;

/* ============================================================
   Player
   ============================================================ */
class Player {
  constructor(world, charDef, isPlayer2) {
    this.world = world;
    this.char = charDef;
    this.pos = [0, 40, 0];
    this.vel = [0, 0, 0];
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.inWater = false;
    this.headInWater = false;
    this.flying = false;
    this.creative = true;
    this.hp = charDef.hp;
    this.maxHp = charDef.hp;
    this.ultMeter = 0;
    this.maxUlt = 100;
    this.combo = 0;
    this.comboTimer = 0;
    this.hurtFlash = 0;
    this.hurtCooldown = 0;
    this.walkAnim = 0;
    this.sprint = false;
    this.sneak = false;
    this.blocked = false;        // grabbed by web cocoon
    this.blockTimer = 0;
    this.invuln = 0;
    this.ko = false;
    this.spawn = [0, 0, 0];
    this.isPlayer2 = !!isPlayer2;
    this.climbNormal = null;
    this.climbSpeed = 4.6;    // blocks per second while scaling a wall
    this.selectedSlot = 0;
    this.koTimer = 0;
  }

  get eyeY() { return this.pos[1] + 1.62; }

  respawn() {
    this.pos = [this.spawn[0], this.spawn[1], this.spawn[2]];
    this.vel = [0, 0, 0];
    this.hp = this.maxHp;
    this.ultMeter = 0;
    this.combo = 0;
    this.ko = false;
    this.invuln = 1.6;
    this.blocked = false;
  }

  /* ---------- physics ---------- */
  update(dt, moveX, moveZ, wantJump, wantSneak) {
    const w = this.world;

    // fluid + ground checks
    const feetBlock = w.getBlock(Math.floor(this.pos[0]), Math.floor(this.pos[1] + 0.2), Math.floor(this.pos[2]));
    const headBlock = w.getBlock(Math.floor(this.pos[0]), Math.floor(this.eyeY), Math.floor(this.pos[2]));
    this.inWater = isLiquid(feetBlock);
    this.headInWater = isLiquid(headBlock);

    this.sneak = !!wantSneak && this.onGround;
    this.sprint = moveX !== 0 || moveZ !== 0;

    const speed = this.char.speed * (this.sneak ? 0.4 : 1);
    const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    // forward is -Z rotated by yaw
    const fx = -sin, fz = -cos;
    const rx = cos, rz = -sin;
    let wishX = fx * moveZ + rx * moveX;
    let wishZ = fz * moveZ + rz * moveX;
    const wl = Math.hypot(wishX, wishZ);
    if (wl > 1) { wishX /= wl; wishZ /= wl; }

    if (this.blocked) {
      this.blockTimer -= dt;
      wishX = 0; wishZ = 0;
      if (this.blockTimer <= 0) this.blocked = false;
    }

    if (this.flying) {
      const fs = speed * 1.9;
      this.vel[0] = wishX * fs;
      this.vel[2] = wishZ * fs;
      let vy = 0;
      if (wantJump) vy += fs;
      if (wantSneak) vy -= fs;
      this.vel[1] = vy;
    } else {
      const accel = this.onGround ? 34 : (this.inWater ? 14 : 11);
      this.vel[0] += (wishX * speed - this.vel[0]) * Math.min(1, accel * dt);
      this.vel[2] += (wishZ * speed - this.vel[2]) * Math.min(1, accel * dt);

      if (this.inWater) {
        this.vel[1] -= GRAVITY * 0.22 * dt;
        if (wantJump) this.vel[1] = Math.min(this.vel[1] + 30 * dt, 4.2);
        this.vel[1] *= WATER_DRAG;
        this.vel[0] *= 0.92; this.vel[2] *= 0.92;
        this.onGround = false;
      } else {
        this.vel[1] -= GRAVITY * dt;
        if (wantJump && this.onGround) {
          this.vel[1] = this.char.jump;
          this.onGround = false;
        }
      }
      this.vel[1] = Math.max(this.vel[1], -58);
    }

    // wall climbing for the spider character
    this.climbNormal = null;
    if (this.char.climbsWalls && !this.flying) {
      // Probe a band of distances just ahead of the player. Probing only one
      // spot means the climb fails to trigger once you are already pressed
      // against a wall, because that single sample lands inside the block
      // behind the player instead of the wall.
      const feetY = Math.floor(this.pos[1] + 0.4);
      const probe = [0.35, 0.55, 0.8];
      if (wishX !== 0) {
        for (const d of probe) {
          const cx = Math.floor(this.pos[0] + Math.sign(wishX) * d);
          if (isSolid(w.getBlock(cx, feetY, Math.floor(this.pos[2])))) {
            this.climbNormal = [Math.sign(wishX), 0, 0];
            break;
          }
        }
      }
      if (!this.climbNormal && wishZ !== 0) {
        for (const d of probe) {
          const cz = Math.floor(this.pos[2] + Math.sign(wishZ) * d);
          if (isSolid(w.getBlock(Math.floor(this.pos[0]), feetY, cz))) {
            this.climbNormal = [0, 0, Math.sign(wishZ)];
            break;
          }
        }
      }
      if (this.climbNormal) {
        // Hug the wall and drive upwards at a steady pace. The vertical
        // speed is set outright rather than nudged, so gravity cannot fight
        // it and stall the climb halfway up.
        this.vel[0] = wishX * speed * 0.55;
        this.vel[2] = wishZ * speed * 0.55;
        this.vel[1] = this.climbSpeed;
      }
    }

    // integrate + collide, axis by axis
    this.moveAxis(0, this.vel[0] * dt, w);
    this.moveAxis(1, this.vel[1] * dt, w);
    this.moveAxis(2, this.vel[2] * dt, w);

    if (this.onGround && !this.flying) this.walkAnim += Math.hypot(this.vel[0], this.vel[2]) * dt * 3.2;
    else this.walkAnim += dt * 1.4;

    if (this.pos[1] < -8) this.respawn();

    // timers
    if (this.hurtCooldown > 0) this.hurtCooldown -= dt;
    if (this.invuln > 0) this.invuln -= dt;
    if (this.hurtFlash > 0) this.hurtFlash -= dt * 2.4;
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 0;
    }
    if (this.ko) {
      this.koTimer -= dt;
      if (this.koTimer <= 0) this.respawn();
    }
  }

  // Sweep one axis and push out of any blocks we end up inside.
  moveAxis(axis, amount, world) {
    if (amount === 0) return;
    const p = this.pos;
    p[axis] += amount;

    const half = 0.32;
    const minX = Math.floor(p[0] - half), maxX = Math.floor(p[0] + half);
    const minY = Math.floor(p[1]), maxY = Math.floor(p[1] + 1.78);
    const minZ = Math.floor(p[2] - half), maxZ = Math.floor(p[2] + half);

    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          const id = world.getBlock(x, y, z);
          if (id === 0 || isLiquid(id)) continue;
          if (!isSolid(id)) continue;
          // resolve on the axis we moved
          if (axis === 0) {
            if (amount > 0) p[0] = x - half - 0.001; else p[0] = x + 1 + half + 0.001;
            this.vel[0] = 0;
          } else if (axis === 1) {
            if (amount > 0) { p[1] = y - 1.78 - 0.001; this.vel[1] = 0; }
            else { p[1] = y + 1 + 0.001; this.vel[1] = 0; this.onGround = true; }
          } else {
            if (amount > 0) p[2] = z - half - 0.001; else p[2] = z + 1 + half + 0.001;
            this.vel[2] = 0;
          }
        }
      }
    }
    if (axis === 1 && amount < 0) this.onGround = true;
    if (axis === 1 && amount !== 0 && Math.abs(this.vel[1]) < 0.01) this.onGround = amount < 0;
  }

  forwardVec(out) {
    const cp = Math.cos(this.pitch);
    out[0] = -Math.sin(this.yaw) * cp;
    out[1] = Math.sin(this.pitch);
    out[2] = -Math.cos(this.yaw) * cp;
    return out;
  }

  takeDamage(amount, fromDir, kb) {
    if (this.invuln > 0 || this.ko) return false;
    this.hp = Math.max(0, this.hp - amount);
    this.hurtFlash = 1;
    this.hurtCooldown = 0.28;
    this.invuln = 0.42;
    this.combo = 0;
    const resist = this.char.knockbackResist || 0;
    if (fromDir) {
      const k = (kb === undefined ? 6 : kb) * (1 - resist);
      this.vel[0] += fromDir[0] * k;
      this.vel[2] += fromDir[2] * k;
      if (!this.flying) this.vel[1] = Math.max(this.vel[1], k * 0.32);
    }
    if (this.hp <= 0) { this.ko = true; this.koTimer = 2.4; }
    return true;
  }

  addUlt(v) {
    if (this.ultMeter >= this.maxUlt) return;
    this.ultMeter = Math.min(this.maxUlt, this.ultMeter + v);
  }

  spendUlt(v) {
    if (this.ultMeter < v) return false;
    this.ultMeter -= v;
    return true;
  }

  bumpCombo() {
    this.combo++;
    this.comboTimer = 2.0;
  }
}

/* ============================================================
   Animal — simple wandering friend
   ============================================================ */
class Animal {
  constructor(def, x, y, z) {
    this.def = def;
    this.pos = [x, y, z];
    this.vel = [0, 0, 0];
    this.yaw = Math.random() * Math.PI * 2;
    this.walkAnim = Math.random() * 6;
    this.think = 1 + Math.random() * 3;
    this.onGround = false;
    this.jumpCool = 0;
    this.scale = 0.85 + Math.random() * 0.3;
  }

  update(dt, world) {
    this.think -= dt;
    if (this.jumpCool > 0) this.jumpCool -= dt;
    if (this.think <= 0) {
      this.think = 1.2 + Math.random() * 3.4;
      this.yaw = Math.random() * Math.PI * 2;
    }

    const speed = this.def.speed * (0.4 + Math.random() * 0.3);
    this.vel[0] = Math.sin(this.yaw) * speed;
    this.vel[2] = Math.cos(this.yaw) * speed;
    this.vel[1] -= GRAVITY * dt;

    const p = [this.pos[0] + this.vel[0] * dt, this.pos[1] + this.vel[1] * dt, this.pos[2] + this.vel[2] * dt];

    // ground
    const below = world.getBlock(Math.floor(p[0]), Math.floor(p[1] - 0.2), Math.floor(p[2]));
    if (isSolid(below)) {
      if (this.vel[1] < 0) { p[1] = Math.floor(p[1] - 0.2) + 1 + 0.2; this.vel[1] = 0; this.onGround = true; }
      else this.onGround = false;
    } else this.onGround = false;

    // walls
    const hx = Math.floor(p[0]), hz = Math.floor(p[2]);
    const bodyY = Math.floor(p[1] + 0.4);
    if (isSolid(world.getBlock(hx, bodyY, hz))) {
      this.yaw += Math.PI * (0.5 + Math.random() * 0.5);
      p[0] = this.pos[0]; p[2] = this.pos[2];
      this.vel[0] = 0; this.vel[2] = 0;
    }

    // step up 1 block so they can climb terrain
    if (this.onGround) {
      const aheadX = Math.floor(p[0] + Math.sin(this.yaw) * 0.6);
      const aheadZ = Math.floor(p[2] + Math.cos(this.yaw) * 0.6);
      const stepUp = isSolid(world.getBlock(aheadX, bodyY, aheadZ)) &&
                     !isSolid(world.getBlock(aheadX, bodyY + 1, aheadZ));
      if (stepUp) p[1] += 0.06;
    }

    // don't walk off tall ledges
    if (this.onGround) {
      const aheadX = Math.floor(p[0] + Math.sin(this.yaw) * 0.7);
      const aheadZ = Math.floor(p[2] + Math.cos(this.yaw) * 0.7);
      const dropY = Math.floor(p[1] - 0.2);
      let ground = false;
      for (let d = 0; d < 4; d++) {
        if (isSolid(world.getBlock(aheadX, dropY - d, aheadZ))) { ground = true; break; }
      }
      if (!ground && this.jumpCool <= 0) {
        this.vel[1] = 7.5;
        this.jumpCool = 0.6;
      }
    }

    this.pos = p;
    this.walkAnim += Math.hypot(this.vel[0], this.vel[2]) * dt * 5;
    if (this.pos[1] < -6) this.pos[1] = 60;
  }
}

/* ============================================================
   Projectile (web, star, shuriken)
   ============================================================ */
class Projectile {
  constructor(owner, dir, def, dmg, kb) {
    this.owner = owner;
    this.pos = [owner.pos[0], owner.eyeY, owner.pos[2]];
    this.vel = [
      dir[0] * 30 + owner.vel[0],
      dir[1] * 30,
      dir[2] * 30 + owner.vel[2],
    ];
    this.def = def;
    this.dmg = dmg;
    this.kb = kb;
    this.life = 3.2;
    this.dead = false;
    this.hit = null;      // the fighter this shot connected with, if any
    this.spin = Math.random() * 6;
  }

  update(dt, world, players) {
    this.life -= dt;
    this.spin += dt * 18;
    if (this.life <= 0) { this.dead = true; return; }

    const steps = 3;
    const sdt = dt / steps;
    for (let s = 0; s < steps && !this.dead; s++) {
      this.pos[0] += this.vel[0] * sdt;
      this.pos[1] += this.vel[1] * sdt;
      this.pos[2] += this.vel[2] * sdt;
      this.vel[1] -= 7 * sdt;

      const id = world.getBlock(Math.floor(this.pos[0]), Math.floor(this.pos[1]), Math.floor(this.pos[2]));
      if (isSolid(id)) {
        this.dead = true;
        Particles.burst(this.pos, this.def, 8, 0.5);
        return;
      }
      for (const p of players) {
        if (p === this.owner || p.ko) continue;
        const dx = p.pos[0] - this.pos[0];
        const dy = (p.pos[1] + 0.9) - this.pos[1];
        const dz = p.pos[2] - this.pos[2];
        if (dx * dx + dy * dy + dz * dz < 0.9) {
          const dir = [this.vel[0], 0, this.vel[2]];
          const dl = Math.hypot(dir[0], dir[2]) || 1;
          dir[0] /= dl; dir[2] /= dl;
          this.hit = p;
          Fight.applyHit(this.owner, p, this.dmg, dir, this.kb, this.def);
          this.dead = true;
          return;
        }
      }
    }
  }
}

/* ============================================================
   Particles
   ============================================================ */
const Particles = {
  list: [],

  burst(pos, def, count, spread) {
    count = count || 10;
    spread = spread || 0.6;
    for (let i = 0; i < count; i++) {
      this.list.push({
        pos: [
          pos[0] + (Math.random() - 0.5) * spread,
          pos[1] + (Math.random() - 0.5) * spread,
          pos[2] + (Math.random() - 0.5) * spread,
        ],
        vel: [
          (Math.random() - 0.5) * 6,
          Math.random() * 6 + 1.5,
          (Math.random() - 0.5) * 6,
        ],
        life: 0.4 + Math.random() * 0.5,
        maxLife: 0.9,
        size: 0.08 + Math.random() * 0.1,
        def: def,
        spin: Math.random() * 6,
        gravity: def && def.gravity !== false,
      });
    }
    if (this.list.length > 900) this.list.splice(0, this.list.length - 900);
  },

  update(dt, world) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life -= dt;
      if (p.life <= 0) { this.list.splice(i, 1); continue; }
      if (p.gravity) p.vel[1] -= 16 * dt;
      const nx = p.pos[0] + p.vel[0] * dt;
      const ny = p.pos[1] + p.vel[1] * dt;
      const nz = p.pos[2] + p.vel[2] * dt;
      if (isSolid(world.getBlock(Math.floor(nx), Math.floor(ny), Math.floor(nz)))) {
        p.vel[0] *= -0.3; p.vel[2] *= -0.3; p.vel[1] *= -0.25;
      } else {
        p.pos[0] = nx; p.pos[1] = ny; p.pos[2] = nz;
      }
      p.spin += dt * 8;
    }
  },

  clear() { this.list.length = 0; },
};

/* Projectile visual definitions, indexed into the texture array */
const PROJ_DEFS = {
  web:      { tile: T.glass,    size: 0.28, glow: 0, gravity: false },
  star:     { tile: T.glowstone,size: 0.3,  glow: 1, gravity: false },
  shuriken: { tile: T.steel,    size: 0.26, glow: 0, gravity: true },
};