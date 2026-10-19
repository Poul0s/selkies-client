'use strict';
const api = window.launcher;
const $ = id => document.getElementById(id);

let state;   // { raw, error, defaults, file, platform }
let raw;     // working copy of the config file content

/* ---------- helpers ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

const clone = v => JSON.parse(JSON.stringify(v));
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function setPath(o, p, v) {
  const keys = p.split('.');
  const last = keys.pop();
  const parent = keys.reduce((a, k) => (a[k] = a[k] && typeof a[k] === 'object' ? a[k] : {}), o);
  parent[last] = v;
}
function delPath(o, p) {
  const keys = p.split('.');
  const chain = [o];
  for (const k of keys.slice(0, -1)) {
    if (!chain[chain.length - 1] || typeof chain[chain.length - 1][k] !== 'object') return;
    chain.push(chain[chain.length - 1][k]);
  }
  delete chain[chain.length - 1][keys[keys.length - 1]];
  for (let i = chain.length - 1; i > 0; i--) { // prune empty parents
    if (Object.keys(chain[i]).length) break;
    delete chain[i - 1][keys[i - 1]];
  }
}

let toastTimer;
function toast(msg, ok = false, ms = 4000) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (ok ? ' ok' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// Splits a command line into argv, honouring "double" and 'single' quotes
function tokenize(line) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]);
  return out;
}
const row = (label, ...ctl) => h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctl' }, ctl));
const quote = s => (/[\s"']/.test(s) || s === '' ? `"${s.replace(/(["\\])/g, '\\$1')}"` : s);

/* ---------- field controls ---------- */
const QUALITIES = [
  ['auto', 'Auto (server default)'], ['low', 'Low'], ['balanced', 'Balanced'],
  ['high', 'High'], ['ultra', 'Ultra'],
];

const STREAM_MODES = [
  ['auto', 'Auto (WebSocket with Tailscale)'], ['websocket', 'WebSocket'], ['webrtc', 'WebRTC'],
];

const OVERRIDABLE = [
  ['Stream', [
    { id: 'bitrate', type: 'bitrate', label: 'Bitrate limit',
      hint: 'Empty or 0 = no limit. A limit switches the encoder to constant-bitrate mode.' },
    { path: 'stream.quality', type: 'select', label: 'Quality', options: QUALITIES,
      hint: 'Constant-quality preset, used when no bitrate limit is set (also drives JPEG quality).' },
    { path: 'stream.mode', type: 'select', label: 'Server mode', options: STREAM_MODES,
      hint: 'Transport the server runs Selkies in (Discord bot: /start selkies mode:websocket). '
        + 'The client cannot change it: it only warns when the server answers differently. WebRTC cannot go through Tailscale.' },
  ]],
  ['Input', [
    { path: 'autoCapture', type: 'bool', label: 'Keyboard', text: 'Capture the keyboard on connect' },
    { path: 'recaptureOnFocus', type: 'bool', label: '', text: 'Re-capture when the window regains focus' },
  ]],
  ['Shortcuts', [
    { path: 'shortcuts.toggleCapture', type: 'text', label: 'Toggle capture' },
    { path: 'shortcuts.reload', type: 'text', label: 'Reload page' },
    { path: 'shortcuts.disconnect', type: 'text', label: 'Close session',
      hint: 'Back to this menu. Letters follow your keyboard layout (AZERTY / QWERTY).' },
  ]],
  ['Hooks', [
    { path: 'hooks.onCapture', type: 'cmds', label: 'On capture',
      hint: 'One command per line, run without a shell. Example: i3-msg mode passthrough' },
    { path: 'hooks.onRelease', type: 'cmds', label: 'On release' },
  ]],
  ['Security', [
    { path: 'insecure', type: 'bool', label: 'TLS', text: 'Accept any certificate (unsafe)' },
  ]],
];

