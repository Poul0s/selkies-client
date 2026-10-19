'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULTS = {
  shortcuts: {
    toggleCapture: 'Ctrl+Alt+Shift+Z',
    reload: 'Ctrl+Alt+Shift+R',
    disconnect: 'Ctrl+Alt+Shift+Q', // close the session, back to the launcher
  },
  autoCapture: true,
  recaptureOnFocus: false,
  hooks: { onCapture: [], onRelease: [] },
  permissions: ['fullscreen', 'keyboardLock', 'clipboard-read',
                'clipboard-sanitized-write', 'pointerLock', 'media'],
  insecure: false,
  autoHooks: true, // offer to fill the capture hooks for the detected window manager
  // bitrateKbps: 0 = no limit; quality: auto | low | balanced | high | ultra
  // mode: transport the server runs Selkies in (auto | websocket | webrtc)
  stream: { bitrateKbps: 0, bitrateUnit: 'Mbps', quality: 'auto', mode: 'auto' },
  // Embedded Tailscale (SOCKS5 sidecar). Global: enabled, hostname, authKey*, useByDefault.
  // A profile sets `tailscale.use` to override useByDefault. No auth key = interactive login.
  tailscale: { enabled: false, hostname: '', authKeyEnv: 'TS_AUTHKEY', useByDefault: false },
};

const STREAM_MODES = ['auto', 'websocket', 'webrtc'];

// Quality presets mapped to the Selkies client settings they drive:
// video_crf (lower = better, constant-quality mode) and jpeg_quality.
const QUALITY_PRESETS = {
  low: { crf: 38, jpeg: 30 },
  balanced: { crf: 28, jpeg: 50 },
  high: { crf: 23, jpeg: 75 },
  ultra: { crf: 18, jpeg: 90 },
};

const expand = p => (typeof p === 'string' && p.startsWith('~'))
  ? path.join(os.homedir(), p.slice(1)) : p;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  }
  return out;
};

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function configFile(userDataDir, args) {
  return expand(args.config || process.env.SELKIES_CLIENT_CONFIG
    || path.join(userDataDir, 'config.json'));
}

// Old configs had a separate `quit` shortcut; it now closes the session too
function migrate(raw) {
  for (const o of [raw, ...Object.values(raw.profiles || {})]) {
    const sc = o && o.shortcuts;
    if (sc && 'quit' in sc) {
      if (sc.quit) sc.disconnect = sc.quit;
      delete sc.quit;
      if (!Object.keys(sc).length) delete o.shortcuts;
    }
  }
  return raw;
}

function readRaw(file) {
  return fs.existsSync(file) ? migrate(JSON.parse(fs.readFileSync(file, 'utf8'))) : {};
}

function writeRaw(file, raw) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The file may hold a plain-text password: keep it private
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
}

function readSecretFile(file) {
  const f = expand(file);
  if (process.platform !== 'win32' && (fs.statSync(f).mode & 0o077)) {
    console.warn(`${f} is readable by other users (chmod 600 recommended)`);
  }
  return fs.readFileSync(f, 'utf8').replace(/\r?\n$/, '');
}

function readPassword(cfg, args) {
  // --password is discouraged: visible in `ps`
  if (args.password && args.password !== true) return args.password;
  const fromEnv = process.env[cfg.passwordEnv || 'SELKIES_PASSWORD'];
  if (fromEnv) return fromEnv;
  if (cfg.passwordFile) return readSecretFile(cfg.passwordFile);
  return cfg.password || null;
}

// Global Tailscale options; hostname falls back to a name derived from this machine
function tailscaleOptions(raw) {
  const ts = merge(DEFAULTS.tailscale, raw && raw.tailscale);
  if (!ts.hostname) {
    ts.hostname = ('selkies-client-' + os.hostname()).toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  }
  return ts;
}

