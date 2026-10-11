'use strict';

/* Server-backed profile access. File:// play remains fully offline. */
const AUTH_PAGE_ID_KEY = 'bw-auth-page-id';
function makePageAuthId() {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function pageAuthIdForLoad() {
  try {
    const saved = sessionStorage.getItem(AUTH_PAGE_ID_KEY);
    if (saved && /^[a-f0-9]{32}$/.test(saved)) return saved;
    const fresh = makePageAuthId();
    sessionStorage.setItem(AUTH_PAGE_ID_KEY, fresh);
    return fresh;
  } catch (_) { /* Offline play does not depend on browser session storage. */ }
  return makePageAuthId();
}
const PAGE_AUTH_ID = pageAuthIdForLoad();
const Network = {
  serverMode: false,
  ready: false,
  profile: null,
  savedWorld: null,
  activeWorldType: 'normal',
  recoveryConflict: null,
  visitRole: null,
  visitOwnerId: null,
  visitOwnerName: null,
  visitCursor: 0,
  visitTimer: null,
  lobbyTimer: null,
  lobbyBusy: false,
  visitBusy: false,
  visitFailures: 0,
  pendingVisitRequest: null,
  remotePlayerState: null,
  hostModeChoice: 'play',
  sharedMode: 'play',
  sharedArenaCenter: null,
  sharedModeRevision: 0,
  fightChoice: null,
  fightVotes: { owner: null, visitor: null },
  fightPhase: 'setup',
  fightLocalInput: null,
  fightRemoteInput: null,
  fightRemoteActions: [],
  fightState: null,
  fightActionSeq: { attack: 0, special: 0, ult: 0, altAttack: 0 },
  fightActionHeld: { attack: false, special: false, ult: false, altAttack: false },
  sharedSentEdits: new Map(),
  pendingSharedEdits: new Map(),
  visitActive: false,
  sharedWorldReady: false,
  sharedWorldLoading: false,
  visitLoadError: null,
  pendingSave: null,
  serverEdits: new Map(),
  lastSavedSeed: null,
  resetEditsPending: false,
  serverRevision: 0,
  saveRevision: 0,
  saveQueue: Promise.resolve(),
  booted: false,
  locked: false,
  signingOut: false,
  saveTimer: null,
  sessionTimer: null,
  sessionCheckFailures: 0,
  readyPromise: null,
  pageAuthId: PAGE_AUTH_ID,

  async init() {
    this.serverMode = location.protocol !== 'file:';
    this.bindForms();
    if (!this.serverMode) {
      this.ready = true;
      const screen = document.getElementById('auth-screen');
      if (screen) screen.classList.add('hidden');
      return;
    }
    try {
      const status = await this.request('/api/status');
      if (status.setupRequired) {
        this.showSetup();
      } else if (status.profileSetupRequired) {
        this.showProfileSetup(status.canAddProfile);
      } else if (status.authenticated && status.user) {
        this.profile = status.user;
        this.activeWorldType = localStorage.getItem('blocky-world-selected-type') === 'flat' ? 'flat' : 'normal';
        this.savedWorld = (await this.request('/api/world?type=' + this.activeWorldType)).world;
        this.saveRevision = Number.isSafeInteger(this.savedWorld.revision) ? this.savedWorld.revision : 0;
        this.serverRevision = this.saveRevision;
        this.serverEdits = this.indexEdits(this.savedWorld.edits);
        this.lastSavedSeed = this.savedWorld.seed;
        this.ready = true;
        await this.restoreRecovery();
      } else {
        this.showLogin();
      }
    } catch (_) {
      this.showLogin('The family PC server is not available. Start it on the PC, then refresh this page.');
    }
  },

  async request(path, options) {
    const requestOptions = Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {});
    requestOptions.headers = Object.assign({}, requestOptions.headers || {}, { 'X-BW-Page': PAGE_AUTH_ID });
    const response = await fetch(path, requestOptions);
    let data = {};
    try { data = await response.json(); } catch (_) { /* show a useful HTTP error below */ }
    if (!response.ok) throw new Error(data.error || 'The server could not complete that request.');
    return data;
  },

  adoptWorldType(worldType, world) {
    worldType = worldType === 'flat' ? 'flat' : 'normal';
    this.activeWorldType = worldType;
    this.savedWorld = Object.assign({}, world, { worldType });
    this.saveRevision = Number.isSafeInteger(world.revision) ? world.revision : 0;
    this.serverRevision = this.saveRevision;
    this.serverEdits = this.indexEdits(world.edits);
    this.lastSavedSeed = world.seed;
    try { localStorage.setItem('blocky-world-selected-type', worldType); } catch (_) {}
    if (typeof Game !== 'undefined') Game.activeWorldType = worldType;
    return this.savedWorld;
  },

  async activateWorld(worldType) {
    worldType = worldType === 'flat' ? 'flat' : 'normal';
    if (worldType === this.activeWorldType) return this.savedWorld;
    if (this.pendingSave && !(await this.flushSave())) throw new Error('The current world could not be saved.');
    const data = await this.request('/api/world?type=' + worldType);
    return this.adoptWorldType(worldType, data.world);
  },
  async startGameIfAllowed() {
    if (this.readyPromise) await this.readyPromise;
    if (this.booted || !this.ready || (this.serverMode && !this.profile)) return;
    this.booted = true;
    const screen = document.getElementById('auth-screen');
    if (screen) screen.classList.add('hidden');
    if (this.profile) {
      const greeting = document.getElementById('player-greeting');
      if (greeting) greeting.textContent = 'Playing as ' + this.profile.displayName;
      const logout = document.getElementById('btn-logout');
      if (logout) logout.classList.remove('hidden');
    }
    await Game.boot();
    if (this.serverMode) {
      this.startSessionCheck();
      this.startLobbyPolling();
    }
  },

  bindForms() {
    const login = document.getElementById('login-form');
    const setup = document.getElementById('setup-form');
    const profileSetup = document.getElementById('profile-setup-form');
    if (login) login.addEventListener('submit', async (event) => {
      event.preventDefault();
      const pinInput = document.getElementById('auth-pin');
      const button = login.querySelector('button[type="submit"]');
      this.setBusy(button, true);
      try {
        await this.request('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: document.getElementById('auth-profile').value, pin: pinInput.value }),
        });
        pinInput.value = '';
        try { sessionStorage.setItem(AUTH_PAGE_ID_KEY, PAGE_AUTH_ID); }
        catch (_) {
          this.setMessage('Allow session storage in this browser, then try signing in again.');
          return;
        }
        location.reload();
      } catch (error) {
        pinInput.value = '';
        this.setMessage(error.message);
      } finally { this.setBusy(button, false); }
    });
    if (setup) setup.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = setup.querySelector('button[type="submit"]');
      const pins = [document.getElementById('setup-pin-1'), document.getElementById('setup-pin-2'), document.getElementById('setup-pin-3')];
      this.setBusy(button, true);
      try {
        await this.request('/api/setup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bootstrapCode: document.getElementById('setup-code').value,
            users: [
              { id: 'p1', pin: pins[0].value },
              { id: 'p2', pin: pins[1].value },
              { id: 'p3', pin: pins[2].value },
            ],
          }),
        });
        for (const input of [document.getElementById('setup-code'), ...pins]) input.value = '';
        location.reload();
      } catch (error) { this.setMessage(error.message); }
      finally { this.setBusy(button, false); }
    });
    if (profileSetup) profileSetup.addEventListener('submit', async (event) => {
      event.preventDefault();
      const pinInput = document.getElementById('profile-setup-pin');
      const setupCode = document.getElementById('profile-setup-code');
      const button = profileSetup.querySelector('button[type="submit"]');
      this.setBusy(button, true);
      try {
        await this.request('/api/profile-setup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: pinInput.value, setupCode: setupCode.value }),
        });
        pinInput.value = '';
        setupCode.value = '';
        location.reload();
      } catch (error) {
        pinInput.value = '';
        setupCode.value = '';
        this.setMessage(error.message);
      } finally { this.setBusy(button, false); }
    });
    document.addEventListener('click', (event) => {
      if (!event.target) return;
      if (event.target.id === 'btn-logout' || event.target.id === 'btn-retry-save') this.logout();
      if (event.target.id === 'btn-return-game') this.returnToGame();
      if (event.target.id === 'btn-use-recovery') this.useRecoveryCopy();
      if (event.target.id === 'btn-keep-server') this.keepServerWorld();
      if (event.target.id === 'btn-visit-end') this.endVisit();
      if (event.target.id === 'btn-visit-approve') this.respondToVisit(true);
      if (event.target.id === 'btn-visit-reject') this.respondToVisit(false);
      if (event.target.id === 'btn-visit-mode') this.openVisitModePicker();
      if (event.target.id === 'btn-visit-mode-cancel') this.closeVisitModePicker();
      const modeButton = event.target.closest && event.target.closest('[data-visit-mode]');
      if (modeButton) this.setVisitMode(modeButton.dataset.visitMode);
      const fightButton = event.target.closest && event.target.closest('[data-shared-fight]');
      if (fightButton) this.chooseSharedFight(fightButton.dataset.sharedFight);
    });
    window.addEventListener('pagehide', () => { this.saveOnPageHide(); });
  },

  showGate(message) {
    const screen = document.getElementById('auth-screen');
    if (screen) screen.classList.remove('hidden');
    const lead = document.getElementById('auth-lead');
    if (lead) lead.textContent = 'Sign in to enter your own world.';
    this.setMessage(message || '');
  },

  showLogin(message) {
    this.showGate('');
    const login = document.getElementById('login-form');
    const setup = document.getElementById('setup-form');
    const profileSetup = document.getElementById('profile-setup-form');
    if (login) login.classList.remove('hidden');
    if (setup) setup.classList.add('hidden');
    if (profileSetup) profileSetup.classList.add('hidden');
    if (message) this.setMessage(message);
  },

  showSetup() {
    this.showGate('First-time setup happens here. The one-time code is printed in the PC server window.');
    const login = document.getElementById('login-form');
    const setup = document.getElementById('setup-form');
    const profileSetup = document.getElementById('profile-setup-form');
    if (login) login.classList.add('hidden');
    if (setup) setup.classList.remove('hidden');
    if (profileSetup) profileSetup.classList.add('hidden');
  },

  showProfileSetup(canAddProfile) {
    this.showGate(canAddProfile
      ? 'Enter the one-time code from the PC server window to add Feng’s PIN. Existing worlds stay saved separately.'
      : 'Feng’s profile needs to be added once on the family PC. Open the game there, then refresh here.');
    const login = document.getElementById('login-form');
    const setup = document.getElementById('setup-form');
    const profileSetup = document.getElementById('profile-setup-form');
    if (login) login.classList.add('hidden');
    if (setup) setup.classList.add('hidden');
    if (profileSetup) profileSetup.classList.toggle('hidden', !canAddProfile);
  },

  setMessage(message) {
    const el = document.getElementById('auth-message');
    if (el) el.textContent = message || '';
  },

  setBusy(button, busy) {
    if (!button) return;
    button.disabled = busy;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
  },

  saveWorld(world, options) {
    if (this.visitRole === 'visitor' || this.visitRole === 'pending') return;
    if (!this.serverMode || !this.profile || !this.ready) return;
    const worldType = world.worldType === 'flat' ? 'flat' : (world.worldType === 'normal' ? 'normal' : this.activeWorldType);
    world.worldType = worldType;
    this.activeWorldType = worldType;
    if (typeof Game !== 'undefined') Game.activeWorldType = worldType;
    if (options && options.resetEdits) this.resetEditsPending = true;
    world.revision = ++this.saveRevision;
    this.savedWorld = world;
    const replaceEdits = this.resetEditsPending || (this.lastSavedSeed !== null && world.seed !== this.lastSavedSeed);
    const baseEdits = replaceEdits ? new Map() : this.serverEdits;
    const edits = Array.isArray(world.edits) ? world.edits : [];
    const delta = edits.filter((edit) => baseEdits.get(this.editKey(edit)) !== edit[3]);
    this.pendingSave = Object.assign({}, world, { edits: delta, editPatch: true, replaceEdits });
    this.persistRecovery();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      await this.flushSave();
    }, 350);
  },

  async flushSave(keepalive, suppressLock) {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.serverMode || !this.profile || !this.ready || !this.pendingSave || !this.savedWorld) return true;
    try {
      const snapshot = this.pendingSave;
      const fullSnapshot = this.savedWorld;
      const worldType = fullSnapshot.worldType === 'flat' ? 'flat' : 'normal';
      const body = JSON.stringify({ world: snapshot });
      const write = this.saveQueue.catch(() => {}).then(() => this.request('/api/world?type=' + worldType, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: !!keepalive,
      }));
      this.saveQueue = write;
      const result = await write;
      if (Number.isSafeInteger(result.revision)) this.saveRevision = Math.max(this.saveRevision, result.revision);
      this.serverRevision = Number.isSafeInteger(result.revision) ? result.revision : snapshot.revision;
      this.serverEdits = this.indexEdits(fullSnapshot.edits);
      this.lastSavedSeed = fullSnapshot.seed;
      if (snapshot.replaceEdits) this.resetEditsPending = false;
      if (this.pendingSave && this.pendingSave.revision === snapshot.revision) {
        this.pendingSave = null;
        this.clearRecovery();
      } else {
        this.persistRecovery();
      }
      return true;
    } catch (_) {
      if (!suppressLock) this.lockGame('The PC server connection was lost. Your latest changes may not have been saved.');
      return false;
    }
  },

  saveOnPageHide() {
    if (!this.serverMode || !this.profile || !this.ready || this.signingOut) return;
    let visitSyncQueued = false;
    if ((this.visitRole === 'owner' || this.visitRole === 'visitor') && this.visitActive) {
      const visitBody = JSON.stringify({
        cursor: this.visitCursor,
        player: this.visitPlayerState(),
        edits: this.visitEditDelta(),
        worldReady: this.sharedWorldReady,
      });
      if (visitBody.length <= 60 * 1024) {
        visitSyncQueued = true;
        this.request('/api/visit/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: visitBody, keepalive: true,
        }).catch(() => {});
      }
    }
    if (!this.pendingSave || !this.savedWorld) return;
    if (visitSyncQueued) {
      // Keep the remaining world snapshot recoverable locally. A second
      // keepalive could exceed the browser's shared in-flight byte budget.
      this.persistRecovery();
      return;
    }
    this.flushSave(true, true);
  },

  editKey(edit) { return edit[0] + ',' + edit[1] + ',' + edit[2]; },

  async refreshVisitLobby() {
    const lobby = document.getElementById('visit-lobby');
    if (!lobby || !this.serverMode || !this.profile || !this.ready || this.lobbyBusy) return;
    // Preserve native mobile select interactions across background polling.
    if (document.activeElement && document.activeElement.id === 'visit-host-mode') return;
    this.lobbyBusy = true;
    try {
      const data = await this.request('/api/visits');
      if (document.activeElement && document.activeElement.id === 'visit-host-mode') return;
      const previousMode = document.getElementById('visit-host-mode');
      if (previousMode) this.hostModeChoice = previousMode.value;
      lobby.replaceChildren();
      lobby.classList.remove('hidden');
      const title = document.createElement('h3');
      title.textContent = 'Visit a friend';
      lobby.appendChild(title);
      if (this.visitRole === 'owner') {
        const note = document.createElement('p');
        note.textContent = 'Your ' + this.modeName(this.sharedMode) + ' session is open for an approved visit.';
        lobby.appendChild(note);
      } else if (this.visitRole === 'visitor' || this.visitRole === 'pending') {
        const note = document.createElement('p');
        note.textContent = this.visitRole === 'pending' ? 'Waiting for the host to answer…' : 'You are visiting ' + (this.visitOwnerName || 'a friend') + '.';
        lobby.appendChild(note);
        const leave = document.createElement('button');
        leave.type = 'button';
        leave.textContent = this.visitRole === 'pending' ? 'Cancel request' : 'Leave visit';
        leave.onclick = () => this.endVisit();
        lobby.appendChild(leave);
        return;
      } else {
        const host = document.createElement('button');
        host.type = 'button';
        host.className = 'primary';
        const modeLabel = document.createElement('label');
        modeLabel.textContent = 'Choose a shared mode';
        modeLabel.htmlFor = 'visit-host-mode';
        const mode = document.createElement('select');
        mode.id = 'visit-host-mode';
        for (const [value, label] of [['play', 'Play & Build'], ['fight', 'Fight Arena'], ['observe', 'Observe World']]) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          mode.appendChild(option);
        }
        mode.value = this.hostModeChoice;
        mode.onchange = () => { this.hostModeChoice = mode.value; };
        host.textContent = 'Host my world';
        host.onclick = () => this.startHosting(mode.value);
        lobby.append(modeLabel, mode, host);
      }
      const owners = Array.isArray(data.owners) ? data.owners.filter(owner => owner.available) : [];
      if (!owners.length) {
        const note = document.createElement('p');
        note.textContent = this.visitRole === 'owner' ? 'Waiting for a visitor request.' : 'No friend is hosting right now.';
        lobby.appendChild(note);
      }
      for (const owner of owners) {
        const row = document.createElement('div');
        row.className = 'visit-owner';
        const name = document.createElement('span');
        name.textContent = owner.displayName + ' is hosting ' + this.modeName(owner.mode) + '.';
        const button = document.createElement('button');
        button.className = 'primary';
        button.type = 'button';
        button.textContent = 'Ask to visit';
        button.onclick = () => this.requestVisit(owner.id, owner.displayName);
        row.append(name, button);
        lobby.appendChild(row);
      }
    } catch (_) {
      lobby.replaceChildren();
      lobby.classList.remove('hidden');
      const note = document.createElement('p');
      note.textContent = 'Live visits are unavailable. Check that the PC server is running.';
      lobby.appendChild(note);
    } finally { this.lobbyBusy = false; }
  },

  startLobbyPolling() {
    clearInterval(this.lobbyTimer);
    this.lobbyTimer = setInterval(() => {
      if (Game.state === 'menu' && !this.visitRole) this.refreshVisitLobby();
    }, 2500);
  },

  modeName(mode) {
    return ({ play: 'Play & Build', fight: 'Fight Arena', observe: 'Observe World' })[mode] || 'Play & Build';
  },

  openVisitModePicker() {
    if (this.visitRole !== 'owner') return;
    const dialog = document.getElementById('visit-mode-dialog');
    if (dialog) dialog.classList.remove('hidden');
  },

  closeVisitModePicker() {
    const dialog = document.getElementById('visit-mode-dialog');
    if (dialog) dialog.classList.add('hidden');
  },

  async setVisitMode(mode) {
    if (this.visitRole !== 'owner' || !['play', 'fight', 'observe'].includes(mode)) return;
    const dialog = document.getElementById('visit-mode-dialog');
    const buttons = dialog ? Array.from(dialog.querySelectorAll('button')) : [];
    buttons.forEach(button => { button.disabled = true; });
    try {
      const result = await this.request('/api/visit/mode', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      this.sharedMode = result.mode;
      this.sharedModeRevision = result.modeRevision;
      if (this.visitTimer) {
        clearInterval(this.visitTimer);
        this.visitTimer = setInterval(() => this.syncVisit(), this.sharedMode === 'fight' ? 75 : 250);
      }
      this.closeVisitModePicker();
      Game.enterSharedMode(this.sharedMode, false);
      this.showVisitHud('The shared session is now ' + this.modeName(this.sharedMode) + '.');
      this.refreshVisitLobby();
    } catch (error) {
      this.showVisitHud(error.message);
    } finally { buttons.forEach(button => { button.disabled = false; }); }
  },

  async startHosting(mode) {
    if (this.visitRole) return;
    if (!await this.flushSave()) return;
    try {
      const hosted = await this.request('/api/visit/host', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: ['play', 'fight', 'observe'].includes(mode) ? mode : 'play', worldType: Game.activeWorldType, arenaCenter: [Game.world.originX, Game.world.originZ] }),
      });
      this.visitRole = 'owner';
      this.sharedWorldReady = false;
      this.visitActive = false;
      this.pendingSharedEdits.clear();
      this.remotePlayerState = null;
      this.visitOwnerId = this.profile.id;
      this.visitOwnerName = this.profile.displayName;
      this.visitCursor = 0;
      this.sharedMode = hosted.mode || mode || 'play';
      this.sharedArenaCenter = hosted.arenaCenter || null;
      this.sharedModeRevision = hosted.modeRevision || 1;
      this.sharedSentEdits = this.indexEdits(Game.world ? Array.from(Game.world.edits, ([key, id]) => key.split(',').map(Number).concat(id)) : []);
      this.startVisitPolling();
      this.showVisitHud('Your ' + this.modeName(this.sharedMode) + ' world is open. Approve each visitor here.');
      Game.enterSharedMode(this.sharedMode, false);
      this.refreshVisitLobby();
    } catch (error) { this.showVisitHud(error.message); }
  },

  async requestVisit(ownerId, ownerName) {
    if (this.visitRole) return;
    if (!await this.flushSave()) return;
    try {
      await this.request('/api/visit/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerId }),
      });
      this.visitRole = 'pending';
      this.sharedWorldReady = false;
      this.visitActive = false;
      this.pendingSharedEdits.clear();
      this.remotePlayerState = null;
      this.visitOwnerId = ownerId;
      this.visitOwnerName = ownerName;
      this.visitCursor = 0;
      this.showVisitHud('Visit request sent to ' + ownerName + '.');
      this.startVisitPolling();
      this.refreshVisitLobby();
    } catch (error) { this.showVisitHud(error.message); }
  },

  startVisitPolling() {
    clearInterval(this.visitTimer);
    this.visitTimer = setInterval(() => this.syncVisit(), this.sharedMode === 'fight' ? 75 : 250);
    this.syncVisit();
  },

  updateFightLobby() {
    const dialog = document.getElementById('shared-fight-dialog');
    const status = document.getElementById('shared-fight-status');
    if (dialog) {
      dialog.classList.remove('hidden');
      dialog.querySelectorAll('[data-shared-fight]').forEach(button => {
        button.disabled = !this.visitActive;
        button.setAttribute('aria-pressed', this.fightVotes[this.visitRole] === button.dataset.sharedFight ? 'true' : 'false');
      });
    }
    if (!status) return;
    if (!this.visitActive) { status.textContent = 'Fight Arena is ready. Invite a friend and approve their visit to choose a match.'; return; }
    const mine = this.fightVotes[this.visitRole];
    const other = this.fightVotes[this.visitRole === 'owner' ? 'visitor' : 'owner'];
    const name = choice => choice === 'duel' ? 'Duel' : 'Co-op';
    status.textContent = mine && other && mine !== other ? 'Different choices: you chose ' + name(mine) + ', your friend chose ' + name(other) + '. Choose the same style to start.' :
      mine ? 'You chose ' + name(mine) + '. Waiting for your friend to choose the same style.' :
      other ? 'Your friend chose ' + name(other) + '. Choose your match style.' : 'Both players must choose Duel or Co-op to start.';
  },

  async chooseSharedFight(choice) {
    if (!['duel', 'coop'].includes(choice) || !this.visitActive || this.sharedMode !== 'fight') return;
    try {
      const result = await this.request('/api/visit/fight-choice', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice }),
      });
      this.fightVotes = result.votes || this.fightVotes;
      this.updateFightLobby();
      this.syncVisit();
      this.showVisitHud(result.phase === 'active' ? 'Fight starting!' : 'Waiting for the other player to choose.');
    } catch (error) { this.showVisitHud(error.message); }
  },

  setSharedFightInput(input) {
    if (!this.visitActive || this.sharedMode !== 'fight') return;
    const actions = {};
    for (const key of ['attack', 'special', 'ult', 'altAttack']) {
      const down = !!input[key];
      if (down && !this.fightActionHeld[key]) this.fightActionSeq[key]++;
      this.fightActionHeld[key] = down;
      actions[key] = this.fightActionSeq[key];
    }
    this.fightLocalInput = {
      mx: input.mx || 0, mz: input.mz || 0, turn: input.turn || 0,
      yaw: input.yaw || 0,
      jump: !!input.jump, sneak: !!input.sneak, actions,
    };
  },

  visitPlayerState() {
    const player = Game.players && Game.players[0];
    return player ? {
      pos: player.pos,
      yaw: player.yaw,
      pitch: player.pitch,
      characterId: player.char.id,
    } : null;
  },

  visitEditDelta() {
    if (!this.visitActive) return [];
    return Array.from(this.pendingSharedEdits, ([key, id]) => key.split(',').map(Number).concat(id)).slice(0, 100);
  },

  queueSharedEdit(x, y, z, id) {
    if (!this.visitActive || (this.visitRole !== 'owner' && this.visitRole !== 'visitor')) return;
    this.pendingSharedEdits.set(x + ',' + y + ',' + z, id);
  },

  async loadVisitWorld(world) {
    this.sharedWorldLoading = true;
    this.visitLoadError = null;
    let heartbeatBusy = false, ended = null;
    const ownerId = this.visitOwnerId;
    const heartbeat = async () => {
      if (heartbeatBusy || this.visitRole !== 'visitor' || this.visitOwnerId !== ownerId) return;
      heartbeatBusy = true;
      try {
        const data = await this.request('/api/visit/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cursor: this.visitCursor, loadingOnly: true, worldReady: false, edits: [] }),
        });
        if (data.state === 'closed' || data.state === 'none') ended = data.reason || 'The host ended the visit during loading.';
        if (data.mode) this.sharedMode = data.mode;
      if (Array.isArray(data.arenaCenter)) this.sharedArenaCenter = data.arenaCenter;
      } catch (_) { /* Main sync handles persistent network failure after loading. */ }
      finally { heartbeatBusy = false; }
    };
    const timer = setInterval(heartbeat, 1000);
    try {
      await Game.enterSharedWorld(world, this.sharedMode);
      if (ended || this.visitRole !== 'visitor' || this.visitOwnerId !== ownerId) {
        if (this.visitRole === 'visitor') await this.handleVisitEnded(ended || 'The visit ended.');
        return false;
      }
      this.sharedWorldReady = true;
      return true;
    } catch (error) {
      this.visitLoadError = error && error.message || 'Could not load the shared world.';
      throw error;
    } finally {
      clearInterval(timer);
      this.sharedWorldLoading = false;
    }
  },

  async syncVisit() {
    if (!this.visitRole || this.visitBusy) return;
    this.visitBusy = true;
    const sentEdits = this.visitRole === 'pending' ? [] : this.visitEditDelta();
    try {
      const data = await this.request('/api/visit/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cursor: this.visitCursor, player: this.visitPlayerState(), edits: sentEdits, worldReady: this.sharedWorldReady,
          fightInput: this.fightLocalInput,
          fightState: this.visitRole === 'owner' && Game.mode === 'fight' && Game.sharedFightStarted ? Game.serializeSharedFightState() : null }),
      });
      if (Number.isSafeInteger(data.cursor)) this.visitCursor = data.cursor;
      if (data.state === 'closed' || data.state === 'none') {
        await this.handleVisitEnded(data.reason || 'The live visit ended. Ask the host to invite you again.');
        return;
      }
      if (data.state === 'active') {
        for (const edit of sentEdits) {
          const key = this.editKey(edit);
          if (this.pendingSharedEdits.get(key) === edit[3]) this.pendingSharedEdits.delete(key);
          this.sharedSentEdits.set(key, edit[3]);
        }
      }
      const wasActive = this.visitActive;
      this.visitActive = data.state === 'active';
      if (this.visitRole === 'owner' && this.visitActive && !wasActive && Game.world) {
        for (const [key, id] of Game.world.edits) if (this.sharedSentEdits.get(key) !== id) this.pendingSharedEdits.set(key, id);
      }
      if (this.visitRole === 'owner' && this.visitActive && Number.isSafeInteger(data.worldRevision)) {
        this.serverRevision = Math.max(this.serverRevision, data.worldRevision);
        this.saveRevision = Math.max(this.saveRevision, data.worldRevision);
      }
      if (this.visitRole === 'pending') {
        if (data.state === 'pending') {
          this.showVisitHud('Waiting for ' + (data.ownerName || this.visitOwnerName) + ' to approve…');
          return;
        }
        if (data.state === 'active' && data.role === 'visitor') this.visitRole = 'visitor';
        else return;
      }
      if (data.pending) {
        this.pendingVisitRequest = data.pending;
        // A pointer-locked canvas captures all mouse clicks, including clicks
        // on the approval HUD. Release it while the owner has a request to
        // answer so this control works from a normal desktop browser.
        if (this.visitRole === 'owner' && document.pointerLockElement === Game.canvas) Input.releaseLock();
        this.showVisitHud('A friend would like to visit your world.', data.pending.displayName);
      } else if (this.visitRole === 'owner') {
        this.pendingVisitRequest = null;
        this.showVisitHud(data.state === 'active'
          ? 'Your friend is visiting your ' + this.modeName(data.mode) + ' world.'
          : 'Your ' + this.modeName(data.mode) + ' world is open.');
      }
      const modeChanged = data.mode && (data.mode !== this.sharedMode || data.modeRevision > this.sharedModeRevision);
      if (data.mode) this.sharedMode = data.mode;
      if (Array.isArray(data.arenaCenter)) this.sharedArenaCenter = data.arenaCenter;
      if (Number.isSafeInteger(data.modeRevision)) this.sharedModeRevision = data.modeRevision;
      if (modeChanged && this.visitTimer) {
        clearInterval(this.visitTimer);
        this.visitTimer = setInterval(() => this.syncVisit(), this.sharedMode === 'fight' ? 75 : 250);
      }
      this.fightChoice = data.fightChoice || null;
      this.fightVotes = data.fightVotes || this.fightVotes;
      this.fightPhase = data.fightPhase || 'setup';
      this.fightRemoteInput = data.fightInput || null;
      this.fightState = data.fightState || null;
      if (this.sharedMode === 'fight') {
        for (const event of Array.isArray(data.events) ? data.events : []) {
          if (event.type === 'fight-action' && event.data && event.data.role === 'visitor') this.fightRemoteActions.push(event.data.action);
        }
        if (this.fightRemoteActions.length > 32) this.fightRemoteActions.splice(0, this.fightRemoteActions.length - 32);
      }
      this.remotePlayerState = data.remotePlayer || null;
      for (const event of Array.isArray(data.events) ? data.events : []) {
        if (event.type === 'edit' && Array.isArray(event.data)) {
          const edit = event.data;
          if (Game.world && Game.world.applyRemoteEdit(edit[0], edit[1], edit[2], edit[3])) {
            const key = this.editKey(edit);
            this.pendingSharedEdits.delete(key);
            this.sharedSentEdits.set(key, edit[3]);
          }
        } else if (event.type === 'joined') {
          this.showVisitHud(event.data.displayName + ' joined your world.');
        } else if (event.type === 'left') {
          this.remotePlayerState = null;
          this.showVisitHud((event.data.displayName || 'Your visitor') + ' left your world.');
        }
      }
      if (data.world && this.visitRole === 'visitor' && !this.sharedWorldReady) {
        this.visitOwnerName = data.ownerName || this.visitOwnerName;
        this.visitRole = 'visitor';
        this.visitCursor = data.cursor || this.visitCursor;
        this.sharedSentEdits = this.indexEdits(data.world.edits);
        this.pendingSharedEdits.clear();
        if (!await this.loadVisitWorld(data.world)) return;
        this.showVisitHud('You are visiting ' + this.visitOwnerName + '. Blocks you build save in their world.');
        this.refreshVisitLobby();
      } else if (data.resync && data.world && Game.world) {
        for (const edit of data.world.edits || []) {
          if (Game.world.applyRemoteEdit(edit[0], edit[1], edit[2], edit[3])) {
            const key = this.editKey(edit);
            this.pendingSharedEdits.delete(key);
            this.sharedSentEdits.set(key, edit[3]);
          }
        }
      }
      // Reconcile gameplay only after a visitor has finished loading the host world.
      const worldReady = this.visitRole === 'owner' || this.sharedWorldReady;
      if (worldReady && Game.world) {
        if (this.sharedMode === 'fight') {
          if (this.visitRole === 'owner' && !this.visitActive) {
            if (!Game.hostedFightPreview || Game.mode !== 'fight') Game.startHostedFightPreview();
            const dialog = document.getElementById('shared-fight-dialog');
            if (dialog) dialog.classList.add('hidden');
          } else if (this.visitActive && this.fightPhase === 'active' && this.fightChoice) {
            if (!Game.sharedFightStarted || Game.mode !== 'fight') Game.startSharedFight(this.fightChoice);
            if (this.visitRole === 'visitor' && this.fightState) Game.applySharedFightState(this.fightState);
            const dialog = document.getElementById('shared-fight-dialog');
            const roundEnded = this.visitRole === 'owner' ? Fight.roundActive === false : !!(this.fightState && this.fightState.roundActive === false);
            if (roundEnded) {
              this.updateFightLobby();
              const status = document.getElementById('shared-fight-status');
              if (status) status.textContent = 'Match finished. Both players choose Duel or Co-op for a rematch.';
            } else if (dialog) dialog.classList.add('hidden');
          } else {
            if (!Game.sharedFightWaiting || Game.mode !== 'fight') Game.openSharedFightChoice();
            this.updateFightLobby();
          }
        } else if (Game.mode !== this.sharedMode || Game.sharedFightWaiting) {
          Game.sharedFightWaiting = false;
          const dialog = document.getElementById('shared-fight-dialog');
          if (dialog) dialog.classList.add('hidden');
          Game.enterSharedMode(this.sharedMode, false);
        }
      }
      this.visitFailures = 0;
    } catch (error) {
      if (this.visitLoadError) {
        const message = this.visitLoadError;
        this.visitLoadError = null;
        console.warn('Shared world load failed:', message);
        await this.handleVisitEnded('Could not load the shared world: ' + message);
        return;
      }
      this.visitFailures++;
      if (this.visitFailures >= 10) await this.handleVisitEnded('The network connection to this live world was lost. Ask the host to approve a new visit.');
    } finally { this.visitBusy = false; }
  },

  showVisitHud(message, requesterName) {
    const hud = document.getElementById('visit-hud');
    const status = document.getElementById('visit-status');
    const request = document.getElementById('visit-request');
    const end = document.getElementById('btn-visit-end');
    const changeMode = document.getElementById('btn-visit-mode');
    if (!hud) return;
    if (!this.visitRole) {
      if (message) UI.toast(message);
      return;
    }
    hud.classList.remove('hidden');
    if (status) status.textContent = message || '';
    if (request) request.classList.toggle('hidden', !requesterName);
    const name = document.getElementById('visit-request-name');
    if (name) name.textContent = requesterName ? requesterName + ' wants to visit.' : '';
    if (end) end.textContent = this.visitRole === 'owner' ? 'Stop hosting' : (this.visitRole === 'pending' ? 'Cancel request' : 'Leave visit');
    if (changeMode) {
      changeMode.classList.toggle('hidden', this.visitRole !== 'owner');
      changeMode.textContent = Game.isTouch ? 'Change shared mode' : 'Change shared mode (M)';
    }
  },

  hideVisitHud() {
    const hud = document.getElementById('visit-hud');
    const request = document.getElementById('visit-request');
    if (hud) hud.classList.add('hidden');
    if (request) request.classList.add('hidden');
    this.closeVisitModePicker();
    const fightDialog = document.getElementById('shared-fight-dialog');
    if (fightDialog) fightDialog.classList.add('hidden');
  },

  updateRemotePlayer(player, dt) {
    if (!player) return;
    const state = this.remotePlayerState;
    if (!state) { player.networkRemoteVisible = false; return; }
    player.networkRemoteVisible = true;
    const target = state.pos;
    if (!player.networkRemoteInitialized || Math.hypot(player.pos[0] - target[0], player.pos[1] - target[1], player.pos[2] - target[2]) > 14) {
      player.pos = target.slice();
      player.networkRemoteInitialized = true;
    } else {
      const blend = Math.min(1, (dt || 0.016) * 14);
      for (let i = 0; i < 3; i++) player.pos[i] += (target[i] - player.pos[i]) * blend;
    }
    player.yaw = state.yaw;
    player.pitch = state.pitch;
    const character = characterById(state.characterId);
    if (player.char !== character) player.char = character;
  },

  async respondToVisit(approve) {
    if (this.visitRole !== 'owner' || !this.pendingVisitRequest) return;
    const request = this.pendingVisitRequest;
    const freezePlay = approve && Game.state === 'play' && !Game.paused;
    if (freezePlay) Game.paused = true;
    try {
      if (approve) {
        for (let pass = 0; this.pendingSave && pass < 4; pass++) {
          if (!await this.flushSave()) throw new Error('Your latest save did not reach the PC. Try approving again after reconnecting.');
        }
        if (this.pendingSave) throw new Error('Pause building for a moment, then approve the visit again.');
      }
      await this.request('/api/visit/respond', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: request.id, approve: !!approve }),
      });
      this.pendingVisitRequest = null;
      this.showVisitHud(approve ? request.displayName + ' is joining your world.' : 'Visit request declined.');
      this.refreshVisitLobby();
    } catch (error) {
      this.pendingVisitRequest = null;
      this.showVisitHud(error.message);
    } finally { if (freezePlay) Game.paused = false; }
  },

  async endVisit() {
    const role = this.visitRole;
    if (!role) return;
    if (role === 'visitor' && this.visitActive) {
      const deadline = Date.now() + 2000;
      while (this.pendingSharedEdits.size && this.visitRole === role && Date.now() < deadline) {
        if (this.visitBusy) await new Promise(resolve => setTimeout(resolve, 40));
        else await this.syncVisit();
      }
      if (this.visitRole !== role) return;
      if (this.pendingSharedEdits.size) UI.toast('Some last block changes may not have reached the host yet.');
    }
    clearInterval(this.visitTimer);
    this.visitTimer = null;
    this.visitRole = null;
    this.sharedArenaCenter = null;
    this.sharedWorldReady = false;
    this.visitActive = false;
    this.pendingSharedEdits.clear();
    this.pendingVisitRequest = null;
    this.remotePlayerState = null;
    this.hideVisitHud();
    try {
      await this.request(role === 'owner' ? '/api/visit/stop' : '/api/visit/leave', { method: 'POST' });
    } catch (_) { /* the server also expires visits when heartbeats stop */ }
    if (role === 'visitor') await Game.restorePersonalWorld();
    else if (role === 'owner') Game.toMenu();
    else this.refreshVisitLobby();
  },

  async handleVisitEnded(message) {
    const role = this.visitRole;
    if (!role) return;
    if (this.pendingSharedEdits.size && role === 'visitor') message = (message || 'The live visit ended.') + ' Some last block changes may not have reached the host.';
    clearInterval(this.visitTimer);
    this.visitTimer = null;
    this.visitRole = null;
    this.sharedArenaCenter = null;
    this.sharedWorldReady = false;
    this.visitActive = false;
    this.pendingSharedEdits.clear();
    this.pendingVisitRequest = null;
    this.remotePlayerState = null;
    this.hideVisitHud();
    if (role === 'visitor') await Game.restorePersonalWorld();
    else if (role === 'owner') Game.toMenu();
    this.refreshVisitLobby();
    if (message) UI.toast(message);
  },

  recoveryKey() { return 'blocky-world-server-recovery-v1:' + (this.profile ? this.profile.id : ''); },

  persistRecovery() {
    if (!this.profile || !this.savedWorld || !this.pendingSave) return;
    try {
      localStorage.setItem(this.recoveryKey(), JSON.stringify({
        baseRevision: this.serverRevision,
        replaceEdits: !!(this.pendingSave && this.pendingSave.replaceEdits),
        world: this.savedWorld,
      }));
    } catch (_) { /* recovery is best-effort when browser storage is unavailable */ }
  },

  clearRecovery() {
    if (!this.profile) return;
    try { localStorage.removeItem(this.recoveryKey()); } catch (_) { /* server save remains authoritative */ }
  },

  async restoreRecovery() {
    if (!this.profile) return false;
    try {
      const raw = localStorage.getItem(this.recoveryKey());
      if (!raw) return false;
      const recovery = JSON.parse(raw);
      if (!recovery || !recovery.world || !Array.isArray(recovery.world.edits)) return false;
      const recoveryType = recovery.world.worldType === 'flat' ? 'flat' : 'normal';
      if (recoveryType !== this.activeWorldType) {
        const data = await this.request('/api/world?type=' + recoveryType);
        this.adoptWorldType(recoveryType, data.world);
      }
      if (recovery.baseRevision !== this.serverRevision) {
        this.recoveryConflict = recovery;
        this.showRecoveryConflict();
        return true;
      }
      this.savedWorld = Object.assign({}, recovery.world, { worldType: recoveryType });
      this.activeWorldType = recoveryType;
      try { localStorage.setItem('blocky-world-selected-type', recoveryType); } catch (_) {}
      Game.activeWorldType = recoveryType;
      this.saveRevision = this.serverRevision;
      this.resetEditsPending = recovery.replaceEdits === true || recovery.world.seed !== this.lastSavedSeed;
      this.saveWorld(this.savedWorld);
      return false;
    } catch (_) { /* an unreadable recovery copy is left in place for manual inspection */ }
    return false;
  },

  showRecoveryConflict() {
    this.ready = false;
    this.showGate('A newer PC save exists alongside this browser’s unsaved recovery copy. Choose which world to open.');
    for (const id of ['login-form', 'setup-form', 'save-recovery-actions']) {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    }
    const actions = document.getElementById('recovery-conflict-actions');
    if (actions) actions.classList.remove('hidden');
  },

  useRecoveryCopy() {
    if (!this.recoveryConflict) return;
    const recovery = this.recoveryConflict;
    this.recoveryConflict = null;
    this.activeWorldType = recovery.world.worldType === 'flat' ? 'flat' : 'normal';
    this.savedWorld = Object.assign({}, recovery.world, { worldType: this.activeWorldType });
    try { localStorage.setItem('blocky-world-selected-type', this.activeWorldType); } catch (_) {}
    Game.activeWorldType = this.activeWorldType;
    this.saveRevision = this.serverRevision;
    this.resetEditsPending = true;
    this.ready = true;
    const actions = document.getElementById('recovery-conflict-actions');
    if (actions) actions.classList.add('hidden');
    const screen = document.getElementById('auth-screen');
    if (screen) screen.classList.add('hidden');
    this.saveWorld(this.savedWorld, { resetEdits: true });
    this.startGameIfAllowed();
  },

  keepServerWorld() {
    if (!this.recoveryConflict) return;
    this.recoveryConflict = null;
    this.clearRecovery();
    this.ready = true;
    const actions = document.getElementById('recovery-conflict-actions');
    if (actions) actions.classList.add('hidden');
    const screen = document.getElementById('auth-screen');
    if (screen) screen.classList.add('hidden');
    this.startGameIfAllowed();
  },

  indexEdits(edits) {
    const indexed = new Map();
    for (const edit of Array.isArray(edits) ? edits : []) {
      if (Array.isArray(edit) && edit.length === 4 && edit.every(Number.isInteger)) indexed.set(this.editKey(edit), edit[3]);
    }
    return indexed;
  },

  startSessionCheck() {
    clearInterval(this.sessionTimer);
    this.sessionCheckFailures = 0;
    this.sessionTimer = setInterval(async () => {
      try {
        const status = await this.request('/api/status');
        this.sessionCheckFailures = 0;
        if (!status.authenticated) this.lockGame('Please sign in again to continue.');
      } catch (_) {
        // Mobile Safari can briefly suspend networking while the tab is backgrounded.
        // Retry transient failures; only return to sign-in after sustained loss.
        this.sessionCheckFailures++;
        if (this.sessionCheckFailures >= 3) {
          this.lockGame('The PC server connection was lost. Start it again and sign in.');
        }
      }
    }, 15000);
  },

  lockGame(message) {
    if (this.locked) return;
    this.locked = true;
    this.ready = false;
    const overlay = document.getElementById('auth-screen');
    if (overlay) overlay.classList.remove('hidden');
    for (const id of ['menu', 'pause', 'hud', 'touch-ui']) {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    }
    this.showLogin(message);
  },

  async logout() {
    if (this.visitRole) await this.endVisit();
    if (this.signingOut && this.locked) return;
    this.signingOut = true;
    const login = document.getElementById('login-form');
    const setup = document.getElementById('setup-form');
    if (login) login.classList.add('hidden');
    if (setup) setup.classList.add('hidden');
    const actions = document.getElementById('save-recovery-actions');
    if (actions) actions.classList.add('hidden');
    this.showGate('Saving your world and signing out…');
    if (!await this.flushSave(false, true)) {
      this.signingOut = false;
      this.showGate('The save did not reach the PC. Retry the save or return to the game with your current changes still open.');
      if (actions) actions.classList.remove('hidden');
      return;
    }
    try { await this.request('/api/logout', { method: 'POST' }); } catch (_) { /* session may already be gone */ }
    location.reload();
  },

  returnToGame() {
    this.signingOut = false;
    const actions = document.getElementById('save-recovery-actions');
    if (actions) actions.classList.add('hidden');
    const screen = document.getElementById('auth-screen');
    if (screen) screen.classList.add('hidden');
    this.startSessionCheck();
  },
};

window.Network = Network;
document.addEventListener('DOMContentLoaded', () => {
  Network.readyPromise = Network.init().catch((error) => {
    Network.showGate(error.message || 'The game could not start.');
  });
});