// read/write/clear on a config object for one field
function accessors(f, path = f.path) {
  if (f.type === 'bitrate') {
    return {
      read: o => {
        const kbps = getPath(o, 'stream.bitrateKbps');
        return kbps === undefined ? undefined
          : { kbps, unit: getPath(o, 'stream.bitrateUnit') || 'Mbps' };
      },
      write: (o, v) => { setPath(o, 'stream.bitrateKbps', v.kbps); setPath(o, 'stream.bitrateUnit', v.unit); },
      clear: o => { delPath(o, 'stream.bitrateKbps'); delPath(o, 'stream.bitrateUnit'); },
    };
  }
  return {
    read: o => getPath(o, path),
    write: (o, v) => setPath(o, path, v),
    clear: o => delPath(o, path),
  };
}

// Returns { el, get(), set(v), disable(b) }
function makeControl(f) {
  if (f.type === 'bool') {
    const i = h('input', { type: 'checkbox' });
    return { el: h('label', { class: 'inherit', style: 'color:inherit;font-size:inherit' }, i, ' ', f.text),
      get: () => i.checked, set: v => { i.checked = !!v; }, disable: b => { i.disabled = b; } };
  }
  if (f.type === 'select') {
    const s = h('select', {}, f.options.map(([v, t]) => h('option', { value: v }, t)));
    return { el: s, get: () => s.value, set: v => { s.value = v ?? f.options[0][0]; },
      disable: b => { s.disabled = b; } };
  }
  if (f.type === 'cmds') {
    const t = h('textarea', { spellcheck: 'false' });
    return { el: t, get: () => t.value.split('\n').map(tokenize).filter(a => a.length),
      set: v => { t.value = (v || []).map(a => a.map(quote).join(' ')).join('\n'); },
      disable: b => { t.disabled = b; } };
  }
  if (f.type === 'bitrate') {
    const n = h('input', { type: 'number', min: '0', step: 'any', placeholder: 'No limit' });
    const u = h('select', {}, h('option', { value: 'Mbps' }, 'Mbps'), h('option', { value: 'kbps' }, 'kbps'));
    let unit = 'Mbps';
    const factor = x => (x === 'Mbps' ? 1000 : 1);
    u.addEventListener('change', () => { // keep the same bitrate, change the unit
      if (n.value !== '') n.value = +(n.value * factor(unit) / factor(u.value)).toFixed(3);
      unit = u.value;
    });
    return {
      el: h('div', { style: 'display:flex;gap:8px' }, n, u),
      get: () => ({ kbps: Math.round(Number(n.value) * factor(u.value)) || 0, unit: u.value }),
      set: v => {
        unit = u.value = (v && v.unit) || 'Mbps';
        n.value = v && v.kbps ? +(v.kbps / factor(unit)).toFixed(3) : '';
      },
      disable: b => { n.disabled = u.disabled = b; },
    };
  }
  const i = h('input', { type: 'text', spellcheck: 'false' });
  return { el: i, get: () => i.value.trim(), set: v => { i.value = v ?? ''; }, disable: b => { i.disabled = b; } };
}

// One settings row; in a profile it can inherit the global value
// A field may use another key for the global value (f.globalPath, e.g. tailscale.useByDefault)
function overridableRow(f, scope, ownObj, inheritedObj) {
  const globalPath = f.globalPath || f.path;
  const acc = accessors(f, scope === 'global' ? globalPath : f.path);
  const ctl = makeControl(f);
  const own = acc.read(ownObj);
  const inherited = accessors(f, globalPath).read(inheritedObj);
  let override = null;
  const sync = () => {
    ctl.disable(!override.checked);
    if (!override.checked) ctl.set(inherited);
  };
  const kids = [ctl.el];
  if (scope === 'profile') {
    override = h('input', { type: 'checkbox', onchange: sync });
    override.checked = own !== undefined;
    kids.push(h('label', { class: 'inherit', title: 'Unchecked: use the global setting' }, override, 'Override'));
    ctl.set(own !== undefined ? own : inherited);
    sync();
  } else {
    ctl.set(own !== undefined ? own : inherited);
  }
  if (f.hint) kids.push(h('small', {}, f.hint));
  return {
    path: f.path,
    set: v => ctl.set(v),
    el: h('div', { class: 'row' }, h('label', {}, f.label || ''), h('div', { class: 'ctl' }, kids)),
    apply: target => {
      if (override && !override.checked) acc.clear(target);
      else acc.write(target, ctl.get());
    },
  };
}

