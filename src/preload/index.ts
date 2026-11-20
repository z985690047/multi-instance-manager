import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type Unsubscribe = () => void

function subscribe(channel: string, cb: (data: unknown) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, data: unknown): void => cb(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  addAccount: (name: string) => ipcRenderer.invoke('accounts:add', name),
  renameAccount: (id: string, name: string) => ipcRenderer.invoke('accounts:rename', { id, name }),
  deleteAccount: (id: string) => ipcRenderer.invoke('accounts:delete', id),
  openAccount: (id: string) => ipcRenderer.invoke('accounts:open', id),
  closeTab: (id: string) => ipcRenderer.invoke('tabs:close', id),
  getTabs: () => ipcRenderer.invoke('tabs:list'),
  setOverlay: (hidden: boolean) => ipcRenderer.invoke('view:overlay', hidden),
  listArtifacts: () => ipcRenderer.invoke('artifacts:list'),
  downloadArtifact: (id: string) => ipcRenderer.invoke('artifacts:download', id),
  clearArtifacts: () => ipcRenderer.send('artifacts:clear'),
  attachFromUrl: (accountId: string, url: string) =>
    ipcRenderer.invoke('attach:from-url', { accountId, url }),
  cancelAttach: (accountId: string) => ipcRenderer.send('attach:cancel', accountId),
  setBounds: (r: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send('view:bounds', r),
  revealDownload: (savePath: string) => ipcRenderer.send('download:reveal', savePath),
  winControl: (action: 'min' | 'max' | 'close') => ipcRenderer.send('win:control', action),
  onAccounts: (cb: (data: unknown) => void): Unsubscribe => subscribe('state:accounts', cb),
  onTabs: (cb: (data: unknown) => void): Unsubscribe => subscribe('state:tabs', cb),
  onPresence: (cb: (data: unknown) => void): Unsubscribe => subscribe('state:presence', cb),
  onDownload: (cb: (data: unknown) => void): Unsubscribe => subscribe('download:event', cb),
  onArtifactEvent: (cb: (data: unknown) => void): Unsubscribe => subscribe('artifact:event', cb),
  onArtifactUpdate: (cb: (data: unknown) => void): Unsubscribe => subscribe('artifact:update', cb),
  onArtifactCleared: (cb: () => void): Unsubscribe => subscribe('artifact:cleared', () => cb()),
  onAttach: (cb: (data: unknown) => void): Unsubscribe => subscribe('attach:event', cb)
})
