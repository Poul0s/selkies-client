'use strict';
// Runs before the Selkies page scripts: seeds the web client's persisted
// settings (bitrate, quality...) in localStorage, using the same key scheme
// as selkies-web-core (`<origin+pathname sanitized>_<setting>`).
(() => {
  const arg = process.argv.find(a => a.startsWith('--stream-settings='));
  if (!arg) return;
  try {
    const { origin, settings } = JSON.parse(decodeURIComponent(arg.slice('--stream-settings='.length)));
    if (window.location.origin !== origin) return;
    const prefix = (window.location.origin + window.location.pathname)
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    for (const [key, value] of Object.entries(settings)) {
      window.localStorage.setItem(`${prefix}_${key}`, String(value));
    }
  } catch (e) {
    console.warn('selkies-client: could not apply stream settings:', e.message);
  }
})();

// Shortcuts seen from inside the page: still delivered when Chromium holds the
// keyboard (keyboard lock), and registered before the Selkies handlers so the
// keys never reach the remote machine.
const { ipcRenderer, webFrame } = require('electron');
ipcRenderer.invoke('shortcuts:get').then(defs => {
  if (!defs) return;
  const isChar = k => typeof k === 'string' && /^[a-z0-9]$/i.test(k);
  window.addEventListener('keydown', e => {
    if (e.repeat) return;
    for (const [name, sc] of Object.entries(defs)) {
      const byKey = sc.key && isChar(e.key);
      if ((byKey ? e.key.toLowerCase() === sc.key : e.code === sc.code)
          && e.ctrlKey === sc.ctrl && e.altKey === sc.alt
          && e.shiftKey === sc.shift && e.metaKey === sc.meta) {
        e.preventDefault();
        e.stopImmediatePropagation();
        ipcRenderer.send('shortcut', name);
        return;
      }
    }
  }, true);
}).catch(() => {});

// Tells the main process when the page opens a WebRTC connection (i.e. the server is not in
// WebSocket mode). The wrapper has to live in the page's own world, hence the injection.
webFrame.executeJavaScript(`(() => {
  const PC = window.RTCPeerConnection;
  if (!PC) return;
  window.RTCPeerConnection = new Proxy(PC, {
    construct(target, args, newTarget) {
      window.postMessage({ type: 'selkies-client:webrtc' }, window.location.origin);
      return Reflect.construct(target, args, newTarget);
    },
  });
})()`).catch(() => {});
window.addEventListener('message', e => {
  if (e.source === window && e.data && e.data.type === 'selkies-client:webrtc') ipcRenderer.send('webrtc-detected');
});