/* ---------- editor ---------- */
function closeModal() { $('modal').hidden = true; $('modal').replaceChildren(); tsRender = null; }

function overridableSections(scope, ownObj, inheritedObj) {
  const rows = [];
  const sections = OVERRIDABLE.map(([title, fields]) => {
    const rs = fields.map(f => overridableRow(f, scope, ownObj, inheritedObj));
    rows.push(...rs);
    return h('section', {}, h('h3', {}, title), rs.map(r => r.el));
  });
  return { sections, rows };
}

function globalsOf(r) {
  const { profiles, default: d, ...g } = r;
  return g;
}

async function persist() {
  if (state.error) { toast('The config file is invalid; fix it manually first.'); return false; }
  const res = await api.saveConfig(raw);
  if (res.error) { toast('Save failed: ' + res.error); return false; }
  return true;
}

/* ---------- Tailscale ---------- */
// Profile: follows the global default (tailscale.useByDefault) unless overridden
const TS_USE = {
  path: 'tailscale.use', globalPath: 'tailscale.useByDefault', type: 'bool', label: 'Tailscale',
  text: 'Go through Tailscale (SOCKS5)',
  hint: 'The server must be a device of your tailnet (MagicDNS name or 100.x address) running Selkies in WebSocket mode.',
};

let tsStatus = null;   // last state reported by the main process
let tsRender = null;   // redraws the open Settings dialog

const TS_STATES = {
  off: 'Disconnected', starting: 'Starting…', connecting: 'Connecting…',
  login: 'Waiting for login: finish in your browser', approval: 'Waiting for an admin to approve this device',
};

const tailscaleEnabled = () => !!(globalsOf(raw).tailscale || {}).enabled;

