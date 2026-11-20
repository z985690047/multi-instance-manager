import { app, net, type WebContents } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import dns from 'node:dns/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

type PushFn = (channel: string, payload: unknown) => void
type DebuggerSession = WebContents['debugger']

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

/** 单份诊断日志大小上限 */
const MAX_LOG_BYTES = 2 * 1024 * 1024
/** 单个文件体积上限 */
const MAX_BYTES = 512 * 1024 * 1024
/** 粘贴兜底路径的上限（需要 base64 传给页面，过大不划算） */
const MAX_PASTE_BYTES = 48 * 1024 * 1024
/** 整体下载超时 */
const OVERALL_TIMEOUT = 10 * 60_000
/** 注入成功后保留临时文件的时长：Chromium 在上传读取时才打开文件，不能立即删除 */
const KEEP_MS = 15 * 60_000
const MAX_REDIRECTS = 5

/* ---------------- 通用小工具 ---------------- */

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function fmtBytes(n: number): string {
  if (!n) return '0B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`
}

function errMsg(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'AbortError') return '请求已中断'
    const m = e.message || e.name
    if (/ENOTFOUND|EAI_AGAIN/.test(m)) return '域名解析失败'
    if (/ECONNREFUSED/.test(m)) return '连接被拒绝'
    if (/ETIMEDOUT|timed out/i.test(m)) return '连接超时'
    return m
  }
  return String(e)
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

function isPrivateIp(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, '').toLowerCase()
  if (ip === '::' || ip === '::1') return true
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true
  if (ip.startsWith('::ffff:')) return isPrivateIp(ip.slice(7))
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('不允许访问本机地址')
  }
  if (isIpLiteral(host)) {
    if (isPrivateIp(host)) throw new Error('不允许访问内网地址')
    return
  }
  const addrs = await dns.lookup(host, { all: true }).catch(() => [])
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('不允许访问内网地址')
}

function parseTarget(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new Error('链接格式不正确')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http/https 链接')
  return u
}

/* ---------------- 文件名 / 类型推断 ---------------- */

