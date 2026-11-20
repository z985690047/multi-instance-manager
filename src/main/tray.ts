import { app, Menu, nativeImage, Tray } from 'electron'
import { IS_MAC } from './platform'

interface ToggleFn {
  (): void
}

interface RecentFn {
  (): { id: string; name: string; lastActiveAt: number }[]
}

let tray: Tray | null = null
let openAccount: ((id: string) => void) | null = null
let recentFn: RecentFn | null = null

/** macOS 用 16x16 模板图（跟随菜单栏明暗）；Windows/Linux 用彩色 32x32，避免深色任务栏上看不见 */
function makeTrayIcon(): Electron.NativeImage {
  if (IS_MAC) {
    const size = 16
    const buf = Buffer.alloc(size * size * 4)
    const cx = (size - 1) / 2
    const cy = (size - 1) / 2
    const r = 6
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - cx, y - cy)
        let a = 0
        if (d <= r - 1.2) a = 255
        else if (d <= r) a = (255 * (r - d)) / 1.2
        const i = (y * size + x) * 4
        buf[i] = 0
        buf[i + 1] = 0
        buf[i + 2] = 0
        buf[i + 3] = a
      }
    }
    const img = nativeImage.createFromBitmap(buf, { width: size, height: size })
    img.setTemplateImage(true)
    return img
  }

  // 32x32 圆角方形 + 两条白色横条，呼应应用图标的「层叠窗口」
  const size = 32
  const buf = Buffer.alloc(size * size * 4)
  const margin = 3
  const radius = 7
  const inRounded = (x: number, y: number): boolean => {
    const min = margin
    const max = size - 1 - margin
    const rx = x < min + radius ? min + radius : x > max - radius ? max - radius : x
    const ry = y < min + radius ? min + radius : y > max - radius ? max - radius : y
    return Math.hypot(x - rx, y - ry) <= radius
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRounded(x, y)) continue
      const bar1 = y >= 12 && y <= 15 && x >= 9 && x <= 23
      const bar2 = y >= 19 && y <= 21 && x >= 9 && x <= 19
      const i = (y * size + x) * 4
      if (bar1 || bar2) {
        buf[i] = 255
        buf[i + 1] = 255
        buf[i + 2] = 255
      } else {
        // #3370FF -> BGRA
        buf[i] = 255
        buf[i + 1] = 112
        buf[i + 2] = 51
      }
      buf[i + 3] = 255
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

export function createTray(toggle: ToggleFn, recent: RecentFn): void {
  recentFn = recent
  tray = new Tray(makeTrayIcon())
  tray.setToolTip('豆包多开管理器')

  const rebuild = (): void => {
    if (!tray) return
    const recents = recentFn ? recentFn() : []
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示 / 隐藏窗口', click: toggle },
        { type: 'separator' },
        ...(recents.length
          ? [
              ...recents.map((a) => ({
                label: `打开「${a.name}」`,
                click: () => {
                  openAccount?.(a.id)
                }
              })),
              { type: 'separator' } as const
            ]
          : []),
        {
          label: '退出',
          click: () => {
            app.isQuitting = true
            app.quit()
          }
        }
      ])
    )
  }

  rebuild()
  // 账号列表会变化，定时刷新托盘菜单里的最近账号
  setInterval(rebuild, 60_000)

  // macOS：左键点击托盘切换窗口
  tray.on('click', toggle)
}

/** 供主进程注入「打开账号」回调（托盘菜单快捷打开） */
export function setTrayOpenHandler(fn: (id: string) => void): void {
  openAccount = fn
}