// Auth key lookup, like the password: environment variable → file → config. null = interactive login
function readAuthKey(ts) {
  const fromEnv = process.env[ts.authKeyEnv || 'TS_AUTHKEY'];
  if (fromEnv) return fromEnv;
  if (ts.authKeyFile) return readSecretFile(ts.authKeyFile).trim();
  return ts.authKey || null;
}

// Settings written into the web client's localStorage before it starts
function streamSettings(stream) {
  const out = {};
  const preset = QUALITY_PRESETS[stream && stream.quality];
  const kbps = Math.round(Number(stream && stream.bitrateKbps) || 0);
  if (kbps > 0) {
    // Selkies only caps the bitrate in constant-bitrate mode
    out.rate_control_mode = 'cbr';
    out.video_bitrate = Math.min(Math.max(kbps, 100), 1000000);
  } else if (preset) {
    out.rate_control_mode = 'crf';
  }
  if (preset) {
    out.video_crf = preset.crf;
    out.jpeg_quality = preset.jpeg;
  }
  return out;
}

// Linux only: detects the window manager and returns the hooks that switch it
// to a mode without its own shortcuts while the keyboard is captured.
function gsettingsGet(schema, key) {
  try {
    return execFileSync('gsettings', ['get', schema, key], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch { return null; }
}

function gsettingsList(schema) {
  try {
    return execFileSync('gsettings', ['list-recursively', schema], { encoding: 'utf8', timeout: 3000 });
  } catch { return null; } // schema not installed
}

// GNOME shortcuts that would swallow keys meant for the remote machine
const GNOME_SCHEMAS = [
  'org.gnome.desktop.wm.keybindings',
  'org.gnome.shell.keybindings',
  'org.gnome.settings-daemon.plugins.media-keys',
  'org.gnome.mutter.keybindings',
  'org.gnome.shell.extensions.dash-to-dock',
  'com.canonical.unity.settings-daemon.plugins.media-keys',
];
const GNOME_GRABBED = /<Super>|<(Primary|Control)><Alt>|<Alt>(Tab|F\d+|Escape|space)|<Shift><Alt>(Tab|Escape)/;

function gnomeHooks(gs) {
  const onCapture = [];
  const onRelease = [];
  const add = (schema, key, current) => {
    const isArray = current.startsWith('[') || current.startsWith('@as');
    const disabled = isArray ? '@as []' : "''";
    if (current === disabled || current === '[]') return; // already unbound
    onCapture.push(['gsettings', 'set', schema, key, isArray ? '[]' : '']);
    onRelease.push(['gsettings', 'set', schema, key, current]);
  };
  const overlay = gs.get('org.gnome.mutter', 'overlay-key');
  if (overlay !== null) add('org.gnome.mutter', 'overlay-key', overlay);
  for (const schema of GNOME_SCHEMAS) {
    for (const line of (gs.list(schema) || '').split('\n')) {
      const m = /^(\S+) (\S+) (.*)$/.exec(line);
      if (m && m[1] === schema && GNOME_GRABBED.test(m[3])) add(schema, m[2], m[3]);
    }
  }
  return { onCapture, onRelease };
}

// Linux only: detects the window manager and returns the hooks that switch it
// to a mode without its own shortcuts while the keyboard is captured.
function detectHooks(env = process.env, platform = process.platform,
                     gs = { get: gsettingsGet, list: gsettingsList }) {
  if (platform !== 'linux') return null;
  const desktop = `${env.XDG_CURRENT_DESKTOP || ''}:${env.DESKTOP_SESSION || ''}`.toLowerCase();
  const wm = (name, bin, args, note) => ({
    name,
    note,
    hooks: { onCapture: [[bin, ...args, 'passthrough']], onRelease: [[bin, ...args, 'default']] },
  });
  // Sway also exports I3SOCK, so test it first
  if (env.HYPRLAND_INSTANCE_SIGNATURE) {
    return {
      name: 'Hyprland',
      note: 'Needs a "passthrough" submap in hyprland.conf: submap = passthrough, then submap = reset.',
      hooks: {
        onCapture: [['hyprctl', 'dispatch', 'submap', 'passthrough']],
        onRelease: [['hyprctl', 'dispatch', 'submap', 'reset']],
      },
    };
  }
  if (env.SWAYSOCK || /\bsway\b/.test(desktop)) {
    return wm('Sway', 'swaymsg', ['mode'], 'Needs a "passthrough" mode in your sway config: mode "passthrough" {}');
  }
  if (env.I3SOCK || /\bi3\b/.test(desktop)) {
    return wm('i3', 'i3-msg', ['mode'], 'Needs a "passthrough" mode in your i3 config: mode "passthrough" {}');
  }
  if (/\bgnome\b/.test(desktop)) {
    // No WM mode to switch: unbind every Super / Alt+Tab / Ctrl+Alt shortcut while
    // capturing and restore the values they have right now on release.
    return {
      name: 'GNOME',
      note: 'Unbinds the Super, Alt+Tab and Ctrl+Alt shortcuts while the keyboard is captured and restores their current values on release. Re-detect after changing shortcuts.',
      hooks: gnomeHooks(gs),
    };
  }
  return null;
}

// Resolves one profile (+ globals + defaults + CLI overrides) into a session config
function buildConfig(raw, name, args = {}) {
  const { profiles = {}, default: defName, ...globals } = raw;
  name = name || defName || Object.keys(profiles)[0];
  if (name && !profiles[name] && !args.host) {
    throw new Error(`Unknown profile: ${name}`);
  }

  const cfg = merge(merge(DEFAULTS, globals), profiles[name] || {});
  if (args.host) cfg.host = args.host;
  if (args.user) cfg.user = args.user;
  if (!cfg.host) throw new Error('Missing "host" field');

  const url = new URL(/^https?:\/\//.test(cfg.host) ? cfg.host : `https://${cfg.host}`);
  cfg.url = url.href;
  cfg.origin = url.origin;
  cfg.host = url.host;
  cfg.hostname = url.hostname.replace(/^\[|\]$/g, '');
  cfg.port = url.port || (url.protocol === 'https:' ? '443' : '80');
  cfg.user = cfg.user || 'user';
  cfg.password = readPassword(cfg, args);
  cfg.profileName = name;
  cfg.saved = !!profiles[name] && !args.host; // can be updated in the config file
  cfg.streamSettings = streamSettings(cfg.stream);

  // Tailscale: the profile's own `use` wins, else the global default (only when enabled).
  // A profile that asks for it while it is disabled is an error, never a silent direct connection.
  const ts = cfg.tailscale;
  cfg.useTailscale = ts.use !== undefined ? !!ts.use : !!(ts.enabled && ts.useByDefault);
  if (cfg.useTailscale && !ts.enabled) {
    throw new Error('This profile goes through Tailscale, but Tailscale is not enabled in ⚙ Settings.');
  }
  // Expected server transport: a Tailscale profile defaults to websocket (the SOCKS5 proxy only carries TCP)
  const mode = STREAM_MODES.includes(cfg.stream.mode) ? cfg.stream.mode : 'auto';
  if (cfg.useTailscale && mode === 'webrtc') {
    throw new Error('WebRTC needs UDP, which cannot go through the Tailscale SOCKS5 proxy. Set the stream mode to WebSocket.');
  }
  cfg.streamMode = mode === 'auto' && cfg.useTailscale ? 'websocket' : mode;
  return cfg;
}

// Boot-time inspection of the command line and config file
function loadBoot(userDataDir, argv) {
  const args = parseArgs(argv);
  const file = configFile(userDataDir, args);
  return { args, file, direct: !!(args.host || args.profile) };
}

module.exports = {
  DEFAULTS, QUALITY_PRESETS, STREAM_MODES, detectHooks, loadBoot, readRaw, writeRaw, buildConfig,
  streamSettings, tailscaleOptions, readAuthKey,
};
