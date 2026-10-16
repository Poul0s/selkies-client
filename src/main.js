'use strict';
const { app, BrowserWindow, Menu, dialog, session } = require('electron');
const { execFile, execFileSync } = require('child_process');
const path = require('path');
const { loadConfig } = require('./config');

// Stable userData path, regardless of how the app is launched
app.setPath('userData', path.join(app.getPath('appData'), 'selkies-client'));

let cfg, win;
let captured = false;
let loginAttempts = 0;
let certDialogShown = false;
let shortcuts;

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
    ctrl: mods.has('ctrl') || mods.has('control'),
    alt: mods.has('alt'),
    shift: mods.has('shift'),
    meta: mods.has('meta') || mods.has('super') || mods.has('cmd'),
  };
}
const matches = (sc, i) => i.code === sc.code && !!i.control === sc.ctrl
  && !!i.alt === sc.alt && !!i.shift === sc.shift && !!i.meta === sc.meta;

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
    await win.webContents.executeJavaScript(`(async () => {
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

/* ---------- window ---------- */
function createWindow() {
  win = new BrowserWindow({
    fullscreen: true,
    show: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => {
    try { if (new URL(url).origin !== cfg.origin) e.preventDefault(); }
    catch { e.preventDefault(); }
  });

  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (matches(shortcuts.toggle, input)) {
      event.preventDefault();
      captured ? release() : capture();
    } else if (matches(shortcuts.reload, input)) {
      event.preventDefault();
      wc.reloadIgnoringCache();
    } else if (matches(shortcuts.quit, input)) {
      event.preventDefault();
      app.quit();
    }
  });

  wc.on('did-finish-load', () => {
    loginAttempts = 0;
    if (cfg.autoCapture && !captured) capture();
  });

  // Avoid leaving the WM in passthrough mode when the window loses focus
  win.on('blur', () => release());
  win.on('focus', () => { if (cfg.recaptureOnFocus) capture(); });
  win.on('closed', () => { win = null; });

  // Only load the page once the window is really fullscreen, because the
  // Selkies client measures the window size at load time.
  let loaded = false;
  const load = () => { if (!loaded) { loaded = true; win.loadURL(cfg.url); } };
  win.once('enter-full-screen', load);
  win.show();
  setTimeout(load, 1500);
}

/* ---------- network: certificate, auth, permissions ---------- */
app.on('certificate-error', (event, wc, url, error, certificate, callback) => {
  let host;
  try { host = new URL(url).host; } catch { return; }
  if (host !== cfg.host) return; // default behaviour: reject
  event.preventDefault();
  if (cfg.insecure || (cfg.certFingerprint && certificate.fingerprint === cfg.certFingerprint)) {
    return callback(true);
  }
  if (!certDialogShown) {
    certDialogShown = true;
    dialog.showErrorBox('Certificat non approuvé',
      `Empreinte reçue :\n${certificate.fingerprint}\n\n` +
      'Si vous reconnaissez ce serveur, copiez-la dans "certFingerprint" ' +
      'du profil, puis relancez.');
  }
  callback(false);
});

app.on('login', (event, wc, details, authInfo, callback) => {
  event.preventDefault();
  const target = !authInfo.isProxy && authInfo.host === cfg.hostname
    && String(authInfo.port) === cfg.port;
  if (!target || !cfg.password || ++loginAttempts > 3) {
    callback(); // cancel
    if (loginAttempts === 4) {
      dialog.showErrorBox('Authentification refusée', 'Identifiants incorrects ou absents.');
    }
    return;
  }
  callback(cfg.user, cfg.password);
});

function setupPermissions() {
  const allowed = (permission, origin) => {
    try { return new URL(origin).origin === cfg.origin && cfg.permissions.includes(permission); }
    catch { return false; }
  };
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb, details) =>
    cb(allowed(permission, details.requestingUrl)));
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
    allowed(permission, requestingOrigin));
}

/* ---------- lifecycle ---------- */
app.whenReady().then(() => {
  try {
    cfg = loadConfig(app.getPath('userData'), process.argv);
    if (!cfg.password) throw new Error(
      'Mot de passe introuvable : définissez la variable SELKIES_PASSWORD, ' +
      '"passwordEnv" ou "passwordFile" dans le profil.');
    shortcuts = {
      toggle: parseShortcut(cfg.shortcuts.toggleCapture),
      reload: parseShortcut(cfg.shortcuts.reload),
      quit: parseShortcut(cfg.shortcuts.quit),
    };
  } catch (e) {
    dialog.showErrorBox('Selkies Client', e.message);
    return app.exit(1);
  }
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  setupPermissions();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  if (captured) {            // never leave the WM in passthrough
    captured = false;
    runHooks(cfg.hooks.onRelease, true);
  }
});
process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
