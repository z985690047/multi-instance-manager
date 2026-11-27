import { app, session, type Session, type WebContents } from 'electron'
import fs from 'node:fs'
import { createReadStream, createWriteStream } from 'node:fs'
import { createDecipheriv, createHash } from 'node:crypto'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

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
  vid?: string // 视频 vid（接口里的 video.vid / video_item.uri）
  nodeId?: string // 资产 node_id（download_info 接口按它取下载地址）
  playUrl?: string // 最近一次解析到的无水印播放地址（仅内存，不长期复用）
}

/** 控制台调试输出用：thumb 是 base64 data URL，主进程只打长度，避免刷屏 */
function briefItem(item: ArtifactItem): Record<string, unknown> {
  return { ...item, thumb: item.thumb ? `<${item.thumb.length} chars>` : undefined }
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

/** 是否为页面给出的无水印地址 */
function isUnwatermarkedUrl(url: string): boolean {
  return url.includes('lr=unwatermarked')
}

/** 深搜 JSON 里所有 http 字符串（不依赖字段名）：用于解析字段结构未知的接口响应 */
function collectHttpUrls(root: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (n: unknown, depth = 0): void => {
    if (out.length >= 60 || depth > 10) return
    if (typeof n === 'string') {
      if (n.startsWith('http') && !seen.has(n)) {
        seen.add(n)
        out.push(n)
      }
      return
    }
    if (Array.isArray(n)) {
      for (const x of n) walk(x, depth + 1)
      return
    }
    if (n && typeof n === 'object') {
      for (const v of Object.values(n as Record<string, unknown>)) walk(v, depth + 1)
    }
  }
  walk(root)
  return out
}

/** 诊断用：深搜找到第一个 key_seed 字符串（fallback_api 响应用） */
function findKeySeedDeep(node: unknown, depth = 0): string {
  if (!node || typeof node !== 'object' || depth > 10) return ''
  const obj = node as Record<string, unknown>
  if (typeof obj['key_seed'] === 'string' && obj['key_seed']) return obj['key_seed']
  for (const v of Object.values(obj)) {
    const hit = findKeySeedDeep(v, depth + 1)
    if (hit) return hit
  }
  return ''
}

/** 诊断用：深度遍历 JSON，回调每个对象节点 */
function walkJsonObjects(
  node: unknown,
  visit: (o: Record<string, unknown>) => void,
  depth = 0
): void {
  if (!node || typeof node !== 'object' || depth > 12) return
  if (Array.isArray(node)) {
    for (const v of node) walkJsonObjects(v, visit, depth + 1)
    return
  }
  const obj = node as Record<string, unknown>
  visit(obj)
  for (const v of Object.values(obj)) walkJsonObjects(v, visit, depth + 1)
}

/** 诊断用：判断候选值的形态（http / qAAB 加密 / base64 / 其它） */
function shapeOfUrl(value: string): string {
  if (/^https?:\/\//i.test(value)) {
    try {
      return `http(${new URL(value).host})`
    } catch {
      return 'http'
    }
  }
  if (value.startsWith('qAAB')) return 'qAAB'
  if (/^[A-Za-z0-9+/=_-]{40,}$/.test(value)) return 'base64?'
  return `other(${value.slice(0, 12)})`
}

/**
 * fplay qAAB 解密：固定盐 + URL 里的 key_seed 派生 AES-128-CBC key/iv。
 * 该算法来自页面数据本身（key_seed 在 URL 上，密文在接口响应里），不涉及登录或第三方签名。
 */
const QAAB_SALT = Buffer.from(
  '4dd4c2e6b83162090e52b3c7a6733ba4' +
    '1cb2462b829ab58a196b39db57177524' +
    'f49baf7f08e8d68d26a72e37c1a95a2f' +
    '1f05a51892aef2949732b62a38aadd58',
  'hex'
)

function decodeQaabUrl(token: string, seedB64: string): string {
  if (!token.startsWith('qAAB') || !seedB64) return ''
  try {
    const blob = Buffer.from(token, 'base64')
    const seed = Buffer.from(seedB64, 'base64').slice(0, 32)
    if (!seed.length || !blob.length) return ''
    const h2 = createHash('sha512')
      .update(Buffer.concat([createHash('sha512').update(seed).digest(), QAAB_SALT]))
      .digest()
    const head = blob[0] === 0xa8 && blob[1] === 0 && blob[2] === 1 && blob[3] === 0
    const bodies = head ? [blob.subarray(4), blob] : [blob]
    for (const body of bodies) {
      if (!body.length || body.length % 16 !== 0) continue
      const variants: [Buffer, Buffer, Buffer][] = [
        [h2.subarray(0, 16), h2.subarray(16, 32), body],
        [h2.subarray(16, 32), h2.subarray(0, 16), body]
      ]
      if (blob.length > 0x24) {
        variants.push([h2.subarray(0, 16), blob.subarray(0x14, 0x24), blob.subarray(0x24)])
      }
      for (const [key, iv, payload] of variants) {
        try {
          const d = createDecipheriv('aes-128-cbc', key, iv)
          d.setAutoPadding(false)
          const out = Buffer.concat([d.update(payload), d.final()])
            .toString('utf8')
            .replace(/\0/g, '')
            .trim()
          if (/^https?:\/\//i.test(out)) return out
        } catch {
          // 尝试下一种组合
        }
      }
    }
  } catch {
    // ignore
  }
  return ''
}

/** 从 fplay 响应里挑 real_bitrate 最高的档位，解出 main/backup 全部候选并校验 lr=unwatermarked */
function pickFplayGear(
  data: unknown,
  seed: string
): { urls: string[]; bitrate: number; def: string; expires: number } | null {
  let best: { urls: string[]; bitrate: number; def: string; expires: number } | null = null
  walkJsonObjects(data, (o) => {
    const br = Number(o['real_bitrate'] ?? o['bitrate'] ?? 0) || 0
    const expires = (Number(o['url_expire'] ?? 0) || 0) * 1000
    const urls: string[] = []
    for (const k of ['main_url', 'backup_url_1']) {
      const v = o[k]
      if (typeof v !== 'string' || !v) continue
      const url = /^https?:\/\//i.test(v) ? v : decodeQaabUrl(v, seed)
      // 只接受解出后仍明确标着无水印的地址
      if (url && isUnwatermarkedUrl(url) && !urls.includes(url)) urls.push(url)
    }
    if (!urls.length) return
    if (!best || br > best.bitrate) {
      best = { urls, bitrate: br, def: String(o['definition'] ?? '-'), expires }
    }
  })
  return best
}

/** 诊断用：把媒体 URL 的关键参数摘出来（不带签名），用于判断走的是哪种通道 */
function describeMediaUrl(url: string): Record<string, string | undefined> {
  try {
    const u = new URL(url)
    return {
      host: u.host,
      lr: u.searchParams.get('lr') ?? undefined,
      cr: u.searchParams.get('cr') ?? undefined,
      download: u.searchParams.get('download') ?? undefined,
      mime: u.searchParams.get('mime_type') ?? undefined,
      obj: objectKeyOfUrl(url) ?? undefined
    }
  } catch {
    return { host: '-' }
  }
}

/** 诊断日志里隐去反爬签名，避免把 msToken/a_bogus 原文写进日志 */
function redactUrl(url: string): string {
  return url.replace(/(msToken|a_bogus|X-Bogus|verifyFp)=([^&]*)/gi, '$1=<redacted>')
}

/** 取 TOS 对象名（去掉查询与模板后缀）：用于把无水印媒体 URL 归属到产物 */
function objectKeyOfUrl(url: string): string | null {
  try {
    // 实机 URL 形如 .../video/tos/cn/tos-cn-v-9ecd54/<对象名>/?a=482431&…
    // 对象名后面有一个斜杠，必须先去掉尾部斜杠再取最后一段
    const p = decodeURIComponent(url.split('?')[0]).replace(/\/+$/, '')
    const name = p.slice(p.lastIndexOf('/') + 1).split('~')[0]
    if (!name) return null
    // 去掉扩展名，保留 hash 主体
    return name.replace(/\.[a-z0-9]{2,5}$/i, '').toLowerCase()
  } catch {
    return null
  }
}

/** 206 响应可能没有 content-length（分段时才有），从 content-range 取总长 */
function totalFromHeaders(headers: Headers): number {
  const cl = Number(headers.get('content-length') ?? 0) || 0
  const cr = headers.get('content-range') ?? ''
  const m = /\/(\d+)$/.exec(cr)
  const total = m ? Number(m[1]) : 0
  return Math.max(cl, total)
}

/** 从接口响应里收集 play_infos / download_infos 的地址（深度遍历，字段名以实机抓包为准） */
function collectPlayUrls(root: unknown): {
  plays: string[]
  nodes: Array<{ id?: string; url: string }>
} {
  const plays: string[] = []
  const nodes: Array<{ id?: string; url: string }> = []
  const pickUrls = (n: unknown): string[] => {
    if (typeof n === 'string' && n.startsWith('http')) return [n]
    if (Array.isArray(n)) return n.flatMap(pickUrls)
    if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>
      const out: string[] = []
      for (const k of ['main', 'main_url', 'backup', 'url', 'download_url']) {
        const v = o[k]
        if (typeof v === 'string' && v.startsWith('http')) out.push(v)
      }
      return out
    }
    return []
  }
  const visit = (n: unknown, depth = 0): void => {
    if (!n || typeof n !== 'object' || depth > 8) return
    if (Array.isArray(n)) {
      for (const x of n) visit(x, depth + 1)
      return
    }
    const o = n as Record<string, unknown>
    if (Array.isArray(o['play_infos'])) {
      for (const p of o['play_infos']) plays.push(...pickUrls(p))
    }
    if (Array.isArray(o['download_infos'])) {
      for (const d of o['download_infos']) {
        const u = pickUrls(d)[0]
        if (!u) continue
        const obj = d as Record<string, unknown>
        const id = obj['node_id'] ?? obj['nodeId']
        nodes.push({ id: id !== undefined && id !== null ? String(id) : undefined, url: u })
      }
    }
    for (const v of Object.values(o)) visit(v, depth + 1)
  }
  visit(root)
  return { plays, nodes }
}

/** 从请求体里取 vid（play_info 请求按 vid 查询，响应里不带 vid，只能和请求体配对） */
function collectVids(body: string | undefined): string[] {
  if (!body) return []
  const out: string[] = []
  try {
    const walk = (n: unknown, depth = 0): void => {
      if (!n || typeof n !== 'object' || depth > 6) return
      if (Array.isArray(n)) {
        n.forEach((x) => walk(x, depth + 1))
        return
      }
      const o = n as Record<string, unknown>
      for (const [k, v] of Object.entries(o)) {
        if ((k === 'vid' || k === 'vids') && typeof v === 'string') out.push(v)
        else if ((k === 'vid' || k === 'vids') && Array.isArray(v)) {
          for (const x of v) if (typeof x === 'string') out.push(x)
        } else walk(v, depth + 1)
      }
    }
    walk(JSON.parse(body))
  } catch {
    // ignore
  }
  return out
}

/** 从请求体里取第一个 node_id 字符串（download_info 请求按 node_id 查询） */
function sampleNodeId(body?: string): string {
  const m = body ? /"node_?[iI]d"\s*:\s*"?([0-9A-Za-z_-]+)"?/.exec(body) : null
  return m ? m[1] : ''
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

/**
 * 视频本地缓存条目。
 * 背景（实测）：同一条 HTTP/2 连接上只要有响应体没被消费完（<video> 缓冲够了就停止读取），
 * 连接级流控窗口会被占满，同域后续请求连响应头都拿不到，最终 net::ERR_HTTP2_PROTOCOL_ERROR。
 * 所以预览不再让渲染进程直连上游：主进程始终把上游读完落盘，渲染进程只读本地文件。
 */
interface MediaCache {
  path: string
  total: number
  downloaded: number
  done: boolean
  error?: string
  lastUsed: number
  active: number // 正在读取（预览/下载复制）的流数量，>0 时不允许清理
  source?: string // 该缓存来自哪种来源（unwatermarked/... 或 watermarked-fallback）
}

const CACHE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024 // 缓存容量上限 2GB
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 天未被访问即过期
const CACHE_GUARD_MS = 10 * 60 * 1000 // 最近访问过的文件 10 分钟内不动，避免与预览竞态
const PLAY_URL_TTL = 5 * 60 * 1000 // 无水印地址只用 5 分钟，之后重新解析（链接可能限时）
const CALL_TEMPLATE_TTL = 30 * 60 * 1000 // 页面调用模板保留 30 分钟，用于回放取新地址
const FALLBACK_URL_TTL = 60 * 60 * 1000 // 捕获的 fallback_api 保留 60 分钟，过期后等页面再次播放刷新

/** 从页面 CDP 学到的一次接口调用（URL/method/body/头），用于按 vid/node_id 回放 */
interface CapturedCall {
  kind: 'play' | 'download'
  url: string
  method: string
  body?: string
  headers: Record<string, string>
  sample: string
  at: number
}

/** /im/chain/single 的调用模板：用于在没有 fallback_api 时自动回放刷新 */
interface ChainTemplate {
  url: string
  method: string
  body: string
  headers: Record<string, string>
  convId: string
  at: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) return false
    await sleep(40)
  }
  return true
}