// Global settings block: enable, device name, authentication, live state and Connect / Disconnect
function tailscaleSection(draft, saveDraft) {
  const t = draft.tailscale || {};
  const enabled = h('input', { type: 'checkbox' });
  enabled.checked = !!t.enabled;
  const host = h('input', { type: 'text', value: t.hostname || '', spellcheck: 'false',
    placeholder: 'selkies-client-<this computer>' });
  const src = h('select', {},
    h('option', { value: 'interactive' }, 'Interactive login (browser)'),
    h('option', { value: 'env' }, 'Auth key from an environment variable'),
    h('option', { value: 'file' }, 'Auth key read from a file'),
    h('option', { value: 'stored' }, 'Auth key saved in config file'));
  let cur = t.authKeyFile ? 'file' : t.authKey ? 'stored' : t.authKeyEnv ? 'env' : 'interactive';
  src.value = cur;
  const vals = { env: t.authKeyEnv || '', file: t.authKeyFile || '', stored: t.authKey || '' };
  const secret = h('input', { type: 'text', spellcheck: 'false', value: vals[cur] || '' });
  const note = h('small', {});
  const syncSrc = () => {
    if (cur !== 'interactive') vals[cur] = secret.value;
    cur = src.value;
    secret.hidden = cur === 'interactive';
    secret.value = vals[cur] || '';
    secret.type = cur === 'stored' ? 'password' : 'text';
    secret.placeholder = { env: 'TS_AUTHKEY', file: '~/.config/selkies-client/tskey.txt', stored: 'tskey-auth-…' }[cur] || '';
    note.textContent = {
      interactive: 'A login link opens in your browser the first time; the login is then kept in the app data folder.',
      env: 'Without a value, TS_AUTHKEY is used. If that variable is set, it always wins over the other sources.',
      file: 'One line, chmod 600 recommended. TS_AUTHKEY, if set, wins.',
      stored: 'Stored in plain text in the config file (readable only by you). TS_AUTHKEY, if set, wins.',
    }[cur];
  };
  src.addEventListener('change', syncSrc);
  const useDefault = overridableRow({ ...TS_USE, label: 'Default', text: 'Profiles go through Tailscale by default' },
    'global', draft, state.defaults);

  const text = h('span', { style: 'flex:1 1 100%;white-space:pre-line' });
  const bConnect = h('button', {}, 'Connect');
  const bDisconnect = h('button', { class: 'ghost' }, 'Disconnect');
  const bLogin = h('button', { class: 'ghost' }, 'Open login page');
  const bForget = h('button', { class: 'ghost', title: 'Log this device out of the tailnet and delete its saved login' }, 'Forget this device');
  bConnect.addEventListener('click', async () => {
    if (!enabled.checked) return toast('Tick “Enable Tailscale” first');
    if (!(await saveDraft())) return; // the main process reads the saved settings
    const res = await api.tailscale.connect();
    if (res.error) toast(res.error);
  });
  bDisconnect.addEventListener('click', () => api.tailscale.disconnect());
  bLogin.addEventListener('click', () => api.tailscale.openLogin());
  let armed = false;
  bForget.addEventListener('click', async () => {
    if (!armed) { armed = true; bForget.textContent = 'Click again to confirm'; return; }
    armed = false;
    bForget.textContent = 'Forget this device';
    const res = await api.tailscale.forget();
    toast(res.error || 'Device forgotten: the next connection needs a new login', !res.error);
  });

  tsRender = s => {
    const busy = s.state !== 'off' && s.state !== 'error';
    text.textContent = !s.available ? s.reason
      : s.state === 'connected' ? `Connected: ${s.ip}${s.dnsName ? ` (${s.dnsName})` : ''}`
      : s.state === 'error' ? `Error: ${s.error}` : TS_STATES[s.state] || s.state;
    text.style.color = s.state === 'connected' ? 'var(--ok)' : s.state === 'error' || !s.available ? 'var(--danger)' : '';
    bConnect.disabled = !s.available || busy;
    bDisconnect.disabled = !busy;
    bLogin.hidden = s.state !== 'login';
    bForget.disabled = !s.available;
  };
  syncSrc();
  tsRender(tsStatus);

  return {
    el: h('section', {}, h('h3', {}, 'Tailscale'),
      row('', h('label', { class: 'inherit', style: 'color:inherit;font-size:inherit' }, enabled,
        ' Enable Tailscale (embedded, nothing to install)')),
      row('Device name', host),
      row('Authentication', src, secret, note),
      useDefault.el,
      row('Status', text, bConnect, bDisconnect, bLogin, bForget)),
    apply: target => {
      if (!enabled.checked && !target.tailscale) return; // never configured: leave the file as it is
      const next = { ...(target.tailscale || {}), enabled: enabled.checked };
      for (const k of ['hostname', 'authKeyEnv', 'authKeyFile', 'authKey']) delete next[k];
      if (host.value.trim()) next.hostname = host.value.trim();
      vals[cur] = secret.value.trim();
      const key = { env: 'authKeyEnv', file: 'authKeyFile', stored: 'authKey' }[cur];
      if (key && vals[cur]) next[key] = vals[cur];
      else if (cur === 'env') next.authKeyEnv = 'TS_AUTHKEY';
      target.tailscale = next;
      useDefault.apply(target);
    },
  };
}

