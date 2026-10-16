'use strict';
const { app, BrowserWindow, Menu, dialog, session, ipcMain } = require('electron');
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Stable userData path, regardless of how the app is launched
app.setPath('userData', path.join(app.getPath('appData'), 'selkies-client'));

const ICON = path.join(__dirname, 'icon.png');

let boot;                 // { args, file, direct }
let cfg, win, launcher;   // cfg/win: the running stream session, if any
let captured = false;
let loginAttempts = 0;
let certDialogShown = false;
let certDecision = null;
let shortcuts;
let sessionError = null;  // reported to the launcher once the stream window is closed
let loadTimer = null;

const NET_ERRORS = {
  ERR_CONNECTION_REFUSED: 'Connection refused: nothing is listening on that address and port.',
  ERR_CONNECTION_TIMED_OUT: 'Connection timed out: the server did not answer.',
  ERR_NAME_NOT_RESOLVED: 'Host name could not be resolved.',
  ERR_ADDRESS_UNREACHABLE: 'Address unreachable: check the network or VPN.',
  ERR_INTERNET_DISCONNECTED: 'No network connection.',
  ERR_CONNECTION_RESET: 'Connection reset by the server.',
  ERR_SSL_PROTOCOL_ERROR: 'TLS error: the server may be using plain HTTP (try http://host:port).',
  ERR_CERT_AUTHORITY_INVALID: 'The server certificate is not trusted.',
};

// Ends the session and tells the user why (in the launcher, or a box without one)
function failSession(message) {
  if (!win) return;
  const text = `${cfg.profileName || cfg.host} (${cfg.url})\n${message}`;
  if (launcher) sessionError = text;
  else dialog.showErrorBox('Connection failed', text);
  win.close();
}

/* ---------- shortcuts ---------- */
function parseShortcut(s) {
  const parts = s.split('+').map(x => x.trim());
  const key = parts.pop();
  const mods = new Set(parts.map(x => x.toLowerCase()));
  let code = key;
  if (/^[a-z]$/i.test(key)) code = 'Key' + key.toUpperCase();
  else if (/^[0-9]$/.test(key)) code = 'Digit' + key;
  return {
    code,
    key: /^[a-z0-9]$/i.test(key) ? key.toLowerCase() : null,
    ctrl: mods.has('ctrl') || mods.has('control'),
    alt: mods.has('alt'),
    shift: mods.has('shift'),
    meta: mods.has('meta') || mods.has('super') || mods.has('cmd'),
  };
}
// Letters/digits match the produced character (so AZERTY and QWERTY layouts both
// work); anything else falls back to the physical key code.
const matches = (sc, i) => {
  const byKey = sc.key && i.key && /^[a-z0-9]$/i.test(i.key);
  return (byKey ? i.key.toLowerCase() === sc.key : i.code === sc.code)
    && !!i.control === sc.ctrl && !!i.alt === sc.alt && !!i.shift === sc.shift && !!i.meta === sc.meta;
};

let lastShortcut = { name: '', at: 0 };
function runShortcut(name) {
  const now = Date.now();
  if (lastShortcut.name === name && now - lastShortcut.at < 300) return; // both paths fired
  lastShortcut = { name, at: now };
  if (!win) return;
  if (name === 'toggle') captured ? release() : capture();
  else if (name === 'reload') win.webContents.reloadIgnoringCache();
  else if (name === 'disconnect') win.close(); // back to the launcher (quits without one)
}

ipcMain.handle('shortcuts:get', e => (win && e.sender === win.webContents ? shortcuts : null));
ipcMain.on('shortcut', (e, name) => {
  if (win && e.sender === win.webContents && shortcuts && name in shortcuts) runShortcut(name);
});

/* ---------- hooks (commands run without a shell) ---------- */
function runHooks(list, sync = false) {
  for (const argv of list || []) {
    if (!Array.isArray(argv) || !argv.length) continue;
    try {
      if (sync) execFileSync(argv[0], argv.slice(1), { stdio: 'ignore', timeout: 3000 });
      else execFile(argv[0], argv.slice(1), err => err && console.error(`hook ${argv[0]}:`, err.message));
    } catch (e) {
      console.error(`hook ${argv[0]}:`, e.message);
    }
  }
}

/* ---------- capture / release ---------- */
async function capture() {
  if (!win || captured) return;
  captured = true;
  runHooks(cfg.hooks.onCapture);
  try {
    // Ask the Selkies client for its own "gaming mode" (fullscreen + pointer lock +
    // keyboard lock armed at the right moment, which is what lets Chromium hold the
    // Win key); fall back to a plain keyboard lock if the page did not react.
    await win.webContents.executeJavaScript(`(async () => {
      window.postMessage({ type: 'requestGamingMode' }, window.location.origin);
      await new Promise(r => setTimeout(r, 1500));
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      if (navigator.keyboard && navigator.keyboard.lock) await navigator.keyboard.lock();
    })()`, true);
  } catch (e) {
    console.error('keyboard lock:', e.message);
  }
}

