import { app, BrowserWindow, session, WebContentsView, type Session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AccountStore, Account } from './store'

export type Presence = 'logged' | 'guest' | 'expired' | 'unknown'

const DOUBAO_URL = 'https://www.doubao.com/chat/'
const LOGIN_COOKIES = ['sessionid', 'sessionid_ss']
const MAX_ALIVE_VIEWS = 8 // LRU 保活上限，超出销毁最久未用的后台视图（登录态仍在 partition）

interface PushFn {
  (channel: string, payload: unknown): void
}

export class ViewManager {
  private win: BrowserWindow
  private store: AccountStore
  private push: PushFn

  /** 会话创建钩子：供产物管理器挂拦截 */
  onViewSession?: (ses: Session, id: string) => void
  /** 页面 webContents 创建钩子：供产物管理器挂 CDP 监听 */
  onViewCreated?: (wc: Electron.WebContents, id: string) => void

  private tabs: string[] = [] // 打开的账号 id，按打开顺序
  private activeId: string | null = null
  private views = new Map<string, WebContentsView>()
  private lastUsed = new Map<string, number>()
  private bounds = { x: 0, y: 0, width: 0, height: 0 }

  constructor(win: BrowserWindow, store: AccountStore, push: PushFn) {
    this.win = win
    this.store = store
    this.push = push
  }

  private sessionFor(id: string): Session {
    return session.fromPartition(`persist:doubao_${id}`)
  }

  async destroySessionData(id: string): Promise<void> {
    const ses = this.sessionFor(id)
    try {
      await ses.clearStorageData()
      await ses.clearCache()
    } catch {
      // ignore
    }
  }

  /** 面板产物下载预先登记的文件名（下载一次消费一次） */

  /** 下载处理：自动保存到系统「下载」目录，重名自动编号，并向前端推送进度 */
  private attachDownloadHandler(ses: Session, accountId: string): void {
    const flag = ses as Session & { __dlAttached?: boolean }
    if (flag.__dlAttached) return
    flag.__dlAttached = true

    ses.on('will-download', (_e, item) => {
      // 页面内发起的下载（面板产物下载已改为主进程流式下载，不经过这里）
      console.log(
        `[download] will-download total=${item.getTotalBytes()} mime=${item.getMimeType()}`
      )
      const dir = app.getPath('downloads')
      let base = item.getFilename() || `download-${Date.now()}`
      const ext = path.extname(base)
      const stem = path.basename(base, ext)
      let savePath = path.join(dir, base)
      let n = 1
      while (fs.existsSync(savePath)) {
        savePath = path.join(dir, `${stem} (${n++})${ext}`)
      }
      item.setSavePath(savePath)

      const payload = (status: string, extra: Record<string, unknown> = {}): void => {
        this.push('download:event', {
          accountId,
          status,
          filename: base,
          savePath,
          received: item.getReceivedBytes(),
          total: item.getTotalBytes(),
          ...extra
        })
      }

      payload('started')
      let lastLog = Date.now()
      item.on('updated', (_ev, state) => {
        if (state === 'progressing' && !item.isPaused()) payload('progressing')
        // 调试：每秒抽样一次真实进度，确认 total/received 是否符合预期
        if (Date.now() - lastLog >= 1000) {
          lastLog = Date.now()
          console.log(
            `[download] ${state} received=${item.getReceivedBytes()} total=${item.getTotalBytes()}`
          )
        }
      })
      item.once('done', (_ev, state) => {
        payload(state === 'completed' ? 'done' : 'failed')
        console.log(
          `[download] done state=${state} received=${item.getReceivedBytes()} total=${item.getTotalBytes()}`
        )
      })
    })
  }

  private ensureView(id: string): WebContentsView {
    let view = this.views.get(id)
    if (view) return view

    this.evictIfNeeded()
    const ses = this.sessionFor(id)
    this.attachDownloadHandler(ses, id)
    this.onViewSession?.(ses, id)
    view = new WebContentsView({
      webPreferences: {
        session: ses,
        contextIsolation: true
      }
    })
    this.views.set(id, view)
    this.onViewCreated?.(view.webContents, id)
    view.webContents.loadURL(DOUBAO_URL)
    return view
  }