export class ArtifactManager {
  private items: ArtifactItem[] = []
  private seen = new Set<string>()
  private itemKeys = new Map<string, string[]>() // item.id -> 全部去重键（主键+URL别名）

  private convNames = new Map<string, string>() // convId -> 会话名（下载命名用）
  private pendingApi = new Set<string>() // 待解析的 IM 接口请求
  private pendingPlay = new Set<string>() // 待解析的 play_info / download_info 响应
  private pendingCalls = new Map<string, CapturedCall>() // requestId -> 调用模板（仅保留必要头）
  /** 第一阶段诊断：待扫描 fallback_api 的响应（requestId -> 请求 URL） */
  private fallbackScan = new Map<string, string>()
  /** 第一阶段诊断：已探测过的 fallback_api URL，避免重复请求 */
  private fallbackProbed = new Set<string>()
  /** IM 响应里学到的 fallback_api（accountId:vid -> URL），用于 fplay 取最高档 */
  private fallbackByVid = new Map<string, { url: string; at: number }>()
  /** fplay 解出的高清地址缓存（accountId:vid -> 地址候选 + 过期时间） */
  private fplayByVid = new Map<string, { urls: string[]; at: number; expires: number }>()
  /** fplay 解析失败时间（accountId:vid），用于避免旧缓存反复重建 */
  private fplayFailedAt = new Map<string, number>()
  /** 见过但缺 key_seed 的 fplay vid，用于给出准确的回退原因 */
  private fallbackNoSeed = new Set<string>()
  /** /im/chain/single 调用模板（accountId:convId -> 模板），用于自动刷新 fallback_api */
  private chainTemplates = new Map<string, ChainTemplate>()
  /** 同一账号同一时刻只允许一次 chain 回放 */
  private chainReplay = new Map<string, Promise<{ ok: boolean; detail: string }>>()
  private playByVid = new Map<string, { url: string; at: number }>()
  private playByNode = new Map<string, { url: string; at: number }>()
  private unwatermarkedByObject = new Map<string, { url: string; at: number; accountId: string }>()
  private callTemplates: CapturedCall[] = []
  private push: PushFn
  private logFile: string
  private queue: (() => Promise<void>)[] = []
  private inflight = 0

  private cacheDir: string
  private cacheIndexFile: string
  private mediaCache = new Map<string, MediaCache>()
  private thumbCache = new Map<string, { data: Buffer; lastUsed: number }>()
  private pendingDelete = new Set<string>() // 列表已移除但当时正被使用，等空闲后再删
  private cacheIndexDirty = false
  private cacheSaveTimer: NodeJS.Timeout | null = null
  private cleaning = false
  private cleanupQueued = false

