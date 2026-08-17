const { app, BrowserWindow, session, systemPreferences, powerSaveBlocker, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// A kiosk display has no keyboard and nobody watching it, so this process
// recovers from as much as it can on its own: it logs itself in, grants its own
// camera and microphone access, keeps the screen awake, and reloads after a
// renderer crash, a hang, a lost window, or a network drop.
//
// What it cannot do is restart itself once the process is gone, or start after a
// reboot. That is left to the OS supervisor - see scripts/com.deyan.portal.plist,
// the LaunchAgent that runs on the display machines.

const DEFAULTS = {
  portalUrl: 'https://dy-portal.onrender.com',
  password: '',
  localOffice: 'office-ny',
  remoteOffice: 'office-serbia',
  kiosk: true
};

const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;

let mainWindow = null;
let powerBlockerId = null;
let retryAttempts = 0;
let retryTimer = null;
let config = DEFAULTS;
// Distinguishes "someone asked us to quit" from "we lost the window", so only
// the former is allowed to end the process.
let isQuitting = false;

// Config comes from, in increasing order of precedence: the bundled defaults, a
// portal.config.json placed next to the app or in userData, then environment
// variables. That lets one signed build serve both offices - only the config
// file differs between machines.
function loadConfig() {
  const candidates = [
    path.join(app.getPath('userData'), 'portal.config.json'),
    path.join(process.resourcesPath || __dirname, 'portal.config.json'),
    path.join(__dirname, 'portal.config.json')
  ];

  let fromFile = {};
  for (const file of candidates) {
    try {
      fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
      console.log(`Loaded config from ${file}`);
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`Ignoring unreadable config at ${file}:`, err.message);
      }
    }
  }

  const fromEnv = {};
  if (process.env.PORTAL_URL) fromEnv.portalUrl = process.env.PORTAL_URL;
  if (process.env.PORTAL_PASSWORD) fromEnv.password = process.env.PORTAL_PASSWORD;
  if (process.env.PORTAL_LOCAL_OFFICE) fromEnv.localOffice = process.env.PORTAL_LOCAL_OFFICE;
  if (process.env.PORTAL_REMOTE_OFFICE) fromEnv.remoteOffice = process.env.PORTAL_REMOTE_OFFICE;
  if (process.env.PORTAL_KIOSK) fromEnv.kiosk = process.env.PORTAL_KIOSK !== 'false';

  return { ...DEFAULTS, ...fromFile, ...fromEnv };
}

function portalOrigin() {
  return new URL(config.portalUrl).origin;
}

// The office is pinned via query params, which the client reads in main.js and
// uses to skip the office-selection screen entirely.
function portalPageUrl() {
  const url = new URL('/client/index.html', config.portalUrl);
  url.searchParams.set('local', config.localOffice);
  url.searchParams.set('remote', config.remoteOffice);
  return url.toString();
}

function isPortalUrl(value) {
  try {
    return new URL(value).origin === portalOrigin();
  } catch {
    return false;
  }
}

// Only the portal itself gets camera and microphone, and only these two
// permissions - anything else a page asks for is denied.
const ALLOWED_PERMISSIONS = new Set(['media', 'audioCapture', 'videoCapture']);

function configurePermissions(ses) {
  ses.setPermissionRequestHandler((contents, permission, callback) => {
    const requester = contents ? contents.getURL() : '';
    callback(ALLOWED_PERMISSIONS.has(permission) && isPortalUrl(requester));
  });

  // getUserMedia and enumerateDevices consult this synchronous path rather than
  // the request handler above; without it the camera list comes back unlabelled.
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    const origin = requestingOrigin || (contents ? contents.getURL() : '');
    return ALLOWED_PERMISSIONS.has(permission) && isPortalUrl(origin);
  });

  ses.setDevicePermissionHandler((details) => isPortalUrl(details.origin));
}

// macOS gates camera and microphone at the OS level on top of the web
// permission, and the prompt only appears once - if it is refused the portal
// comes up black with no obvious cause, so the result is logged.
async function requestMediaAccess() {
  if (process.platform !== 'darwin') return;

  for (const type of ['camera', 'microphone']) {
    try {
      const granted = await systemPreferences.askForMediaAccess(type);
      if (!granted) {
        console.error(`macOS ${type} access denied - grant it in System Settings > Privacy & Security`);
      }
    } catch (err) {
      console.error(`Could not request ${type} access:`, err.message);
    }
  }
}

