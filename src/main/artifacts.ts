import { session, type Session, type WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export interface ArtifactItem {
  id: string
  accountId: string
  kind: 'image' | 'video'
  url: string
  filename: string
  time: number
  size: number
  thumb?: string // data URL，仅图片
  thumbSrc?: string // 缩略图源地址（接口方案提供，长期有效）
  prompt?: string // 生成提示词（接口方案提供）
  convId?: string // 所属会话
}

const MAX_ITEMS = 200
const MAX_THUMB_BYTES = 8 * 1024 * 1024
const MIN_IMAGE_BYTES = 20 * 1024 // 小于 20K 的图基本是 UI 素材

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']
const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.m4v', '.mkv']
const EXCLUDE_KEYWORDS = [
  'favicon', 'logo', 'avatar', 'icon', 'emoji', 'sprite',
  'banner', 'watermark', '.svg', '/static/', 'sso_', 'captcha'
]

function kindByContentType(ct?: string): 'image' | 'video' | null {
  if (!ct || typeof ct !== 'string') return null
  const c = ct.toLowerCase()
  if (c.startsWith('image/')) return 'image'
  if (c.startsWith('video/')) return 'video'
  return null
}

function kindByExt(url: string): 'image' | 'video' | null {
  const p = url.split('?')[0].toLowerCase()
  if (IMAGE_EXTS.some((e) => p.endsWith(e))) return 'image'
  if (VIDEO_EXTS.some((e) => p.endsWith(e))) return 'video'
  return null
}

function isExcluded(url: string): boolean {
  const lower = url.toLowerCase()
  return EXCLUDE_KEYWORDS.some((k) => lower.includes(k))
}

/**
 * AI 生成产物的路径指纹（来自实测日志）：
 * 生成图片形如 tos-cn-i-xxx/rc_gen_image/<hash>.jpeg~tplv-...
 * 生成视频的下载/播放地址带 video_gen / gen_video / rc_gen_video 段
 * 用户上传的源文件形如 tos-cn-i-xxx/<hash>.mp4，不含任何生成指纹
 */
const GEN_PATTERNS = [
  /\/rc_gen_image\//,
  /rc_gen_video/,
  /gen_video/,
  /video_gen/,
  // 工作任务（flow）产物目录：rc/pc/super_tool/<hash>.jpg|mp4
  /\/rc\/pc\/super_tool\//
]

function isGeneratedPath(url: string): boolean {
  const lower = url.toLowerCase()
  return GEN_PATTERNS.some((r) => r.test(lower))
}

/**
 * 从 CDN 模板段提取真实输出扩展名。
 * 实测（content-type/image 字节均证实）：模板段决定转码输出格式，
 * 基础对象名 rc_gen_image/<hash>.jpeg 经 ~tplv-a9rns2rl98-cgen_wm0.png 输出的是 PNG 字节
 */
function tplExtOfUrl(url: string): string | null {
  const m = url.split('?')[0].match(/~tplv-[a-z0-9_-]+\.([a-z0-9]{2,5})$/i)
  return m ? '.' + m[1].toLowerCase() : null
}

/** 从媒体 URL 推断下载扩展名（视频固定 .mp4；图片优先取 CDN 模板输出格式） */
function extOfUrl(url: string, kind: 'image' | 'video'): string {
  if (kind === 'video') return '.mp4'
  const tpl = tplExtOfUrl(url)
  if (tpl) return tpl
  const rawBase = decodeURIComponent(url.split('?')[0].split('~')[0])
  return '.' + ((rawBase.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png')
}

function basenameOf(url: string, kind: 'image' | 'video'): string {
  const p = url.split('?')[0]
  // 去掉 CDN 模板后缀：xxx.jpeg~tplv-a9rns2rl98-cgen_wm0.png -> xxx.jpeg
  let name = decodeURIComponent(p.slice(p.lastIndexOf('/') + 1)).split('~')[0]
  if (!name) name = `artifact-${Date.now()}`
  // 图片的真实格式跟随模板输出（基础对象名 .jpeg 实际可能是 png 字节）
  const tpl = tplExtOfUrl(url)
  if (kind === 'image' && tpl) name = name.replace(/\.[a-z0-9]{2,5}$/i, '') + tpl
  if (kind === 'video' && !VIDEO_EXTS.some((e) => name.toLowerCase().endsWith(e))) name += '.mp4'
  return name
}

/** 从媒体 URL 提取去重键：tos-cn-i-xxx/rc_gen_image/<hash>.jpeg（跨 CDN 节点/模板一致） */
function keyOfUrl(url: string): string | null {
  try {
    const path = decodeURIComponent(url.split('?')[0])
    const idx = path.indexOf('tos-cn')
    if (idx === -1) return null
    return path.slice(idx).split('~')[0] || null
  } catch {
    return null
  }
}

/** 提取文件内容 hash 键（如 3c8fb445...jpeg 里的 hex 段）：跨 CDN 集群/模板/通道的唯一指纹 */
function hashKeyOfUrl(url: string): string | null {
  try {
    const path = decodeURIComponent(url.split('?')[0])
    const m = path.match(/([0-9a-f]{16,64})\.[a-z0-9]{2,5}(?:~|$)/i)
    return m ? `h:${m[1].toLowerCase()}` : null
  } catch {
    return null
  }
}

/** 在对象里深度找第一个 url 字段 */
function firstUrl(node: unknown, depth = 0): string | undefined {
  if (!node || typeof node !== 'object' || depth > 6) return undefined
  const obj = node as Record<string, unknown>
  if (typeof obj['url'] === 'string') return obj['url']
  for (const v of Object.values(obj)) {
    const hit = firstUrl(v, depth + 1)
    if (hit) return hit
  }
  return undefined
}

interface PushFn {
  (channel: string, payload: unknown): void
}

export class ArtifactManager {
  private items: ArtifactItem[] = []
  private seen = new Set<string>()
  private itemKeys = new Map<string, string[]>() // item.id -> 全部去重键（主键+URL别名）

  private convNames = new Map<string, string>() // convId -> 会话名（下载命名用）
  private pendingApi = new Set<string>() // 待解析的 IM 接口请求
  private push: PushFn
  private logFile: string
  private queue: (() => void)[] = []
  private inflight = 0

  constructor(push: PushFn, userDataDir: string) {
    this.push = push
    this.logFile = path.join(userDataDir, 'artifacts-debug.log')
  }

  /** 给账号 session 挂媒体拦截（兜底：能拿到响应头大小，但看不到缓存命中） */
  attach(ses: Session, accountId: string): void {
    const flag = ses as Session & { __artAttached?: boolean }
    if (flag.__artAttached) return
    flag.__artAttached = true

    ses.webRequest.onCompleted((details) => {
      const headers = details.responseHeaders ?? {}
      // Electron 的 header 值是 string[]，取第一个
      const pick = (k: string): string | undefined => {
        const v = headers[k] ?? headers[k.replace(/^\w/, (c) => c.toUpperCase())]
        return Array.isArray(v) ? v[0] : v
      }
      const ct = pick('content-type')
      const size = Number(pick('content-length') ?? 0)
      const kind =
        kindByContentType(ct) ??
        kindByExt(details.url) ??
        (details.resourceType === 'media' ? 'video' : null)
      this.handleMedia(details.url, kind, accountId, ct, size)
    })
  }

  /** 给页面的 webContents 挂 CDP 网络监听（主通道：缓存命中 + IM 接口解析都靠它） */
  attachView(wc: WebContents, accountId: string): void {
    const dbg = wc.debugger
    try {
      if (!dbg.isAttached()) dbg.attach()
    } catch {
      return
    }
    try {
      dbg.sendCommand('Network.enable')
    } catch {
      return
    }
    const listener = (_e: unknown, method: string, params: Record<string, unknown>): void => {
      if (method === 'Network.responseReceived') {
        const resp = params.response as
          | { url?: string; mimeType?: string; headers?: Record<string, string> }
          | undefined
        if (!resp?.url) return
        // IM 会话接口：等加载完解析产物
        if (resp.url.includes('doubao.com/im/')) {
          this.pendingApi.add(params.requestId as string)
        }
        // 媒体兜底捕获
        const mime = resp.mimeType ?? ''
        const cdpType = (params.type as string) ?? ''
        const size = Number(resp.headers?.['content-length'] ?? resp.headers?.['Content-Length'] ?? 0)
        const kind =
          kindByContentType(mime) ??
          (cdpType === 'Image' ? 'image' : cdpType === 'Media' ? 'video' : null)
        this.handleMedia(resp.url, kind, accountId, mime, size)
      } else if (method === 'Network.loadingFinished') {
        const requestId = params.requestId as string
        if (this.pendingApi.delete(requestId)) {
          // 响应体可能已被 Chromium 回收（报 No resource found），静默忽略
          void (async () => {
            try {
              const r = (await dbg.sendCommand('Network.getResponseBody', { requestId })) as
                | { body?: string }
                | null
              if (r?.body) this.parseCreationApi(r.body, accountId)
            } catch {
              // ignore
            }
          })()
        }
      }
    }
    dbg.on('message', listener)
    wc.once('destroyed', () => {
      try {
        dbg.off('message', listener)
      } catch {
        // ignore
      }
    })
  }

  /**
   * 解析豆包 IM 接口返回（/im/chain/single、/im/conversation/info 等）：
   * 深度遍历 creation_block.creations，提取产物（图片/视频、原图、缩略图、提示词）
   */
  private parseCreationApi(text: string, accountId: string): void {
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      return
    }
    const found: Array<{ c: Record<string, unknown>; convId?: string; time?: number }> = []
    const videos: Array<{ v: Record<string, unknown>; convId?: string; time?: number }> = []
    let ctx: { convId?: string; time?: number } = {}
    const visit = (n: unknown): void => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) {
        n.forEach(visit)
        return
      }
      const obj = n as Record<string, unknown>
      if (typeof obj['conversation_id'] === 'string') {
        ctx = {
          convId: obj['conversation_id'] as string,
          time: obj['create_time'] ? Number(obj['create_time']) * 1000 : undefined
        }
      }
      // 缓存会话名称：豆包原生下载文件名 = 会话名 + 扩展名
      const ci = obj as {
        conversation_info?: { conversation_id?: string; name?: string }
      }
      if (ci.conversation_info?.conversation_id && typeof ci.conversation_info.name === 'string') {
        this.convNames.set(ci.conversation_info.conversation_id, ci.conversation_info.name)
      }
      const cb = obj['creation_block'] as { creations?: unknown[] } | undefined
      if (cb && Array.isArray(cb.creations)) {
        for (const c of cb.creations) {
          found.push({ c: c as Record<string, unknown>, convId: ctx.convId, time: ctx.time })
        }
      }
      // 工作任务（flow/任务对话）的媒体不在 creation_block，而在 content_block 的
      // rich_media_layout_block.media[]：type=6 是 creation（与 creation_block 同构），
      // type=8 是 video_item（resource/uri/name/cover_url）
      const rmb = obj['rich_media_layout_block'] as { media?: unknown[] } | undefined
      if (rmb && Array.isArray(rmb.media)) {
        for (const raw of rmb.media) {
          const m = raw as Record<string, unknown>
          const type = Number(m['type'])
          if (type === 6 && m['creation']) {
            found.push({
              c: m['creation'] as Record<string, unknown>,
              convId: ctx.convId,
              time: ctx.time
            })
          } else if (type === 8 && m['video_item']) {
            videos.push({
              v: m['video_item'] as Record<string, unknown>,
              convId: ctx.convId,
              time: ctx.time
            })
          } else {
            this.log(
              `${new Date().toISOString()}\t${accountId}\tunknown-media\ttype=${String(
                m['type']
              )}\t${JSON.stringify(m).slice(0, 300)}`
            )
          }
        }
      }
      Object.values(obj).forEach(visit)
    }
    visit(data)
    for (const f of found) this.emitCreation(f.c, accountId, f.convId, f.time)
    for (const v of videos) this.emitVideoItem(v.v, accountId, v.convId, v.time)
  }

  /** 把一个 creation 转成产物条目 */
  private emitCreation(
    c: Record<string, unknown>,
    accountId: string,
    convId?: string,
    time?: number
  ): void {
    const img = c['image'] as Record<string, unknown> | undefined
    const vid = c['video'] as Record<string, unknown> | undefined
    const kind: 'image' | 'video' | null = img ? 'image' : vid ? 'video' : null
    if (!kind) return
    const vid0 = vid?.['vid'] as string | undefined
    const key = `api:${(img?.['key'] as string) || vid0 || (c['id'] as string) || ''}`
    // 封面/缩略图：图片用 image_thumb；视频用 cover.image_thumb
    const cover = vid?.['cover'] as Record<string, unknown> | undefined
    const thumbSrc =
      (img?.['image_thumb'] as { url?: string })?.url ??
      (cover?.['image_thumb'] as { url?: string })?.url
    const url =
      (img?.['image_ori_raw'] as { url?: string })?.url ??
      (img?.['image_ori'] as { url?: string })?.url ??
      (img?.['image_preview'] as { url?: string })?.url ??
      (vid?.['download_url'] as string) ??
      firstUrl(vid) ??
      ''
    if (!url) return
    const genParams = (img ?? {})['gen_params'] as { prompt?: string } | undefined
    // 对齐豆包原生下载命名：会话名（豆包用 conversation_info.name 命名下载文件）> title > CDN 名
    const title = typeof c['title'] === 'string' ? c['title'].trim() : ''
    const convName = convId ? this.convNames.get(convId) : undefined
    const name = (convName || title).trim()
    const filename = name ? `${name}${extOfUrl(url, kind)}` : basenameOf(url, kind)
    const item: ArtifactItem = {
      id: `art_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      accountId,
      kind,
      url,
      filename,
      time: time || Date.now(),
      size: 0,
      thumbSrc,
      prompt: genParams?.prompt || undefined,
      convId
    }
    this.addItem(item, key)
  }

  /** 任务模式 video_item（原片/转码 playback 副本）转成产物条目 */
  private emitVideoItem(
    v: Record<string, unknown>,
    accountId: string,
    convId?: string,
    time?: number
  ): void {
    const resource = typeof v['resource'] === 'string' ? v['resource'] : ''
    if (!resource.startsWith('http')) return
    const uri = typeof v['uri'] === 'string' ? v['uri'] : ''
    const vid = v['id'] !== undefined && v['id'] !== null ? String(v['id']) : ''
    const key = `api:${uri || vid || resource}`
    const itemName = typeof v['name'] === 'string' ? v['name'].trim() : ''
    const convName = convId ? this.convNames.get(convId) : undefined
    let filename: string
    if (convName) {
      filename = `${convName}${extOfUrl(resource, 'video')}`
    } else if (itemName) {
      filename = /\.[a-z0-9]{2,5}$/i.test(itemName)
        ? itemName
        : `${itemName}${extOfUrl(resource, 'video')}`
    } else {
      filename = basenameOf(resource, 'video')
    }
    this.addItem(
      {
        id: `art_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        accountId,
        kind: 'video',
        url: resource,
        filename,
        time: time || Date.now(),
        size: 0,
        thumbSrc: typeof v['cover_url'] === 'string' ? v['cover_url'] : undefined,
        convId
      },
      key
    )
  }

  /** 统一入口：去重、过滤、记录、推送（媒体 URL 兜底通道） */
  private handleMedia(
    url: string,
    kind: 'image' | 'video' | null,
    accountId: string,
    ct?: string,
    size = 0
  ): void {
    if (!kind || !url.startsWith('http')) return
    if (isExcluded(url)) return
    // 只收 AI 生成产物：图片/视频都必须命中生成路径指纹。
    // 用户上传的源文件（如 p26-flow-sign.byteimg.com/tos-cn-i-ik7evvg4ik/<hash>.mp4）
    // 虽然 Content-Type 是 video/*，但路径没有任何 rc_gen/gen_video 标记，不能收录。
    if (!isGeneratedPath(url)) return
    if (kind === 'image' && size > 0 && size < MIN_IMAGE_BYTES) return
    const key = keyOfUrl(url)
    if (!key) return

    this.log(`${new Date().toISOString()}\t${accountId}\t${kind}\t${ct ?? '-'}\t${size}\t${url}`)

    this.addItem(
      {
        id: `art_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        accountId,
        kind,
        url,
        filename: basenameOf(url, kind),
        time: Date.now(),
        size
      },
      key
    )
  }

  /** 共享入库：去重（含 hash 通用键）、信息合并、容量上限、推送、拉缩略图 */
  private addItem(item: ArtifactItem, key: string): void {
    if (!key) return
    // 主键 + URL 别名键 + hash 键任一已存在，都视为同一产物（双向去重）
    const candidates = [
      key,
      keyOfUrl(item.url),
      item.thumbSrc ? keyOfUrl(item.thumbSrc) : null,
      hashKeyOfUrl(item.url),
      item.thumbSrc ? hashKeyOfUrl(item.thumbSrc) : null
    ].filter((k): k is string => !!k)
    const dupKey = candidates.find((k) => this.seen.has(k))
    if (dupKey) {
      // 同一产物再次到达：若新数据更丰富（接口通道带提示词/会话名/好文件名），合并到旧条目
      const old = this.items.find((i) => (this.itemKeys.get(i.id) ?? []).includes(dupKey))
      if (old) {
        let changed = false
        if (!old.prompt && item.prompt) {
          old.prompt = item.prompt
          changed = true
        }
        if (!old.convId && item.convId) {
          old.convId = item.convId
          changed = true
        }
        const oldNameLooksRaw =
          !old.filename || /^artifact-/.test(old.filename) || /\.[0-9a-f]{16,}\./i.test(old.filename)
        if (oldNameLooksRaw && item.filename && !/^artifact-/.test(item.filename)) {
          old.filename = item.filename
          changed = true
        }
        if (item.thumbSrc && !old.thumbSrc) {
          old.thumbSrc = item.thumbSrc
          changed = true
        }
        for (const k of candidates) {
          if (!this.seen.has(k)) {
            this.seen.add(k)
            this.itemKeys.get(old.id)?.push(k)
          }
        }
        if (changed) this.push('artifact:update', old)
      }
      return
    }
    const fresh: string[] = []
    for (const k of candidates) {
      if (k && !this.seen.has(k)) {
        this.seen.add(k)
        fresh.push(k)
      }
    }
    this.itemKeys.set(item.id, fresh)
    this.items.unshift(item)
    if (this.items.length > MAX_ITEMS) {
      for (const removed of this.items.splice(MAX_ITEMS)) {
        for (const k of this.itemKeys.get(removed.id) ?? []) {
          this.seen.delete(k)
        }
        this.itemKeys.delete(removed.id)
      }
    }
    this.push('artifact:event', item)
    // 图片拉本体当缩略图；视频拉封面（thumbSrc）
    if (item.kind === 'image' || item.thumbSrc) this.requestThumb(item)
  }

  list(): ArtifactItem[] {
    return this.items
  }

  get(id: string): ArtifactItem | undefined {
    return this.items.find((i) => i.id === id)
  }

  clear(): void {
    this.items = []
    this.seen.clear()
    this.itemKeys.clear()
    this.push('artifact:cleared', null)
  }

  /** 下载产物：用该账号的 webContents 触发 downloadURL，走统一 will-download 管线 */
  onDownloadName?: (accountId: string, name: string) => void

  download(id: string, getWebContents: (accountId: string) => WebContents | null): boolean {
    const item = this.items.find((i) => i.id === id)
    if (!item) return false
    const wc = getWebContents(item.accountId)
    if (!wc) return false
    // 下载时实时解析会话名：产物入库时会话信息可能还没返回，文件名不能在入库时定死
    const convName = item.convId ? this.convNames.get(item.convId) : undefined
    const ext = extOfUrl(item.url, item.kind)
    const stem = (convName ?? item.filename.replace(/\.[a-z0-9]+$/i, '')).trim()
    const name = stem ? `${stem}${ext}` : item.filename
    this.onDownloadName?.(item.accountId, name)
    wc.downloadURL(item.url)
    return true
  }

  /** 缩略图按账号 session 拉（带 Cookie），并发上限 3 */
  private requestThumb(item: ArtifactItem): void {
    this.queue.push(() => this.fetchThumb(item))
    this.pump()
  }

  private pump(): void {
    while (this.inflight < 3 && this.queue.length) {
      const task = this.queue.shift()!
      this.inflight++
      task().finally(() => {
        this.inflight--
        this.pump()
      })
    }
  }

  private async fetchThumb(item: ArtifactItem): Promise<void> {
    try {
      const src = item.thumbSrc ?? item.url
      const ses = session.fromPartition(`persist:doubao_${item.accountId}`)
      const res = await ses.fetch(src, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0 || buf.length > MAX_THUMB_BYTES) return
      const mime = res.headers.get('content-type') ?? 'image/jpeg'
      item.thumb = `data:${mime};base64,${buf.toString('base64')}`
      this.push('artifact:update', item)
    } catch {
      // 链接过期/网络失败：面板显示占位图
    }
  }

  /** 追加调试日志（>5MB 自动重置） */
  private log(line: string): void {
    try {
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > 5 * 1024 * 1024) {
        fs.writeFileSync(this.logFile, '')
      }
      fs.appendFileSync(this.logFile, line + '\n')
    } catch {
      // ignore
    }
  }
}
