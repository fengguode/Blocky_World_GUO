'use strict';
(function () {
  const fixture = {"seed":1337,"randomSeed":35590967,"worldType":"normal","player":[100008,30,100008],"camera":{"viewIndex":0,"position":[100042,59,100042],"target":[100008,29,100008],"yaw":0.7853981633974483,"pitch":-0.54}};
  let state = fixture.randomSeed | 0;
  Math.random = function () {
    state = (state + 0x6D2B79F5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  BWStorage.setItem('blocky-world-selected-type', fixture.worldType);
  BWStorage.setItem('blocky-world-local-save-v1', JSON.stringify({
    worldType: fixture.worldType, seed: fixture.seed, worldSize: 200000, player1: fixture.player,
    slot: 0, pick: { p1: 'steve', p2: 'golem', p2bot: true, botLevel: 1 },
    settings: { sensitivity: 0.0024, renderDist: 5, dayNight: true, sfx: false, renderDistAuto: false },
    inventory: { apple: 0, meat: 0 }, edits: [],
  }));
  const qa = window.BW_QA = { fixture: fixture, ready: false, applySetup: applySetup };
  function applySetup() {
    if (typeof Game === 'undefined' || !Game.world || Game.state !== 'menu') return false;
    if (!Game.players[0]) return false;
    Game.players[0].pos = fixture.player.slice();
    Game.startObserve();
    Game.update = function () {};
    Game.dayPhase = 0.25;
    Game.showDebug = false;
    Observer.index = fixture.camera.viewIndex;
    Observer.target = fixture.camera.target.slice();
    Observer.pos = fixture.camera.position.slice();
    Cam.yaw = fixture.camera.yaw;
    Cam.pitch = fixture.camera.pitch;
    Cam.pos = fixture.camera.position.slice();
    Cam.update(0, Game.aspect(), Cam.pos);
    Game.time = 0;
    qa.ready = true;
    return true;
  }
  window.addEventListener("load", function () {
    let attempts = 0;
    const poll = function () {
      if (applySetup()) return;
      if (++attempts < 600) setTimeout(poll, 100);
    };
    poll();
  });
})();
