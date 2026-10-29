import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from './types.js';

const bridge: DesktopBridge = {
  platform: process.platform,
  titlebarHeight: 52,
  vibrancy: process.platform === 'darwin',
  getStatus: () => ipcRenderer.invoke('desktop:status'),
  setTheme: mode => ipcRenderer.invoke('desktop:theme', mode),
  revealProject: projectId => ipcRenderer.invoke('desktop:reveal-project', projectId),
  revealExport: (projectId, assetId) => ipcRenderer.invoke('desktop:reveal-export', projectId, assetId),
  openExternal: url => ipcRenderer.invoke('desktop:external', url),
  setDemo: on => ipcRenderer.invoke('desktop:demo', on),
};
contextBridge.exposeInMainWorld('nightshiftDesktop', Object.freeze(bridge));