/** MIME -> 可接受的扩展名；下载后按真实 MIME 纠正扩展名，避免盲信 URL 路径 */
const MIME_EXTS: Array<{ mime: string; exts: string[] }> = [
  { mime: 'image/png', exts: ['.png'] },
  { mime: 'image/jpeg', exts: ['.jpg', '.jpeg'] },
  { mime: 'image/gif', exts: ['.gif'] },
  { mime: 'image/webp', exts: ['.webp'] },
  { mime: 'image/bmp', exts: ['.bmp'] },
  { mime: 'image/avif', exts: ['.avif'] },
  { mime: 'image/svg+xml', exts: ['.svg'] },
  { mime: 'video/mp4', exts: ['.mp4', '.m4v'] },
  { mime: 'video/quicktime', exts: ['.mov'] },
  { mime: 'video/webm', exts: ['.webm'] },
  { mime: 'video/x-matroska', exts: ['.mkv'] },
  { mime: 'audio/mpeg', exts: ['.mp3'] },
  { mime: 'audio/wav', exts: ['.wav'] },
  { mime: 'audio/x-wav', exts: ['.wav'] },
  { mime: 'audio/mp4', exts: ['.m4a'] },
  { mime: 'application/pdf', exts: ['.pdf'] },
  { mime: 'application/zip', exts: ['.zip'] },
  { mime: 'application/x-zip-compressed', exts: ['.zip'] },
  { mime: 'application/x-rar-compressed', exts: ['.rar'] },
  { mime: 'application/vnd.rar', exts: ['.rar'] },
  { mime: 'application/x-7z-compressed', exts: ['.7z'] },
  { mime: 'application/gzip', exts: ['.gz'] },
  { mime: 'application/x-tar', exts: ['.tar'] },
  { mime: 'application/msword', exts: ['.doc'] },
  { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', exts: ['.docx'] },
  { mime: 'application/vnd.ms-excel', exts: ['.xls'] },
  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', exts: ['.xlsx'] },
  { mime: 'application/vnd.ms-powerpoint', exts: ['.ppt'] },
  { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', exts: ['.pptx'] },
  { mime: 'text/plain', exts: ['.txt'] },
  { mime: 'text/csv', exts: ['.csv'] },
  { mime: 'text/markdown', exts: ['.md'] },
  { mime: 'application/json', exts: ['.json'] }
]

function extsOfMime(mime: string): string[] {
  return MIME_EXTS.find((m) => m.mime === mime)?.exts ?? []
}

function sanitizeName(raw: string): string {
  let name = raw
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
  if (!name) name = `file-${Date.now()}`
  if (name.length > 120) {
    const ext = path.extname(name)
    name = name.slice(0, Math.max(1, 120 - ext.length)) + ext
  }
  return name
}

function filenameFromDisposition(cd: string | null): string | null {
  if (!cd) return null
  const star = cd.match(/filename\*\s*=\s*([^;]+)/i)
  if (star) {
    const v = star[1].trim().replace(/^"|"$/g, '')
    const m = v.match(/^([^']*)'[^']*'(.*)$/)
    const encoded = m ? m[2] : v
    try {
      return decodeURIComponent(encoded)
    } catch {
      return encoded
    }
  }
  const quoted = cd.match(/filename\s*=\s*"([^"]*)"/i)
  if (quoted) return quoted[1]
  const plain = cd.match(/filename\s*=\s*([^;]+)/i)
  return plain ? plain[1].trim() : null
}

function nameFromUrl(u: URL): string {
  const seg = u.pathname.split('/').filter(Boolean).pop() ?? ''
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

/** Content-Disposition / URL 名 + 真实 MIME 综合定名，MIME 与扩展名冲突时以 MIME 为准 */
function finalizeName(raw: string, mime: string): string {
  let name = sanitizeName(raw)
  const exts = extsOfMime(mime)
  if (!exts.length) return name
  const ext = path.extname(name).toLowerCase()
  if (!ext) return name + exts[0]
  if (!exts.includes(ext)) return name.slice(0, name.length - ext.length) + exts[0]
  return name
}

async function uniqueFilePath(dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename)
  const stem = path.basename(filename, ext)
  let p = path.join(dir, filename)
  let n = 1
  while (fs.existsSync(p)) {
    p = path.join(dir, `${stem}-${n++}${ext}`)
  }
  return p
}

/* ---------------- 页面注入表达式 ---------------- */

const FIND_FILE_INPUT = `(() => {
  const list = Array.from(document.querySelectorAll('input[type="file"]'));
  return list.find((n) => !n.disabled) || null;
})()`

/** 定位并点击附件按钮；返回命中的选择器与节点信息，便于诊断 */
const CLICK_UPLOAD = `(() => {
  const sels = [
    '[data-testid*="upload"]',
    '[data-testid*="attach"]',
    'button[aria-label*="上传"]',
    '[role="button"][aria-label*="上传"]',
    'button[aria-label*="附件"]',
    '[role="button"][aria-label*="附件"]',
    'button[title*="上传"]',
    'button[title*="附件"]'
  ];
  for (const s of sels) {
    const nodes = Array.from(document.querySelectorAll(s));
    const el = nodes.find((n) => {
      const tid = n.getAttribute('data-testid') || '';
      return tid !== 'chat_input_input' && !tid.includes('attachment_file_item');
    });
    if (el && typeof el.click === 'function') {
      el.click();
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      return {
        selector: s,
        tag: el.tagName.toLowerCase(),
        testid: el.getAttribute('data-testid'),
        aria: el.getAttribute('aria-label'),
        title: el.getAttribute('title'),
        rect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
        html: (el.outerHTML || '').slice(0, 300)
      };
    }
  }
  return null;
})()`

/** 兜底：向 tiptap 编辑器合成 paste / drop 事件，并回传完整诊断信息 */
const PASTE_INTO_EDITOR = `async (filename, mime, b64) => {
  const container = document.querySelector('[data-testid="chat_input_input"]');
  // 关键：ProseMirror 的事件监听挂在真正的 contenteditable 根节点 .ProseMirror 上，
  // chat_input_input 只是外层容器，事件不会向下冒泡到编辑器，必须直接派发到根节点
  const editor = document.querySelector('.tiptap.ProseMirror')
    || (container ? container.querySelector('[contenteditable="true"]') : null)
    || container;
  if (!editor) return { status: 'no-editor' };
  try { editor.focus(); } catch (e) { /* ignore */ }
  try {
    // 真实附件节点：attachment_area / attachment-video-card / attachment-delete-btn。
    // attachment_file_item 是旧版结构，线上页面已不再使用，仅作兼容保留。
    const signal = () => {
      const q = (s) => document.querySelectorAll(s).length;
      return {
        fileItem: q('[data-testid="attachment_file_item"]'),
        area: q('[data-testid="attachment_area"]'),
        videoCard: q('[data-testid*="attachment-video-card"]'),
        imageCard: q('[data-testid*="attachment-image-card"]'),
        fileCard: q('[data-testid*="attachment-file-card"]'),
        deleteBtn: q('[data-testid="attachment-delete-btn"]'),
        uploading: q('[data-testid*="upload-progress"], [data-testid*="uploading"], [data-testid*="attachment_loading"], [class*="uploading"]')
      };
    };
    const attached = (s, b) => s.fileItem > b.fileItem || s.area > b.area
      || s.videoCard > b.videoCard || s.imageCard > b.imageCard
      || s.fileCard > b.fileCard || s.deleteBtn > b.deleteBtn
      || s.uploading > b.uploading;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitSignal = async (baseline, deadline) => {
      let state = signal();
      while (!attached(state, baseline) && Date.now() < deadline) {
        await sleep(100);
        state = signal();
      }
      return { hit: attached(state, baseline), state: state };
    };
    const attachNodes = () => Array.from(document.querySelectorAll('[data-testid*="attach"]'))
      .map((n) => n.getAttribute('data-testid')).slice(0, 20);
    const before = signal();
    const active = document.activeElement;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], filename, { type: mime || 'application/octet-stream' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const diag = {
      editorTag: editor.tagName.toLowerCase(),
      editorCls: (editor.getAttribute('class') || '').slice(0, 120),
      editorIsProseMirror: editor.classList.contains('ProseMirror'),
      editorContentEditable: !!editor.isContentEditable,
      editorTextBefore: (editor.textContent || '').slice(0, 200),
      activeIsEditor: !!active && (active === editor || editor.contains(active)),
      activeDesc: active ? ((active.tagName || '') + ' ' + (active.getAttribute('data-testid') || '') + ' ' + (active.getAttribute('class') || '')).slice(0, 160) : '',
      fileSize: file.size,
      fileType: file.type,
      dtItems: dt.items.length,
      signalsBefore: before,
      attachNodesBefore: attachNodes()
    };
    editor.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true, cancelable: true, clipboardData: dt
    }));
    // 上传中可能只有 loading/进度节点，给足 2s 观察窗口再判断是否需要 drop 兜底
    let result = await waitSignal(before, Date.now() + 2000);
    let via = result.hit ? 'paste' : '';
    if (!result.hit) {
      editor.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: dt
      }));
      result = await waitSignal(before, Date.now() + 3000);
      via = result.hit ? 'drop' : '';
    }
    return Object.assign({}, diag, {
      status: result.hit ? 'ok' : 'no-effect',
      via: via || 'none',
      signalsAfter: result.state,
      attachNodesAfter: attachNodes(),
      editorTextAfter: (editor.textContent || '').slice(0, 200)
    });
  } catch (e) {
    return { status: 'error', error: String(e) };
  }
}`

/** 页面结构快照：file input、附件按钮候选、编辑器容器、附件条目与全量 testid 计数 */
const SNAPSHOT_JS = `(() => {
  const slice = (s, n) => (s || '').replace(/\\s+/g, ' ').slice(0, n);
  const short = (el, n) => { try { return slice(el.outerHTML || '', n) } catch (e) { return '' } };
  const rect = (el) => { try { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] } catch (e) { return null } };
  const attr = (el, k) => el.getAttribute(k);
  const base = (el) => ({
    tag: el.tagName ? el.tagName.toLowerCase() : '',
    testid: attr(el, 'data-testid'),
    aria: attr(el, 'aria-label'),
    title: attr(el, 'title'),
    cls: slice(attr(el, 'class'), 100),
    rect: rect(el)
  });
  const editor = document.querySelector('[data-testid="chat_input_input"]') || document.querySelector('.tiptap.ProseMirror');
  const composer = editor ? (editor.closest('form') || (editor.parentElement && editor.parentElement.parentElement && editor.parentElement.parentElement.parentElement) || null) : null;
  const inComposer = (el) => !!(composer && composer.contains(el));
  const chain = (el, n) => {
    const out = []; let p = el;
    for (let i = 0; p && i < n; i++) { out.push(base(p)); p = p.parentElement }
    return out;
  };
  const inputs = Array.from(document.querySelectorAll('input[type="file"]')).map((el) => ({
    tag: 'input',
    type: attr(el, 'type'),
    accept: attr(el, 'accept'),
    multiple: el.hasAttribute('multiple'),
    hidden: el.hasAttribute('hidden'),
    disabled: !!el.disabled,
    style: slice(attr(el, 'style'), 120),
    testid: attr(el, 'data-testid'),
    aria: attr(el, 'aria-label'),
    title: attr(el, 'title'),
    cls: slice(attr(el, 'class'), 100),
    rect: rect(el),
    files: el.files ? el.files.length : -1,
    fileNames: el.files ? Array.from(el.files).map((f) => f.name + ':' + f.size + ':' + f.type) : [],
    inEditor: !!(editor && editor.contains(el)),
    inComposer: inComposer(el),
    nearestInteractive: (() => { const p = el.closest('button, [role="button"], label, form, [data-testid]'); return p ? base(p) : null })(),
    ancestors: chain(el.parentElement, 4),
    html: short(el, 600)
  }));

  const kw = /attach|upload|\\u9644\\u4ef6|\\u4e0a\\u4f20/i;
  const candidates = [];
  for (const el of document.querySelectorAll('[data-testid], [aria-label], [title]')) {
    const label = [attr(el, 'data-testid'), attr(el, 'aria-label'), attr(el, 'title')].filter(Boolean).join(' | ');
    if (!label || !kw.test(label)) continue;
    candidates.push(Object.assign({}, base(el), {
      label: label,
      text: slice(el.textContent, 60),
      inComposer: inComposer(el),
      html: short(el, 300),
      parentHtml: el.parentElement ? short(el.parentElement, 500) : ''
    }));
    if (candidates.length >= 30) break;
  }

  const composerButtons = composer ? Array.from(composer.querySelectorAll('button, [role="button"]')).slice(0, 30).map((el) => Object.assign({}, base(el), {
    text: slice(el.textContent, 60),
    html: short(el, 240)
  })) : [];

  const items = Array.from(document.querySelectorAll('[data-testid="attachment_file_item"]')).map((el) => ({ html: short(el, 500), text: slice(el.textContent, 160) }));
  const attachNodes = Array.from(document.querySelectorAll('[data-testid*="attach"]')).slice(0, 20).map((el) => ({ testid: attr(el, 'data-testid'), text: slice(el.textContent, 120) }));
  const messageAreas = Array.from(document.querySelectorAll('[data-testid*="message"], [class*="message-list"], [class*="messageList"]')).slice(0, 10).map((el) => ({
    testid: attr(el, 'data-testid'),
    cls: slice(attr(el, 'class'), 100),
    childCount: el.childElementCount,
    textLen: (el.textContent || '').length,
    tail: slice((el.textContent || '').slice(-200), 200)
  }));

  const testids = {};
  for (const el of document.querySelectorAll('[data-testid]')) {
    const t = attr(el, 'data-testid');
    if (t) testids[t] = (testids[t] || 0) + 1;
  }

  const active = document.activeElement;
  return {
    at: new Date().toISOString(),
    url: location.href,
    readyState: document.readyState,
    viewport: [innerWidth, innerHeight],
    activeElement: active ? Object.assign({}, base(active), { isEditor: !!(editor && (editor === active || editor.contains(active))) }) : null,
    editor: editor ? Object.assign({}, base(editor), {
      childCount: editor.childElementCount,
      text: slice(editor.textContent, 200),
      ancestors: chain(editor.parentElement, 6)
    }) : null,
    composerHtml: composer ? short(composer, 1500) : '',
    inputs: inputs,
    candidates: candidates,
    composerButtons: composerButtons,
    attachmentItems: items,
    attachNodes: attachNodes,
    messageAreas: messageAreas,
    testids: Object.entries(testids).sort((a, b) => b[1] - a[1]).slice(0, 60)
  };
})()`

interface DownloadedFile {
  path: string
  filename: string
  mime: string
  size: number
}

interface Job {
  ac: AbortController
  cancelled: boolean
}

interface NewTaskState {
  editorReady: boolean
  path: string
  pathIsNew: boolean
  hasText: boolean
  hasAttachment: boolean
  href: string
}

interface NewTaskCandidate {
  tag: string
  testid: string | null
  aria: string | null
  title: string | null
  text: string
  hit: string
  x: number
  y: number
  disabled: boolean
  html: string
}

/** 当前页面是否已处于「新工作任务」状态，以及编辑器是否就绪 */
const NEW_TASK_STATE = `(() => {
  const editor = document.querySelector('.tiptap.ProseMirror')
    || document.querySelector('[data-testid="chat_input_input"] [contenteditable="true"]');
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 };
  const path = location.pathname.replace(/\\/+$/, '');
  const guide = document.querySelector('[data-testid="flow_chat_guidance_page"]');
  const guideVisible = !!guide && guide.getBoundingClientRect().width > 0;
  return {
    editorReady: !!editor && !!editor.isContentEditable && visible(editor),
    path: location.pathname,
    pathIsNew: path === '/chat' || guideVisible,
    hasText: !!(editor && (editor.textContent || '').trim().length),
    hasAttachment: !!document.querySelector('[data-testid="attachment_area"], [data-testid="attachment_file_item"]'),
    href: location.href
  };
})()`

/** 按可见文案「新工作任务」定位按钮，data-testid 只作兜底；返回可见候选与点击坐标 */
const FIND_NEW_TASK = `(() => {
  const target = '新工作任务';
  const norm = (s) => (s || '').replace(/\\s+/g, '');
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 };
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll('button, [role="button"], a, [data-testid]')) {
    if (seen.has(el)) continue;
    const testid = el.getAttribute('data-testid') || '';
    const aria = el.getAttribute('aria-label');
    const title = el.getAttribute('title');
    const text = norm(el.textContent);
    const byLabel = norm(aria) === target || norm(title) === target;
    const byText = text.includes(target) && text.length <= target.length + 8;
    const byTid = /new[-_]?task|new[-_]?chat/i.test(testid);
    if (!byLabel && !byText && !byTid) continue;
    seen.add(el);
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    out.push({
      tag: el.tagName.toLowerCase(), testid: testid, aria: aria, title: title,
      text: text.slice(0, 24),
      hit: byLabel ? 'label' : byText ? 'text' : 'testid',
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      html: (el.outerHTML || '').slice(0, 240)
    });
  }
  const rank = { label: 0, text: 1, testid: 2 };
  out.sort((a, b) => rank[a.hit] - rank[b.hit]);
  return out;
})()`

/** 找不到按钮时 dump 可见按钮，便于确认真实文案与 testid */
const DUMP_BUTTONS = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('button, [role="button"], a, [data-testid]')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    const testid = el.getAttribute('data-testid');
    const aria = el.getAttribute('aria-label');
    const title = el.getAttribute('title');
    if (!testid && !aria && !title && !text) continue;
    out.push({ tag: el.tagName.toLowerCase(), testid: testid, aria: aria, title: title, text: text });
    if (out.length >= 60) break;
  }
  return out;
})()`

/** 点击「新工作任务」后等待任务页输入区就绪的超时 */
const NEW_TASK_TIMEOUT = 10_000

export class AttachmentManager {
  private push: PushFn
  private getView: (accountId: string) => WebContents | null
  private jobs = new Map<string, Job>()
  private logFile: string

  constructor(push: PushFn, getView: (accountId: string) => WebContents | null, userDataDir: string) {
    this.push = push
    this.getView = getView
    this.logFile = path.join(userDataDir, 'attach-debug.log')
  }

  /** 追加诊断日志；单文件超过 2MB 时滚动为 attach-debug.log.1，只保留一份历史 */
  private dlog(jobId: string, accountId: string, msg: string): void {
    try {
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > MAX_LOG_BYTES) {
        const rotated = `${this.logFile}.1`
        try {
          fs.rmSync(rotated, { force: true })
        } catch {
          // 旧历史删除失败不阻塞
        }
        fs.renameSync(this.logFile, rotated)
      }
      fs.appendFileSync(this.logFile, `${new Date().toISOString()} [${accountId}/${jobId}] ${msg}\n`)
    } catch {
      // 日志写入失败不影响同步主流程
    }
  }

  /** 取消某个账号正在进行的同步（下载阶段可中断） */
  cancel(accountId: string): boolean {
    const job = this.jobs.get(accountId)
    if (!job) return false
    job.cancelled = true
    job.ac.abort()
    return true
  }

  /**
   * 进入「新工作任务」：对话模式不支持上传文件，必须先切到任务页。
   * 已在新任务页则不重复点击，避免清空用户正在编辑的内容。
   */
  private async enterNewTask(
    wc: WebContents,
    jobId: string,
    accountId: string,
    signal: AbortSignal
  ): Promise<void> {
    const evalState = async (): Promise<NewTaskState | null> => {
      try {
        return (await wc.executeJavaScript(NEW_TASK_STATE, false)) as NewTaskState
      } catch (e) {
        this.dlog(jobId, accountId, `[new-task] state probe error: ${errMsg(e)}`)
        return null
      }
    }

    const state = await evalState()
    if (state) this.dlog(jobId, accountId, `[new-task] state ${JSON.stringify(state)}`)
    if (state && state.editorReady && state.pathIsNew) {
      this.dlog(jobId, accountId, '[new-task] already on new-task page, skip click')
      return
    }
    if (state && state.hasText) {
      this.dlog(jobId, accountId, '[new-task] current page has draft text')
    }
    if (state && !state.pathIsNew && (state.hasText || state.hasAttachment)) {
      throw new Error('未能切换到新工作任务：当前对话有未发送内容，请先发送或清空后再同步')
    }

    let candidates: NewTaskCandidate[] = []
    try {
      candidates = (await wc.executeJavaScript(FIND_NEW_TASK, false)) as NewTaskCandidate[]
    } catch (e) {
      this.dlog(jobId, accountId, `[new-task] find button error: ${errMsg(e)}`)
    }
    this.dlog(jobId, accountId, `[new-task] candidates ${JSON.stringify(candidates)}`)
    const hit = candidates.find((c) => !c.disabled)
    if (!hit) {
      try {
        const dump = await wc.executeJavaScript(DUMP_BUTTONS, false)
        this.dlog(jobId, accountId, `[new-task] button dump ${JSON.stringify(dump)}`)
      } catch {
        // ignore
      }
      throw new Error(`未能切换到新工作任务：未找到「新工作任务」按钮（诊断日志：${this.logFile}）`)
    }

    const dbg = this.debuggerFor(wc)
    let clicked = false
    if (dbg) {
      try {
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y })
        await dbg.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: hit.x,
          y: hit.y,
          button: 'left',
          buttons: 1,
          clickCount: 1
        })
        await dbg.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: hit.x,
          y: hit.y,
          button: 'left',
          buttons: 0,
          clickCount: 1
        })
        clicked = true
        this.dlog(
          jobId,
          accountId,
          `[new-task] clicked via CDP mouse at ${hit.x},${hit.y} (hit=${hit.hit})`
        )
      } catch (e) {
        this.dlog(jobId, accountId, `[new-task] CDP click error: ${errMsg(e)}`)
      }
    }
    if (!clicked) {
      // debugger 不可用时退化为页面内 click（普通按钮可用，Radix 类组件可能无效）
      try {
        const ok = await wc.executeJavaScript(
          `(() => {
            const target = '新工作任务';
            const norm = (s) => (s || '').replace(/\\s+/g, '');
            for (const el of document.querySelectorAll('button, [role="button"], a, [data-testid]')) {
              const text = norm(el.textContent);
              const testid = el.getAttribute('data-testid') || '';
              if (norm(el.getAttribute('aria-label')) === target || norm(el.getAttribute('title')) === target
                || (text.includes(target) && text.length <= target.length + 8)
                || /new[-_]?task|new[-_]?chat/i.test(testid)) {
                el.click();
                return true;
              }
            }
            return false;
          })()`,
          true
        )
        clicked = ok === true
        this.dlog(jobId, accountId, `[new-task] fallback page click => ${clicked}`)
      } catch (e) {
        this.dlog(jobId, accountId, `[new-task] fallback click error: ${errMsg(e)}`)
      }
    }

    const deadline = Date.now() + NEW_TASK_TIMEOUT
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('已取消')
      if (wc.isDestroyed()) throw new Error('账号页面已关闭，无法切换新工作任务')
      await delay(200)
      const s = await evalState()
      if (s && s.editorReady) {
        this.dlog(jobId, accountId, `[new-task] editor ready at ${s.path}`)
        return
      }
    }
    throw new Error(
      `未能切换到新工作任务：等待任务页输入区就绪超时（诊断日志：${this.logFile}）`
    )
  }

  /**
   * 完整流程：校验链接 -> 切新工作任务 -> 流式下载到临时文件 -> 注入当前可见的对话页输入框。
   * 只接受当前激活账号的可见视图，不使用隐藏临时视图。
   */
  async attachFromUrl(accountId: string, rawUrl: string): Promise<{ ok: boolean; reason?: string }> {
    const jobId = `at_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    let safeUrl = rawUrl
    try {
      const u = new URL(rawUrl)
      safeUrl = u.origin + u.pathname
    } catch {
      // ignore
    }
    this.dlog(jobId, accountId, `=== attach start url=${safeUrl} ===`)
    const fail = (reason: string, filePath?: string): { ok: false; reason: string } => {
      this.push('attach:event', {
        id: jobId,
        accountId,
        status: 'failed',
        reason,
        filePath
      } satisfies AttachEvent)
      return { ok: false, reason }
    }

    if (this.jobs.has(accountId)) return fail('该账号正在同步文件，请稍候')
    const wc = this.getView(accountId)
    if (!wc || wc.isDestroyed()) return fail('请先打开并切换到该账号的标签页')

    let url: URL
    try {
      url = parseTarget(rawUrl)
      await assertPublicHost(url.hostname)
    } catch (e) {
      return fail(errMsg(e))
    }

    const ac = new AbortController()
    const job: Job = { ac, cancelled: false }
    this.jobs.set(accountId, job)
    const timer = setTimeout(() => ac.abort(), OVERALL_TIMEOUT)

    let downloaded: DownloadedFile | null = null
    try {
      // 顺序要求：先切到新工作任务并等输入区就绪，再下载，最后注入
      this.push('attach:event', {
        id: jobId,
        accountId,
        status: 'switching',
        filename: '新工作任务'
      } satisfies AttachEvent)
      await this.enterNewTask(wc, jobId, accountId, ac.signal)
      downloaded = await this.download(url, accountId, jobId, ac.signal)
      this.dlog(
        jobId,
        accountId,
        `downloaded path=${downloaded.path} size=${downloaded.size} mime=${downloaded.mime}`
      )
      if (wc.isDestroyed()) throw new Error('账号页面已关闭，无法注入')

      this.push('attach:event', {
        id: jobId,
        accountId,
        status: 'injecting',
        filename: downloaded.filename
      } satisfies AttachEvent)

      await this.inject(wc, downloaded, jobId, accountId)
      // 注入成功也不能立刻删除：Chromium 在真正上传读取时才打开文件
      this.scheduleCleanup(downloaded.path, wc, KEEP_MS)
      this.push('attach:event', {
        id: jobId,
        accountId,
        status: 'done',
        filename: downloaded.filename
      } satisfies AttachEvent)
      return { ok: true }
    } catch (e) {
      const msg = job.cancelled
        ? '已取消'
        : ac.signal.aborted
          ? `下载超时（超过 ${Math.round(OVERALL_TIMEOUT / 60_000)} 分钟）`
          : errMsg(e)
      if (downloaded) {
        this.scheduleCleanup(downloaded.path, wc, 30 * 60_000)
        this.dlog(jobId, accountId, `FAILED: ${msg} (file kept: ${downloaded.path})`)
        return fail(`${msg}（文件已保留：${downloaded.path}）`, downloaded.path)
      }
      this.dlog(jobId, accountId, `FAILED: ${msg}`)
      return fail(msg)
    } finally {
      clearTimeout(timer)
      this.jobs.delete(accountId)
    }
  }

  /* ---------------- 下载 ---------------- */

  private async download(
    start: URL,
    accountId: string,
    jobId: string,
    signal: AbortSignal
  ): Promise<DownloadedFile> {
    let current = start
    let res: Response | null = null

    // 手动跟随重定向：每一跳都重新做公网校验，避免重定向到内网
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      await assertPublicHost(current.hostname)
      res = await net.fetch(current.toString(), { signal, redirect: 'manual' })
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location')
        void res.body?.cancel().catch(() => {})
        if (!loc) throw new Error('重定向响应缺少 Location')
        current = new URL(loc, current)
        if (current.protocol !== 'http:' && current.protocol !== 'https:') {
          throw new Error('重定向到了不受支持的协议')
        }
        continue
      }
      break
    }

    if (!res) throw new Error('请求失败')
    if ([301, 302, 303, 307, 308].includes(res.status)) throw new Error('重定向次数过多')
    if (!res.ok) throw new Error(`服务器返回 ${res.status}${res.statusText ? ' ' + res.statusText : ''}`)
    if (!res.body) throw new Error('服务器响应无内容')

    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const total = Number(res.headers.get('content-length') ?? 0) || 0
    if (total > MAX_BYTES) throw new Error(`文件大小超过上限 ${fmtBytes(MAX_BYTES)}`)

    const rawName =
      filenameFromDisposition(res.headers.get('content-disposition')) ||
      nameFromUrl(current) ||
      `file-${Date.now()}`
    const filename = finalizeName(rawName, mime)

    const dir = path.join(app.getPath('temp'), 'doubao-attach', accountId)
    await fsp.mkdir(dir, { recursive: true })
    const filePath = await uniqueFilePath(dir, filename)
    const finalName = path.basename(filePath)

    this.push('attach:event', {
      id: jobId,
      accountId,
      status: 'downloading',
      filename: finalName,
      received: 0,
      total
    } satisfies AttachEvent)

    let received = 0
    let lastPush = 0
    const emitProgress = (n: number): void => {
      this.push('attach:event', {
        id: jobId,
        accountId,
        status: 'downloading',
        filename: finalName,
        received: n,
        total
      } satisfies AttachEvent)
    }
    const counter = new Transform({
      transform(
        chunk: Buffer,
        _enc: BufferEncoding,
        cb: (error?: Error | null, data?: Buffer) => void
      ): void {
        received += chunk.length
        if (received > MAX_BYTES) {
          cb(new Error(`文件大小超过上限 ${fmtBytes(MAX_BYTES)}`))
          return
        }
        const now = Date.now()
        if (now - lastPush >= 250) {
          lastPush = now
          emitProgress(received)
        }
        cb(null, chunk)
      }
    })

    try {
      await pipeline(
        Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
        counter,
        fs.createWriteStream(filePath)
      )
    } catch (e) {
      await fsp.unlink(filePath).catch(() => {})
      throw e
    }

    const stat = await fsp.stat(filePath)
    if (!stat.size) {
      await fsp.unlink(filePath).catch(() => {})
      throw new Error('下载内容为空')
    }
    return { path: filePath, filename: finalName, mime, size: stat.size }
  }

  /* ---------------- 注入 ---------------- */

  private debuggerFor(wc: WebContents): DebuggerSession | null {
    const dbg = wc.debugger
    try {
      if (!dbg.isAttached()) dbg.attach('1.3')
      return dbg
    } catch {
      return null
    }
  }

  /**
   * 注入阶梯（本轮只加诊断，策略不变）：
   * 1. input[type=file] -> DOM.setFileInputFiles
   * 2. 点击附件按钮，等待 input / Page.fileChooserOpened
   * 3. 向 tiptap 编辑器合成 paste/drop
   * 无论成功失败都会写 attach-debug.log，并在注入后 1s/3s/8s 采样页面变化
   */
  private async inject(
    wc: WebContents,
    file: DownloadedFile,
    jobId: string,
    accountId: string
  ): Promise<void> {
    const before = await this.snapshot(wc, jobId, accountId, 'before-inject')
    if (before) {
      this.dlog(
        jobId,
        accountId,
        `[inject] precheck inputs=${((before['inputs'] as unknown[]) ?? []).length} candidates=${
          ((before['candidates'] as unknown[]) ?? []).length
        } composerButtons=${((before['composerButtons'] as unknown[]) ?? []).length} editor=${
          before['editor'] ? 'yes' : 'no'
        } attachments=${((before['attachmentItems'] as unknown[]) ?? []).length}`
      )
    }

    let mode = ''
    const dbg = this.debuggerFor(wc)
    this.dlog(jobId, accountId, `[inject] debugger=${dbg ? 'ready' : 'unavailable'}`)
    try {
      if (dbg) {
        const objectId = await this.findFileInput(dbg)
        if (objectId) {
          this.dlog(
            jobId,
            accountId,
            `[inject] picked input: ${JSON.stringify(await this.describeNode(dbg, objectId))}`
          )
          const ok = await this.setFiles(dbg, { objectId }, file.path)
          this.dlog(jobId, accountId, `[inject] DOM.setFileInputFiles(objectId) => ${ok}`)
          if (ok) {
            await delay(200)
            this.dlog(
              jobId,
              accountId,
              `[inject] input after set: ${JSON.stringify(await this.describeNode(dbg, objectId))}`
            )
            mode = 'file-input'
          }
        } else {
          this.dlog(jobId, accountId, '[inject] no input[type=file] in document')
        }
        if (!mode && (await this.pickViaUploadButton(dbg, file.path, jobId, accountId))) {
          mode = 'picker'
        }
      }

      if (!mode) {
        const paste = await this.pasteIntoEditor(wc, file)
        this.dlog(jobId, accountId, `[inject] synthetic paste => ${JSON.stringify(paste)}`)
        if (paste.status !== 'ok') {
          const reason =
            paste.status === 'no-editor'
              ? '未找到豆包输入框，请确认当前处于对话页'
              : paste.status === 'error' || paste.status === 'too-large'
                ? `合成粘贴失败：${String(paste.error)}`
                : '合成粘贴未产生附件'
          throw new Error(`${reason}（诊断日志：${this.logFile}）`)
        }
        mode = 'paste'
      }
      this.dlog(jobId, accountId, `[inject] injected via ${mode}`)
    } finally {
      this.scheduleSnapshots(wc, jobId, accountId, mode || 'failed', before)
    }
  }

  private async findFileInput(dbg: DebuggerSession): Promise<string | null> {
    try {
      const r = (await dbg.sendCommand('Runtime.evaluate', {
        expression: FIND_FILE_INPUT,
        returnByValue: false
      })) as { result?: { objectId?: string; subtype?: string } }
      const id = r?.result?.objectId
      return r?.result?.subtype === 'null' ? null : id ?? null
    } catch {
      return null
    }
  }

  /** 描述当前选中的 input 节点（用于确认它到底属于哪个区域、是否真的被赋值） */
  private async describeNode(
    dbg: DebuggerSession,
    objectId: string
  ): Promise<Record<string, unknown> | null> {
    try {
      const r = (await dbg.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () {
          const el = this;
          const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          const editor = document.querySelector('[data-testid="chat_input_input"]') || document.querySelector('.tiptap.ProseMirror');
          const composer = editor ? (editor.closest('form') || (editor.parentElement && editor.parentElement.parentElement && editor.parentElement.parentElement.parentElement)) : null;
          const host = el.closest('button, [role="button"], label, form, [data-testid]');
          return {
            tag: el.tagName ? el.tagName.toLowerCase() : '',
            testid: el.getAttribute('data-testid'),
            accept: el.getAttribute('accept'),
            multiple: el.hasAttribute('multiple'),
            hidden: el.hasAttribute('hidden'),
            style: (el.getAttribute('style') || '').slice(0, 120),
            files: el.files ? el.files.length : -1,
            fileNames: el.files ? Array.from(el.files).map((f) => f.name + ':' + f.size + ':' + f.type) : [],
            rect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
            inEditor: !!(editor && editor.contains(el)),
            inComposer: !!(composer && composer.contains(el)),
            nearestInteractive: host ? { tag: host.tagName.toLowerCase(), testid: host.getAttribute('data-testid'), aria: host.getAttribute('aria-label'), cls: (host.getAttribute('class') || '').slice(0, 100) } : null,
            html: (el.outerHTML || '').slice(0, 600)
          };
        }`,
        returnByValue: true
      })) as { result?: { value?: unknown } }
      return (r?.result?.value as Record<string, unknown>) ?? null
    } catch {
      return null
    }
  }

  private async setFiles(
    dbg: DebuggerSession,
    target: { objectId?: string; backendNodeId?: number },
    filePath: string
  ): Promise<boolean> {
    try {
      await dbg.sendCommand('DOM.setFileInputFiles', { files: [filePath], ...target })
      return true
    } catch {
      return false
    }
  }

  private async pickViaUploadButton(
    dbg: DebuggerSession,
    filePath: string,
    jobId: string,
    accountId: string
  ): Promise<boolean> {
    const seen: { backendNodeId: number } = { backendNodeId: 0 }
    const onMessage = (
      _e: Electron.Event,
      method: string,
      params: Record<string, unknown>
    ): void => {
      if (method === 'Page.fileChooserOpened') {
        seen.backendNodeId = Number(params['backendNodeId'] ?? 0)
        this.dlog(
          jobId,
          accountId,
          `[picker] Page.fileChooserOpened backendNodeId=${seen.backendNodeId} mode=${String(
            params['mode'] ?? ''
          )}`
        )
      }
    }

    try {
      try {
        await dbg.sendCommand('Page.enable')
      } catch {
        // 已启用时可能抛错，忽略
      }
      dbg.on('message', onMessage)
      try {
        await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
      } catch (e) {
        this.dlog(jobId, accountId, `[picker] intercept enable error: ${errMsg(e)}`)
        return false
      }

      const clicked = (await dbg.sendCommand('Runtime.evaluate', {
        expression: CLICK_UPLOAD,
        returnByValue: true,
        userGesture: true
      })) as { result?: { value?: unknown } }
      const info = clicked?.result?.value as Record<string, unknown> | null | undefined
      if (!info) {
        this.dlog(jobId, accountId, '[picker] no upload candidate matched any selector')
        return false
      }
      this.dlog(jobId, accountId, `[picker] clicked candidate: ${JSON.stringify(info)}`)

      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        if (seen.backendNodeId) {
          const ok = await this.setFiles(dbg, { backendNodeId: seen.backendNodeId }, filePath)
          this.dlog(jobId, accountId, `[picker] setFiles(backendNodeId) => ${ok}`)
          if (ok) return true
        }
        const objectId = await this.findFileInput(dbg)
        if (objectId) {
          this.dlog(
            jobId,
            accountId,
            `[picker] input appeared: ${JSON.stringify(await this.describeNode(dbg, objectId))}`
          )
          const ok = await this.setFiles(dbg, { objectId }, filePath)
          this.dlog(jobId, accountId, `[picker] setFiles(objectId) => ${ok}`)
          if (ok) return true
        }
        await delay(150)
      }
      this.dlog(jobId, accountId, '[picker] timed out waiting for input/fileChooser')
      return false
    } catch (e) {
      this.dlog(jobId, accountId, `[picker] error: ${errMsg(e)}`)
      return false
    } finally {
      try {
        await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false })
      } catch {
        // ignore
      }
      try {
        dbg.off('message', onMessage)
      } catch {
        // ignore
      }
    }
  }

  private async pasteIntoEditor(
    wc: WebContents,
    file: DownloadedFile
  ): Promise<{ status: string; via?: string; error?: string; [k: string]: unknown }> {
    if (file.size > MAX_PASTE_BYTES) {
      return {
        status: 'too-large',
        error: `文件超过粘贴注入上限 ${fmtBytes(MAX_PASTE_BYTES)}`
      }
    }
    const b64 = (await fsp.readFile(file.path)).toString('base64')
    const expr = `(${PASTE_INTO_EDITOR})(${JSON.stringify(file.filename)}, ${JSON.stringify(
      file.mime || 'application/octet-stream'
    )}, ${JSON.stringify(b64)})`
    const result = (await wc.executeJavaScript(expr, true)) as unknown
    if (result && typeof result === 'object') {
      return result as { status: string; via?: string; error?: string }
    }
    return { status: String(result) }
  }

  /* ---------------- 诊断快照 ---------------- */

  private async snapshot(
    wc: WebContents,
    jobId: string,
    accountId: string,
    tag: string
  ): Promise<Record<string, unknown> | null> {
    if (wc.isDestroyed()) {
      this.dlog(jobId, accountId, `[snapshot:${tag}] skipped (view destroyed)`)
      return null
    }
    try {
      const snap = (await wc.executeJavaScript(SNAPSHOT_JS, false)) as Record<string, unknown>
      this.dlog(jobId, accountId, `[snapshot:${tag}] ${JSON.stringify(snap)}`)
      return snap
    } catch (e) {
      this.dlog(jobId, accountId, `[snapshot:${tag}] error: ${errMsg(e)}`)
      return null
    }
  }

  /** 注入后 1s / 3s / 8s 各采样一次，并对比 testid 计数变化 */
  private scheduleSnapshots(
    wc: WebContents,
    jobId: string,
    accountId: string,
    mode: string,
    before: Record<string, unknown> | null
  ): void {
    for (const ms of [1000, 3000, 8000]) {
      const timer = setTimeout(() => {
        void (async () => {
          const snap = await this.snapshot(wc, jobId, accountId, `${mode}+${ms}ms`)
          if (snap) this.logDiff(jobId, accountId, ms, before, snap)
        })()
      }, ms)
      timer.unref?.()
    }
  }

  private logDiff(
    jobId: string,
    accountId: string,
    ms: number,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>
  ): void {
    const toMap = (snap: Record<string, unknown> | null): Map<string, number> => {
      const list = (snap?.['testids'] as [string, number][] | undefined) ?? []
      return new Map(list)
    }
    const b = toMap(before)
    const a = toMap(after)
    const changes: string[] = []
    for (const [k, v] of a) {
      const old = b.get(k) ?? 0
      if (v !== old) changes.push(`${k}: ${old}->${v}`)
    }
    for (const [k, v] of b) if (!a.has(k)) changes.push(`${k}: ${v}->0`)
    const countOf = (snap: Record<string, unknown> | null, key: string): number =>
      ((snap?.[key] as unknown[] | undefined) ?? []).length
    this.dlog(
      jobId,
      accountId,
      `[diff:${ms}ms] attachments ${countOf(before, 'attachmentItems')}->${countOf(
        after,
        'attachmentItems'
      )} attachNodes ${countOf(before, 'attachNodes')}->${countOf(after, 'attachNodes')} inputs ${countOf(
        before,
        'inputs'
      )}->${countOf(after, 'inputs')} messageAreas ${countOf(
        before,
        'messageAreas'
      )}->${countOf(after, 'messageAreas')} testidChanges=${
        changes.slice(0, 40).join('; ') || 'none'
      }`
    )
  }

  /** 延迟清理临时文件：上传读取/视图销毁/超时任一条件到达后删除 */
  private scheduleCleanup(filePath: string, wc: WebContents, ttl: number): void {
    const remove = (): void => {
      void fsp.unlink(filePath).catch(() => {})
    }
    const timer = setTimeout(remove, ttl)
    timer.unref?.()
    try {
      wc.once('destroyed', () => {
        clearTimeout(timer)
        remove()
      })
    } catch {
      // ignore
    }
  }
}
