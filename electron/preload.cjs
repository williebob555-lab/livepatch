const { contextBridge, ipcRenderer } = require('electron');

// Native bridge. The renderer checks for `window.livepatchNative` and falls
// back to localStorage / browser file pickers when absent (plain-browser dev).
contextBridge.exposeInMainWorld('livepatchNative', {
  // Diagnostics log (one file per run, written by the main process only).
  diagLog: (kind, data) => ipcRenderer.invoke('diag:log', kind, data),
  diagPath: () => ipcRenderer.invoke('diag:path'),
  diagReveal: () => ipcRenderer.invoke('diag:reveal'),
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
  keysWatch: (accels) => ipcRenderer.invoke('keys:watch', accels),
  keysSend: (accel) => ipcRenderer.invoke('keys:send', accel),
  exportPlayer: (name, bytes, opts) => ipcRenderer.invoke('dialog:exportPlayer', name, bytes, opts),
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
  // Detached Dock window (dock.html). `dockwinSend` is the hot path — document
  // sync and the live value stream — so it is a fire-and-forget `send`, not an
  // `invoke`: a promise per message would tax it many times a second for a
  // result nobody reads.
  dockwinOpen: () => ipcRenderer.invoke('dockwin:open'),
  dockwinClose: () => ipcRenderer.invoke('dockwin:close'),
  dockwinIsOpen: () => ipcRenderer.invoke('dockwin:isOpen'),
  dockwinSetFullScreen: (on) => ipcRenderer.invoke('dockwin:setFullScreen', on),
  dockwinIsFullScreen: () => ipcRenderer.invoke('dockwin:isFullScreen'),
  dockwinSend: (msg) => ipcRenderer.send('dockwin:send', msg),
  onDockwinMessage: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('dockwin:message', listener);
    return () => ipcRenderer.removeListener('dockwin:message', listener);
  },
  /** The detached window closed — the main window re-attaches its Dock. */
  onDockwinAttached: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('dockwin:attached', listener);
    return () => ipcRenderer.removeListener('dockwin:attached', listener);
  },
  // LAN control surface (phone / tablet). Off until explicitly started; the
  // server is never launched at boot and its "on" state is not persisted, so
  // a machine that tried it once does not come back up listening.
  lanStart: (opts) => ipcRenderer.invoke('lan:start', opts),
  lanStop: () => ipcRenderer.invoke('lan:stop'),
  lanStatus: () => ipcRenderer.invoke('lan:status'),
  updatesCheck: () => ipcRenderer.invoke('updates:check'),
  updatesDownload: () => ipcRenderer.invoke('updates:download'),
  updatesInstall: () => ipcRenderer.invoke('updates:install'),
  onUpdateProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('updates:progress', listener);
    return () => ipcRenderer.removeListener('updates:progress', listener);
  },
});