  /** LRU：超过保活上限时销毁最久未用的非激活视图 */
  private evictIfNeeded(): void {
    while (this.views.size >= MAX_ALIVE_VIEWS) {
      let oldestId: string | null = null
      let oldest = Infinity
      for (const [vid] of this.views) {
        if (vid === this.activeId) continue
        const t = this.lastUsed.get(vid) ?? 0
        if (t < oldest) {
          oldest = t
          oldestId = vid
        }
      }
      if (!oldestId) break
      this.detach(oldestId)
    }
  }

  private detach(id: string): void {
    const view = this.views.get(id)
    if (!view) return
    try {
      this.win.contentView.removeChildView(view)
    } catch {
      // ignore
    }
    this.views.delete(id)
    view.webContents.close()
  }

  open(id: string): void {
    if (!this.store.accounts.some((a) => a.id === id)) return
    if (!this.tabs.includes(id)) this.tabs.push(id)
    this.activate(id)
    this.store.touch(id)
  }

  activate(id: string): void {
    if (this.activeId && this.activeId !== id) {
      const cur = this.views.get(this.activeId)
      if (cur) {
        try {
          this.win.contentView.removeChildView(cur)
        } catch {
          // ignore
        }
      }
    }
    const view = this.ensureView(id)
    this.lastUsed.set(id, Date.now())
    this.activeId = id
    this.win.contentView.addChildView(view)
    view.setBounds(this.bounds)
    this.win.focusOnWebView?.()
    this.pushTabs()
  }

  closeTab(id: string): void {
    if (this.views.get(id) && id === this.activeId) {
      this.detach(id)
    } else {
      const v = this.views.get(id)
      if (v) this.detach(id)
    }
    this.tabs = this.tabs.filter((t) => t !== id)
    if (this.activeId === id) {
      this.activeId = this.tabs.length ? this.tabs[this.tabs.length - 1] : null
      if (this.activeId) {
        this.activate(this.activeId)
        return
      }
    }
    this.pushTabs()
  }

  setBounds(r: { x: number; y: number; width: number; height: number }): void {
    this.bounds = r
    if (this.activeId) {
      const view = this.views.get(this.activeId)
      if (view) view.setBounds(r)
    }
  }

  /** 打开窗口内浮层（图片/视频预览）时临时移除当前视图：原生 WebContentsView 永远盖住 DOM 浮层 */
  setOverlay(hidden: boolean): void {
    const view = this.activeId ? this.views.get(this.activeId) : null
    if (!view) return
    try {
      if (hidden) {
        this.win.contentView.removeChildView(view)
      } else {
        this.win.contentView.addChildView(view)
        view.setBounds(this.bounds)
      }
    } catch {
      // ignore
    }
  }

  /** 当前真正可见的视图 webContents：不接受未激活账号，也不创建隐藏临时视图 */
  activeWebContents(id: string): Electron.WebContents | null {
    if (this.activeId !== id) return null
    const view = this.views.get(id)
    return view ? view.webContents : null
  }

  tabsState(): { tabs: { id: string; name: string; color: string }[]; activeId: string | null } {
    const tabs = this.tabs
      .map((id) => this.store.accounts.find((a) => a.id === id))
      .filter((a): a is Account => !!a)
      .map((a) => ({ id: a.id, name: a.name, color: a.color }))
    return { tabs, activeId: this.activeId }
  }

  pushTabs(): void {
    this.push('state:tabs', this.tabsState())
  }

  recentAccounts(n: number): Account[] {
    return [...this.store.accounts]
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, n)
  }

  async checkPresence(id: string): Promise<Presence> {
    try {
      const ses = this.sessionFor(id)
      const cookies = await ses.cookies.get({ domain: 'doubao.com' })
      const now = Date.now() / 1000
      const hit = cookies.find((c) => LOGIN_COOKIES.includes(c.name))
      if (!hit) return 'guest'
      if (hit.expirationDate && hit.expirationDate < now) return 'expired'
      return 'logged'
    } catch {
      return 'unknown'
    }
  }

  startPresencePolling(onResult: (p: Record<string, Presence>) => void): void {
    const run = async () => {
      const result: Record<string, Presence> = {}
      await Promise.all(
        this.store.accounts.map(async (a) => {
          result[a.id] = await this.checkPresence(a.id)
        })
      )
      onResult(result)
    }
    void run()
    setInterval(run, 30_000)
  }
}
