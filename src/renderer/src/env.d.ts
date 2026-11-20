export interface Account {
  id: string
  name: string
  color: string
  createdAt: number
  lastActiveAt: number
}

export type Presence = 'logged' | 'guest' | 'expired' | 'unknown'

export interface TabInfo {
  tabs: { id: string; name: string; color: string }[]
  activeId: string | null
}

export interface DownloadEvent {
  accountId: string
  status: 'started' | 'progressing' | 'done' | 'failed'
  filename: string
  savePath: string
  received: number
  total: number
}

export interface ArtifactItem {
  id: string
  accountId: string
  kind: 'image' | 'video'
  url: string
  filename: string
  time: number
  size: number
  thumb?: string
  thumbSrc?: string
  prompt?: string
  convId?: string
}

export interface AttachEvent {
  id: string
  accountId: string
  status: 'switching' | 'downloading' | 'injecting' | 'done' | 'failed'
  filename?: string
  received?: number
  total?: number
  reason?: string
  filePath?: string
}

export interface Api {
  platform: NodeJS.Platform | string
  listAccounts(): Promise<Account[]>
  addAccount(name: string): Promise<Account>
  renameAccount(id: string, name: string): Promise<void>
  deleteAccount(id: string): Promise<void>
  openAccount(id: string): Promise<void>
  closeTab(id: string): Promise<void>
  getTabs(): Promise<TabInfo>
  setOverlay(hidden: boolean): Promise<void>
  listArtifacts(): Promise<ArtifactItem[]>
  downloadArtifact(id: string): Promise<boolean>
  clearArtifacts(): void
  attachFromUrl(accountId: string, url: string): Promise<{ ok: boolean; reason?: string }>
  cancelAttach(accountId: string): void
  setBounds(r: { x: number; y: number; width: number; height: number }): void
  revealDownload(savePath: string): void
  winControl(action: 'min' | 'max' | 'close'): void
  onAccounts(cb: (data: Account[]) => void): () => void
  onTabs(cb: (data: TabInfo) => void): () => void
  onPresence(cb: (data: Record<string, Presence>) => void): () => void
  onDownload(cb: (data: DownloadEvent) => void): () => void
  onArtifactEvent(cb: (data: ArtifactItem) => void): () => void
  onArtifactUpdate(cb: (data: ArtifactItem) => void): () => void
  onArtifactCleared(cb: () => void): () => void
  onAttach(cb: (data: AttachEvent) => void): () => void
}

declare global {
  interface Window {
    api: Api
  }
}
