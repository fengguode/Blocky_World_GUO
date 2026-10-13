'use strict';
/* ============================================================
   ui.js — menus, HUD, toasts
   ============================================================ */

const UI = {
  toastTimer: null,

  drawCharacterPortrait(canvas, character) {
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.clearRect !== 'function' || typeof ctx.fillRect !== 'function') return;
    const themes = {
      steve: { skin: '#d8a477', hair: '#704936', shirt: '#4b91ce', pants: '#344d79', shoes: '#55483f' },
      alex: { skin: '#e0ac7d', hair: '#d3953e', shirt: '#54aa83', pants: '#465a51', shoes: '#76523a' },
      spider: { skin: '#d7a078', hair: '#3f3445', shirt: '#c94f50', pants: '#385c9a', shoes: '#d04f47' },
      doll: { skin: '#f2c0a4', hair: '#d960a4', shirt: '#e875b6', pants: '#f0c1d9', shoes: '#b54d88' },
      golem: { skin: '#9b9b8b', hair: '#77796e', shirt: '#969789', pants: '#77796e', shoes: '#676b64' },
      ninja: { skin: '#dcaa7c', hair: '#453b38', shirt: '#d16b35', pants: '#373e4c', shoes: '#343942' },
    };
    const t = themes[character && character.id] || themes.steve;
    const color = character && character.color || '#4b91ce';
    // A deliberately chunky, low-resolution builder portrait. The same shape
    // works at menu and selection sizes without external art.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    const id = character && character.id;
    const isGolem = id === 'golem';
    const headX = isGolem ? 6 : 8;
    const headW = isGolem ? 36 : 32;
    ctx.fillStyle = '#fff1cf';
    ctx.fillRect(14, 2, 20, 2); ctx.fillRect(10, 6, 28, 2);
    ctx.fillRect(headX, 10, headW, isGolem ? 24 : 20);
    ctx.fillStyle = t.skin; ctx.fillRect(headX + 2, 12, headW - 4, isGolem ? 20 : 16);
    ctx.fillStyle = t.hair; ctx.fillRect(headX, 8, headW, 8); ctx.fillRect(headX, 14, 4, 8); ctx.fillRect(headX + headW - 4, 12, 4, 8);
    if (id === 'alex') {
      ctx.fillRect(34, 10, 10, 5); ctx.fillRect(38, 14, 8, 8); ctx.fillRect(40, 20, 5, 6); // ranger ponytail
    } else if (isGolem) {
      ctx.fillStyle = '#77796e'; ctx.fillRect(6, 8, 36, 5); ctx.fillRect(6, 13, 5, 11);
      ctx.fillStyle = '#c3c2a9'; ctx.fillRect(9, 16, 4, 3); ctx.fillRect(35, 24, 4, 4); // stone flecks
    } else if (id === 'doll') {
      ctx.fillRect(6, 14, 6, 12); ctx.fillRect(36, 14, 6, 12); // long side curls
      ctx.fillStyle = '#fff1cf'; ctx.fillRect(34, 4, 8, 4); ctx.fillRect(36, 2, 4, 8); // bright bow
    }
    ctx.fillStyle = '#44382e'; ctx.fillRect(15, 20, 4, 4); ctx.fillRect(29, 20, 4, 4);
    ctx.fillStyle = '#fffaf0'; ctx.fillRect(15, 20, 2, 2); ctx.fillRect(29, 20, 2, 2);
    ctx.fillStyle = t.skin; ctx.fillRect(21, 24, 6, 3);
    ctx.fillStyle = '#aa5547'; ctx.fillRect(20, 29, 9, 2);
    if (id === 'spider') {
      ctx.fillStyle = '#37699a'; ctx.fillRect(10, 19, 28, 7); // bright original hero mask
      ctx.fillStyle = '#fff3d9'; ctx.fillRect(14, 20, 7, 3); ctx.fillRect(27, 20, 7, 3);
      ctx.fillStyle = '#e3a878'; ctx.fillRect(19, 26, 10, 5);
    } else if (id === 'ninja') {
      ctx.fillStyle = '#e6b657'; ctx.fillRect(8, 17, 32, 3); ctx.fillRect(34, 15, 8, 3); // tied headband
      ctx.fillStyle = '#413b3b'; ctx.fillRect(12, 25, 24, 6); // lower face wrap
    }
    ctx.fillStyle = '#f7d394'; ctx.fillRect(isGolem ? 4 : 6, 34, isGolem ? 40 : 36, 3);
    const torsoX = isGolem ? 5 : 8;
    const torsoW = isGolem ? 38 : 32;
    ctx.fillStyle = t.shirt;
    ctx.fillRect(torsoX, 36, torsoW, 16);
    ctx.fillRect(isGolem ? 0 : 2, 38, isGolem ? 10 : 8, 13);
    ctx.fillRect(isGolem ? 38 : 38, 38, isGolem ? 10 : 8, 13);
    ctx.fillStyle = color; ctx.fillRect(20, 36, 8, 13); // signature chest patch
    if (id === 'doll') {
      ctx.fillStyle = t.shirt; ctx.fillRect(6, 48, 36, 5); ctx.fillRect(10, 53, 28, 5); // flared dress hem
      ctx.fillStyle = '#fff1cf'; ctx.fillRect(11, 56, 3, 3); ctx.fillRect(21, 56, 3, 3); ctx.fillRect(33, 56, 3, 3);
    }
    ctx.fillStyle = t.pants;
    if (!isGolem && id !== 'doll') { ctx.fillRect(10, 52, 12, 8); ctx.fillRect(26, 52, 12, 8); }
    else if (isGolem) { ctx.fillRect(8, 52, 14, 8); ctx.fillRect(26, 52, 14, 8); }
    else { ctx.fillRect(10, 57, 12, 3); ctx.fillRect(26, 57, 12, 3); }
    ctx.fillStyle = t.shoes; ctx.fillRect(isGolem ? 6 : 8, 60, isGolem ? 17 : 15, 4); ctx.fillRect(25, 60, isGolem ? 17 : 15, 4);
    if (id === 'ninja') { ctx.fillStyle = '#f2c46b'; ctx.fillRect(5, 39, 5, 4); ctx.fillRect(38, 41, 5, 4); }
    // Tiny leaf-like pixels make the portrait feel at home in the storybook world.
    ctx.fillStyle = '#829b53'; ctx.fillRect(1, 31, 5, 3); ctx.fillRect(42, 29, 5, 3);
  },

  mountPortraits(root) {
    if (!root) return;
    root.querySelectorAll('[data-portrait]').forEach(canvas => {
      const character = characterById(canvas.dataset.portrait);
      this.drawCharacterPortrait(canvas, character);
    });
  },

  init() {
    const $ = (id) => document.getElementById(id);

    $('btn-play').onclick = () => Game.startPlay();
    $('btn-worlds').onclick = () => UI.showWorldSelect();
    $('btn-characters').onclick = () => { UI.showPlayerCharacterSelect('menu'); };
    $('btn-fight').onclick = () => { UI.showCharSelect(); };
    $('btn-observe').onclick = () => Game.startObserve();
    $('btn-controls').onclick = () => { UI.showControls($('menu-extra')); };
    $('btn-options').onclick = () => { UI.showOptions($('menu-extra')); };
    $('btn-reset').onclick = () => {
      if (confirm('Start a brand new world? This clears your old one.')) {
        Game.newWorld();
      }
    };
    $('btn-resume').onclick = () => Game.togglePause(false);
    $('btn-runtime-reload').onclick = async () => {
      Game.save();
      if (window.Network && Network.serverMode) await Network.flushSave(false, true);
      window.location.reload();
    };
    $('btn-pause-character').onclick = () => { UI.showPlayerCharacterSelect('pause'); };
    $('btn-game-settings').onclick = () => Game.togglePause(true);
    const fightLobbySettings = $('btn-fight-lobby-settings');
    if (fightLobbySettings) fightLobbySettings.onclick = () => Game.togglePause(true);
    const fightLobbyExit = $('btn-fight-lobby-exit');
    if (fightLobbyExit) fightLobbyExit.onclick = () => Game.toMenu();
    const openPausePanel = (show) => {
      UI.show('pause-menu-content', false);
      UI.show('pause-extra', true);
      show($('pause-extra'));
    };
    $('btn-pause-controls').onclick = () => openPausePanel(box => UI.showControls(box));
    $('btn-pause-options').onclick = () => openPausePanel(box => UI.showOptions(box));
    $('btn-pause-rescue').onclick = () => {
      Game.recoverPlayerPosition(Game.players[0], true);
      Game.save();
      Game.togglePause(false);
    };
    $('btn-pause-menu').onclick = () => Game.toMenu();

    this.buildHotbar();
  },

  show(id, on) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !on);
    if (id === 'hud') {
      const settings = document.getElementById('btn-game-settings');
      if (settings) settings.classList.toggle('hidden', !on);
    }
  },

  showMainMenu() {
    const box = document.getElementById('menu-extra');
    box.innerHTML = '';
    document.getElementById('menu').classList.remove('hidden');
    document.getElementById('pause').classList.remove('show');
    const label = document.getElementById('world-label');
    if (label) label.textContent = 'Current world: ' + (Game.activeWorldType === 'flat' ? 'Flat World' : 'Normal World');
    const character = characterById(Game.pick.p1);
    const portrait = document.getElementById('menu-character-preview');
    if (portrait) this.drawCharacterPortrait(portrait, character);
    const name = document.getElementById('menu-character-name');
    const style = document.getElementById('menu-character-style');
    if (name) name.textContent = character.name;
    if (style) style.textContent = character.style;
    if (window.Network && Network.serverMode) Network.refreshVisitLobby();
  },

  showWorldSelect() {
    const box = document.getElementById('menu-extra');
    box.innerHTML =
      '<section class="world-select" aria-labelledby="world-select-title">' +
        '<h3 id="world-select-title">Choose a world</h3>' +
        '<p>You can switch worlds later; each keeps its own blocks and progress.</p>' +
        '<div class="world-cards">' +
          '<button type="button" class="world-card" id="choose-normal">' +
            '<strong>Normal World</strong><span>Hills, trees, water and open places to explore.</span>' +
            (Game.activeWorldType === 'normal' ? '<em>Current world</em>' : '') +
          '</button>' +
          '<button type="button" class="world-card" id="choose-flat">' +
            '<strong>Flat World</strong><span>A wide, level grassy world with no trees.</span>' +
            (Game.activeWorldType === 'flat' ? '<em>Current world</em>' : '') +
          '</button>' +
        '</div>' +
        '<button type="button" id="world-select-back">Back</button>' +
      '</section>';
    box.querySelector('#choose-normal').onclick = () => Game.selectWorld('normal');
    box.querySelector('#choose-flat').onclick = () => Game.selectWorld('flat');
    box.querySelector('#world-select-back').onclick = () => UI.showMainMenu();
  },
  /* ---------- character select ---------- */
  showCharSelect() {
    const box = document.getElementById('menu-extra');
    let p1 = Game.pick.p1 || 'steve';
    let p2 = Game.pick.p2 || 'golem';
    let editing = 1;

    // On a phone there is only room for one pair of thumbs, so the second
    // fighter is the computer by default. A controller takes over if present.
    const levelNames = ['Easy', 'Normal', 'Hard'];
    const levelBlurb = [
      'Misses lots of attacks. Great for a first fight.',
      'Gets you sometimes and blocks well.',
      'Fast, accurate and uses every move it has.',
    ];

    const render = () => {
      const cards = CHARACTERS.map(c => {
        const sel = (editing === 1 && c.id === p1) || (editing === 2 && c.id === p2);
        return '<div class="char-card ' + (sel ? 'sel' : '') + '" data-id="' + c.id + '"' +
          ' role="button" tabindex="0" aria-pressed="' + sel + '">' +
          '<canvas class="character-portrait" width="48" height="64" data-portrait="' + c.id + '" aria-hidden="true"></canvas>' +
          '<div class="char-card-copy">' +
          '<div class="cname" style="color:' + c.color + '">' + c.name + '</div>' +
          '<div class="cstyle">' + c.style + '</div>' +
          '<div class="cdesc">' + c.desc + '</div>' +
          '<div class="stat-line"><span>POWER</span><span class="track"><i style="width:' +
            (c.stats.power * 100) + '%;background:' + c.color + '"></i></span></div>' +
          '<div class="stat-line"><span>SPEED</span><span class="track"><i style="width:' +
            (c.stats.speed * 100) + '%;background:' + c.color + '"></i></span></div>' +
          '<div class="stat-line"><span>RANGE</span><span class="track"><i style="width:' +
            (c.stats.range * 100) + '%;background:' + c.color + '"></i></span></div>' +
          '<div class="cdesc" style="margin-top:8px;color:' + c.color + '">ULT: ' + c.ultName + '</div>' +
          '<div class="cdesc" style="font-size:11px;opacity:.65">' + c.ultDesc + '</div></div>' +
          '</div>';
      }).join('');

      const level = Game.pick.botLevel || 1;

      box.innerHTML =
        '<h3>Who is playing?</h3>' +
        '<div class="btn-grid" style="margin-bottom:12px">' +
          '<button class="primary" id="slot1">Player 1: ' + characterById(p1).name + '</button>' +
          '<button class="' + (Game.pick.p2bot ? '' : 'danger') + '" id="slot2">' +
            (Game.pick.p2bot ? 'Computer: ' + characterById(p2).name : 'Player 2: ' + characterById(p2).name) +
          '</button>' +
        '</div>' +
        '<div class="chars">' + cards + '</div>' +

        '<div class="toggle-row" id="bot-toggle">' +
          '<span>Player 2 is the computer</span>' +
          '<span class="val">' + (Game.pick.p2bot ? 'Yes' : 'No') + '</span>' +
        '</div>' +
        (Game.pick.p2bot ?
          '<div class="toggle-row" id="bot-level">' +
            '<span>Difficulty</span><span class="val">' + levelNames[level] + '</span>' +
          '</div>' +
          '<div style="font-size:12px;opacity:.62;text-align:left;margin:-2px 0 12px 8px">' +
            levelBlurb[level] +
          '</div>' : '') +

        '<div style="margin-top:12px;font-size:12px;opacity:.7">' +
          (Game.isTouch
            ? 'Player 1: <b>thumbstick to move</b>, drag the screen to look, big buttons to hit.'
            : 'Player 1: <b>WASD + mouse</b>, <b>J</b> hit, <b>K</b> skill, <b>L</b> ultimate.') +
        '</div>' +
        '<div class="btn-grid" style="margin-top:14px">' +
          '<button class="primary" id="do-fight">Start Fight</button>' +
          '<button id="back-menu">Back</button>' +
        '</div>';

      UI.mountPortraits(box);

      box.querySelector('#slot1').onclick = () => { editing = 1; render(); };
      box.querySelector('#slot2').onclick = () => { editing = 2; render(); };
      box.querySelectorAll('.char-card').forEach(card => {
        const selectCard = () => {
          if (editing === 1) Game.pick.p1 = p1 = card.dataset.id;
          else Game.pick.p2 = p2 = card.dataset.id;
          render();
          const selectedCard = box.querySelector('.char-card[data-id="' + card.dataset.id + '"]');
          if (selectedCard) selectedCard.focus();
        };
        card.onclick = selectCard;
        card.onkeydown = (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectCard();
          }
        };
      });
      const botT = box.querySelector('#bot-toggle');
      if (botT) botT.onclick = () => { Game.pick.p2bot = !Game.pick.p2bot; render(); };
      const botL = box.querySelector('#bot-level');
      if (botL) botL.onclick = () => {
        Game.pick.botLevel = ((Game.pick.botLevel || 1) + 1) % 3;
        render();
      };
      box.querySelector('#do-fight').onclick = () => { Game.save(); Game.startFight(); };
      box.querySelector('#back-menu').onclick = () => UI.showMainMenu();
    };
    render();
  },

  showPlayerCharacterSelect(context) {
    const inPause = context === 'pause';
    const box = document.getElementById(inPause ? 'pause-character-panel' : 'menu-extra');
    if (inPause) {
      this.show('pause-menu-content', false);
      this.show('pause-character-panel', true);
    }

    const render = () => {
      const selected = characterById(Game.pick.p1);
      box.innerHTML =
        '<h3>Choose your character</h3>' +
        '<p class="character-current">Playing as <b>' + selected.name + '</b> · Outfit: ' + selected.style + '</p>' +
        '<div class="character-choices">' + CHARACTERS.map(c =>
          '<button type="button" class="character-choice ' + (c.id === selected.id ? 'selected' : '') + '"' +
            ' data-character="' + c.id + '" aria-pressed="' + (c.id === selected.id) + '">' +
            '<canvas class="character-portrait" width="48" height="64" data-portrait="' + c.id + '" aria-hidden="true"></canvas>' +
            '<span class="character-choice-copy">' +
            '<span class="choice-name" style="color:' + c.color + '">' + c.name + '</span>' +
            '<span class="choice-style">' + c.style + '</span>' +
            '</span>' +
          '</button>'
        ).join('') + '</div>' +
        '<p class="character-current">Select a block to build or the shovel to remove · Blocks are unlimited</p>' +
        '<div class="btn-grid"><button class="primary" id="done-character-select">Done</button></div>';

      UI.mountPortraits(box);

      box.querySelectorAll('.character-choice').forEach(button => {
        button.onclick = () => {
          Game.changeCharacter(button.dataset.character);
          render();
        };
      });
      box.querySelector('#done-character-select').onclick = () => {
        if (inPause) {
          this.show('pause-character-panel', false);
          this.show('pause-menu-content', true);
        } else this.showMainMenu();
      };
    };
    render();
  },

  showControls(box) {
    let rows;
    if (Game.isTouch) {
      rows = [
        ['Move around', 'Left thumbstick'],
        ['Look around', 'Drag anywhere on the right'],
        ['Break / attack', 'BREAK mines blocks or attacks animals / your visitor'],
        ['Place a block', 'PLACE button'],
        ['Choose a block', 'Tap the bar at the bottom'],
        ['Eat food', 'Select Apple or Meat, then PLACE'],
        ['Jump / fly up', 'JUMP'],
        ['Fly down', 'FLY (tap to switch flying on)'],
        ['Hit an enemy', 'HIT'],
        ['Use a special move', 'SKILL'],
        ['Ultimate move', 'ULT when the bar is full'],
        ['Change camera view', 'JUMP, in Observe mode'],
        ['Take a photo', 'PHOTO, in Observe mode'],
        ['Pause menu', 'Pause button on iOS, or the menu on desktop'],
      ];
    } else {
      rows = [
        ['Move', 'W A S D'],
        ['Jump / Fly up', 'Space'],
        ['Sneak / Fly down', 'Shift'],
        ['Break / attack', 'Left click (animals or visiting player)'],
        ['Place block', 'Right click'],
        ['Pick block', 'Q'],
        ['Hotbar', '1–9 blocks, 0 shovel, or wheel for food'],
        ['Eat food', 'Select Apple or Meat, then right click'],
        ['Toggle flying', 'F'],
        ['Watch your fighter', 'V'],
        ['Observe: change view', 'F5'],
        ['Observe: photo', 'P'],
        ['Pause / Menu', 'F10 or Esc'],
        ['Hit an enemy', 'Left click or J'],
        ['Special move', 'Right click or K'],
        ['Ultimate', 'L (needs a full bar)'],
        ['Player 2 (keyboard)', 'Arrows + Numpad 1/2/3'],
        ['Player 2 (controller)', 'Sticks + A/X/Y/B'],
        ['Build attack (controller)', 'X'],
      ];
    }
    box.innerHTML =
      '<h3>Controls</h3><div class="keycaps">' +
      rows.map(r => '<div><span>' + r[0] + '</span><kbd>' + r[1] + '</kbd></div>').join('') +
      '</div><div style="margin-top:14px"><button id="ok-controls">Got it</button></div>';
    box.querySelector('#ok-controls').onclick = () => {
      if (Game.state === 'menu') UI.showMainMenu(); else Game.togglePause(false);
    };
  },

  showOptions(box) {
    const s = Game.settings;
    const touchNote = Game.isTouch
      ? '<div style="font-size:12px;opacity:.6;margin-top:10px;text-align:left">' +
        'On this device: thumbstick moves, drag anywhere on the right to look, and the round buttons act. ' +
        'Select a block to PLACE it, or the shovel to remove your target. BREAK also mines. Tap the picture frame twice for a photo.</div>'
      : '';

    box.innerHTML =
      '<h3>Options</h3>' +
      '<div class="toggle-row"><span>Look sensitivity</span><span class="val" id="sensv">' +
        s.sensitivity.toFixed(3) + '</span></div>' +
      '<input type="range" id="sens" min="0.0008" max="0.008" step="0.0002" value="' + s.sensitivity + '" style="width:100%">' +
      '<div class="toggle-row"><span>How far you can see</span><span class="val" id="rdv">' + s.renderDist + '</span></div>' +
      '<input type="range" id="rd" min="3" max="9" step="1" value="' + s.renderDist + '" style="width:100%">' +
      '<div class="toggle-row"><span>Day/night cycle (5 minutes)</span><span class="val" id="dnv">' + (s.dayNight ? 'On' : 'Off') + '</span></div>' +
      '<div class="btn-grid"><button id="set-day" type="button">Day now</button><button id="set-night" type="button">Night now</button></div>' +
      '<div class="toggle-row"><span>Sound</span><span class="val" id="sfxv">' + (s.sfx ? 'On' : 'Off') + '</span></div>' +
      (Game.isTouch ? '' :
        '<div class="toggle-row"><span>Show touch buttons</span><span class="val" id="tuv">' +
          (document.body.classList.contains('touch') ? 'On' : 'Off') + '</span></div>') +
      touchNote +
      '<div style="margin-top:14px" class="btn-grid"><button id="ok-options">Done</button></div>';

    box.querySelector('#sens').oninput = (e) => {
      s.sensitivity = parseFloat(e.target.value);
      Input.sensitivity = s.sensitivity;
      box.querySelector('#sensv').textContent = s.sensitivity.toFixed(3);
    };
    box.querySelector('#rd').oninput = (e) => {
      s.renderDist = parseInt(e.target.value, 10);
      // From here on this is the player's decision, so the automatic device
      // profile must stop overriding it.
      s.renderDistAuto = false;
      box.querySelector('#rdv').textContent = s.renderDist;
      UI.toast('Updating view distance…');
      // The renderer draws from this, so update it now rather than waiting for
      // the next load: without this the slider changes the fog but not the
      // distance you can actually see.
      Game.renderDist = s.renderDist;
      Game.save();
    };
    box.querySelector('#dnv').parentElement.onclick = () => {
      s.dayNight = !s.dayNight;
      box.querySelector('#dnv').textContent = s.dayNight ? 'On' : 'Off';
    };
    box.querySelector('#set-day').onclick = () => { Game.dayPhase = 0.5; s.dayNight = true; box.querySelector('#dnv').textContent = 'On'; };
    box.querySelector('#set-night').onclick = () => { Game.dayPhase = 0; s.dayNight = true; box.querySelector('#dnv').textContent = 'On'; };
    box.querySelector('#sfxv').parentElement.onclick = () => {
      s.sfx = !s.sfx;
      Audio.enabled = s.sfx;
      box.querySelector('#sfxv').textContent = s.sfx ? 'On' : 'Off';
    };
    const tu = box.querySelector('#tuv');
    if (tu) tu.parentElement.onclick = () => {
      const on = !document.body.classList.contains('touch');
      document.body.classList.toggle('touch', on);
      Touch.enabled = on;
      box.querySelector('#tuv').textContent = on ? 'On' : 'Off';
    };
    box.querySelector('#ok-options').onclick = () => {
      Game.save();
      if (Game.state === 'paused') Game.togglePause(false); else UI.showMainMenu();
    };
  },

  /* ---------- hotbar ---------- */
  buildHotbar() {
    const bar = document.getElementById('hotbar');
    bar.innerHTML = '';
    bar.addEventListener('click', (e) => {
      const slot = e.target.closest && e.target.closest('.slot');
      if (slot) Game.selectSlot(Number(slot.dataset.slot));
    });
    HOTBAR_ITEMS.forEach((item, i) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.slot = i;
      slot.tabIndex = 0;
      slot.setAttribute('role', 'button');
      slot.setAttribute('aria-label', item.name + (item.kind === 'block' ? ', unlimited blocks' : item.kind === 'food' ? ', food' : ', removes the targeted block'));
      slot.setAttribute('aria-pressed', i === Game.selectedSlot ? 'true' : 'false');
      slot.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          Game.selectSlot(i);
        }
      });
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = (i + 1) % 10;
      const icon = item.kind === 'block' ? blockIconCanvas(item.id, 38) : document.createElement('canvas');
      if (item.kind === 'tool') {
        icon.width = icon.height = 38;
        const ctx = icon.getContext('2d');
        ctx.translate(19, 19); ctx.rotate(-Math.PI / 4);
        ctx.fillStyle = '#bb8049'; ctx.fillRect(-3, -12, 6, 25);
        ctx.strokeStyle = '#dae9f5'; ctx.lineWidth = 3; ctx.strokeRect(-6, -17, 12, 7);
        ctx.fillStyle = '#9fb8cb'; ctx.fillRect(-8, 8, 16, 10);
        ctx.beginPath(); ctx.moveTo(-8,18); ctx.lineTo(0,23); ctx.lineTo(8,18); ctx.fill();
      } else if (item.kind === 'food') {
        icon.width = icon.height = 38;
        const ctx = icon.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        if (item.id === 'apple') {
          ctx.fillStyle = '#d94b50'; ctx.fillRect(8, 10, 22, 21);
          ctx.fillStyle = '#ff8580'; ctx.fillRect(11, 12, 6, 5);
          ctx.fillStyle = '#568d42'; ctx.fillRect(19, 5, 9, 5);
          ctx.fillStyle = '#76502f'; ctx.fillRect(19, 6, 3, 7);
        } else {
          ctx.fillStyle = '#a9493e'; ctx.fillRect(7, 10, 24, 18);
          ctx.fillStyle = '#e7cda0'; ctx.fillRect(3, 16, 8, 5); ctx.fillRect(27, 16, 8, 5);
          ctx.fillStyle = '#f2e5c8'; ctx.fillRect(3, 14, 4, 4); ctx.fillRect(3, 19, 4, 4);
          ctx.fillRect(31, 14, 4, 4); ctx.fillRect(31, 19, 4, 4);
        }
      }
      slot.title = item.name;
      const key = document.createElement('span');
      key.className = 'key';
      slot.appendChild(num);
      slot.appendChild(icon);
      if (item.kind === 'food') {
        const count = document.createElement('span');
        count.className = 'food-count';
        count.dataset.item = item.id;
        count.textContent = '0';
        slot.appendChild(count);
      }
      slot.appendChild(key);
      bar.appendChild(slot);
    });
  },

  setActiveSlot(i) {
    document.querySelectorAll('#hotbar .slot').forEach((s, idx) => {
      s.classList.toggle('active', idx === i);
      s.setAttribute('aria-pressed', idx === i ? 'true' : 'false');
    });
  },

  updateEquipmentStatus(player, mode) {
    const el = document.getElementById('equipment-status');
    if (!el) return;
    if (mode !== 'play' || !player) {
      el.classList.add('hidden');
      return;
    }
    const character = player.char || characterById(Game.pick.p1);
    const item = HOTBAR_ITEMS[Game.selectedSlot] || HOTBAR_ITEMS[0];
    const count = item.kind === 'food' ? Math.max(0, Math.floor(Number((player.inventory || {})[item.id]) || 0)) : 0;
    const attackDamage = Game.playAttackDamage ? Game.playAttackDamage(player) : 8;
    const attackStyle = attackDamage === 20 ? 'gold' : attackDamage === 16 ? 'stone' : attackDamage === 12 ? 'wood' : 'fist';
    const summary = character.name + ' · Outfit: ' + character.style +
      ' · Selected: ' + item.name + (item.kind === 'block' ? ' ∞ · PLACE builds' : item.kind === 'food' ? ' ×' + count + ' · PLACE eats' : ' · PLACE removes') +
      ' · BREAK attack: ' + attackDamage + ' (' + attackStyle + ')';
    if (el.textContent !== summary) el.textContent = summary;
    el.classList.remove('hidden');
  },

  /* ---------- HUD ---------- */
  updateHUD(player, mode, extra) {
    this.updateEquipmentStatus(player, mode);
    const setBar = (id, pct) => {
      const el = document.getElementById(id);
      if (el) el.style.width = Math.max(0, Math.min(100, pct)) + '%';
    };
    const inPlay = mode === 'play';
    const hpVisible = mode === 'fight' || inPlay;
    const statusRow = document.querySelector('.status-row');
    if (statusRow) statusRow.classList.toggle('play-health', inPlay);
    const ultFill = document.getElementById('ult-fill');
    const ultBar = ultFill && ultFill.parentElement;
    const ultLabel = ultBar && ultBar.previousElementSibling;
    const combo = document.getElementById('combo-label');
    if (ultLabel) ultLabel.style.display = mode === 'fight' ? '' : 'none';
    if (ultBar) ultBar.style.display = mode === 'fight' ? '' : 'none';
    if (combo) combo.style.display = mode === 'fight' ? '' : 'none';
    if (hpVisible) {
      setBar('hp-fill', (player.hp / player.maxHp) * 100);
      const hpFill = document.getElementById('hp-fill');
      const hpLabel = hpFill && hpFill.parentElement && hpFill.parentElement.previousElementSibling;
      if (hpLabel) hpLabel.textContent = (inPlay ? '♥ ' : '') + 'HP ' + Math.ceil(player.hp) + '/' + player.maxHp;
      document.querySelectorAll('#hotbar .food-count').forEach((el) => {
        el.textContent = String(Math.max(0, Math.floor(Number((player.inventory || {})[el.dataset.item]) || 0)));
      });
      const statusRowEl = document.querySelector('.status-row');
      if (statusRowEl) statusRowEl.style.display = 'flex';
    }
    if (mode === 'fight') {
      setBar('ult-fill', (player.ultMeter / player.maxUlt) * 100);
      const ult = document.getElementById('ult-fill');
      if (ult) ult.parentElement.classList.toggle('ult-ready', player.ultMeter >= player.maxUlt);
      const cl = document.getElementById('combo-label');
      if (cl) cl.textContent = player.combo > 1 ? (player.combo + ' HIT COMBO') : '';
      document.getElementById('hotbar').style.display = 'none';
    } else if (mode === 'play') {
      document.getElementById('hotbar').style.display = '';
    } else {
      document.getElementById('hotbar').style.display = '';
      document.querySelector('.status-row').style.display = 'none';
    }

    const info = document.getElementById('info-box');
    if (info && extra) info.innerHTML = extra;

    const vig = document.getElementById('vignette');
    if (vig) vig.classList.toggle('hurt', player.hurtFlash > 0.05);

    const ch = document.getElementById('crosshair');
    if (ch) ch.classList.toggle('hit', player.hurtFlash > 0.4);
  },

  comboPopup(n) {
    const el = document.getElementById('combo-pop');
    if (!el) return;
    el.textContent = n + ' HIT!';
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  },

  toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), 1700);
  },

  debug(text, on) {
    const el = document.getElementById('debug');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('hidden', !on);
  },
};