// Authenticates in the main process so the kiosk never sees the login page. The
// session cookie lands in the shared cookie jar, so the subsequent page load is
// already authenticated. Cookies persist across restarts, so this is normally a
// no-op after the first launch.
async function ensureLoggedIn(ses) {
  if (!config.password) {
    console.warn('No password configured - the portal will show its login page.');
    return false;
  }

  try {
    const response = await ses.fetch(new URL('/api/login', config.portalUrl).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: config.password })
    });

    if (!response.ok) {
      console.error(`Auto-login rejected with HTTP ${response.status} - check the configured password.`);
      return false;
    }

    console.log('Auto-login succeeded');
    return true;
  } catch (err) {
    console.error('Auto-login failed:', err.message);
    return false;
  }
}

function scheduleRetry(reason) {
  if (retryTimer) clearTimeout(retryTimer);

  retryAttempts++;
  const delay = Math.min(RETRY_BASE_MS * Math.pow(1.5, retryAttempts - 1), RETRY_MAX_MS);
  console.log(`${reason} - retrying in ${Math.round(delay / 1000)}s (attempt ${retryAttempts})`);

  retryTimer = setTimeout(loadPortal, delay);
}

async function loadPortal() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  await ensureLoggedIn(session.defaultSession);

  try {
    await mainWindow.loadURL(portalPageUrl());
    retryAttempts = 0;
  } catch (err) {
    showOfflinePage();
    scheduleRetry(`Could not reach the portal (${err.message})`);
  }
}

function showOfflinePage() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadFile(path.join(__dirname, 'offline.html')).catch(() => {});
}

function createWindow() {
  mainWindow = new BrowserWindow({
    show: false,
    kiosk: config.kiosk,
    fullscreen: config.kiosk,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // The portal is a video call that must keep running while unfocused;
      // Chromium's default throttling would stall the WebRTC timers.
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // The only diagnostic a headless kiosk leaves behind is its log, so record
  // what it actually managed to load.
  mainWindow.webContents.on('did-finish-load', () => {
    console.log(`Loaded ${mainWindow.webContents.getURL()}`);
  });

  // The client narrates its connection state to the console; forwarding it means
  // a black screen in the far office can be diagnosed from this log alone.
  mainWindow.webContents.on('console-message', (event) => {
    console.log(`[renderer] ${event.message}`);
  });

  // In-process recovery for the failures that leave this process alive. Anything
  // that kills the process outright is the OS supervisor's job.
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ABORTED, which fires on ordinary navigation cancellation.
    if (!isMainFrame || errorCode === -3) return;
    showOfflinePage();
    scheduleRetry(`Load failed: ${errorDescription} (${validatedURL})`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    scheduleRetry(`Renderer exited: ${details.reason}`);
  });

  mainWindow.webContents.on('unresponsive', () => {
    scheduleRetry('Renderer stopped responding');
  });

  // A kiosk should never spawn a second window or wander off-origin.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isPortalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isPortalUrl(url) && !url.startsWith('file://')) event.preventDefault();
  });

  // Kiosk mode swallows the normal window chrome, so this is the way out.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (!mod || !input.shift) return;

    const key = input.key.toLowerCase();
    if (key === 'q') {
      event.preventDefault();
      app.quit();
    } else if (key === 'i') {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    } else if (key === 'r') {
      event.preventDefault();
      retryAttempts = 0;
      loadPortal();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// A second copy would fight the first for the camera and for the peer ID.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
  });

  app.whenReady().then(async () => {
    config = loadConfig();
    console.log(`Portal: ${config.portalUrl} as ${config.localOffice} -> ${config.remoteOffice}`);

    // An always-on display must not blank or the far office sees a dead screen.
    powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');

    configurePermissions(session.defaultSession);
    await requestMediaAccess();

    createWindow();
    await loadPortal();
  });

  // A crash that takes the window down with it must not end the app - only a
  // deliberate quit should. The OS-level supervisor covers the main process
  // dying outright; this covers losing just the window.
  app.on('window-all-closed', () => {
    if (isQuitting) {
      app.quit();
      return;
    }

    console.warn('Window closed unexpectedly - reopening');
    createWindow();
    loadPortal();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
      powerSaveBlocker.stop(powerBlockerId);
    }
  });
}
