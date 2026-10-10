'use strict';

/* Server-backed profile access. File:// play remains fully offline. */
const Network = {
  serverMode: false,
  ready: false,
  profile: null,
  savedWorld: null,
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
  sharedSentEdits: new Map(),
  pendingSharedEdits: new Map(),
  visitActive: false,
  sharedWorldReady: false,
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
  readyPromise: null,

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
        this.savedWorld = (await this.request('/api/world')).world;
        this.saveRevision = Number.isSafeInteger(this.savedWorld.revision) ? this.savedWorld.revision : 0;
        this.serverRevision = this.saveRevision;
        this.serverEdits = this.indexEdits(this.savedWorld.edits);
        this.lastSavedSeed = this.savedWorld.seed;
        this.ready = true;
        this.restoreRecovery();
      } else {
        this.showLogin();
      }
    } catch (_) {
      this.showLogin('The family PC server is not available. Start it on the PC, then refresh this page.');
    }
  },

  async request(path, options) {
    const response = await fetch(path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {}));
    let data = {};
    try { data = await response.json(); } catch (_) { /* show a useful HTTP error below */ }
    if (!response.ok) throw new Error(data.error || 'The server could not complete that request.');
    return data;
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
      const body = JSON.stringify({ world: snapshot });
      const write = this.saveQueue.catch(() => {}).then(() => this.request('/api/world', {
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
    if ((this.visitRole === 'owner' || this.visitRole === 'visitor') && this.visitActive && navigator.sendBeacon) {
      const visitBody = JSON.stringify({
        cursor: this.visitCursor,
        player: this.visitPlayerState(),
        edits: this.visitEditDelta(),
        worldReady: this.sharedWorldReady,
      });
      if (visitBody.length <= 60 * 1024) navigator.sendBeacon('/api/visit/sync', new Blob([visitBody], { type: 'application/json' }));
    }
    if (!this.pendingSave || !this.savedWorld) return;
    const body = JSON.stringify({ world: this.pendingSave });
    if (navigator.sendBeacon && body.length <= 60 * 1024) {
      const queued = navigator.sendBeacon('/api/world/flush', new Blob([body], { type: 'text/plain;charset=UTF-8' }));
      if (queued) return;
    }
    this.flushSave(true);
  },

  editKey(edit) { return edit[0] + ',' + edit[1] + ',' + edit[2]; },

  async refreshVisitLobby() {
    const lobby = document.getElementById('visit-lobby');
    if (!lobby || !this.serverMode || !this.profile || !this.ready || this.lobbyBusy) return;
    this.lobbyBusy = true;
    try {
      const data = await this.request('/api/visits');
      lobby.replaceChildren();
      lobby.classList.remove('hidden');
      const title = document.createElement('h3');
      title.textContent = 'Visit a friend';
      lobby.appendChild(title);
      if (this.visitRole === 'owner') {
        const note = document.createElement('p');
        note.textContent = 'Your Play & Build world is open for an approved visit.';
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
        host.textContent = 'Host my Play & Build world';
        host.onclick = () => this.startHosting();
        lobby.appendChild(host);
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
        name.textContent = owner.displayName + ' is hosting Play & Build';
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

  async startHosting() {
    if (this.visitRole) return;
    if (!await this.flushSave()) return;
    try {
      await this.request('/api/visit/host', { method: 'POST' });
      this.visitRole = 'owner';
      this.sharedWorldReady = false;
      this.visitActive = false;
      this.pendingSharedEdits.clear();
      this.remotePlayerState = null;
      this.visitOwnerId = this.profile.id;
      this.visitOwnerName = this.profile.displayName;
      this.visitCursor = 0;
      this.sharedSentEdits = this.indexEdits(Game.world ? Array.from(Game.world.edits, ([key, id]) => key.split(',').map(Number).concat(id)) : []);
      this.startVisitPolling();
      this.showVisitHud('Your Play & Build world is open. Approve each visitor here.');
      Game.startPlay();
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
    this.visitTimer = setInterval(() => this.syncVisit(), 250);
    this.syncVisit();
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

  async syncVisit() {
    if (!this.visitRole || this.visitBusy) return;
    this.visitBusy = true;
    const sentEdits = this.visitRole === 'pending' ? [] : this.visitEditDelta();
    try {
      const data = await this.request('/api/visit/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cursor: this.visitCursor, player: this.visitPlayerState(), edits: sentEdits, worldReady: this.sharedWorldReady }),
      });
      this.visitFailures = 0;
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
        this.showVisitHud('A friend would like to visit your world.', data.pending.displayName);
      } else if (this.visitRole === 'owner') {
        this.pendingVisitRequest = null;
        this.showVisitHud(data.state === 'active' ? 'Your friend is visiting your Play & Build world.' : 'Your Play & Build world is open.');
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
      if (data.world && this.visitRole === 'visitor') {
        this.visitOwnerName = data.ownerName || this.visitOwnerName;
        this.visitRole = 'visitor';
        this.visitCursor = data.cursor || this.visitCursor;
        this.sharedSentEdits = this.indexEdits(data.world.edits);
        this.pendingSharedEdits.clear();
        await Game.enterSharedWorld(data.world);
        this.sharedWorldReady = true;
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
    } catch (_) {
      this.visitFailures++;
      if (this.visitFailures >= 10) await this.handleVisitEnded('The network connection to this live world was lost. Ask the host to approve a new visit.');
    } finally { this.visitBusy = false; }
  },

  showVisitHud(message, requesterName) {
    const hud = document.getElementById('visit-hud');
    const status = document.getElementById('visit-status');
    const request = document.getElementById('visit-request');
    const end = document.getElementById('btn-visit-end');
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
  },

  hideVisitHud() {
    const hud = document.getElementById('visit-hud');
    const request = document.getElementById('visit-request');
    if (hud) hud.classList.add('hidden');
    if (request) request.classList.add('hidden');
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

  restoreRecovery() {
    if (!this.profile) return;
    try {
      const raw = localStorage.getItem(this.recoveryKey());
      if (!raw) return false;
      const recovery = JSON.parse(raw);
      if (!recovery || !recovery.world || !Array.isArray(recovery.world.edits)) return false;
      if (recovery.baseRevision !== this.serverRevision) {
        this.recoveryConflict = recovery;
        this.showRecoveryConflict();
        return true;
      }
      this.savedWorld = recovery.world;
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
    this.savedWorld = Object.assign({}, recovery.world);
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
    this.sessionTimer = setInterval(async () => {
      try {
        const status = await this.request('/api/status');
        if (!status.authenticated) this.lockGame('Please sign in again to continue.');
      } catch (_) {
        this.lockGame('The PC server connection was lost. Start it again and sign in.');
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

