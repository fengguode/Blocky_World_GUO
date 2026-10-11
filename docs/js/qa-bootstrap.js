'use strict';
(function(){
  let state = 0x51f15e;
  Math.random = function(){ state = (state + 0x6D2B79F5) | 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const save = { seed:1337, worldSize:200000, player1:null, slot:0, pick:{p1:'steve',p2:'golem',p2bot:true,botLevel:1}, settings:{sensitivity:0.0024,renderDist:5,dayNight:true,sfx:false,renderDistAuto:false}, inventory:{apple:0,meat:0}, edits:[] };
  try { localStorage.clear(); localStorage.setItem('blocky-world-selected-type','normal'); localStorage.setItem('blocky-world-local-save-v1',JSON.stringify(save)); } catch (_) {}
})();