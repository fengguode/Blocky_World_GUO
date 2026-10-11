'use strict';
/* ============================================================
   bot.js — computer opponent for the fight arena

   Needed on iPhone/iPad where a second player has no controller
   and no room for a second thumbstick. The bot reads the same
   input shape a human produces, so Fight and Player don't know
   the difference.
   ============================================================ */

class Bot {
  constructor(player, level) {
    this.p = player;
    this.level = Number.isInteger(level) && level >= 0 && level <= 2 ? level : 1;
                                      // 0 = easy, 1 = normal, 2 = hard
    this.state = 'approach';
    this.think = 0;
    this.attackCool = 0;
    this.jumpCool = 0;
    this.ultCool = 0;
    this.strafe = 1;
    this.strafeTimer = 0;
    this.reaction = 0.28;
    this.mistakeRate = [0.42, 0.20, 0.09][this.level] || 0.2;
  }

  // Returns the same fields gatherInput/gatherInput2 produce.
  think_opponent(opponent, dt, out) {
    const p = this.p;
    const o = opponent;
    out = out || { mx: 0, mz: 0, jump: false, attack: false, special: false, ult: false };
    out.mx = 0; out.mz = 0;
    out.jump = false; out.attack = false; out.special = false; out.ult = false;

    if (p.ko) return out;

    this.think -= dt;
    this.attackCool -= dt;
    this.jumpCool -= dt;
    this.ultCool -= dt;
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = 0.7 + Math.random() * 1.1;
      this.strafe = Math.random() < 0.5 ? -1 : 1;
    }

    const dx = o.pos[0] - p.pos[0];
    const dz = o.pos[2] - p.pos[2];
    const dist = Math.hypot(dx, dz);
    const dy = o.pos[1] - p.pos[1];

    // face the opponent
    const wantYaw = Math.atan2(-dx, -dz);
    let diff = wantYaw - p.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const turnRate = 4.2 + this.level * 1.6;
    p.yaw += Math.max(-turnRate * dt, Math.min(turnRate * dt, diff));

    // aim slightly up when the opponent is higher
    if (Math.abs(dy) > 0.6 && dist < 6) {
      p.pitch = Math.max(-0.6, Math.min(0.6, dy * 0.5));
    } else {
      p.pitch *= 0.9;
    }

    const hasRanged = p.char.attacks.some(a => a.type === 'ranged');
    const ideal = hasRanged ? 7.5 : 2.6;
    const aggressive = this.level >= 1;

    // --- movement ---
    if (dist > ideal + 1.6) {
      out.mz = 1;                       // walk in
      out.mx = this.strafe * 0.35;       // slight weave, less perfect
    } else if (dist < ideal - 1.2) {
      out.mz = -1;                      // back off
      out.mx = this.strafe * 0.6;
    } else {
      // in range: circle, and back off sometimes so it's not a slugfest
      out.mx = this.strafe;
      out.mz = aggressive && Math.random() < 0.5 ? 1 : -0.3;
    }

    // stay inside the arena so the bot does not walk off the edge
    const arena = p.world && p.world.arena;
    if (arena) {
      const ex = p.pos[0] - arena.x, ez = p.pos[2] - arena.z;
      const edge = Math.hypot(ex, ez);
      if (edge > arena.radius - 3) {
        out.mx = -ex / edge;
        out.mz = -ez / edge;
      }
    }

    // jump to reach a higher opponent or to look dramatic
    if (this.jumpCool <= 0) {
      if (dy > 1.2 && dist < 5) { out.jump = true; this.jumpCool = 1.1; }
      else if (Math.random() < 0.012) { out.jump = true; this.jumpCool = 2.2; }
    }

    // --- attacks ---
    const wantsHit = dist <= p.char.reach + 0.4 || (hasRanged && dist < p.char.attacks.find(a => a.type === 'ranged').reach);
    if (this.think <= 0) {
      this.think = this.reaction + Math.random() * 0.2;
      const mistake = Math.random() < this.mistakeRate;
      if (wantsHit && !mistake && this.attackCool <= 0) {
        if (hasRanged && dist > 4) {
          out.special = true;
          this.attackCool = 1.5 + Math.random();
        } else {
          out.attack = true;
          this.attackCool = (aggressive ? 0.55 : 0.85) + Math.random() * 0.7;
        }
      }
    }

    // --- ultimate ---
    if (p.ultMeter >= p.maxUlt && this.ultCool <= 0) {
      const wantIt = dist < 16;
      if (wantIt) {
        out.ult = true;
        this.ultCool = 4;
      }
    }

    return out;
  }
}