async function release() {
  if (!win || !captured) return;
  captured = false;
  try {
    await win.webContents.executeJavaScript(`(async () => {
      try { navigator.keyboard.unlock(); } catch (e) {}
      if (document.fullscreenElement) await document.exitFullscreen();
    })()`, true);
  } catch (e) { /* page may already be closed */ }
  runHooks(cfg.hooks.onRelease);
}

/* ---------- stream window ---------- */
function createStreamWindow() {
  const additionalArguments = [];
  if (Object.keys(cfg.streamSettings).length) {
    additionalArguments.push('--stream-settings=' + encodeURIComponent(
      JSON.stringify({ origin: cfg.origin, settings: cfg.streamSettings })));
  }

  win = new BrowserWindow({
    icon: ICON,
    fullscreen: true,
    show: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload-stream.js'),
      additionalArguments,
    },
  });

  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => {
    try { if (new URL(url).origin !== cfg.origin) e.preventDefault(); }
    catch { e.preventDefault(); }
  });

  // First path: before the page sees the key. With a locked keyboard Chromium may
  // skip it, so the stream preload also reports the shortcuts from inside the page.
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const name = Object.keys(shortcuts).find(n => matches(shortcuts[n], input));
    if (!name) return;
    event.preventDefault();
    runShortcut(name);
  });

  wc.on('did-finish-load', () => {
    clearTimeout(loadTimer);
    loginAttempts = 0;
    if (cfg.autoCapture && !captured) capture();
  });

  wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: aborted (navigation replaced)
    failSession(NET_ERRORS[desc] || `${desc} (${code})`);
  });

  // Avoid leaving the WM in passthrough mode when the window loses focus
  win.on('blur', () => release());
  win.on('focus', () => { if (cfg.recaptureOnFocus) capture(); });
  win.on('close', () => {
    if (captured) {
      captured = false;
      runHooks(cfg.hooks.onRelease, true);
    }
  });
  win.on('closed', () => {
    clearTimeout(loadTimer);
    win = null;
    cfg = null;
    if (launcher) {
      launcher.show();
      launcher.focus();
      if (sessionError) launcher.webContents.send('session:error', sessionError);
      sessionError = null;
    }
    else app.quit();
  });

  // Only load the page once the window is really fullscreen, because the
  // Selkies client measures the window size at load time.
  let loaded = false;
  const load = () => {
    if (loaded || !win) return;
    loaded = true;
    win.loadURL(cfg.url).catch(() => {}); // failures are reported by did-fail-load
    loadTimer = setTimeout(() => failSession('Timed out: the server did not respond in 30 seconds.'), 30000);
  };
  win.once('enter-full-screen', load);
  win.show();
  setTimeout(load, 1500);
}

// Starts a session; returns { ok } or { error } for the launcher
function connect(name, args = {}) {
  if (win) return { error: 'A session is already running' };
  let c;
  try {
    c = config.buildConfig(config.readRaw(boot.file), name, args);
    if (!c.password) {
      return { error: 'No password: set one in the profile, or define SELKIES_PASSWORD.' };
    }
  } catch (e) {
    return { error: e.message };
  }
  cfg = c;
  shortcuts = {
    toggle: parseShortcut(cfg.shortcuts.toggleCapture),
    reload: parseShortcut(cfg.shortcuts.reload),
    disconnect: parseShortcut(cfg.shortcuts.disconnect),
  };
  loginAttempts = 0;
  certDialogShown = false;
  certDecision = null;
  createStreamWindow();
  if (launcher) launcher.hide();
  return { ok: true };
}

/* ---------- launcher window ---------- */
function createLauncher() {
  launcher = new BrowserWindow({
    icon: ICON,
    width: 1080,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    title: 'Selkies Client',
    backgroundColor: '#14161c',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'ui', 'preload.js'),
    },
  });
  launcher.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  launcher.webContents.on('will-navigate', e => e.preventDefault());
  launcher.on('closed', () => { launcher = null; if (!win) app.quit(); });
  launcher.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

function trustedSender(e) {
  return launcher && e.sender === launcher.webContents;
}

ipcMain.handle('config:get', e => {
  if (!trustedSender(e)) return null;
  let raw = {};
  let error = null;
  const exists = fs.existsSync(boot.file);
  try { raw = config.readRaw(boot.file); } catch (err) { error = err.message; }
  return {
    raw, error, exists, defaults: config.DEFAULTS, file: boot.file, platform: process.platform,
    suggestion: config.detectHooks(),
  };
});

