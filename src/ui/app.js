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
function toast(msg, ok = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (ok ? ' ok' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

// Splits a command line into argv, honouring "double" and 'single' quotes
function tokenize(line) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]);
  return out;
}
const quote = s => (/[\s"']/.test(s) || s === '' ? `"${s.replace(/(["\\])/g, '\\$1')}"` : s);

/* ---------- field controls ---------- */
const QUALITIES = [
  ['auto', 'Auto (server default)'], ['low', 'Low'], ['balanced', 'Balanced'],
  ['high', 'High'], ['ultra', 'Ultra'],
];

const OVERRIDABLE = [
  ['Stream', [
    { id: 'bitrate', type: 'bitrate', label: 'Bitrate limit',
      hint: 'Empty or 0 = no limit. A limit switches the encoder to constant-bitrate mode.' },
    { path: 'stream.quality', type: 'select', label: 'Quality', options: QUALITIES,
      hint: 'Constant-quality preset, used when no bitrate limit is set (also drives JPEG quality).' },
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
function accessors(f) {
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
    read: o => getPath(o, f.path),
    write: (o, v) => setPath(o, f.path, v),
    clear: o => delPath(o, f.path),
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
function overridableRow(f, scope, ownObj, inheritedObj) {
  const acc = accessors(f);
  const ctl = makeControl(f);
  const own = acc.read(ownObj);
  const inherited = acc.read(inheritedObj);
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
function closeModal() { $('modal').hidden = true; $('modal').replaceChildren(); }

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

function openGlobalEditor() {
  const draft = clone(globalsOf(raw));
  const { sections, rows } = overridableSections('global', draft, state.defaults);
  const save = async () => {
    rows.forEach(r => r.apply(draft));
    const next = { ...(raw.default ? { default: raw.default } : {}), ...draft, profiles: raw.profiles || {} };
    const backup = raw;
    raw = next;
    if (await persist()) { closeModal(); render(); toast('Settings saved', true); } else raw = backup;
  };
  showDialog('Global settings', h('p', { style: 'margin:12px 0 0;color:var(--muted)' },
    'Defaults for every profile. Each profile can override them.'), sections, [
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
  for (const k of ['stream', 'shortcuts', 'hooks']) {
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

  const row = (label, ...ctl) => h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctl' }, ctl));
  const connection = h('section', {}, h('h3', {}, 'Connection'),
    row('Name', name), row('Host', host), row('User', user),
    row('Password', src, secret, hint),
    row('Certificate', fp),
    row('', h('label', { class: 'inherit', style: 'color:inherit;font-size:inherit' }, isDefault, ' Default profile')));

  const { sections, rows } = overridableSections('profile', p, globals);

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
      h('div', { class: 'badge' }, summary(p)));
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
  handleSuggestion(state.suggestion);
  render();
}

init();
