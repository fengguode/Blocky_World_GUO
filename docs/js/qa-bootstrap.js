'use strict';
(function(){
  let state = 0x51f15e;
  Math.random = function(){ state = (state + 0x6D2B79F5) | 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const save = { seed:1337, worldSize:200000, player1:null, slot:0, pick:{p1:'steve',p2:'golem',p2bot:true,botLevel:1}, settings:{sensitivity:0.0024,renderDist:5,dayNight:true,sfx:false,renderDistAuto:false}, inventory:{apple:0,meat:0}, edits:[] };
  const data=new Map(); const storage={get length(){return data.size;},clear(){data.clear();},getItem(k){return data.has(String(k))?data.get(String(k)):null;},key(i){return Array.from(data.keys())[i]??null;},removeItem(k){data.delete(String(k));},setItem(k,v){data.set(String(k),String(v));}};
  try { Object.defineProperty(window,'localStorage',{configurable:true,value:storage}); } catch(e) { throw new Error('QA storage isolation unavailable; refusing to touch origin storage'); }
  if(window.localStorage!==storage) throw new Error('QA storage isolation unavailable; refusing to touch origin storage');
  storage.setItem('blocky-world-selected-type','normal'); storage.setItem('blocky-world-local-save-v1',JSON.stringify(save));
})();