function openGlobalEditor() {
  const draft = clone(globalsOf(raw));
  const { sections, rows } = overridableSections('global', draft, state.defaults);
  // Applies the form and writes the config file; true when saved
  const commit = async () => {
    rows.forEach(r => r.apply(draft));
    tsSection.apply(draft);
    const next = { ...(raw.default ? { default: raw.default } : {}), ...draft, profiles: raw.profiles || {} };
    const backup = raw;
    raw = next;
    if (await persist()) return true;
    raw = backup;
    return false;
  };
  const save = async () => {
    if (await commit()) { closeModal(); render(); toast('Settings saved', true); }
  };
  const tsSection = tailscaleSection(draft, async () => { // Connect saves first, without closing
    const ok = await commit();
    if (ok) render();
    return ok;
  });
  showDialog('Global settings', h('p', { style: 'margin:12px 0 0;color:var(--muted)' },
    'Defaults for every profile. Each profile can override them.'), sections, tsSection.el, [
    h('button', { onclick: save }, 'Save'),
    h('button', { class: 'ghost', onclick: closeModal }, 'Cancel'),
    h('button', { class: 'ghost', style: 'margin-left:auto', title: 'Re-detect the window manager and refill the hooks (not saved until you click Save)',
      onclick: async () => {
        const sug = await api.detectHooks();
        if (!sug) return toast('No supported desktop detected (i3, Sway, Hyprland, GNOME)');
        rows.find(r => r.path === 'hooks.onCapture').set(sug.hooks.onCapture);
        rows.find(r => r.path === 'hooks.onRelease').set(sug.hooks.onRelease);
        toast(`Detected ${sug.name}: hooks refilled, click Save to keep them. ${sug.note}`, true);
      } }, 'Detect hooks'),
  ]);
}

