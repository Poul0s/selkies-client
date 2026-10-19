'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: raw => ipcRenderer.invoke('config:save', raw),
  detectHooks: () => ipcRenderer.invoke('hooks:detect'),
  onSessionError: cb => ipcRenderer.on('session:error', (e, msg) => cb(msg)),
  connect: name => ipcRenderer.invoke('session:connect', name),
  tailscale: {
    status: () => ipcRenderer.invoke('tailscale:status'),
    connect: () => ipcRenderer.invoke('tailscale:connect'),
    disconnect: () => ipcRenderer.invoke('tailscale:disconnect'),
    forget: () => ipcRenderer.invoke('tailscale:forget'),
    openLogin: () => ipcRenderer.invoke('tailscale:login'),
    onStatus: cb => ipcRenderer.on('tailscale:status', (e, s) => cb(s)),
  },
});
