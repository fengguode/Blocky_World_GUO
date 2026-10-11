'use strict';
/* ============================================================
   chars.js — playable characters
   Original designs for a cheerful, imaginative voxel adventure
   (blocky Minecraft builders, a wall-crawling hero, a sparkly doll,
   a heavy stone golem, a parkour ranger, a fire ninja).
   ============================================================ */

const CHARACTERS = [
  {
    id: 'steve',
    name: 'Steve',
    style: 'Balanced Builder',
    color: '#4a90d9',
    desc: 'The classic blocky builder. Strong, steady, good at everything. Great for learning the ropes.',
    skin: T.skin, hair: T.hair_brown, shirt: T.builder_shirt, accent: T.shirt_cyan, pants: T.pants, shoe: T.shoe,
    hp: 100, speed: 4.6, jump: 8.2, damage: 12, reach: 3.4,
    ultName: 'Block Bonanza',
    ultDesc: 'Throws a spinning wall of blocks that knock the enemy back.',
    stats: { power: 0.55, speed: 0.55, range: 0.5 },
    attacks: [
      { name: 'Punch',   type: 'melee', dmg: 12, windup: 0.14, active: 0.12, recover: 0.26, reach: 3.4, kb: 5 },
      { name: 'Kick',    type: 'melee', dmg: 16, windup: 0.20, active: 0.12, recover: 0.34, reach: 3.6, kb: 8 },
      { name: 'Slam',    type: 'melee', dmg: 24, windup: 0.34, active: 0.14, recover: 0.46, reach: 3.8, kb: 14 },
    ],
  },
  {
    id: 'alex',
    name: 'Alex',
    style: 'Parkour Ranger',
    color: '#4ec3b0',
    desc: 'Quick and nimble. Runs fast, jumps higher, and whips out a triple combo.',
    skin: T.skin, hair: T.hair_gold, shirt: T.ranger_shirt, accent: T.shirt_blue, pants: T.pants_dark, shoe: T.shoe,
    hp: 90, speed: 5.6, jump: 9.4, damage: 10, reach: 3.2,
    ultName: 'Triple Cyclone',
    ultDesc: 'Spins through the air kicking three times, then dashes away.',
    stats: { power: 0.45, speed: 0.8, range: 0.45 },
    attacks: [
      { name: 'Jab',      type: 'melee', dmg: 9,  windup: 0.09, active: 0.10, recover: 0.16, reach: 3.2, kb: 4 },
      { name: 'Roundhouse',type: 'melee', dmg: 13, windup: 0.13, active: 0.11, recover: 0.24, reach: 3.4, kb: 7 },
      { name: 'Flip Kick', type: 'melee', dmg: 18, windup: 0.22, active: 0.14, recover: 0.32, reach: 3.6, kb: 11, air: true },
    ],
  },
  {
    id: 'spider',
    name: 'Web Hero',
    style: 'Wall-Crawling Hero',
    color: '#e63946',
    desc: 'A red and blue wall crawler. Can zip up walls and hit from far away with web shots.',
    skin: T.skin, hair: T.hero_red, shirt: T.climber_shirt, accent: T.hero_red, pants: T.hero_blue, shoe: T.hero_red,
    hp: 95, speed: 5.2, jump: 9.0, damage: 11, reach: 3.6, climbsWalls: true,
    ultName: 'Web Cocoon',
    ultDesc: 'Fires a huge web ball that sticks the enemy in place, then pulls them in.',
    stats: { power: 0.55, speed: 0.7, range: 0.85 },
    attacks: [
      { name: 'Web Shot', type: 'ranged', dmg: 10, windup: 0.14, active: 0.05, recover: 0.26, reach: 22, kb: 3, projectile: 'web' },
      { name: 'Punch',     type: 'melee',  dmg: 12, windup: 0.11, active: 0.11, recover: 0.22, reach: 3.5, kb: 5 },
      { name: 'Spider Kick', type: 'melee', dmg: 20, windup: 0.26, active: 0.13, recover: 0.36, reach: 3.8, kb: 10 },
    ],
  },
  {
    // An original doll character: bright, sparkly, and unmistakably a doll —
    // big eyes, tufted hair, a dress rather than armour.
    id: 'doll',
    name: 'Dolly',
    style: 'Sparkle Power',
    color: '#ff7ad9',
    desc: 'A cheerful doll in a pink dress. She throws glittery stars and heals herself every time she lands a hit.',
    skin: T.skin_doll, hair: T.hair_pink, shirt: T.dolly_dress, accent: T.glowstone, pants: T.dolly_leggings, shoe: T.hero_red,
    hp: 85, speed: 5.0, jump: 8.6, damage: 10, reach: 3.2, healsOnHit: 6,
    dollFace: true,
    ultName: 'Star Shower',
    ultDesc: 'Calls down a burst of stars that rain all around her.',
    stats: { power: 0.5, speed: 0.65, range: 0.6 },
    attacks: [
      { name: 'Star Toss', type: 'ranged', dmg: 11, windup: 0.15, active: 0.05, recover: 0.25, reach: 18, kb: 4, projectile: 'star' },
      { name: 'Pinch',      type: 'melee',  dmg: 9,  windup: 0.10, active: 0.10, recover: 0.18, reach: 3.2, kb: 4 },
      { name: 'Heartbreak',type: 'melee',  dmg: 17, windup: 0.22, active: 0.12, recover: 0.34, reach: 3.4, kb: 8 },
    ],
  },
  {
    id: 'golem',
    name: 'Stone Golem',
    style: 'Heavy Hitter',
    color: '#9aa0a6',
    desc: 'Big, slow and incredibly strong. Every hit sends the enemy flying.',
    skin: T.cobble, hair: T.stone, shirt: T.cobble, accent: T.glowstone, pants: T.stone, shoe: T.stone,
    hp: 140, speed: 3.4, jump: 7.0, damage: 18, reach: 4.0, knockbackResist: 0.85,
    ultName: 'Quake Stomp',
    ultDesc: 'Slams the ground, sending a shockwave that flattens everything.',
    stats: { power: 0.95, speed: 0.25, range: 0.4 },
    attacks: [
      { name: 'Backhand', type: 'melee', dmg: 20, windup: 0.22, active: 0.13, recover: 0.38, reach: 4.0, kb: 12 },
      { name: 'Headbutt', type: 'melee', dmg: 28, windup: 0.36, active: 0.14, recover: 0.52, reach: 4.2, kb: 18 },
      { name: 'Earthshaker', type: 'melee', dmg: 36, windup: 0.5, active: 0.16, recover: 0.6, reach: 4.6, kb: 24 },
    ],
  },
  {
    id: 'ninja',
    name: 'Fire Ninja',
    style: 'Blazing Speed',
    color: '#ff7a18',
    desc: 'A fast fire ninja who dashes and throws flame shurikens.',
    skin: T.skin, hair: T.hero_red, shirt: T.fire_ninja, accent: T.glowstone, pants: T.pants_dark, shoe: T.shoe,
    hp: 88, speed: 6.0, jump: 9.8, damage: 11, reach: 3.3, canDash: true,
    ultName: 'Blazing Rush',
    ultDesc: 'Dash forward leaving a trail of fire that burns the enemy.',
    stats: { power: 0.55, speed: 0.9, range: 0.5 },
    attacks: [
      { name: 'Shuriken', type: 'ranged', dmg: 9,  windup: 0.10, active: 0.04, recover: 0.18, reach: 20, kb: 3, projectile: 'shuriken' },
      { name: 'Slash',    type: 'melee',  dmg: 12, windup: 0.10, active: 0.10, recover: 0.20, reach: 3.3, kb: 6 },
      { name: 'Fire Dash',type: 'melee',  dmg: 19, windup: 0.20, active: 0.16, recover: 0.30, reach: 4.4, kb: 9, dash: true },
    ],
  },
];

