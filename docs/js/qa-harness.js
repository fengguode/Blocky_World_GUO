'use strict';
(function(){
const centre=100008, ground=29, marker=document.createElement('aside');
marker.id='qa-evidence'; marker.setAttribute('aria-live','polite');
marker.style.cssText='position:fixed;z-index:10000;top:10px;left:10px;max-width:400px;padding:8px 10px;border:1px solid rgba(255,255,255,.35);border-radius:8px;background:rgba(13,16,23,.9);color:#fff;font:12px/1.45 system-ui,sans-serif;box-shadow:0 3px 16px #0005';
marker.innerHTML='<strong>Issue #21 visual QA · '+(window.BW_QA_VARIANT||'unknown')+'</strong><br>Storybook · seed 1337 · fixed dawn camera<br><button id="qa-measure" type="button" style="margin-top:5px;font:inherit">Measure 20 s</button> <span id="qa-result">Preparing world…</span>';
window.BW_QA={variant:window.BW_QA_VARIANT||'unknown',seed:1337,camera:'fixed storybook free cam',ready:false,metrics:null};
document.addEventListener('DOMContentLoaded',()=>document.body.appendChild(marker));
function setup(){
 const result=document.getElementById('qa-result');
 if(typeof Game==='undefined'){if(result)result.textContent='Waiting: Game binding unavailable';return false;}
 if(!Game.world || Game.state!=='menu'){if(result)result.textContent='Waiting: '+Game.state+' · world '+!!Game.world;return false;}
 try {
 Object.defineProperty(Game,'dayPhase',{configurable:true,get:()=>0.25,set:()=>{}});
 Game.startObserve();
 Game.animals.forEach(a=>{a.update=()=>{};});
 Game.updateAnimals=()=>{};
 Game.players.forEach(p=>{p.pos=[centre,ground+1,centre];});
 Observer.index=0; Observer.pos=[centre+34,ground+30,centre+34];
 Cam.yaw=Math.PI/4; Cam.pitch=-0.54; Cam.pos=Observer.pos.slice();
 Game.time=0;
 window.BW_QA.ready=true;
 if(result) result.textContent='Ready · '+Game.animals.length+' static animals';
 return true;
 } catch(e) { if(result)result.textContent='QA setup error: '+(e&&e.message||String(e)); return false; }
}
window.addEventListener('load',()=>{let attempts=0; const poll=()=>{if(setup()) return; if(++attempts<600)setTimeout(poll,100);}; poll();});
function measure(){
 const button=document.getElementById('qa-measure'), result=document.getElementById('qa-result'); if(!button||button.disabled)return;
 button.disabled=true; result.textContent='Warm-up (5 s)…';
 setTimeout(()=>{ result.textContent='Sampling (20 s)…'; const frames=[]; let previous=null; const start=performance.now();
  function tick(now){if(previous!==null)frames.push(now-previous);previous=now;if(now-start<20000){requestAnimationFrame(tick);return;}
   const sorted=frames.slice().sort((a,b)=>a-b), mean=frames.reduce((s,n)=>s+n,0)/Math.max(1,frames.length), pct=p=>sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*p))]||0;
   const heap=performance.memory&&Number.isFinite(performance.memory.usedJSHeapSize)?(performance.memory.usedJSHeapSize/1048576).toFixed(1)+' MiB':'unavailable';
   const metrics={samples:frames.length,meanFrameMs:+mean.toFixed(2),medianFrameMs:+pct(.5).toFixed(2),p95FrameMs:+pct(.95).toFixed(2),meanFps:+(1000/Math.max(.01,mean)).toFixed(1),devicePixelRatio:devicePixelRatio,viewport:innerWidth+'x'+innerHeight,userAgent:navigator.userAgent,jsHeapMiB:heap};
   window.BW_QA.metrics=metrics; result.textContent=metrics.meanFps+' FPS · p95 '+metrics.p95FrameMs+' ms · heap '+heap; button.disabled=false; window.dispatchEvent(new CustomEvent('bw-qa-measured',{detail:metrics}));
  } requestAnimationFrame(tick);
 },5000);
}
document.addEventListener('DOMContentLoaded',()=>{const button=document.getElementById('qa-measure'); if(button)button.addEventListener('click',measure);});
})();