function openProfileEditor(oldName) {
  const isNew = oldName == null;
  const p = isNew ? {} : clone(raw.profiles[oldName]);
  const globals = { ...clone(state.defaults), ...clone(globalsOf(raw)) };
  // deep-merge one level (stream / shortcuts / hooks) so inheritance shows real values
  for (const k of ['stream', 'shortcuts', 'hooks', 'tailscale']) {
    globals[k] = { ...state.defaults[k], ...(globalsOf(raw)[k] || {}) };
  }

  const name = h('input', { type: 'text', value: oldName || '', placeholder: 'My computer' });
  const host = h('input', { type: 'text', value: p.host || '', placeholder: '192.168.1.10:8080 or https://host', spellcheck: 'false' });
  const user = h('input', { type: 'text', value: p.user || '', placeholder: 'user' });
  const initialSrc = p.passwordFile ? 'file' : p.passwordEnv ? 'env' : 'stored';
  const src = h('select', {},
    h('option', { value: 'stored' }, 'Saved in config file'),
    h('option', { value: 'file' }, 'Read from a file'),
    h('option', { value: 'env' }, 'Environment variable'));
  src.value = initialSrc;
  const secretVals = { stored: p.password || '', file: p.passwordFile || '', env: p.passwordEnv || '' };
  const secret = h('input', { type: 'password', value: secretVals[initialSrc] });
  let currentSrc = initialSrc;
  const syncSecret = () => {
    secretVals[currentSrc] = secret.value;
    currentSrc = src.value;
    secret.value = secretVals[currentSrc];
    secret.type = currentSrc === 'stored' ? 'password' : 'text';
    secret.placeholder = { stored: '', file: '~/.config/selkies-client/pass.txt', env: 'SELKIES_PASSWORD' }[currentSrc];
    hint.textContent = currentSrc === 'stored'
      ? 'Stored in plain text in the config file (readable only by you).' : '';
  };
  const hint = h('small', {});
  src.addEventListener('change', syncSecret);
  const fp = h('input', { type: 'text', value: p.certFingerprint || '', placeholder: 'sha256/… (auto-filled when you trust a certificate)', spellcheck: 'false' });
  const isDefault = h('input', { type: 'checkbox' });
  isDefault.checked = !isNew && raw.default === oldName;

  const connection = h('section', {}, h('h3', {}, 'Connection'),
    row('Name', name), row('Host', host), row('User', user),
    row('Password', src, secret, hint),
    row('Certificate', fp),
    row('', h('label', { class: 'inherit', style: 'color:inherit;font-size:inherit' }, isDefault, ' Default profile')));

  const { sections, rows } = overridableSections('profile', p, globals);
  // Only offered once Tailscale is enabled in the settings; otherwise the profile is left as it is
  const useTs = overridableRow(TS_USE, 'profile', p, globals);
  sections.push(h('section', {}, h('h3', {}, 'Tailscale'), tailscaleEnabled() ? useTs.el
    : row('', h('small', { style: 'color:var(--muted)' }, 'Not configured: enable and connect Tailscale in ⚙ Settings.'))));
  if (tailscaleEnabled()) rows.push(useTs);

  const save = async () => {
    const newName = name.value.trim();
    if (!newName) return toast('A name is required');
    if (!host.value.trim()) return toast('A host is required');
    if (newName !== oldName && raw.profiles && raw.profiles[newName]) return toast('This name is already used');

    const np = p;
    rows.forEach(r => r.apply(np));
    np.host = host.value.trim();
    user.value.trim() ? (np.user = user.value.trim()) : delete np.user;
    fp.value.trim() ? (np.certFingerprint = fp.value.trim()) : delete np.certFingerprint;
    secretVals[currentSrc] = secret.value;
    delete np.password; delete np.passwordFile; delete np.passwordEnv;
    const key = { stored: 'password', file: 'passwordFile', env: 'passwordEnv' }[currentSrc];
    if (secretVals[currentSrc]) np[key] = secretVals[currentSrc];

    const backup = raw;
    raw = clone(raw);
    const profiles = {};
    let placed = false;
    for (const [k, v] of Object.entries(raw.profiles || {})) { // keep order, handle rename
      if (k === oldName) { profiles[newName] = np; placed = true; } else profiles[k] = v;
    }
    if (!placed) profiles[newName] = np;
    raw.profiles = profiles;
    if (isDefault.checked) raw.default = newName;
    else if (raw.default === oldName || raw.default === newName) delete raw.default;
    if (!isDefault.checked && !raw.default) delete raw.default;

    if (await persist()) { closeModal(); render(); } else raw = backup;
  };

  const actions = [
    h('button', { onclick: save }, 'Save'),
    h('button', { class: 'ghost', onclick: closeModal }, 'Cancel'),
  ];
  if (!isNew) {
    const del = h('button', { class: 'danger', style: 'margin-left:auto' }, 'Delete');
    let armed = false;
    del.addEventListener('click', async () => {
      if (!armed) { armed = true; del.textContent = 'Click again to confirm'; return; }
      const backup = raw;
      raw = clone(raw);
      delete raw.profiles[oldName];
      if (raw.default === oldName) delete raw.default;
      if (await persist()) { closeModal(); render(); } else raw = backup;
    });
    actions.push(del);
  }
  showDialog(isNew ? 'Add computer' : `Edit “${oldName}”`, connection, sections, actions);
  syncSecret();
  name.focus();
}

function showDialog(title, ...parts) {
  const actions = parts.pop();
  const m = $('modal');
  m.replaceChildren(h('div', { class: 'dialog', role: 'dialog' },
    h('h2', {}, title), h('div', { class: 'body' }, parts), h('div', { class: 'actions' }, actions)));
  m.hidden = false;
}

/* ---------- home grid ---------- */
function viaTailscale(profile) {
  const ts = globalsOf(raw).tailscale || {};
  const own = (profile.tailscale || {}).use;
  return !!(own !== undefined ? own : ts.enabled && ts.useByDefault);
}

function summary(profile) {
  const g = globalsOf(raw);
  const stream = { ...state.defaults.stream, ...(g.stream || {}), ...(profile.stream || {}) };
  const bits = [];
  if (stream.bitrateKbps > 0) {
    bits.push(stream.bitrateKbps >= 1000 && stream.bitrateUnit !== 'kbps'
      ? `${+(stream.bitrateKbps / 1000).toFixed(2)} Mbps` : `${stream.bitrateKbps} kbps`);
  }
  if (stream.quality && stream.quality !== 'auto') bits.push(stream.quality);
  return bits.join(' · ') || 'Default stream';
}

