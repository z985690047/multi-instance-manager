import { app, BrowserWindow, ipcMain, Menu, protocol, session, shell } from 'electron'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { AccountStore, type Account } from './store'
import { ViewManager, type Presence } from './manager'
import { createTray, setTrayOpenHandler } from './tray'
import { ArtifactManager } from './artifacts'
import { AttachmentManager } from './attach'
import { IS_MAC } from './platform'

// electron.d.ts 里 App 是全局命名空间 Electron 下的接口（模块 'electron' 只是
// `export = Electron.CrossProcessExports`），所以必须合并到 Electron.App，
// 不能在模块里重新声明 interface App（会与已导出的 type App 别名重名）。
declare global {
  namespace Electron {
    interface App {
      isQuitting?: boolean
    }
  }
}

// 用户可见名称统一为中文；必须在 app ready 前设置，否则菜单栏/关于面板仍会用旧名
app.setName('豆包多开管理器')
// 关键：productName 改动会让默认 userData 变成 ~/Library/Application Support/豆包多开管理器。
// 显式固定回旧目录，保证 accounts.json、persist 登录态分区与日志全部沿用
app.setPath('userData', join(app.getPath('appData'), 'doubao-multi-manager'))
if (IS_MAC) {
  app.setAboutPanelOptions({
    applicationName: '豆包多开管理器',
    applicationVersion: app.getVersion()
  })
}

// 视频代理协议：须在 app ready 前注册特权
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'artifactstream',
    privileges: { standard: true, stream: true, supportFetchAPI: true }
  }
])

let win: BrowserWindow | null = null
let store: AccountStore
let manager: ViewManager
let artifacts: ArtifactManager
let attachment: AttachmentManager
let streamLog: string

function dlog(s: string): void {
  try {
    appendFileSync(streamLog, `${new Date().toISOString()} ${s}\n`)
  } catch {
    // ignore
  }
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: '豆包多开管理器',
    // 两端都用无边框窗口：macOS 用系统红绿灯，Windows 用渲染层的 .win-controls
    frame: false,
    titleBarStyle: IS_MAC ? 'hiddenInset' : undefined,
    trafficLightPosition: IS_MAC ? { x: 16, y: 14 } : undefined,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js')
    }
  })

  w.once('ready-to-show', () => w.show())

  // 关闭 = 隐藏到托盘
  w.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      w.hide()
    }
  })

  // 注意：不能依赖 app.isPackaged（本机 dev 启动时会被误判为 true），
  // ELECTRON_RENDERER_URL 只有 electron-vite dev 会注入，生产构建不存在该变量
  if (process.env['ELECTRON_RENDERER_URL']) {
    w.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    w.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return w
}