  constructor(push: PushFn, userDataDir: string) {
    this.push = push
    this.logFile = path.join(userDataDir, 'artifacts-debug.log')
    this.cacheDir = path.join(userDataDir, 'media-cache')
    this.cacheIndexFile = path.join(this.cacheDir, 'index.json')
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true })
    } catch {
      // ignore
    }
    // 缓存跨启动保留：靠 index.json 记住每个文件的大小与最后访问时间，7 天过期/2GB 上限才有意义
    this.loadCacheIndex()
    // 启动后是安全时机：清过期、超容量、以及上次没写完的残留
    setImmediate(() => this.cleanup('启动'))
  }

  private loadCacheIndex(): void {
    let raw: Record<string, { size?: number; lastUsed?: number; source?: string }> = {}
    try {
      raw = JSON.parse(fs.readFileSync(this.cacheIndexFile, 'utf8')) as Record<
        string,
        { size?: number; lastUsed?: number; source?: string }
      >
    } catch {
      raw = {}
    }
    for (const [id, v] of Object.entries(raw)) {
      const p = path.join(this.cacheDir, `${id}.mp4`)
      try {
        const st = fs.statSync(p)
        // 只恢复「上次完整写完」且大小一致的缓存；不一致视为半截文件，交给启动清理删掉
        if (!st.isFile() || st.size <= 0 || st.size !== v.size) continue
        this.mediaCache.set(id, {
          path: p,
          total: st.size,
          downloaded: st.size,
          done: true,
          lastUsed: Number(v.lastUsed) || st.mtimeMs,
          active: 0,
          source: v.source
        })
      } catch {
        // 文件已不存在，忽略
      }
    }
  }

  /** 访问时间落盘做节流：播放中每秒都会命中，不能每次都写文件 */
  private scheduleSaveIndex(): void {
    this.cacheIndexDirty = true
    if (this.cacheSaveTimer) return
    this.cacheSaveTimer = setTimeout(() => {
      this.cacheSaveTimer = null
      this.saveCacheIndex()
    }, 10_000)
    this.cacheSaveTimer.unref()
  }

  private saveCacheIndex(): void {
    if (!this.cacheIndexDirty) return
    this.cacheIndexDirty = false
    const out: Record<string, { size: number; lastUsed: number; source?: string }> = {}
    for (const [id, e] of this.mediaCache) {
      if (e.done && !e.error) out[id] = { size: e.downloaded, lastUsed: e.lastUsed, source: e.source }
    }
    try {
      const tmp = `${this.cacheIndexFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(out))
      fs.renameSync(tmp, this.cacheIndexFile)
    } catch {
      // ignore
    }
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
      if (method === 'Network.requestWillBeSent') {
        const req = params.request as
          | { url?: string; method?: string; postData?: string; headers?: Record<string, string> }
          | undefined
        if (req?.url) {
          this.trackCall(params.requestId as string, req)
          this.trackChainCall(req, accountId)
        }
        return
      }
      if (method === 'Network.responseReceived') {
        const resp = params.response as
          | { url?: string; mimeType?: string; headers?: Record<string, string> }
          | undefined
        if (!resp?.url) return
        // 页面自己拿到的无水印媒体地址：按 TOS 对象名归属，供下载时优先使用
        if (isUnwatermarkedUrl(resp.url)) this.rememberUnwatermarked(resp.url, accountId)
        // IM 会话接口：等加载完解析产物
        if (resp.url.includes('doubao.com/im/')) {
          this.pendingApi.add(params.requestId as string)
        }
        // 第一阶段诊断：豆包 IM / 画布 / SSE 响应的原始文本里可能带 fallback_api
        const scanMime = resp.mimeType ?? ''
        const scanType = (params.type as string) ?? ''
        const scanUrl = resp.url
        const scanable =
          scanUrl.includes('doubao.com') &&
          scanType !== 'Media' &&
          scanType !== 'Image' &&
          (/\/im\//.test(scanUrl) ||
            /\/(samantha|alice|creativity)\//.test(scanUrl) ||
            /canvas|sse|event-stream|\/flow\//i.test(scanUrl) ||
            scanMime.includes('event-stream'))
        if (scanable) this.fallbackScan.set(params.requestId as string, scanUrl)
        // 已跟踪的 play_info / download_info 调用：等加载完取响应体
        if (this.pendingCalls.has(params.requestId as string)) {
          if (scanMime.includes('json')) this.pendingPlay.add(params.requestId as string)
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
        // 第一阶段诊断：扫描响应原文里的 fallback_api / video/fplay
        const scannedUrl = this.fallbackScan.get(requestId)
        if (scannedUrl) {
          this.fallbackScan.delete(requestId)
          void (async () => {
            try {
              const r = (await dbg.sendCommand('Network.getResponseBody', { requestId })) as
                | { body?: string }
                | null
              if (r?.body) this.scanFallbackApi(r.body, scannedUrl, accountId)
            } catch {
              // 响应体可能已被回收，忽略
            }
          })()
        }
        if (this.pendingPlay.delete(requestId)) {
          const call = this.pendingCalls.get(requestId)
          this.pendingCalls.delete(requestId)
          if (call) {
            void (async () => {
              try {
                const r = (await dbg.sendCommand('Network.getResponseBody', { requestId })) as
                  | { body?: string }
                  | null
                if (r?.body) this.parsePlayInfo(r.body, call, accountId)
              } catch {
                // 响应体可能已被回收，忽略
              }
            })()
          }
        }
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
      } else if (method === 'Network.loadingFailed') {
        const requestId = params.requestId as string
        this.fallbackScan.delete(requestId)
        this.pendingPlay.delete(requestId)
        this.pendingCalls.delete(requestId)
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
   * 第一阶段诊断（只记录，不参与取源）：
   * 扫描豆包响应原文里的 "fallback_api" 与 /video/fplay/ 地址，记录上下文并探测其响应结构。
   */
  private scanFallbackApi(text: string, sourceUrl: string, accountId: string): void {
    const head = text.slice(0, 400_000)
    const hits: { url: string; at: number }[] = []
    const unescape = (s: string): string =>
      s.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=')
    const reApi = /"fallback_api"\s*:\s*"([^"]+)"/g
    let m: RegExpExecArray | null
    while ((m = reApi.exec(head))) hits.push({ url: unescape(m[1]), at: m.index })
    const reFplay = /https?:\/\/[^\s"'\\<>]*\/video\/fplay\/[^\s"'\\<>]*/g
    while ((m = reFplay.exec(head))) hits.push({ url: m[0], at: m.index })
    if (!hits.length) return

    const vid = /"vid"\s*:\s*"([^"]+)"/.exec(head)?.[1] ?? '-'
    const conv = /"conversation_id"\s*:\s*"([^"]+)"/.exec(head)?.[1] ?? '-'
    const seen = new Set<string>()
    for (const h of hits) {
      if (seen.has(h.url)) continue
      seen.add(h.url)
      const params = ((): string => {
        try {
          return [...new URL(h.url).searchParams.keys()].join(',') || '-'
        } catch {
          return '-'
        }
      })()
      this.log(
        `[fallback][diag] 命中 source=${sourceUrl.slice(0, 140)} vid=${vid} conv=${conv} at=${h.at} params=${params} url=${h.url}`
      )
      console.log(`[fallback] 捕获 fallback_api vid=${vid} url=${h.url.slice(0, 140)}`)
      // 只对带 key_seed 的 fplay 地址建立 vid 映射（这才是可解密的高清档入口）
      const registered = this.registerFallbackUrl(h.url, accountId)
      const fplayVid = this.vidOfFplayUrl(h.url)
      if (fplayVid) {
        this.log(
          `[fplay][diag] ${registered ? '记录' : '跳过'} fallback_api vid=${fplayVid} hasKeySeed=${/[?&]key_seed=/.test(h.url) ? 'yes' : 'no'} params=${params}`
        )
      }
      void this.probeFallbackApi(h.url, accountId, vid)
    }
  }

  /** fplay 路径是 /video/fplay/<version>/<hash>/<vid>，vid 取最后一段 */
  private vidOfFplayUrl(url: string): string {
    try {
      return new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
    } catch {
      return ''
    }
  }

  /** 记录可用的 fplay 地址（必须带 key_seed）；返回是否成功写入映射 */
  private registerFallbackUrl(url: string, accountId: string): boolean {
    if (!/\/video\/fplay\//.test(url)) return false
    const vid = this.vidOfFplayUrl(url)
    if (!vid) return false
    if (!/[?&]key_seed=/.test(url)) {
      this.fallbackNoSeed.add(`${accountId}:${vid}`)
      return false
    }
    this.fallbackByVid.set(`${accountId}:${vid}`, { url, at: Date.now() })
    this.fallbackNoSeed.delete(`${accountId}:${vid}`)
    return true
  }

  /** 记录 /im/chain/single 调用模板（按账号+会话），供缺 fallback_api 时自动回放 */
  private trackChainCall(
    req: { url?: string; method?: string; postData?: string; headers?: Record<string, string> },
    accountId: string
  ): void {
    const url = req.url ?? ''
    if (!url.includes('doubao.com') || !/\/im\/chain\/single/.test(url)) return
    const body = req.postData ?? ''
    if (!body || body.length > 64_000) return
    let convId = ''
    try {
      convId = (JSON.parse(body) as { conversation_id?: string }).conversation_id ?? ''
    } catch {
      // body 不是 JSON 时退回 URL 参数
    }
    if (!convId) {
      try {
        convId = new URL(url).searchParams.get('conversation_id') ?? ''
      } catch {
        // ignore
      }
    }
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const lower = k.toLowerCase()
      // Cookie 走 session；content-length 会因读取方式失效
      if (lower === 'cookie' || lower === 'content-length' || lower === 'host') continue
      if (lower === 'content-type' || lower.startsWith('x-')) headers[k] = v
    }
    this.chainTemplates.set(`${accountId}:${convId || '-'}`, {
      url,
      method: req.method ?? 'POST',
      body,
      headers,
      convId,
      at: Date.now()
    })
    if (this.chainTemplates.size > 30) {
      const first = this.chainTemplates.keys().next().value
      if (first) this.chainTemplates.delete(first)
    }
    this.log(
      `[fplay][diag] 记录 chain 模板 conv=${convId || '-'} bodyLen=${body.length} headers=${Object.keys(headers).join(',') || '-'}`
    )
  }

  /** 只把文本里带 key_seed 的 fallback_api 写入映射；返回是否命中目标 vid */
  private ingestFallbackText(text: string, accountId: string, targetVid: string): boolean {
    const head = text.slice(0, 1_500_000)
    const unescape = (s: string): string =>
      s.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=')
    const urls: string[] = []
    const reApi = /"fallback_api"\s*:\s*"([^"]+)"/g
    let m: RegExpExecArray | null
    while ((m = reApi.exec(head))) urls.push(unescape(m[1]))
    const reFplay = /https?:\/\/[^\s"'\\<>]*\/video\/fplay\/[^\s"'\\<>]*/g
    while ((m = reFplay.exec(head))) urls.push(m[0])
    for (const u of urls) this.registerFallbackUrl(u, accountId)
    return !!targetVid && this.fallbackByVid.has(`${accountId}:${targetVid}`)
  }

  /**
   * 没有可用 fallback_api 时，用该账号 session 回放一次 /im/chain/single 模板：
   * 带 Cookie、边读边找目标 vid，命中或达到上限即断开；同一账号同一时刻只回放一次。
   */
  private async replayChainForVid(
    item: ArtifactItem,
    ses: Session,
    why: string
  ): Promise<{ ok: boolean; detail: string }> {
    const key = `${item.accountId}:${item.vid ?? ''}`
    if (!item.vid) return { ok: false, detail: '产物没有 vid' }
    const vid = item.vid
    let tpl = this.chainTemplates.get(`${item.accountId}:${item.convId ?? '-'}`)
    if (!tpl) {
      // 没有该会话模板时，用该账号最近一条 chain 模板兜底
      for (const [k, v] of this.chainTemplates) {
        if (!k.startsWith(`${item.accountId}:`)) continue
        if (!tpl || v.at > tpl.at) tpl = v
      }
    }
    if (!tpl) return { ok: false, detail: '没有可回放的 /im/chain/single 模板' }
    if (Date.now() - tpl.at > CALL_TEMPLATE_TTL) {
      return { ok: false, detail: '捕获的 /im/chain/single 模板已过期（30 分钟）' }
    }
    const template = tpl

    const running = this.chainReplay.get(item.accountId)
    if (running) {
      await running
      return this.fallbackByVid.has(key)
        ? { ok: true, detail: '复用同账号并发的回放结果' }
        : { ok: false, detail: '同账号回放未命中该 vid' }
    }

    const run = (async (): Promise<{ ok: boolean; detail: string }> => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 12_000)
      const t0 = Date.now()
      try {
        const res = await ses.fetch(template.url, {
          method: template.method,
          headers: template.headers,
          body: template.body,
          credentials: 'include',
          signal: ctrl.signal
        })
        const ct = res.headers.get('content-type') ?? '-'
        if (!res.ok) {
          this.log(
            `[fplay] ${item.id} 回放 chain（${why}）失败 status=${res.status} ct=${ct} ms=+${Date.now() - t0}`
          )
          return { ok: false, detail: `回放 HTTP ${res.status}` }
        }
        let text = ''
        const LIMIT = 768 * 1024
        if (res.body) {
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) text += dec.decode(value, { stream: true })
            if (text.length >= LIMIT) {
              try {
                await reader.cancel()
              } catch {
                // ignore
              }
              break
            }
            // 命中目标 vid 的 fallback_api 就提前断开，避免把整段会话读完
            if (text.includes('fallback_api') && text.includes(vid)) {
              try {
                await reader.cancel()
              } catch {
                // ignore
              }
              break
            }
          }
        } else {
          text = await res.text()
        }
        clearTimeout(timer)
        const hit = this.ingestFallbackText(text, item.accountId, vid)
        const detail = hit
          ? '命中目标 vid'
          : this.fallbackNoSeed.has(key)
            ? '回放拿到的地址不带 key_seed'
            : '回放响应里没有该 vid 的 fallback_api'
        this.log(
          `[fplay] ${item.id} 回放 chain（${why}）status=${res.status} ct=${ct} read=${Math.round(text.length / 1024)}KB 命中=${hit ? 'yes' : 'no'} ms=+${Date.now() - t0}`
        )
        return { ok: hit, detail }
      } catch (e) {
        clearTimeout(timer)
        const msg = e instanceof Error ? e.message : String(e)
        this.log(`[fplay] ${item.id} 回放 chain（${why}）异常 ${msg} ms=+${Date.now() - t0}`)
        return { ok: false, detail: `回放失败：${msg}` }
      } finally {
        this.chainReplay.delete(item.accountId)
      }
    })()
    this.chainReplay.set(item.accountId, run)
    return run
  }

  /** 第一阶段诊断：原样 GET 一次 fallback_api（不改任何参数），记录响应结构 */
  private async probeFallbackApi(url: string, accountId: string, vid: string): Promise<void> {
    if (this.fallbackProbed.has(url)) return
    if (this.fallbackProbed.size >= 12) {
      this.log('[fallback][diag] 探测已达 12 条上限，跳过新地址')
      return
    }
    this.fallbackProbed.add(url)
    const ses = session.fromPartition(`persist:doubao_${accountId}`)
    const t0 = Date.now()
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 10_000)
      // 保留 URL 原始参数，不覆盖 channel / codec_type / logo_type
      const res = await ses.fetch(url, {
        credentials: 'omit',
        headers: { accept: 'application/json,text/plain,*/*' },
        signal: ctrl.signal
      })
      clearTimeout(timer)
      const ct = res.headers.get('content-type') ?? '-'
      this.log(
        `[fallback][diag] 探测 vid=${vid} status=${res.status} ct=${ct} ms=+${Date.now() - t0} url=${url.slice(0, 200)}`
      )
      if (!res.ok) {
        console.log(`[fallback] 探测失败 vid=${vid} status=${res.status}`)
        return
      }
      const text = await res.text()
      let data: unknown = null
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
      if (!data || typeof data !== 'object') {
        this.log(
          `[fallback][diag] 响应非 JSON len=${text.length} snippet=${text.slice(0, 300)}`
        )
        return
      }
      const seed = findKeySeedDeep(data)
      const entries: Record<string, unknown>[] = []
      walkJsonObjects(data, (o) => {
        if (
          typeof o['main_url'] === 'string' ||
          typeof o['play_url'] === 'string' ||
          typeof o['backup_url_1'] === 'string'
        ) {
          entries.push(o)
        }
      })
      const fieldSet = new Set<string>()
      for (const e of entries) for (const k of Object.keys(e)) fieldSet.add(k)
      const topKeys = Object.keys(data).slice(0, 8).join(',')
      this.log(
        `[fallback][diag] 结构 vid=${vid} key_seed=${seed ? `yes(len=${seed.length})` : 'no'} 顶层=${topKeys} 条目=${entries.length} 字段=${[...fieldSet].join(',') || '-'}`
      )
      const details = entries.slice(0, 8).map((e, i) => {
        const fields = ['main_url', 'play_url', 'backup_url_1'].filter(
          (k) => typeof e[k] === 'string'
        )
        const shapes = fields.map((k) => `${k}:${shapeOfUrl(e[k] as string)}`).join(' ')
        // fplay 的 video_info 用 bitrate/real_bitrate，没有 br 字段
        const meta = [
          'definition',
          'quality',
          'vwidth',
          'vheight',
          'bitrate',
          'real_bitrate',
          'size',
          'logo_type',
          'url_expire'
        ]
          .map((k) => `${k}=${String(e[k] ?? '-')}`)
          .join(' ')
        return `#${i}{${meta} ${shapes}}`
      })
      this.log(`[fallback][diag] 条目明细 vid=${vid} ${details.join(' ') || '-'}`)
      console.log(`[fallback] 探测完成 vid=${vid} 条目=${entries.length} key_seed=${seed ? 'yes' : 'no'}`)
    } catch (e) {
      this.log(`[fallback][diag] 探测异常 vid=${vid} ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * 既用于解析本次返回的地址，也留作模板给其他 vid/node_id 回放。
   */
  private trackCall(
    requestId: string,
    req: { url?: string; method?: string; postData?: string; headers?: Record<string, string> }
  ): void {
    const url = req.url ?? ''
    const body = req.postData
    if (!url.includes('doubao.com') || !body) return
    // 只跟踪媒体相关接口，排除埋点上报（opt.doubao.com/monitor_browser，body 里也可能带 vid）
    const pathOnly = url.split('?')[0]
    if (!/\/(samantha|creativity|alice)\//.test(pathOnly)) return
    if (body.length > 4000) return
    const kind: 'play' | 'download' | null = /node_?[iI]d/.test(body)
      ? 'download'
      : /"vid"/.test(body)
        ? 'play'
        : null
    if (!kind) return
    const sample = kind === 'play' ? (collectVids(body)[0] ?? '') : sampleNodeId(body)
    if (!sample) return
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const lower = k.toLowerCase()
      // Cookie 由 session 自动带；content-length 会因 body 变化而不准
      if (lower === 'cookie' || lower === 'content-length') continue
      if (lower === 'content-type' || lower.startsWith('x-')) headers[k] = v
    }
    this.pendingCalls.set(requestId, {
      kind,
      url,
      method: req.method ?? 'POST',
      body,
      headers,
      sample,
      at: Date.now()
    })
    if (this.pendingCalls.size > 40) {
      const first = this.pendingCalls.keys().next().value
      if (first) this.pendingCalls.delete(first)
    }
    let scene = '-'
    try {
      scene = new URL(url).searchParams.get('scene') ?? '-'
    } catch {
      // ignore
    }
    if (scene === '-') {
      const m = /"(?:request_?[sS]cene|scene)"\s*:\s*"([^"]+)"/.exec(body)
      if (m) scene = m[1]
    }
    this.log(
      `[playurl][diag] 捕获调用 kind=${kind} scene=${scene} url=${redactUrl(url).slice(0, 320)} body=${body.slice(0, 600)}`
    )
  }

  /** 页面已经拿到无水印媒体地址：记下来（不落盘），下载时可优先复用 */
  private rememberUnwatermarked(url: string, accountId: string): void {
    const obj = objectKeyOfUrl(url)
    if (obj) this.unwatermarkedByObject.set(`${accountId}:${obj}`, { url, at: Date.now(), accountId })
    while (this.unwatermarkedByObject.size > 200) {
      const first = this.unwatermarkedByObject.keys().next().value
      if (!first) break
      this.unwatermarkedByObject.delete(first)
    }
    try {
      const matched = obj ? this.items.find((i) => objectKeyOfUrl(i.url) === obj) : undefined
      console.log(
        `[playurl] 捕获无水印媒体 host=${new URL(url).host} obj=${obj ?? '-'} 归属=${
          matched ? matched.id : '-'
        }`
      )
    } catch {
      // ignore
    }
  }

  /** 解析 play_info / download_info / get_without_watermark 响应体，建立 vid/node_id → 地址映射 */
  private parsePlayInfo(text: string, call: CapturedCall, accountId: string): void {
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      this.log(`[playurl][diag] 响应非 JSON kind=${call.kind} snippet=${text.slice(0, 200)}`)
      return
    }
    const { plays, nodes } = collectPlayUrls(data)
    // 通用提取：字段结构未知时，直接深搜所有 http 字符串（get_without_watermark 就属于这类）
    const all = [...new Set([...plays, ...nodes.map((n) => n.url), ...collectHttpUrls(data)])]
    if (!all.length) {
      this.log(`[playurl][diag] 响应里没有任何 http 地址 kind=${call.kind} snippet=${text.slice(0, 300)}`)
      return
    }
    const now = Date.now()
    const vids = call.kind === 'play' ? collectVids(call.body) : []
    const un = all.filter(isUnwatermarkedUrl)
    if (call.kind === 'play' && vids.length) {
      if (vids.length === 1) {
        const url = un[0]
        if (url) this.playByVid.set(`${accountId}:${vids[0]}`, { url, at: now })
      } else {
        un.forEach((url, i) => {
          const vid = vids[i] ?? vids[vids.length - 1]
          this.playByVid.set(`${accountId}:${vid}`, { url, at: now })
        })
      }
    }
    for (const n of nodes) {
      if (n.id && isUnwatermarkedUrl(n.url)) {
        this.playByNode.set(`${accountId}:${n.id}`, { url: n.url, at: now })
      }
    }
    this.callTemplates = [
      { ...call, at: now },
      ...this.callTemplates.filter((t) => now - t.at < CALL_TEMPLATE_TTL)
    ].slice(0, 6)
    console.log(
      `[playurl] 捕获接口 kind=${call.kind} urls=${all.length}(无水印 ${un.length}) vids=${vids.length} url=${call.url.slice(0, 100)}`
    )
    this.log(
      `[playurl][diag] 响应 kind=${call.kind} 无水印=${un.length} ${JSON.stringify(
        all.slice(0, 6).map(describeMediaUrl)
      )} snippet=${text.slice(0, 240)}`
    )
  }

  /** 只在 5 分钟内复用捕获到的地址；更早的视为失效，重新解析 */
  private freshPlayUrl(item: ArtifactItem): { url: string; source: string } | null {
    const now = Date.now()
    const vid = item.vid ? this.playByVid.get(`${item.accountId}:${item.vid}`) : undefined
    if (vid && now - vid.at < PLAY_URL_TTL && isUnwatermarkedUrl(vid.url)) {
      return { url: vid.url, source: 'vid' }
    }
    const node = item.nodeId ? this.playByNode.get(`${item.accountId}:${item.nodeId}`) : undefined
    if (node && now - node.at < PLAY_URL_TTL && isUnwatermarkedUrl(node.url)) {
      return { url: node.url, source: 'node_id' }
    }
    const objKey = objectKeyOfUrl(item.url)
    const obj = objKey ? this.unwatermarkedByObject.get(`${item.accountId}:${objKey}`) : undefined
    if (obj && now - obj.at < PLAY_URL_TTL) return { url: obj.url, source: 'object' }
    return null
  }

  /**
   * fplay 最高档：把捕获到的 fallback_api 覆盖成无水印参数再 GET，
   * 取 real_bitrate 最高的档位并解 qAAB；只接受解出后仍为 lr=unwatermarked 的地址。
   */
  private async resolveFplay(
    item: ArtifactItem,
    ses: Session
  ): Promise<{ urls: string[]; source: string } | { reason: string }> {
    if (!item.vid) return { reason: '产物没有 vid' }
    const key = `${item.accountId}:${item.vid}`
    const cached = this.fplayByVid.get(key)
    // 预留 2 分钟提前量，避免拿到临界过期的地址
    if (cached && Date.now() < cached.expires - 120_000) {
      return { urls: cached.urls, source: 'fplay' }
    }
    let fb = this.fallbackByVid.get(key)
    const expired = !!fb && Date.now() - fb.at > FALLBACK_URL_TTL
    if (!fb || expired) {
      const why = !fb ? (this.fallbackNoSeed.has(key) ? '缺 key_seed' : '缺失') : '已过期'
      const rp = await this.replayChainForVid(item, ses, why)
      if (!rp.ok) {
        return {
          reason: `${!fb ? '未记录到该 vid 的 fallback_api' : '捕获的 fallback_api 已过期'}，且自动回放失败：${rp.detail}`
        }
      }
      fb = this.fallbackByVid.get(key)
      if (!fb) return { reason: '自动回放后仍未拿到该 vid 的 fallback_api' }
    }
    const u = new URL(fb.url)
    u.searchParams.set('channel', 'no')
    u.searchParams.set('codec_type', '8')
    u.searchParams.set('logo_type', 'unwatermarked')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    try {
      const res = await ses.fetch(u.toString(), {
        credentials: 'omit',
        headers: { accept: 'application/json,text/plain,*/*' },
        signal: ctrl.signal
      })
      clearTimeout(timer)
      if (!res.ok) {
        this.fplayFailedAt.set(key, Date.now())
        return { reason: `fplay 无水印请求 HTTP ${res.status}` }
      }
      const text = await res.text()
      let data: unknown = null
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
      if (!data || typeof data !== 'object') {
        this.fplayFailedAt.set(key, Date.now())
        return { reason: 'fplay 响应不是 JSON' }
      }
      const seed = u.searchParams.get('key_seed') || findKeySeedDeep(data)
      const gear = pickFplayGear(data, seed)
      if (!gear) {
        this.fplayFailedAt.set(key, Date.now())
        this.log(
          `[fplay][diag] ${item.id} 无可用无水印档位 ${JSON.stringify(
            collectHttpUrls(data).slice(0, 4).map(describeMediaUrl)
          )}`
        )
        return { reason: 'fplay 未返回可用无水印档位' }
      }
      const expires = gear.expires > 0 ? gear.expires : Date.now() + 30 * 60_000
      this.fplayByVid.set(key, { urls: gear.urls, at: Date.now(), expires })
      this.fplayFailedAt.delete(key)
      const hosts = gear.urls
        .map((u) => {
          try {
            return new URL(u).host
          } catch {
            return '-'
          }
        })
        .join('|')
      console.log(
        `[fplay] ${item.id} 命中最高档 definition=${gear.def} bitrate=${gear.bitrate} host=${hosts} 有效至=${new Date(expires).toISOString()}`
      )
      this.log(
        `[fplay][diag] ${item.id} 选择 definition=${gear.def} bitrate=${gear.bitrate} host=${hosts} exp=${Math.round(
          (expires - Date.now()) / 1000
        )}s 候选=${gear.urls.length}`
      )
      return { urls: gear.urls, source: 'fplay' }
    } catch (e) {
      clearTimeout(timer)
      this.fplayFailedAt.set(key, Date.now())
      return {
        reason: `fplay 请求失败：${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  /** 获取当前可用的无水印地址：优先捕获映射，其次回放页面学到的接口；失败带原因返回给调用方 */
  private async resolveUnwatermarked(
    item: ArtifactItem,
    ses: Session
  ): Promise<{ url: string; source: string } | { reason: string }> {
    const fresh = this.freshPlayUrl(item)
    if (fresh) {
      item.playUrl = fresh.url
      console.log(`[playurl] ${item.id} 命中捕获映射(${fresh.source}) host=${new URL(fresh.url).host}`)
      return fresh
    }
    // 实机证据（2026-11-27）：/samantha/video/get_play_info 无论 scene 都返回
    // lr=video_gen_watermark_dyn&download=true；页面真正拿无水印走的是
    // /creativity/resource/get_without_watermark（body {"vid":[...]}）。
    // 所以模板按 endpoint 优先 get_without_watermark，其次才是其他 play 调用。
    if (!item.vid) return { reason: '产物没有 vid，无法查询无水印接口' }
    const id = item.vid
    const now = Date.now()
    const eligible = this.callTemplates.filter(
      (t) => t.kind === 'play' && now - t.at < CALL_TEMPLATE_TTL && !!t.body && t.body.includes(t.sample)
    )
    const ordered = [
      ...eligible.filter((t) => t.url.includes('get_without_watermark')),
      ...eligible.filter((t) => !t.url.includes('get_without_watermark'))
    ]
    if (!ordered.length) {
      return { reason: '未捕获到可回放的播放接口（页面还没播放过这个视频）' }
    }
    const reasons: string[] = []
    for (const tpl of ordered) {
      const r = await this.replayTemplate(item, tpl, ses, id)
      if ('url' in r) return r
      reasons.push(r.reason)
    }
    return { reason: reasons.join('；') }
  }

  /** 用页面学到的调用模板取一次无水印地址（把样例 vid 替换成当前产物 vid） */
  private async replayTemplate(
    item: ArtifactItem,
    tpl: CapturedCall,
    ses: Session,
    vid: string
  ): Promise<{ url: string; source: string } | { reason: string }> {
    const endpoint = `${tpl.method} ${redactUrl(tpl.url).slice(0, 160)}`
    if (!tpl.body) return { reason: `模板缺少 body（${endpoint}）` }
    try {
      const body = tpl.body.split(tpl.sample).join(vid)
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 10_000)
      const res = await ses.fetch(tpl.url, {
        method: tpl.method,
        headers: tpl.headers,
        body,
        signal: ctrl.signal
      })
      clearTimeout(timer)
      if (!res.ok) return { reason: `回放接口 HTTP ${res.status}（${endpoint}）` }
      const text = await res.text()
      let data: unknown
      try {
        data = JSON.parse(text)
      } catch {
        return { reason: `回放接口响应非 JSON（${endpoint}）` }
      }
      const found = collectPlayUrls(data)
      const all = [
        ...new Set([...found.plays, ...found.nodes.map((n) => n.url), ...collectHttpUrls(data)])
      ]
      this.log(
        `[playurl][diag] 回放候选（${endpoint}）：${JSON.stringify(all.slice(0, 6).map(describeMediaUrl))}`
      )
      const url = all.find(isUnwatermarkedUrl)
      if (!url) {
        const first = all[0]
        const host = first
          ? (() => {
              try {
                return new URL(first).host
              } catch {
                return '-'
              }
            })()
          : '-'
        return {
          reason: `回放接口返回的是${first ? `非无水印地址 host=${host}` : '空数据'}（${endpoint}）`
        }
      }
      this.playByVid.set(`${item.accountId}:${vid}`, { url, at: Date.now() })
      item.playUrl = url
      console.log(`[playurl] ${item.id} 回放成功（${endpoint}）host=${new URL(url).host}`)
      return {
        url,
        source: tpl.url.includes('get_without_watermark')
          ? 'replay/get_without_watermark'
          : 'replay/play'
      }
    } catch (e) {
      return {
        reason: `回放接口失败（${endpoint}）：${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  /** 取视频源：无水印优先（Range: bytes=0-，6s 无响应就断开换连接重试），失败回退水印地址 */
  private async openVideoSource(item: ArtifactItem): Promise<{ res: Response; label: string }> {
    const ses = session.fromPartition(`persist:doubao_${item.accountId}`)
    // 诊断：产物条目当前到底有哪些字段（vid/nodeId/url 全靠它判断）
    const dumped = JSON.stringify(briefItem(item))
    console.log(`[playurl] item ${item.id} 字段 ${dumped}`)
    this.log(`[playurl][diag] item ${item.id} ${dumped}`)
    this.log(
      `[playurl][diag] item.url 对象名=${objectKeyOfUrl(item.url) ?? '-'} vid=${
        item.vid ?? '-'
      } nodeId=${item.nodeId ?? '-'}`
    )
    const candidates: Array<{ url: string; label: string; range: boolean }> = []
    // 第一优先级：fplay 最高档（main + backup 两个 host 都作为独立候选）
    const fplay = await this.resolveFplay(item, ses)
    if ('urls' in fplay) {
      fplay.urls.forEach((u, i) => {
        candidates.push({
          url: u,
          label: `unwatermarked/${fplay.source}#${i === 0 ? 'main' : 'backup'}`,
          range: true
        })
      })
    } else {
      console.log(`[fplay] ${item.id} 不可用：${fplay.reason}；回退 get_without_watermark`)
      this.log(`[fplay] ${item.id} 不可用：${fplay.reason}；回退 get_without_watermark`)
    }
    // 第二优先级：页面 get_without_watermark / 捕获映射
    const un = await this.resolveUnwatermarked(item, ses)
    if ('url' in un) {
      candidates.push({ url: un.url, label: `unwatermarked/${un.source}`, range: true })
    } else {
      console.log(`[playurl] ${item.id} 无水印不可用：${un.reason}；回退水印地址`)
      this.log(`[playurl] ${item.id} 无水印不可用：${un.reason}；回退水印地址`)
    }
    candidates.push({ url: item.url, label: 'watermarked-fallback', range: false })

    for (const c of candidates) {
      // fplay 有 main/backup 两个 host，各自只试一次；其余来源仍给 2 次机会
      const tries = c.label.includes('fplay') ? 1 : 2
      for (let attempt = 1; attempt <= tries; attempt++) {
        const ctrl = new AbortController()
        const t0 = Date.now()
        // 无水印源首次响应正常约 0.3s，6s 没头就视为卡死并换连接；水印源沿用 15s
        const timer = setTimeout(() => ctrl.abort(), c.range ? 6_000 : 15_000)
        try {
          const res = await ses.fetch(c.url, {
            headers: c.range ? { Range: 'bytes=0-' } : {},
            signal: ctrl.signal
          })
          if (!res.ok || !res.body) {
            console.log(`[playurl] ${item.id} ${c.label} HTTP ${res.status}，尝试下一种来源`)
            break
          }
          console.log(
            `[playurl] ${item.id} 使用 ${c.label} host=${new URL(c.url).host} attempt=${attempt} status=${res.status} +${Date.now() - t0}ms`
          )
          this.log(
            `[playurl] ${item.id} 使用 ${c.label} host=${new URL(c.url).host} status=${res.status}`
          )
          return { res, label: c.label }
        } catch (e) {
          console.log(
            `[playurl] ${item.id} ${c.label} 第 ${attempt} 次失败 +${Date.now() - t0}ms: ${
              e instanceof Error ? e.message : String(e)
            }`
          )
        } finally {
          // 无论成功/失败都清理定时器，避免遗留计时器拖住流程
          clearTimeout(timer)
        }
      }
    }
    throw new Error('无水印地址与水印地址均不可用')
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
      convId,
      vid: vid0,
      nodeId:
        (typeof vid?.['node_id'] === 'string' ? (vid['node_id'] as string) : undefined) ??
        (typeof c['node_id'] === 'string' ? (c['node_id'] as string) : undefined)
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
        convId,
        vid: uri || vid || undefined,
        nodeId:
          typeof v['node_id'] === 'string'
            ? v['node_id']
            : typeof v['nodeId'] === 'string'
              ? v['nodeId']
              : undefined
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
        if (!old.vid && item.vid) {
          old.vid = item.vid
          changed = true
        }
        if (!old.nodeId && item.nodeId) {
          old.nodeId = item.nodeId
          changed = true
        }
        for (const k of candidates) {
          if (!this.seen.has(k)) {
            this.seen.add(k)
            this.itemKeys.get(old.id)?.push(k)
          }
        }
        if (changed) {
          console.log('[artifacts] 更新', briefItem(old))
          this.push('artifact:update', old)
        }
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
        this.dropCache(removed.id)
      }
    }
    console.log('[artifacts] 新增', briefItem(item))
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
    console.log('[artifacts] 清空')
    this.items = []
    this.seen.clear()
    this.itemKeys.clear()
    this.thumbCache.clear()
    for (const id of this.mediaCache.keys()) this.pendingDelete.add(id)
    this.push('artifact:cleared', null)
    this.cleanup('列表清空')
  }

  /** 拉取（或复用）视频的本地缓存：整条上游流都由主进程读完落盘，不依赖渲染进程消费 */
  private ensureCache(item: ArtifactItem): MediaCache {
    const hit = this.mediaCache.get(item.id)
    if (hit) {
      // 旧缓存低于当前可用来源时重建：水印版→无水印，或 2.15Mbps 无水印→fplay 5.8Mbps 最高档
      const key = item.vid ? `${item.accountId}:${item.vid}` : ''
      const fplayKnown =
        !!key && (this.fplayByVid.has(key) || this.fallbackByVid.has(key))
      const fplayRecentFail =
        !!key && Date.now() - (this.fplayFailedAt.get(key) ?? 0) < 5 * 60_000
      const upgradeToFplay =
        hit.done &&
        hit.active === 0 &&
        fplayKnown &&
        !fplayRecentFail &&
        !hit.source?.startsWith('unwatermarked/fplay')
      const upgradeFromWatermark =
        hit.done &&
        hit.active === 0 &&
        hit.source === 'watermarked-fallback' &&
        !!this.freshPlayUrl(item)
      if (upgradeToFplay || upgradeFromWatermark) {
        console.log(
          `[cache] ${item.id} 旧缓存来源=${hit.source ?? 'unknown'} 低于当前可用来源，重建`
        )
        try {
          fs.unlinkSync(hit.path)
        } catch {
          // ignore
        }
        this.mediaCache.delete(item.id)
        this.cacheIndexDirty = true
        this.scheduleSaveIndex()
      } else {
        return hit
      }
    }
    const entry: MediaCache = {
      path: path.join(this.cacheDir, `${item.id}.mp4`),
      total: 0,
      downloaded: 0,
      done: false,
      lastUsed: Date.now(),
      active: 0
    }
    this.mediaCache.set(item.id, entry)
    console.log(`[cache] start ${item.id}`)
    void (async () => {
      let fh: fs.promises.FileHandle | null = null
      try {
        const { res, label } = await this.openVideoSource(item)
        entry.source = label
        if (!res.body) throw new Error(`HTTP ${res.status} ${res.statusText}（无响应体）`)
        entry.total = totalFromHeaders(res.headers)
        fh = await fs.promises.open(entry.path, 'w')
        const upstream = Readable.fromWeb(
          res.body as unknown as import('node:stream/web').ReadableStream
        )
        for await (const chunk of upstream) {
          const buf = chunk as Buffer
          // 顺序 await 写入：保证 downloaded 计数对应的字节已经落盘，读侧不会读到空洞
          await fh.write(buf)
          entry.downloaded += buf.length
        }
        entry.done = true
        entry.lastUsed = Date.now()
        console.log(`[cache] done ${item.id} ${entry.downloaded}/${entry.total}`)
        this.scheduleSaveIndex()
        // 写入完成是安全时机：此时不会有半截文件被清掉
        this.cleanup('写入完成')
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err)
        console.log(`[cache] failed ${item.id}`, entry.error)
        this.mediaCache.delete(item.id)
        this.scheduleSaveIndex()
        try {
          if (fs.existsSync(entry.path)) fs.unlinkSync(entry.path)
        } catch {
          // ignore
        }
      } finally {
        try {
          await fh?.close()
        } catch {
          // ignore
        }
      }
    })()
    return entry
  }

  /** 正在写入、或正在被预览/复制读取的缓存不能删 */
  private isCacheBusy(e: MediaCache): boolean {
    if (!e.done && !e.error) return true
    // active 理论上随流结束归零；若异常泄漏，按「最近访问」兜底放行，避免永远清不掉
    if (e.active > 0 && Date.now() - e.lastUsed < CACHE_GUARD_MS) return true
    return false
  }

  private totalCacheBytes(): number {
    let total = 0
    for (const e of this.mediaCache.values()) {
      try {
        total += fs.statSync(e.path).size
      } catch {
        // ignore
      }
    }
    return total
  }

  /** 列表移除/清空：先登记，正在使用就等下次清理时再删 */
  private dropCache(id: string): void {
    if (!this.mediaCache.has(id)) return
    this.pendingDelete.add(id)
    this.cleanup('列表移除')
  }

  /** 清理只在安全时机调用：启动后、缓存写入完成后、列表变更后 */
  private cleanup(reason: string): void {
    if (this.cleaning) {
      this.cleanupQueued = true
      return
    }
    this.cleaning = true
    try {
      do {
        this.cleanupQueued = false
        this.runCleanup(reason)
      } while (this.cleanupQueued)
    } finally {
      this.cleaning = false
    }
    this.saveCacheIndex()
  }

  private runCleanup(reason: string): void {
    const now = Date.now()
    const removed: Array<{ id: string; why: string; size: number }> = []
    const sizeOf = (e: MediaCache): number => {
      try {
        return fs.statSync(e.path).size
      } catch {
        return e.downloaded
      }
    }
    const drop = (id: string, e: MediaCache, why: string): void => {
      const size = sizeOf(e)
      this.mediaCache.delete(id)
      this.pendingDelete.delete(id)
      this.thumbCache.delete(id)
      this.cacheIndexDirty = true
      try {
        fs.unlinkSync(e.path)
      } catch {
        // ignore
      }
      removed.push({ id, why, size })
    }

    // 1) 目录里有、索引里没有的 .mp4：上次没写完的残留
    try {
      for (const name of fs.readdirSync(this.cacheDir)) {
        if (!name.endsWith('.mp4')) continue
        const id = name.slice(0, -'.mp4'.length)
        if (this.mediaCache.has(id)) continue
        const p = path.join(this.cacheDir, name)
        let size = 0
        try {
          size = fs.statSync(p).size
        } catch {
          // ignore
        }
        try {
          fs.unlinkSync(p)
        } catch {
          // ignore
        }
        removed.push({ id, why: '遗留', size })
      }
    } catch {
      // ignore
    }

    // 2) 产物已从列表移除（或清空列表）
    for (const id of [...this.pendingDelete]) {
      const e = this.mediaCache.get(id)
      if (!e) {
        this.pendingDelete.delete(id)
        continue
      }
      if (this.isCacheBusy(e)) continue
      drop(id, e, '列表移除')
    }

    // 3) 超过 7 天没被访问
    for (const [id, e] of [...this.mediaCache]) {
      if (!this.mediaCache.has(id)) continue
      if (now - e.lastUsed <= CACHE_TTL_MS) continue
      if (this.isCacheBusy(e)) continue
      drop(id, e, '过期')
    }

    // 4) 容量超过 2GB：按最后访问时间从旧到新淘汰
    const alive = [...this.mediaCache.entries()].map(([id, e]) => ({ id, e, size: sizeOf(e) }))
    let total = alive.reduce((s, x) => s + x.size, 0)
    if (total > CACHE_LIMIT_BYTES) {
      alive.sort((a, b) => a.e.lastUsed - b.e.lastUsed)
      for (const x of alive) {
        if (total <= CACHE_LIMIT_BYTES) break
        if (!this.mediaCache.has(x.id) || this.isCacheBusy(x.e)) continue
        total -= x.size
        drop(x.id, x.e, '容量')
      }
    }

    if (removed.length) {
      const detail = removed
        .map((r) => `${r.id}(${r.why},${(r.size / 1048576).toFixed(1)}MB)`)
        .join(' ')
      console.log(
        `[cache] 清理(${reason}) 删除 ${removed.length} 个：${detail}；当前占用 ${(
          this.totalCacheBytes() / 1048576
        ).toFixed(0)}MB`
      )
    }
  }

  /**
   * 列表里的视频首帧封面：只拉文件头部 2MB，按「完整文件」返回。
   * 封面元素是 preload=metadata，若走完整播放通道会把整段视频缓存下来；
   * 这里的有界响应会被一次性读完，不会留下未消费的响应体。
   */
  async serveThumb(item: ArtifactItem): Promise<Response> {
    const hit = this.thumbCache.get(item.id)
    if (hit) {
      hit.lastUsed = Date.now()
      return new Response(hit.data as unknown as BodyInit, {
        headers: { 'content-type': 'video/mp4', 'content-length': String(hit.data.length) }
      })
    }
    const HEAD = 2 * 1024 * 1024
    const ses = session.fromPartition(`persist:doubao_${item.accountId}`)
    const res = await ses.fetch(item.url, { headers: { range: `bytes=0-${HEAD - 1}` } })
    if (!res.ok || !res.body) return new Response(`thumb HTTP ${res.status}`, { status: 502 })
    const upstream = Readable.fromWeb(
      res.body as unknown as import('node:stream/web').ReadableStream
    )
    const chunks: Buffer[] = []
    let got = 0
    try {
      for await (const c of upstream) {
        const buf = c as Buffer
        chunks.push(buf)
        got += buf.length
        if (got >= HEAD) break
      }
    } finally {
      if (got >= HEAD) {
        // 上游忽略 Range 返回整包时，主动断掉剩余字节
        try {
          await (res.body as unknown as ReadableStream<Uint8Array>).cancel()
        } catch {
          // ignore
        }
      }
    }
    const data = Buffer.concat(chunks)
    this.thumbCache.set(item.id, { data, lastUsed: Date.now() })
    while (this.thumbCache.size > 12) {
      let oldestId = ''
      let oldest = Infinity
      for (const [id, v] of this.thumbCache) {
        if (v.lastUsed < oldest) {
          oldest = v.lastUsed
          oldestId = id
        }
      }
      if (!oldestId) break
      this.thumbCache.delete(oldestId)
    }
    console.log(`[thumb] head ${item.id} ${data.length}/${got}`)
    return new Response(data as unknown as BodyInit, {
      headers: { 'content-type': 'video/mp4', 'content-length': String(data.length) }
    })
  }

  /**
   * 视频代理：从本地缓存文件按 Range 返回，缓存还没下载到的部分边下边读。
   * 内容语义必须和原样透传一致（content-range 覆盖到文件末尾），否则 Chromium 会
   * 认为整个文件已经缓冲完并直接跳到结尾（实测：1MB 有界窗口会让视频 1 秒内结束）。
   */
  async serveVideo(item: ArtifactItem, range: string | null): Promise<Response> {
    const e = this.ensureCache(item)
    // 命中缓存即算一次访问：内存时间立刻更新，落盘走节流（播放中每秒都会命中）
    e.lastUsed = Date.now()
    e.active++
    this.scheduleSaveIndex()
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      e.active = Math.max(0, e.active - 1)
    }
    const head = new Headers({ 'content-type': 'video/mp4', 'accept-ranges': 'bytes' })
    const ready = await waitUntil(
      () => e.total > 0 || e.downloaded > 0 || e.done || !!e.error,
      20_000
    )
    if (!ready) {
      release()
      return new Response('cache timeout', { status: 504 })
    }
    if (e.error && e.downloaded === 0) {
      release()
      return new Response(`cache error: ${e.error}`, { status: 502 })
    }

    const total = e.total || 0
    const m = /^bytes=(\d+)-(\d*)$/.exec(range ?? '')
    let start = m ? Number(m[1]) : 0
    let end = total ? total - 1 : Infinity
    if (m && m[2]) end = Math.min(end, Number(m[2]))
    if (total && start >= total) {
      release()
      return new Response('range not satisfiable', { status: 416 })
    }
    if (total) {
      head.set('content-length', String(end - start + 1))
      if (m) head.set('content-range', `bytes ${start}-${end}/${total}`)
    }
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        e.lastUsed = Date.now()
        this.scheduleSaveIndex()
        for (;;) {
          if (e.error && start >= e.downloaded) {
            release()
            controller.error(new Error(e.error))
            return
          }
          if (start > end) {
            release()
            controller.close()
            return
          }
          if (start < e.downloaded) {
            const len = Math.min(512 * 1024, e.downloaded - start, end - start + 1)
            const buf = Buffer.allocUnsafe(len)
            const fh = await fs.promises.open(e.path, 'r')
            try {
              const { bytesRead } = await fh.read(buf, 0, len, start)
              if (bytesRead <= 0) {
                await sleep(20)
                continue
              }
              start += bytesRead
              controller.enqueue(buf.subarray(0, bytesRead))
              return
            } finally {
              await fh.close()
            }
          }
          if (e.done) {
            release()
            controller.close()
            return
          }
          await sleep(30)
        }
      },
      cancel: () => {
        release()
      }
    })
    return new Response(body, { status: m ? 206 : 200, headers: head })
  }

  /** 下载产物：主进程用该账号 session 直接流式拉取写盘（不依赖 webContents / will-download） */
  download(id: string): boolean {
    const item = this.items.find((i) => i.id === id)
    if (!item) return false
    // 下载时实时解析会话名：产物入库时会话信息可能还没返回，文件名不能在入库时定死
    const convName = item.convId ? this.convNames.get(item.convId) : undefined
    const ext = extOfUrl(item.url, item.kind)
    const stem = (convName ?? item.filename.replace(/\.[a-z0-9]+$/i, '')).trim()
    const name = stem ? `${stem}${ext}` : item.filename
    console.log('[download] 触发', item.id, item.kind, name)
    // 视频复用缓存那条流：不再为下载单独开第二路同 URL 请求
    if (item.kind === 'video') void this.downloadVideo(item, name)
    else void this.streamToFile(item, name)
    return true
  }

  /** 视频下载：等本地缓存抓完再复制到「下载」目录，进度直接沿用缓存进度 */
  private async downloadVideo(item: ArtifactItem, name: string): Promise<void> {
    const t0 = Date.now()
    const state = { filename: name, savePath: this.uniquePath(name), received: 0, total: 0 }
    const e = this.ensureCache(item)
    // 下载命中缓存也算访问，并且复制期间不能让清理删掉这个文件
    e.lastUsed = Date.now()
    e.active++
    this.scheduleSaveIndex()
    this.emitDownload(item.accountId, 'started', state)
    console.log(`[download] 缓存下载 -> ${state.savePath}`)
    const ticker = setInterval(() => {
      state.received = e.downloaded
      if (e.total) state.total = e.total
      this.emitDownload(item.accountId, 'progressing', state)
    }, 200)
    try {
      const ok = await waitUntil(() => e.done || !!e.error, 30 * 60_000)
      if (!ok) throw new Error('缓存下载超时')
      if (e.error) throw new Error(e.error)
      await pipeline(createReadStream(e.path), createWriteStream(state.savePath))
      state.received = fs.statSync(state.savePath).size
      state.total = state.received
      this.emitDownload(item.accountId, 'done', state)
      console.log(`[download] done(cache) received=${state.received} +${Date.now() - t0}ms`)
    } catch (err) {
      console.log(
        '[download] 缓存路径失败，回退直连流式：',
        err instanceof Error ? err.message : String(err)
      )
      clearInterval(ticker)
      await this.streamToFile(item, name)
      return
    } finally {
      clearInterval(ticker)
      e.active = Math.max(0, e.active - 1)
      this.scheduleSaveIndex()
    }
  }

  private emitDownload(
    accountId: string,
    status: string,
    p: { filename: string; savePath: string; received: number; total: number }
  ): void {
    this.push('download:event', { accountId, status, ...p })
  }

  /** 同名文件自动编号：xxx.mp4 -> xxx (1).mp4 */
  private uniquePath(base: string): string {
    const dir = app.getPath('downloads')
    let p = path.join(dir, base)
    const ext = path.extname(base)
    const stem = path.basename(base, ext)
    for (let n = 1; fs.existsSync(p); n++) p = path.join(dir, `${stem} (${n})${ext}`)
    return p
  }

  /**
   * 主进程流式下载：不经过渲染进程/网页/下载管理器，
   * total 取 content-length（未知则为 0，前端按「已下载字节」展示），收到多少推多少。
   * 15s 没有新数据视为连接卡死，中断后用 Range 从断点续传（最多 3 次）。
   */
  private async streamToFile(item: ArtifactItem, name: string): Promise<void> {
    const t0 = Date.now()
    const state = { filename: name, savePath: this.uniquePath(name), received: 0, total: 0 }
    const ses = session.fromPartition(`persist:doubao_${item.accountId}`)
    try {
      let started = false
      for (let attempt = 0; attempt < 3; attempt++) {
        const ctrl = new AbortController()
        const resume = state.received > 0
        const reqHeaders: Record<string, string> = resume ? { Range: `bytes=${state.received}-` } : {}
        const res = await ses.fetch(item.url, { headers: reqHeaders, signal: ctrl.signal })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        // 续传时服务端若忽略 Range 返回 200，只能从 0 重来
        const append = resume && res.status === 206
        if (resume && !append) state.received = 0

        if (!started) {
          // 用真实 MIME 纠正扩展名（CDN 模板 URL 的对象名扩展名不可信）
          const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
          const sub = mime.split('/')[1]
          if ((mime.startsWith('image/') || mime.startsWith('video/')) && sub) {
            const want = sub === 'jpeg' ? '.jpeg' : '.' + sub.replace(/[^a-z0-9]/g, '')
            if (want.length > 1 && !name.toLowerCase().endsWith(want)) {
              const corrected = name.replace(/\.[a-z0-9]{2,5}$/i, '') + want
              state.filename = corrected
              state.savePath = this.uniquePath(corrected)
            }
          }
          const cr = res.headers.get('content-range')
          state.total =
            Number(res.headers.get('content-length') ?? 0) ||
            Number(cr?.split('/')[1] ?? 0) ||
            0
          started = true
          this.emitDownload(item.accountId, 'started', state)
          console.log(
            `[download] streaming +${Date.now() - t0}ms total=${state.total} -> ${state.savePath}`
          )
        }

        let lastData = Date.now()
        let lastEmit = Date.now()
        const counter = new Transform({
          transform: (chunk: Buffer, _enc, cb) => {
            state.received += chunk.length
            lastData = Date.now()
            const now = Date.now()
            if (now - lastEmit >= 150) {
              lastEmit = now
              this.emitDownload(item.accountId, 'progressing', state)
            }
            cb(null, chunk)
          }
        })
        // 卡死检测：15s 没有任何新数据就主动断开，交给下一轮断点续传
        const watchdog = setInterval(() => {
          if (Date.now() - lastData > 15_000) {
            console.log(`[download] stalled at ${state.received}, abort & retry`)
            ctrl.abort()
          }
        }, 1000)
        try {
          await pipeline(
            Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
            counter,
            createWriteStream(state.savePath, { flags: append ? 'a' : 'w' })
          )
        } catch (e) {
          if (attempt < 2) {
            // 续传位置以磁盘真实大小为准：pipeline 中断时计数可能比已落盘字节多出一个 chunk
            try {
              if (fs.existsSync(state.savePath)) state.received = fs.statSync(state.savePath).size
            } catch {
              // ignore
            }
            console.log(
              `[download] attempt ${attempt + 1} failed (${e instanceof Error ? e.message : String(e)}), resume at ${state.received}`
            )
            continue
          }
          throw e
        } finally {
          clearInterval(watchdog)
        }
        if (state.total && state.received < state.total) {
          // 提前断流（无报错但没传完）也走续传
          if (attempt < 2) continue
          throw new Error(`连接提前断开（${state.received}/${state.total}）`)
        }
        this.emitDownload(item.accountId, 'done', state)
        console.log(
          `[download] done received=${state.received} total=${state.total} +${Date.now() - t0}ms`
        )
        return
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log('[download] failed', msg)
      // 清掉写了一半的残留文件，避免用户拿到损坏文件
      try {
        if (state.savePath && fs.existsSync(state.savePath)) fs.unlinkSync(state.savePath)
      } catch {
        // ignore
      }
      this.emitDownload(item.accountId, 'failed', state)
    }
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
      console.log('[artifacts] 缩略图更新', briefItem(item))
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