async function connect(name, tile) {
  tile.classList.add('busy');
  const res = await api.connect(name);
  if (res && res.error) toast(res.error);
  setTimeout(() => tile.classList.remove('busy'), 800);
}

function render() {
  const grid = $('grid');
  const profiles = Object.entries(raw.profiles || {});
  grid.replaceChildren(...profiles.map(([name, p]) => {
    const tile = h('div', { class: 'tile' + (raw.default === name ? ' default' : ''), tabindex: '0',
      onclick: () => connect(name, tile) },
      h('button', { class: 'edit', title: 'Edit', onclick: e => { e.stopPropagation(); openProfileEditor(name); } }, '✎'),
      h('div', { class: 'monitor' }, h('div', { class: 'screen' }), h('div', { class: 'foot' }), h('div', { class: 'base' })),
      h('div', { class: 'name' }, name),
      h('div', { class: 'sub' }, p.host || ''),
      h('div', { class: 'badge' }, summary(p),
        viaTailscale(p) ? h('span', { class: 'pill', title: 'Goes through Tailscale (SOCKS5, WebSocket mode)' }, 'Tailscale') : null));
    tile.addEventListener('keydown', e => { if (e.key === 'Enter') connect(name, tile); });
    return tile;
  }), h('div', { class: 'tile add', tabindex: '0', onclick: () => openProfileEditor(null) },
    h('div', { class: 'plus' }, '+'), h('div', {}, 'Add')));
  $('empty').hidden = profiles.length > 0;
}

/* ---------- window-manager hooks suggestion (Linux) ---------- */
const sameHooks = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b);

async function applySuggestion(sug) {
  const backup = raw;
  raw = { ...raw, hooks: clone(sug.hooks) };
  if (await persist()) { $('hooks-banner').hidden = true; toast(`Hooks set for ${sug.name}`, true); }
  else raw = backup;
}

async function dontAskAgain() {
  const backup = raw;
  raw = { ...raw, autoHooks: false };
  if (await persist()) $('hooks-banner').hidden = true; else raw = backup;
}

function handleSuggestion(sug) {
  if (!sug || state.error) return;
  if (!state.exists) { // brand new configuration: fill the hooks silently
    raw = { ...raw, hooks: clone(sug.hooks) };
    toast(`Detected ${sug.name}: capture hooks filled in. ${sug.note}`, true);
    return;
  }
  if (raw.autoHooks === false || sameHooks(raw.hooks, sug.hooks)) return;
  const b = $('hooks-banner');
  const cmd = a => a.map(quote).join(' ');
  b.replaceChildren(
    h('div', { class: 'msg' },
      `${sug.name} detected. Replace the capture hooks with “${cmd(sug.hooks.onCapture[0])}” / “${cmd(sug.hooks.onRelease[0])}”?`,
      h('small', {}, sug.note)),
    h('button', { onclick: () => applySuggestion(sug) }, 'Yes'),
    h('button', { class: 'ghost', onclick: () => { b.hidden = true; } }, 'No'),
    h('button', { class: 'ghost', onclick: dontAskAgain }, "Don't ask again"));
  b.hidden = false;
}

async function init() {
  state = await api.getConfig();
  raw = state.raw;
  $('footer').textContent = state.file;
  if (state.error) {
    const b = $('error-banner');
    b.textContent = `Cannot read the config file (${state.error}). Fix it by hand; saving is disabled.`;
    b.hidden = false;
  }
  $('settings-btn').addEventListener('click', openGlobalEditor);
  $('modal').addEventListener('mousedown', e => { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  tsStatus = await api.tailscale.status();
  api.tailscale.onStatus(s => { tsStatus = s; if (tsRender) tsRender(s); });
  api.onSessionError(msg => toast('Connection failed: ' + msg, false, 12000));
  handleSuggestion(state.suggestion);
  render();
}

init();
