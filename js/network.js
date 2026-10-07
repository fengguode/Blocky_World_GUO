'use strict';

/* Server-backed profile access. File:// play remains fully offline. */
const Network = {
  serverMode: false,
  ready: false,
  profile: null,
  savedWorld: null,
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
      } else if (status.authenticated && status.user) {
        this.profile = status.user;
        this.savedWorld = (await this.request('/api/world')).world;
        this.saveRevision = Number.isSafeInteger(this.savedWorld.revision) ? this.savedWorld.revision : 0;
        this.ready = true;
      } else {
        this.showLogin();
      }
    } catch (_) {
      this.showGate('The family PC server is not available. Start it on the PC, then refresh this page.');
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
    if (this.serverMode) this.startSessionCheck();
  },

  bindForms() {
    const login = document.getElementById('login-form');
    const setup = document.getElementById('setup-form');
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
      const names = [document.getElementById('setup-name-1'), document.getElementById('setup-name-2')];
      const pins = [document.getElementById('setup-pin-1'), document.getElementById('setup-pin-2')];
      this.setBusy(button, true);
      try {
        await this.request('/api/setup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bootstrapCode: document.getElementById('setup-code').value,
            users: [
              { id: 'p1', displayName: names[0].value, pin: pins[0].value },
              { id: 'p2', displayName: names[1].value, pin: pins[1].value },
            ],
          }),
        });
        for (const input of [document.getElementById('setup-code'), ...names, ...pins]) input.value = '';
        this.showLogin('Setup is complete. Choose a profile and sign in.');
      } catch (error) { this.setMessage(error.message); }
      finally { this.setBusy(button, false); }
    });
    document.addEventListener('click', (event) => {
      if (event.target && event.target.id === 'btn-logout') this.logout();
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
    if (login) login.classList.remove('hidden');
    if (setup) setup.classList.add('hidden');
    if (message) this.setMessage(message);
  },

  showSetup() {
    this.showGate('First-time setup happens here. The one-time code is printed in the PC server window.');
    const login = document.getElementById('login-form');
    const setup = document.getElementById('setup-form');
    if (login) login.classList.add('hidden');
    if (setup) setup.classList.remove('hidden');
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

  saveWorld(world) {
    if (!this.serverMode || !this.profile || !this.ready) return;
    world.revision = ++this.saveRevision;
    this.savedWorld = world;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      await this.flushSave();
    }, 350);
  },

  async flushSave(keepalive) {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.serverMode || !this.profile || !this.ready || !this.savedWorld) return true;
    try {
      const snapshot = this.savedWorld;
      const body = JSON.stringify({ world: snapshot });
      const write = this.saveQueue.catch(() => {}).then(() => this.request('/api/world', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: !!keepalive,
      }));
      this.saveQueue = write;
      const result = await write;
      if (Number.isSafeInteger(result.revision)) this.saveRevision = Math.max(this.saveRevision, result.revision);
      return true;
    } catch (_) {
      this.lockGame('The PC server connection was lost. Your latest changes may not have been saved.');
      return false;
    }
  },

  saveOnPageHide() {
    if (!this.serverMode || !this.profile || !this.ready || !this.savedWorld || this.signingOut) return;
    const body = JSON.stringify({ world: this.savedWorld });
    if (navigator.sendBeacon && body.length <= 60 * 1024) {
      const queued = navigator.sendBeacon('/api/world/flush', new Blob([body], { type: 'text/plain;charset=UTF-8' }));
      if (queued) return;
    }
    this.flushSave(true);
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
    await this.flushSave();
    this.signingOut = true;
    try { await this.request('/api/logout', { method: 'POST' }); } catch (_) { /* session may already be gone */ }
    location.reload();
  },
};

window.Network = Network;
document.addEventListener('DOMContentLoaded', () => {
  Network.readyPromise = Network.init().catch((error) => {
    Network.showGate(error.message || 'The game could not start.');
  });
});
