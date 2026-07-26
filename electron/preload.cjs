const { contextBridge, ipcRenderer } = require('electron');

// Native bridge. The renderer checks for `window.livepatchNative` and falls
// back to localStorage / browser file pickers when absent (plain-browser dev).
contextBridge.exposeInMainWorld('livepatchNative', {
  listScenes: () => ipcRenderer.invoke('scenes:list'),
  saveScene: (name, json) => ipcRenderer.invoke('scenes:save', name, json),
  loadScene: (name) => ipcRenderer.invoke('scenes:load', name),
  deleteScene: (name) => ipcRenderer.invoke('scenes:delete', name),
  exportScene: (name, json) => ipcRenderer.invoke('dialog:export', name, json),
  importScene: () => ipcRenderer.invoke('dialog:import'),
  openAudioFile: () => ipcRenderer.invoke('dialog:openAudioFile'),
  openAudioFiles: () => ipcRenderer.invoke('dialog:openAudioFiles'),
  openAudioFolder: () => ipcRenderer.invoke('dialog:openAudioFolder'),
  openMidiFiles: () => ipcRenderer.invoke('dialog:openMidiFiles'),
  openMidiFolder: () => ipcRenderer.invoke('dialog:openMidiFolder'),
  openVstPlugin: () => ipcRenderer.invoke('dialog:openVstPlugin'),
  openFolder: (title) => ipcRenderer.invoke('dialog:openFolder', title),
  saveAudioFile: (name, ext, data) => ipcRenderer.invoke('dialog:saveAudioFile', name, ext, data),
  cassettesList: () => ipcRenderer.invoke('cassettes:list'),
  cassettesSave: (meta, data) => ipcRenderer.invoke('cassettes:save', meta, data),
  cassettesLoad: (id) => ipcRenderer.invoke('cassettes:load', id),
  cassettesDelete: (id) => ipcRenderer.invoke('cassettes:delete', id),
  cassettesUpdateMeta: (id, patch) => ipcRenderer.invoke('cassettes:updateMeta', id, patch),
  cassettesImportPaths: (paths) => ipcRenderer.invoke('cassettes:importPaths', paths),
  cassettesSavePcm: (id, data) => ipcRenderer.invoke('cassettes:savePcm', id, data),
  vstScan: (dirs) => ipcRenderer.invoke('vst:scan', dirs),
  vstFrame: (shm, lastSeq) => ipcRenderer.invoke('vst:frame', shm, lastSeq),
  engineStart: (cfg) => ipcRenderer.invoke('engine:start', cfg),
  engineStop: () => ipcRenderer.invoke('engine:stop'),
  engineSend: (msg) => ipcRenderer.invoke('engine:send', msg),
  onEngineMessage: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('engine:message', listener);
    return () => ipcRenderer.removeListener('engine:message', listener);
  },
  updatesCheck: () => ipcRenderer.invoke('updates:check'),
  updatesDownload: () => ipcRenderer.invoke('updates:download'),
  updatesInstall: () => ipcRenderer.invoke('updates:install'),
  onUpdateProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('updates:progress', listener);
    return () => ipcRenderer.removeListener('updates:progress', listener);
  },
});