/* ============================================================
   Audio — tiny WebAudio synth, no files needed
   ============================================================ */
const Audio = {
  ctx: null,
  enabled: true,

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) { this.ctx = null; }
  },

  play(kind, opt) {
    if (!this.enabled || !this.ctx) return;
    opt = opt || {};
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const t = this.ctx.currentTime;
    const gain = (opt.gain === undefined ? 1 : opt.gain) * 0.16;
    const pitch = opt.pitch || 1;

    const tone = (freq, dur, type, vol, slideTo) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(freq * pitch, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo * pitch), t + dur);
      g.gain.setValueAtTime(vol * gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.ctx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    };

    const noise = (dur, vol, filterFreq) => {
      const len = Math.max(1, (dur * this.ctx.sampleRate) | 0);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = filterFreq || 900;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(vol * gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f); f.connect(g); g.connect(this.ctx.destination);
      src.start(t);
    };

    switch (kind) {
      case 'break':   noise(0.16, 1.1, 1400); tone(220, 0.08, 'square', 0.4, 140); break;
      case 'place':   noise(0.1, 0.8, 700);  tone(160, 0.1, 'square', 0.5, 110); break;
      case 'step':    noise(0.06, 0.32, 500); break;
      case 'hit':     noise(0.12, 0.9, 2200); tone(180, 0.12, 'sawtooth', 0.5, 70); break;
      case 'swing':   noise(0.08, 0.4, 3200); break;
      case 'shoot':   tone(880, 0.09, 'square', 0.5, 420); break;
      case 'jump':    tone(340, 0.11, 'square', 0.45, 620); break;
      case 'ult':     tone(160, 0.5, 'sawtooth', 0.9, 900); noise(0.4, 0.7, 2600); break;
      case 'ko':      tone(300, 0.5, 'square', 0.7, 70); break;
      case 'eat':     tone(540, 0.06, 'sine', 0.35, 760); break;
      case 'win':     tone(520, 0.12, 'square', 0.7); tone(660, 0.12, 'square', 0.7); tone(880, 0.3, 'square', 0.8); break;
      case 'select':  tone(600, 0.05, 'square', 0.4); break;
      case 'view':    tone(480, 0.06, 'sine', 0.4); break;
    }
  },
};
