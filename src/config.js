'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  shortcuts: {
    toggleCapture: 'Ctrl+Alt+Shift+Z',
    reload: 'Ctrl+Alt+Shift+R',
    quit: 'Ctrl+Alt+Shift+Q',
  },
  autoCapture: true,
  recaptureOnFocus: false,
  hooks: { onCapture: [], onRelease: [] },
  permissions: ['fullscreen', 'keyboardLock', 'clipboard-read',
                'clipboard-sanitized-write', 'pointerLock', 'media'],
  insecure: false,
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

function readPassword(cfg, args) {
  // --password is discouraged: visible in `ps`
  if (args.password && args.password !== true) return args.password;
  const fromEnv = process.env[cfg.passwordEnv || 'SELKIES_PASSWORD'];
  if (fromEnv) return fromEnv;
  if (cfg.passwordFile) {
    const f = expand(cfg.passwordFile);
    if (process.platform !== 'win32' && (fs.statSync(f).mode & 0o077)) {
      console.warn(`${f} est lisible par d'autres utilisateurs (chmod 600 conseillé)`);
    }
    return fs.readFileSync(f, 'utf8').replace(/\r?\n$/, '');
  }
  return cfg.password || null;
}

function loadConfig(userDataDir, argv) {
  const args = parseArgs(argv);
  const file = expand(args.config || process.env.SELKIES_CLIENT_CONFIG
    || path.join(userDataDir, 'config.json'));

  let raw = {};
  if (fs.existsSync(file)) {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else if (!args.host) {
    throw new Error(`Aucune configuration : créez ${file} (voir config.example.json) ou passez --host=IP:PORT`);
  }

  const { profiles = {}, default: defName, ...globals } = raw;
  const name = args.profile || defName || Object.keys(profiles)[0];
  if (args.profile && !profiles[args.profile] && !args.host) {
    throw new Error(`Profil inconnu : ${args.profile}`);
  }

  const cfg = merge(merge(DEFAULTS, globals), profiles[name] || {});
  if (args.host) cfg.host = args.host;
  if (args.user) cfg.user = args.user;
  if (!cfg.host) throw new Error('Champ "host" manquant');

  const url = new URL(/^https?:\/\//.test(cfg.host) ? cfg.host : `https://${cfg.host}`);
  cfg.url = url.href;
  cfg.origin = url.origin;
  cfg.host = url.host;
  cfg.hostname = url.hostname.replace(/^\[|\]$/g, '');
  cfg.port = url.port || (url.protocol === 'https:' ? '443' : '80');
  cfg.user = cfg.user || 'user';
  cfg.password = readPassword(cfg, args);
  cfg.profileName = name;
  return cfg;
}

module.exports = { loadConfig };