function characterById(id) {
  return CHARACTERS.find(c => c.id === id) || CHARACTERS[0];
}

/* ---------- friendly animals ---------- */
const ANIMALS = [
  { id: 'pig',    name: 'Pig',    body: T.pig_skin, face: T.pig_skin, accent: T.pig_snout, leg: T.pig_skin, w: 1.08, h: 0.94, d: 1.42, speed: 1.1, tame: 'Oink!' },
  { id: 'sheep',  name: 'Sheep', body: T.wool, face: T.sheep_face, accent: T.skin, leg: T.skin, w: 1.16, h: 1.1, d: 1.36, speed: 1.0, tame: 'Baa!' },
  { id: 'chick',  name: 'Chick', body: T.chick, face: T.chick, accent: T.chick_wing, beak: T.beak, leg: T.beak, w: 0.7, h: 0.76, d: 0.72, speed: 1.4, tame: 'Peep!' },
  { id: 'wolf',   name: 'Wolf', body: T.wolf, face: T.wolf_face, accent: T.wolf_dark, leg: T.wolf_dark, w: 1.0, h: 1.0, d: 1.5, speed: 2.5, predator: true, tame: 'A wolf pack!' },
];

function animalById(id) {
  return ANIMALS.find(a => a.id === id) || ANIMALS[0];
}
