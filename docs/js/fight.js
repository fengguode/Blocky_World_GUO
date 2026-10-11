'use strict';
/* ============================================================
   fight.js — combat between two characters, each with its own
   fighting style and one signature ultimate move.
   ============================================================ */

const Fight = {
  players: [null, null, null],
  teams: [0, 1, 1],
  projectiles: [],
  roundTime: 0,
  roundActive: false,
  banner: null,
  winner: null,

  ultHits: [],

  reset(p1, p2, p3, coop) {
    this.players[0] = p1;
    this.players[1] = p2;
    this.players[2] = p3 || null;
    this.teams = coop ? [0, 0, 1] : [0, 1, 1];
    this.projectiles.length = 0;
    this.ultHits.length = 0;
    this.roundTime = 0;
    this.roundActive = true;
    this.winner = null;

    // Take the arena from the world the players actually belong to, rather
    // than a module-level global, so this works with more than one world.
    const world = (p1 && p1.world) || (typeof World !== 'undefined' && World.world);
    const arena = (world && world.arena) || {
      x: world ? world.originX : 8,
      y: SEA_LEVEL + 2,
      z: world ? world.originZ : 8,
      radius: 16,
    };
    const r = (arena.radius || 16) - 3;
    p1.pos = [arena.x - r * 0.5, arena.y, arena.z];
    p1.vel = [0, 0, 0];
    p1.yaw = Math.PI / 2;
    p1.pitch = 0;
    p1.creative = false;
    p1.flying = false;
    p1.hp = p1.maxHp;
    p1.ultMeter = 0;
    p1.ko = false;

    p2.pos = [arena.x + r * 0.5, arena.y, arena.z];
    p2.vel = [0, 0, 0];
    p2.yaw = -Math.PI / 2;
    p2.pitch = 0;
    p2.creative = false;
    p2.flying = false;
    p2.hp = p2.maxHp;
    p2.ultMeter = 0;
    p2.ko = false;

    p1.spawn = p1.pos.slice();
    p2.spawn = p2.pos.slice();
    if (p3) {
      p3.pos = [arena.x, arena.y, arena.z + r * 0.5];
      p3.vel = [0, 0, 0];
      p3.yaw = Math.PI;
      p3.pitch = 0;
      p3.creative = false;
      p3.flying = false;
      p3.hp = p3.maxHp;
      p3.ultMeter = 0;
      p3.ko = false;
      p3.spawn = p3.pos.slice();
    }
    this.banner('FIGHT!', 1.0);
  },

  banner(text, time) {
    const el = document.getElementById('banner');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  },

  areOpponents(a, b) {
    const ia = this.players.indexOf(a), ib = this.players.indexOf(b);
    return ia >= 0 && ib >= 0 && this.teams[ia] !== this.teams[ib];
  },

  nearestOpponent(p) {
    let best = null, bestDistance = Infinity;
    for (const candidate of this.players) {
      if (!candidate || candidate === p || candidate.ko || !this.areOpponents(p, candidate)) continue;
      const d = Math.hypot(candidate.pos[0] - p.pos[0], candidate.pos[2] - p.pos[2]);
      if (d < bestDistance) { best = candidate; bestDistance = d; }
    }
    return best;
  },

  /* ---------- central hit resolution ---------- */
  applyHit(attacker, victim, dmg, dir, kb, projDef) {
    const landed = victim.takeDamage(dmg, dir, kb);
    if (!landed) return false;

    attacker.addUlt(dmg * 0.85);
    attacker.bumpCombo();
    victim.addUlt(dmg * 0.45);

    if (attacker.char.healsOnHit) {
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + attacker.char.healsOnHit);
    }

    // hit spark at the victim's chest
    const hitPos = [victim.pos[0], victim.pos[1] + 1.0, victim.pos[2]];
    Particles.burst(hitPos, PROJ_DEFS.star, attacker.combo > 2 ? 16 : 9, 0.5);

    Cam.addShake(Math.min(0.55, dmg * 0.012));
    Audio.play('hit', { pitch: 0.85 + Math.random() * 0.3, gain: Math.min(1, dmg / 26) });

    if (attacker.combo >= 3 && attacker.combo % 2 === 1) {
      UI.comboPopup(attacker.combo);
    }
    if (victim.ko) {
      const remaining = this.players.filter(p => p && !p.ko && this.areOpponents(attacker, p));
      if (!remaining.length) {
        this.banner(attacker.char.name.toUpperCase() + ' WINS!', 1.8);
        this.winner = attacker;
        this.roundActive = false;
        Audio.play('win');
      }
    }
    return true;
  },

  /* ---------- melee swing ---------- */
  tryMelee(p, attackIndex, opponent) {
    // A fighter already mid-swing cannot start another. Without this guard a
    // held or rapid input replaces the current swing, resetting its timer, so
    // the attack never reaches its active window and the fighter appears to
    // flail without ever landing a hit.
    if (p.swing) return false;
    p.swing = {
      attack: attackIndex,
      t: 0,
      windup: attackIndex === 2 ? 0.30 : attackIndex === 1 ? 0.16 : 0.10,
      active: 0.12,
      recover: attackIndex === 2 ? 0.40 : 0.22,
      hit: false,
      spec: p.char.attacks[attackIndex],
    };
    p.swingTotal = p.swing.windup + p.swing.active + p.swing.recover;
    p.attacking = true;

    if (attackIndex === 2) Cam.addShake(0.18);

    // dash-in moves
    if (attackIndex === 2 && (p.char.canDash || p.char.id === 'ninja' || p.char.id === 'alex')) {
      const f = p.forwardVec([0, 0, 0]);
      p.vel[0] += f[0] * 9;
      p.vel[2] += f[2] * 9;
    }
    return true;
  },

  /* ---------- ranged shot ---------- */
  tryRanged(p, attackIndex) {
    if (p.swing) return false;
    const spec = p.char.attacks[attackIndex];
    const f = p.forwardVec([0, 0, 0]);
    this.projectiles.push(new Projectile(p, f, PROJ_DEFS[spec.projectile] || PROJ_DEFS.web, spec.dmg, spec.kb));
    p.attacking = true;
    p.swing = {
      attack: attackIndex,
      t: 0,
      windup: spec.windup,
      active: 0.05,
      recover: spec.recover,
      hit: true,
      spec,
      ranged: true,
    };
    p.swingTotal = spec.windup + 0.05 + spec.recover;
    Audio.play('shoot');
    return true;
  },

  /* ---------- the ultimate ---------- */
  useUltimate(p, opponent) {
    if (p.ultMeter < p.maxUlt) {
      UI.toast('Not charged yet — keep hitting!');
      return false;
    }
    p.ultMeter = 0;
    p.ultTimer = 1.6;
    p.ultFlash = 1;
    const dir = p.forwardVec([0, 0, 0]);
    const id = p.char.id;

    this.banner(p.char.ultName.toUpperCase() + '!', 1.2);
    Audio.play('ult');
    Cam.addShake(0.9);

    // shared burst at the caster's feet, so every ultimate feels powerful
    Particles.burst([p.pos[0], p.pos[1] + 0.6, p.pos[2]], PROJ_DEFS.star, 40, 1.1);

    switch (id) {
      case 'spider': {
        // Beacon Burst: a bright signal flare briefly roots its target.
        const pr = new Projectile(p, dir, PROJ_DEFS.star, 34, 16);
        pr.big = true;
        pr.cocoon = true;
        this.projectiles.push(pr);
        break;
      }
      case 'doll': {
        // Star Shower: stars rain all around the caster
        for (let i = 0; i < 16; i++) {
          const a = Math.random() * Math.PI * 2;
          const r = 1.5 + Math.random() * 4.5;
          const start = [p.pos[0] + Math.cos(a) * r, p.pos[1] + 11 + Math.random() * 4, p.pos[2] + Math.sin(a) * r];
          const pr = new Projectile(p, [0, -1, 0], PROJ_DEFS.star, 13, 7);
          pr.pos = start;
          pr.vel = [0, -18, 0];
          pr.life = 1.6;
          this.projectiles.push(pr);
        }
        p.hp = Math.min(p.maxHp, p.hp + 25);
        break;
      }
      case 'golem': {
        // Quake Stomp: radial shockwave
        this.shockwave(p, opponent, 44, 26);
        break;
      }
      case 'ninja': {
        // Blazing Rush: a committed dash through the opponent. The dash alone
        // used to move the ninja but never connect, because the fire trail was
        // spawned behind her, dropped straight down and missed entirely. Now
        // the dash carries scheduled hits the same way Alex's cyclone does,
        // and the trail is left along the path actually travelled.
        const toOpp = [
          opponent.pos[0] - p.pos[0], 0, opponent.pos[2] - p.pos[2],
        ];
        const flat = Math.hypot(toOpp[0], toOpp[2]);
        // Aim at the opponent when there is one in front, otherwise straight
        // ahead, so the dash always goes somewhere useful.
        const aim = (flat > 0.1) ? [toOpp[0] / flat, 0, toOpp[2] / flat] : dir;
        for (let i = 0; i < 3; i++) {
          this.ultHits.push({
            attacker: p, target: opponent,
            inFrames: 3 + i * 9,
            dmg: 14, kb: 11, reach: 4.6,
          });
          p.vel[0] = aim[0] * 24;
          p.vel[2] = aim[2] * 24;
          if (!p.flying) p.vel[1] = Math.max(p.vel[1], 6);
        }
        for (let i = 0; i < 7; i++) {
          const back = [
            p.pos[0] - aim[0] * i * 0.9,
            p.pos[1] + 0.7,
            p.pos[2] - aim[2] * i * 0.9,
          ];
          const pr = new Projectile(p, [0, -1, 0], PROJ_DEFS.star, 15, 8);
          pr.pos = back;
          pr.vel = [0, -16, 0];
          pr.life = 0.7 + i * 0.06;
          this.projectiles.push(pr);
        }
        break;
      }
      case 'alex': {
        // Triple Cyclone: dash through the opponent with a hit at each pass.
        // The three hits are scheduled a few frames apart so the
        // invulnerability from the first one cannot swallow the rest.
        for (let i = 0; i < 3; i++) {
          this.ultHits.push({
            attacker: p, target: opponent,
            inFrames: 4 + i * 12,
            dmg: 16, kb: 9,
          });
          const toOpp = [
            opponent.pos[0] - p.pos[0], 0, opponent.pos[2] - p.pos[2],
          ];
          const l = Math.hypot(toOpp[0], toOpp[2]) || 1;
          p.vel[0] = toOpp[0] / l * 20;
          p.vel[2] = toOpp[2] / l * 20;
          if (!p.flying) p.vel[1] = Math.max(p.vel[1], 5.5);
        }
        p.hp = Math.min(p.maxHp, p.hp + 18);
        break;
      }
      default: {
        // Steve: Block Bonanza — a wall of blocks flies forward
        for (let i = 0; i < 6; i++) {
          const spread = (i % 3 - 1) * 0.42;
          const up = Math.floor(i / 3) * 0.9;
          const d = [dir[0] - dir[2] * spread, dir[1] * 0.3 + up * 0.4, dir[2] + dir[0] * spread];
          const pr = new Projectile(p, d, { tile: T.cobble, size: 0.62, glow: 0, gravity: true }, 19, 13);
          pr.life = 2.2;
          this.projectiles.push(pr);
        }
        break;
      }
    }
    return true;
  },

  shockwave(p, opponent, dmg, kb) {
    const ringR = 13;
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const sp = new Projectile(p, [Math.cos(a), 0.12, Math.sin(a)], PROJ_DEFS.star, dmg, kb);
      sp.pos = [p.pos[0] + Math.cos(a) * 1.2, p.pos[1] + 0.4, p.pos[2] + Math.sin(a) * 1.2];
      sp.life = 1.1;
      sp.ring = true;
      this.projectiles.push(sp);
    }
    // direct hit if the opponent is close
    const d = Math.hypot(opponent.pos[0] - p.pos[0], opponent.pos[2] - p.pos[2]);
    if (d < ringR) {
      const dir = [opponent.pos[0] - p.pos[0], 0, opponent.pos[2] - p.pos[2]];
      const l = Math.hypot(dir[0], dir[2]) || 1;
      this.applyHit(p, opponent, dmg, [dir[0] / l, 0, dir[2] / l], kb);
    }
  },

  /* ---------- per-frame ---------- */
  update(dt, p1, p2) {
    this.roundTime += dt;

    // update any active swings
    for (const p of this.players) {
      if (!p || !p.swing) continue;
      p.swing.t += dt;
      const s = p.swing;
      const at = s.windup;
      const endActive = s.windup + s.active;

      if (s.t >= at && s.t <= endActive && !s.hit) {
        s.hit = true;
        if (!s.ranged) {
          const opp = this.nearestOpponent(p) || ((p === p1) ? p2 : p1);
          const dx = opp.pos[0] - p.pos[0];
          const dy = (opp.pos[1] + 0.9) - (p.eyeY);
          const dz = opp.pos[2] - p.pos[2];
          const dist = Math.hypot(dx, dy, dz);
          if (dist <= s.spec.reach && !opp.ko) {
            const dir = [dx, 0, dz];
            const l = Math.hypot(dir[0], dir[2]) || 1;
            dir[0] /= l; dir[2] /= l;
            this.applyHit(p, opp, s.spec.dmg, dir, s.spec.kb);
          } else {
            Audio.play('swing', { gain: 0.35 });
          }
        }
      }
      if (p.swing.t >= p.swingTotal) {
        p.swing = null;
        p.attacking = false;
      }
    }

    // scheduled ultimate hits (Alex's Triple Cyclone, the ninja's Blazing Rush)
    if (this.ultHits && this.ultHits.length) {
      for (let i = this.ultHits.length - 1; i >= 0; i--) {
        const h = this.ultHits[i];
        h.inFrames--;
        if (h.inFrames > 0) continue;
        this.ultHits.splice(i, 1);
        if (!h.attacker || !h.target || h.attacker.ko || h.target.ko) continue;
        const dx = h.target.pos[0] - h.attacker.pos[0];
        const dz = h.target.pos[2] - h.attacker.pos[2];
        const dist = Math.hypot(dx, dz);
        // Each hit may override the default reach, because a long dash needs a
        // wider window than a spin.
        if (dist < (h.reach === undefined ? 4.2 : h.reach)) {
          const l = dist || 1;
          this.applyHit(h.attacker, h.target, h.dmg, [dx / l, 0, dz / l], h.kb);
        }
      }
    }

    // Resolve the world from the players, falling back to the global. Taking
    // it from the players keeps this working with more than one world and
    // stops a missing global from throwing mid-frame.
    const world = (this.players[0] && this.players[0].world) ||
                  (this.players[1] && this.players[1].world) ||
                  (typeof World !== 'undefined' ? World.world : null);
    if (!world) return;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.update(dt, world, this.players);
      if (pr.dead) {
        // Beacon Burst holds the enemy where they stand for a moment.
        if (pr.cocoon && pr.hit) {
          pr.hit.blocked = true;
          pr.hit.blockTimer = Math.max(pr.hit.blockTimer, 2.6);
        }
        this.projectiles.splice(i, 1);
      }
    }

    Particles.update(dt, world);

    // regen a sliver of health so fights can't stall forever on low hp
    for (const p of this.players) {
      if (!p || p.ko) continue;
      if (p.hp < p.maxHp * 0.25) p.hp = Math.min(p.maxHp * 0.25, p.hp + 1.4 * dt);
    }
  },

  clear() {
    this.projectiles.length = 0;
    this.ultHits.length = 0;
    this.players[0] = null;
    this.players[1] = null;
    this.players[2] = null;
    Particles.clear();
    this.roundActive = false;
    this.winner = null;
  },
};