ipcMain.handle('hooks:detect', e => (trustedSender(e) ? config.detectHooks() : null));

ipcMain.handle('config:save', (e, raw) => {
  if (!trustedSender(e)) return { error: 'forbidden' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid config' };
  try { config.writeRaw(boot.file, raw); return { ok: true }; }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('session:connect', (e, name) => {
  if (!trustedSender(e)) return { error: 'forbidden' };
  return connect(name);
});

/* ---------- network: certificate, auth, permissions ---------- */
function saveFingerprint(fingerprint) {
  try {
    const raw = config.readRaw(boot.file);
    const profile = raw.profiles && raw.profiles[cfg.profileName];
    if (!profile) return;
    profile.certFingerprint = fingerprint;
    config.writeRaw(boot.file, raw);
  } catch (e) {
    console.error('could not save fingerprint:', e.message);
  }
}

async function askTrust(fingerprint) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Untrusted certificate',
    message: `The server "${cfg.host}" presented a certificate that is not trusted.`,
    detail: `Fingerprint:\n${fingerprint}\n\nTrust it and remember it for this profile?`,
    buttons: ['Trust and save', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return false;
  cfg.certFingerprint = fingerprint;
  saveFingerprint(fingerprint);
  return true;
}

app.on('certificate-error', (event, wc, url, error, certificate, callback) => {
  if (!cfg) return;
  let host;
  try { host = new URL(url).host; } catch { return; }
  if (host !== cfg.host) return; // default behaviour: reject
  event.preventDefault();
  if (cfg.insecure || (cfg.certFingerprint && certificate.fingerprint === cfg.certFingerprint)) {
    return callback(true);
  }
  if (!cfg.saved) { // started from the command line: nothing to update
    if (!certDialogShown) {
      certDialogShown = true;
      dialog.showErrorBox('Untrusted certificate',
        `Received fingerprint:\n${certificate.fingerprint}\n\n` +
        'If you recognise this server, copy it into "certFingerprint" ' +
        'of the profile, then relaunch.');
    }
    return callback(false);
  }
  // One prompt shared by all concurrent certificate errors
  certDecision = certDecision || askTrust(certificate.fingerprint).then(ok => {
    if (!ok && win) win.close();
    return ok;
  });
  certDecision.then(callback);
});

app.on('login', (event, wc, details, authInfo, callback) => {
  event.preventDefault();
  const target = cfg && !authInfo.isProxy && authInfo.host === cfg.hostname
    && String(authInfo.port) === cfg.port;
  if (!target || !cfg.password || ++loginAttempts > 3) {
    callback(); // cancel
    if (loginAttempts === 4) failSession('Authentication refused: wrong user name or password.');
    return;
  }
  callback(cfg.user, cfg.password);
});

function setupPermissions() {
  const allowed = (permission, origin) => {
    try { return !!cfg && new URL(origin).origin === cfg.origin && cfg.permissions.includes(permission); }
    catch { return false; }
  };
  const ses = session.defaultSession;
  // HTTP errors on the page itself (502 behind a proxy, 404 on a wrong path...)
  ses.webRequest.onCompleted({ urls: ['*://*/*'] }, details => {
    if (details.resourceType !== 'mainFrame' || !win || details.webContentsId !== win.webContents.id) return;
    if (details.statusCode >= 400 && details.statusCode !== 401) {
      failSession(`The server answered HTTP ${details.statusCode}${details.statusLine ? ` (${details.statusLine.replace(/^HTTP\/\S+ \d+ ?/, '')})` : ''}.`);
    }
  });
  ses.setPermissionRequestHandler((wc, permission, cb, details) =>
    cb(allowed(permission, details.requestingUrl)));
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
    allowed(permission, requestingOrigin));
}

/* ---------- lifecycle ---------- */
app.whenReady().then(() => {
  boot = config.loadBoot(app.getPath('userData'), process.argv);
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  setupPermissions();

  if (boot.direct) { // --profile / --host: skip the launcher
    let res;
    try {
      const raw = config.readRaw(boot.file);
      if (!boot.args.host && !(raw.profiles || {})[boot.args.profile]) {
        throw new Error(`Unknown profile: ${boot.args.profile}`);
      }
      // connect() re-reads the file; pass CLI overrides through
      res = connect(boot.args.profile, boot.args);
    } catch (e) {
      res = { error: e.message };
    }
    if (res.error) {
      dialog.showErrorBox('Selkies Client', res.error);
      return app.exit(1);
    }
  } else {
    createLauncher();
  }
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  if (captured && cfg) {     // never leave the WM in passthrough
    captured = false;
    runHooks(cfg.hooks.onRelease, true);
  }
});
process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
