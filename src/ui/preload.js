'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: raw => ipcRenderer.invoke('config:save', raw),
  detectHooks: () => ipcRenderer.invoke('hooks:detect'),
  connect: name => ipcRenderer.invoke('session:connect', name),
});
