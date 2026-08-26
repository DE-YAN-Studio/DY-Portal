const { app, BrowserWindow, ipcMain, session, systemPreferences, powerSaveBlocker, shell } = require('electron');
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
  // Off by default. The window is already fullscreen and frameless, so kiosk
  // mode adds only one thing: it takes away app switching and the ways out of
  // fullscreen. On an unattended display that is the point, so set it in
  // portal.config.json there - but it makes the app unusable to develop
  // against, and if the process is killed while kiosk is active macOS can be
  // left with the Dock and menu bar still hidden.
  kiosk: false
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
let settingsWindow = null;

// Config comes from, in increasing order of precedence: the bundled defaults, a
// portal.config.json placed next to the app or in userData, then environment
// variables. That lets one signed build serve both offices - only the config
// file differs between machines.
// The one location the settings window writes to, and the first place
// loadConfig looks. Keeping it in userData rather than beside the app means a
// reinstall does not wipe the password.
function configFilePath() {
  return path.join(app.getPath('userData'), 'portal.config.json');
}

function loadConfig() {
  const candidates = [
    configFilePath(),
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
    // The display only ever shows the far office, so it comes up fullscreen and
    // frameless unconditionally - a title bar is a strip of grey that steals
    // height from the video and offers a stray click target. `kiosk` is still
    // configurable on top of this: it additionally blocks the ways *out* of
    // fullscreen, which is what an unattended display wants and a developer
    // debugging on a laptop does not.
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
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

  // The window is frameless, and kiosk mode also takes away app switching, so
  // these are the way out.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (!mod || !input.shift) return;

    const key = input.key.toLowerCase();
    if (key === 'q') {
      // Quit takes Control as well on macOS, because Cmd+Shift+Q is the Apple
      // menu's Log Out shortcut - the system claims it before the window ever
      // sees the keystroke, so binding quit there means it never fires.
      if (process.platform === 'darwin' && !input.control) return;
      event.preventDefault();
      app.quit();
    } else if (key === 'i') {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    } else if (key === 'r') {
      event.preventDefault();
      retryAttempts = 0;
      loadPortal();
    } else if (key === 's') {
      // Deliberately the same three-modifier chord as quit. A display in a
      // shared space should not surface its password field to anyone who
      // brushes the keyboard, so there is no menu item and no on-screen way in.
      if (process.platform === 'darwin' && !input.control) return;
      event.preventDefault();
      openSettings();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// The portal's fullscreen button, forwarded from the renderer by preload.js.
// Registered once for the process rather than per window, so it survives the
// window being reopened after a crash.
ipcMain.handle('toggle-fullscreen', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  const goFullscreen = !mainWindow.isFullScreen();

  // Kiosk mode is fullscreen plus a lock on the ways out of it, so it has to be
  // released before the window will leave fullscreen - and put back on the way
  // in, or one press would leave an unattended display escapable for good.
  if (config.kiosk) mainWindow.setKiosk(goFullscreen);
  mainWindow.setFullScreen(goFullscreen);

  console.log(`Fullscreen toggled -> ${goFullscreen}`);
  return goFullscreen;
});

// The renderer's stall watchdog escalates to this rather than reloading itself.
// loadPortal re-runs the login first, so a session that expired while the app
// was up - SESSION_MAX_AGE is days, an always-on display runs for longer -
// recovers instead of parking on a login page nobody is there to fill in.
ipcMain.handle('reload-portal', async () => {
  console.log('Renderer asked for a re-authenticated reload');
  retryAttempts = 0;
  await loadPortal();
  return true;
});

// The settings window is the supported way to point a display at a server and
// tell it which office it is. Before this existed the config had to be hand
// written into userData, and getting the path wrong was silent: the app fell
// back to its defaults, came up as office-ny, and collided with the real NY
// display over the peer ID.
function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 520,
    height: 620,
    title: 'Portal Settings',
    backgroundColor: '#16181d',
    // The portal window may be kiosk or fullscreen, which would otherwise sit
    // on top of this one and make it look like nothing happened.
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// Launch at login is an OS setting, not portal config - it deliberately does
// not live in portal.config.json, because the file is copied between machines
// and whether *this* Mac starts the portal is a property of the Mac.
function launchAtLogin() {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch (err) {
    console.error('Could not read login item settings:', err.message);
    return false;
  }
}

// Environment variables outrank the config file, so a value typed here can be
// silently overridden and the window would look broken. Report which keys are
// shadowed rather than letting someone chase it.
function envOverrides() {
  const map = {
    portalUrl: 'PORTAL_URL',
    password: 'PORTAL_PASSWORD',
    localOffice: 'PORTAL_LOCAL_OFFICE',
    remoteOffice: 'PORTAL_REMOTE_OFFICE',
    kiosk: 'PORTAL_KIOSK'
  };
  return Object.values(map).filter((name) => process.env[name]);
}

ipcMain.handle('settings:load', () => ({
  configPath: configFilePath(),
  envOverrides: envOverrides(),
  portalUrl: config.portalUrl,
  localOffice: config.localOffice,
  remoteOffice: config.remoteOffice,
  kiosk: config.kiosk,
  launchAtLogin: launchAtLogin(),
  isPackaged: app.isPackaged,
  // Whether a password exists, never the password itself.
  hasPassword: Boolean(config.password)
}));

ipcMain.handle('settings:close', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
});

ipcMain.handle('settings:save', async (event, values) => {
  const portalUrl = String(values.portalUrl || '').trim();
  const localOffice = String(values.localOffice || '').trim();
  const remoteOffice = String(values.remoteOffice || '').trim();

  try {
    new URL(portalUrl);
  } catch {
    return { ok: false, error: 'Server URL is not a valid URL.' };
  }

  if (!localOffice || !remoteOffice) {
    return { ok: false, error: 'Both office IDs are required.' };
  }

  // The check that matters most. Two displays sharing an ID do not fail
  // loudly - the second one is refused by the signaling server with
  // "ID is taken", retries forever, and both offices show as offline.
  if (localOffice === remoteOffice) {
    return { ok: false, error: 'Local and remote office must differ.' };
  }

  // A blank password means "keep the stored one", so that reopening this
  // window and saving an unrelated change cannot silently clear it.
  const password = values.password ? String(values.password) : config.password;

  const next = {
    portalUrl,
    password,
    localOffice,
    remoteOffice,
    kiosk: Boolean(values.kiosk)
  };

  const file = configFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Written via a temp file and renamed so a crash mid-write cannot leave a
    // truncated config, which would send the display back to the defaults.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    return { ok: false, error: `Could not write config: ${err.message}` };
  }

  console.log(`Settings saved to ${file}`);

  // Applied separately from the config file, and reported rather than fatal: a
  // failure here should not lose the settings the operator just typed in.
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(values.launchAtLogin) });
    console.log(`Launch at login -> ${Boolean(values.launchAtLogin)}`);
  } catch (err) {
    console.error('Could not set launch at login:', err.message);
  }

  config = loadConfig();
  console.log(`Portal: ${config.portalUrl} as ${config.localOffice} -> ${config.remoteOffice}`);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setKiosk(config.kiosk);
  }

  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();

  // Reconnect with the new identity rather than making someone restart the app
  // on a machine that may have no keyboard.
  retryAttempts = 0;
  await loadPortal();

  return { ok: true, warning: config.password ? null : 'No password set - the portal will show its login page.' };
});

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

    // Coming out of kiosk mode deliberately gives the Dock and menu bar back.
    // Quitting straight out of it can leave macOS with both still hidden, which
    // looks like a machine that has stopped switching apps.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isKiosk()) {
      mainWindow.setKiosk(false);
    }

    if (retryTimer) clearTimeout(retryTimer);
    if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
      powerSaveBlocker.stop(powerBlockerId);
    }
  });
}
