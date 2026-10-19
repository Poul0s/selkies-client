'use strict';
// Runs the Tailscale sidecar (sidecar/, Go + tsnet) on demand and tracks its state.
// The sidecar exposes a SOCKS5 proxy on 127.0.0.1; its protocol is described in sidecar/main.go.
const { app, shell } = require('electron');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const GOOS = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
const GOARCH = { x64: 'amd64', arm64: 'arm64' }[process.arch];
const BINARY = 'tailscale-sidecar' + (process.platform === 'win32' ? '.exe' : '');

const events = new EventEmitter();
let child = null;
let started = null;       // { hostname, authKey, stateDir } of the running sidecar
let stopping = false;
let stderrTail = [];
let openedUrl = '';
let status = idle();

function idle() {
  return { state: 'off', ip: '', dnsName: '', loginUrl: '', error: '', denied: '', port: 0 };
}

function binaryPath() {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'sidecar')
    : path.join(__dirname, '..', 'sidecar', 'bin', `${GOOS}-${GOARCH}`);
  const file = path.join(dir, BINARY);
  return fs.existsSync(file) ? file : null;
}

function update(patch) {
  status = { ...status, ...patch };
  events.emit('status', getStatus());
}

function getStatus() {
  const available = !!binaryPath();
  // A reported error (invalid key...) without a connection counts as the "error" state
  const failed = status.error && !['connected', 'login', 'approval'].includes(status.state);
  return {
    ...status,
    state: failed ? 'error' : status.state,
    running: !!child, // the sidecar process is alive (it keeps running after an auth error)
    available,
    reason: available ? '' : 'The Tailscale sidecar is missing from this build (run "make sidecar").',
  };
}

function openLogin() {
  try {
    if (new URL(status.loginUrl).protocol === 'https:') shell.openExternal(status.loginUrl);
  } catch { /* no valid URL yet */ }
}

function onEvent(ev) {
  switch (ev.event) {
    case 'listening': return update({ port: ev.port });
    case 'login':
      update({ loginUrl: ev.url });
      if (ev.url !== openedUrl) { openedUrl = ev.url; openLogin(); }
      return;
    case 'state':
      return update({
        state: ev.state,
        ip: ev.state === 'connected' ? ev.ip || '' : '',
        dnsName: ev.state === 'connected' ? ev.dnsName || '' : '',
        loginUrl: ev.state === 'login' ? status.loginUrl : '',
        error: ev.state === 'connected' ? '' : status.error,
      });
    case 'error': return update({ error: ev.error });
    case 'denied': return update({ denied: `${ev.target}: ${ev.reason}` }); // refused by the proxy policy
  }
}

// Starts (or restarts, if the settings changed) the sidecar. authKey may be null (interactive login).
function start({ stateDir, hostname, authKey }) {
  const bin = binaryPath();
  if (!bin) return Promise.reject(new Error(getStatus().reason));
  if (child && started.hostname === hostname && started.authKey === authKey && getStatus().state !== 'error') {
    return Promise.resolve();
  }
  return stop().then(() => {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const env = { ...process.env };
    delete env.TS_AUTHKEY; // the key is passed explicitly, never through the arguments (visible in `ps`)
    if (authKey) env.TS_AUTHKEY = authKey;
    stderrTail = [];
    openedUrl = '';
    stopping = false;
    status = { ...idle(), state: 'starting' };
    const proc = spawn(bin, ['-state-dir', stateDir, '-hostname', hostname], {
      env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    child = proc;
    started = { stateDir, hostname, authKey };
    readline.createInterface({ input: proc.stdout }).on('line', line => {
      try { onEvent(JSON.parse(line)); } catch { /* not for us */ }
    });
    readline.createInterface({ input: proc.stderr }).on('line', line => {
      stderrTail = [...stderrTail, line].slice(-6);
    });
    proc.stdin.on('error', () => {}); // the sidecar may already be gone
    proc.on('error', err => {
      if (child === proc) child = null;
      update({ ...idle(), state: 'error', error: `Cannot start the Tailscale sidecar: ${err.message}` });
    });
    proc.on('exit', (code, signal) => {
      if (child !== proc) return;
      child = null;
      if (stopping) return update(idle());
      update({
        ...idle(), state: 'error',
        error: `The Tailscale sidecar stopped unexpectedly (${signal || 'code ' + code}).${stderrTail.length ? '\n' + stderrTail.join('\n') : ''}`,
      });
    });
    events.emit('status', getStatus());
  });
}

// Asks the sidecar to quit (closing stdin does it too), then makes sure it did
function stop() {
  const proc = child;
  if (!proc) return Promise.resolve();
  stopping = true;
  return new Promise(resolve => {
    const kill = setTimeout(() => proc.kill(), 3000);
    proc.once('exit', () => { clearTimeout(kill); resolve(); });
    send({ cmd: 'quit' });
    proc.stdin.end();
  });
}

// Deregisters the node from the tailnet, then forgets its saved state
async function forget(stateDir) {
  if (child) {
    stopping = true;
    const proc = child;
    await new Promise(resolve => {
      const kill = setTimeout(() => proc.kill(), 20000);
      proc.once('exit', () => { clearTimeout(kill); resolve(); });
      send({ cmd: 'logout' });
    });
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
  update(idle());
}

function send(cmd) {
  if (child && child.stdin.writable) child.stdin.write(JSON.stringify(cmd) + '\n');
}

// Destinations ("host:port") the proxy may reach; nothing is reachable until set
function setAllow(hosts) {
  send({ cmd: 'allow', hosts });
}

// Resolves once connected; rejects with a user-readable reason if it cannot get there soon
function waitConnected(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const s = getStatus();
      let why = null;
      if (s.state === 'connected') why = '';
      else if (s.state === 'login') why = 'Tailscale needs you to log in: finish in the browser, then try again.';
      else if (s.state === 'approval') why = 'This device must be approved by a tailnet admin before it can connect.';
      else if (s.state === 'error') why = s.error;
      else if (s.state === 'off') why = 'Tailscale is not running.';
      if (why === null) return;
      cleanup();
      return why === '' ? resolve() : reject(new Error(why));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Tailscale did not connect in time. Check the network, or connect from ⚙ Settings.'));
    }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); events.off('status', check); };
    events.on('status', check);
    check();
  });
}

function proxyRules() {
  return `socks5://127.0.0.1:${status.port}`;
}

// Synchronous, for app exit
function shutdown() {
  if (!child) return;
  stopping = true;
  child.stdin.destroy();
  child.kill();
}

module.exports = {
  events, getStatus, start, stop, forget, setAllow, waitConnected, proxyRules, openLogin, shutdown,
};