function push(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function registerIpc(): void {
  ipcMain.handle('accounts:list', () => store.accounts)
  ipcMain.handle('accounts:add', (_e, name: string) => {
    const acc = store.add(name)
    push('state:accounts', store.accounts)
    manager.open(acc.id)
    return acc
  })
  ipcMain.handle('accounts:rename', (_e, p: { id: string; name: string }) => {
    store.rename(p.id, p.name)
    push('state:accounts', store.accounts)
    manager.pushTabs()
  })
  ipcMain.handle('accounts:delete', async (_e, id: string) => {
    manager.closeTab(id)
    await manager.destroySessionData(id)
    store.remove(id)
    push('state:accounts', store.accounts)
  })
  ipcMain.handle('accounts:open', (_e, id: string) => manager.open(id))
  ipcMain.handle('tabs:close', (_e, id: string) => manager.closeTab(id))
  ipcMain.handle('tabs:list', () => manager.tabsState())
  ipcMain.handle('view:overlay', (_e, hidden: boolean) => manager.setOverlay(hidden))
  ipcMain.handle('artifacts:list', () => artifacts.list())
  ipcMain.handle('artifacts:download', (_e, id: string) => artifacts.download(id))
  ipcMain.on('artifacts:clear', () => artifacts.clear())
  ipcMain.handle('attach:from-url', (_e, p: { accountId: string; url: string }) =>
    attachment.attachFromUrl(p.accountId, p.url)
  )
  ipcMain.on('attach:cancel', (_e, accountId: string) => attachment.cancel(accountId))
  ipcMain.on('view:bounds', (_e, r: { x: number; y: number; width: number; height: number }) => {
    manager.setBounds(r)
  })
  ipcMain.on('download:reveal', (_e, p: string) => {
    if (p) shell.showItemInFolder(p)
  })
  ipcMain.on('win:control', (_e, action: 'min' | 'max' | 'close') => {
    if (!win) return
    if (action === 'min') win.minimize()
    else if (action === 'max') win.isMaximized() ? win.unmaximize() : win.maximize()
    else if (action === 'close') win.close()
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    // 开发模式 Dock 显示自定义图标；打包后由 icon.icns 生效
    if (IS_MAC && !app.isPackaged && app.dock) {
      const devIcon = join(__dirname, '../../build/icon.png')
      if (existsSync(devIcon)) app.dock.setIcon(devIcon)
    }
    // Windows/Linux 打包后去掉默认英文菜单栏，避免与自定义标题栏重复
    if (!IS_MAC && app.isPackaged) Menu.setApplicationMenu(null)
    store = new AccountStore(app.getPath('userData'))
    streamLog = join(app.getPath('userData'), 'stream-debug.log')
    win = createWindow()
    manager = new ViewManager(win, store, push)
    artifacts = new ArtifactManager(push, app.getPath('userData'))
    manager.onViewSession = (ses, id) => artifacts.attach(ses, id)
    manager.onViewCreated = (wc, id) => artifacts.attachView(wc, id)
    attachment = new AttachmentManager(
      push,
      (id) => manager.activeWebContents(id),
      app.getPath('userData')
    )

    // 视频代理：artifactstream://v/<item.id>，经对应账号 session 转发，透传 Range 支持拖动
    protocol.handle('artifactstream', async (req) => {
      let status = 500
      try {
        const id = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''))
        const item = artifacts.get(id)
        dlog(`req ${req.url} -> ${id} ${item ? item.kind : 'NOT FOUND'}`)
        if (!item) return new Response('not found', { status: 404 })
        // 视频：主进程单条流下载到本地缓存，预览与下载共用同一条流。
        // 直接让渲染进程直连上游时，<video> 缓冲够了就停止读取，未消费的响应体会占满
        // HTTP/2 连接级流控窗口，同域后续请求（预览续读、下载）连响应头都拿不到，
        // 最终 net::ERR_HTTP2_PROTOCOL_ERROR（探针已验证）。
        if (item.kind === 'video') {
          // ?thumb=1 是列表首帧封面：只取文件头，不触发整段缓存
          const thumb = new URL(req.url).searchParams.get('thumb') === '1'
          const res = thumb
            ? await artifacts.serveThumb(item)
            : await artifacts.serveVideo(item, req.headers.get('range'))
          status = res.status
          dlog(
            `${thumb ? 'thumb' : 'video cache'} status=${status} range=${req.headers.get('range') ?? 'none'}`
          )
          return res
        }
        const ses = session.fromPartition(`persist:doubao_${item.accountId}`)
        const headers: Record<string, string> = {}
        const res = await ses.fetch(item.url, { headers })
        status = res.status
        dlog(`upstream status=${status} ct=${res.headers.get('content-type')} cl=${res.headers.get('content-length')}`)
        const resHeaders = new Headers()
        for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          const v = res.headers.get(k)
          if (v) resHeaders.set(k, v)
        }
        if (!resHeaders.has('accept-ranges')) resHeaders.set('accept-ranges', 'bytes')
        return new Response(res.body, { status: res.status, headers: resHeaders })
      } catch (err) {
        dlog(`error: ${String(err)}`)
        return new Response(String(err), { status: 502 })
      } finally {
        dlog(`done status=${status}`)
      }
    })

    registerIpc()
    createTray(() => {
      if (!win) return
      win.isVisible() && !win.isMinimized() ? win.hide() : (win.show(), win.focus())
    }, () => manager.recentAccounts(5))
    setTrayOpenHandler((id) => {
      manager.open(id)
      win?.show()
      win?.focus()
    })
    manager.startPresencePolling((p: Record<string, Presence>) => push('state:presence', p))
  })

  app.on('activate', () => {
    if (win) {
      win.show()
    }
  })

  app.on('before-quit', () => {
    app.isQuitting = true
  })

  app.on('window-all-closed', () => {
    // 托盘常驻：不退出
  })
}
