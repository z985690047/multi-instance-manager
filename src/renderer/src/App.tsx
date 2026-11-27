import { useEffect, useMemo, useRef, useState } from 'react'
import type { Account, ArtifactItem, AttachEvent, DownloadEvent, Presence, TabInfo } from './env.d'

const PRESENCE_META: Record<Presence, { label: string; className: string }> = {
  logged: { label: '已登录', className: 'ok' },
  guest: { label: '未登录', className: 'off' },
  expired: { label: '已过期', className: 'warn' },
  unknown: { label: '检测中', className: 'off' }
}

function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

function Avatar({ name, color, size = 26 }: { name: string; color: string; size?: number }) {
  return (
    <span className="avatar" style={{ background: color, width: size, height: size, fontSize: size * 0.46 }}>
      {name.slice(0, 1)}
    </span>
  )
}

/**
 * 无 cover_url 的视频封面：用 video 元素自身取首帧。
 * preload=metadata 只加载头部，seek 到极小时刻触发解码一帧，不会下载完整文件；
 * 失败（编解码不支持、跨域受限等）退回文件名占位。
 */
function VideoThumb({ src, name, onOpen }: { src: string; name: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false)
  const [ready, setReady] = useState(false)
  const settled = useRef(false)

  useEffect(() => {
    if (ready || failed) return
    const timer = window.setTimeout(() => {
      if (!settled.current) setFailed(true)
    }, 8000)
    return () => window.clearTimeout(timer)
  }, [ready, failed])

  const markReady = (): void => {
    if (settled.current) return
    settled.current = true
    setReady(true)
  }

  return (
    <div className="art-thumb video" onClick={onOpen}>
      {failed ? (
        <span className="vname">{name}</span>
      ) : (
        <video
          className="art-cover"
          src={src}
          preload="metadata"
          muted
          playsInline
          style={{ opacity: ready ? 1 : 0 }}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget
            // 定位到 0：30fps 下 0.1s 已经是第 3 帧
            try {
              v.currentTime = 0
            } catch {
              // ignore
            }
            // 部分浏览器在 currentTime 已是 0 时不触发 seeked，用 0.001s 兜底，
            // 仍在第一帧时长内，关键帧对齐后依旧解码第 1 帧
            window.setTimeout(() => {
              if (settled.current) return
              try {
                v.currentTime = 0.001
              } catch {
                // ignore
              }
            }, 120)
          }}
          onSeeked={markReady}
          onError={() => setFailed(true)}
        />
      )}
      <span className="play">▶</span>
    </div>
  )
}

export default function App() {
  const api = window.api
  const isMac = api.platform === 'darwin'

  const [accounts, setAccounts] = useState<Account[]>([])
  const [tabs, setTabs] = useState<TabInfo['tabs']>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [presence, setPresence] = useState<Record<string, Presence>>({})
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [downloads, setDownloads] = useState<DownloadEvent[]>([])
  const [attaches, setAttaches] = useState<AttachEvent[]>([])
  const [syncOpen, setSyncOpen] = useState(false)
  const [syncUrl, setSyncUrl] = useState('')
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([])
  const [panelOpen, setPanelOpen] = useState(true)
  const [artFilter, setArtFilter] = useState<string>('all')
  const [panelTab, setPanelTab] = useState<'preview' | 'artifacts'>('artifacts')
  const [pvItem, setPvItem] = useState<ArtifactItem | null>(null)
  const [pvZoom, setPvZoom] = useState(75)
  const [panelW, setPanelW] = useState(355)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const viewRef = useRef<HTMLDivElement>(null)

  // 拖拽面板左边缘调整宽度
  const startResize = (e: React.MouseEvent): void => {
    dragRef.current = { startX: e.clientX, startW: panelW }
    document.body.style.cursor = 'col-resize'
    e.preventDefault()
  }

  useEffect(() => {
    const move = (e: MouseEvent): void => {
      if (!dragRef.current) return
      const w = dragRef.current.startW - (e.clientX - dragRef.current.startX)
      setPanelW(Math.min(560, Math.max(200, w)))
    }
    const up = (): void => {
      dragRef.current = null
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

  // 点击产物 → 切到预览 tab 并居中展示
  const openPreview = (a: ArtifactItem): void => {
    setPvItem(a)
    setPvZoom(75)
    setPanelTab('preview')
  }
  const pvIdx = artifacts.findIndex((x) => x.id === pvItem?.id)

  useEffect(() => {
    api.listAccounts().then(setAccounts)
    api.listArtifacts().then(setArtifacts)
    api.getTabs().then((t) => {
      setTabs(t.tabs)
      setActiveId(t.activeId)
    })
    const offA = api.onAccounts((d) => setAccounts(d as Account[]))
    const offArt = api.onArtifactEvent((raw) => {
      const item = raw as ArtifactItem
      setArtifacts((prev) => (prev.some((x) => x.id === item.id) ? prev : [item, ...prev]))
    })
    const offArtU = api.onArtifactUpdate((raw) => {
      const item = raw as ArtifactItem
      setArtifacts((prev) => prev.map((x) => (x.id === item.id ? item : x)))
    })
    const offArtC = api.onArtifactCleared(() => setArtifacts([]))
    const offT = api.onTabs((d) => {
      const t = d as TabInfo
      setTabs(t.tabs)
      setActiveId(t.activeId)
    })
    const offP = api.onPresence((d) => setPresence(d as Record<string, Presence>))
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const offAt = api.onAttach((ev) => {
      setAttaches((prev) => {
        const idx = prev.findIndex((x) => x.id === ev.id)
        if (idx === -1) return [...prev, ev]
        const next = [...prev]
        next[idx] = ev
        return next
      })
      if (ev.status === 'done' || ev.status === 'failed') {
        const t = setTimeout(() => {
          setAttaches((prev) => prev.filter((x) => x.id !== ev.id))
          timers.delete(t)
        }, ev.status === 'done' ? 6000 : 12000)
        timers.add(t)
      }
    })
    const offD = api.onDownload((raw) => {
      const ev = raw as DownloadEvent
      setDownloads((prev) => {
        const idx = prev.findIndex((t) => t.savePath === ev.savePath)
        if (idx === -1) return [...prev, ev]
        const next = [...prev]
        next[idx] = ev
        return next
      })
      if (ev.status === 'done' || ev.status === 'failed') {
        const t = setTimeout(() => {
          setDownloads((prev) => prev.filter((x) => x.savePath !== ev.savePath))
          timers.delete(t)
        }, ev.status === 'done' ? 6000 : 9000)
        timers.add(t)
      }
    })

    const ro = new ResizeObserver(() => {
      const el = viewRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      api.setBounds({ x: r.x, y: r.y, width: r.width, height: r.height })
    })
    if (viewRef.current) ro.observe(viewRef.current)

    return () => {
      offA()
      offT()
      offP()
      offD()
      offArt()
      offArtU()
      offArtC()
      offAt()
      timers.forEach(clearTimeout)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase()
    const list = kw ? accounts.filter((a) => a.name.toLowerCase().includes(kw)) : accounts
    return [...list].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }, [accounts, search])

  const openCount = tabs.length
  const loggedCount = accounts.filter((a) => presence[a.id] === 'logged').length
  const accMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const artList = useMemo(
    () => (artFilter === 'all' ? artifacts : artifacts.filter((a) => a.accountId === artFilter)),
    [artifacts, artFilter]
  )

  // 调试用：产物面板每次变化都在 DevTools 控制台打印一次完整数据，便于核对字段
  useEffect(() => {
    const list = artifacts
    console.log(`[产物面板] 列表变化 ${list.length} 条`, list)
    console.table(
      list.map((a) => ({
        id: a.id,
        账号: accMap.get(a.accountId)?.name ?? a.accountId,
        accountId: a.accountId,
        kind: a.kind,
        文件名: a.filename,
        大小: a.size,
        时间: new Date(a.time).toLocaleString(),
        convId: a.convId ?? '',
        prompt: a.prompt ?? '',
        thumb: a.thumb ? `${a.thumb.length} chars` : '',
        thumbSrc: a.thumbSrc ?? '',
        url: a.url
      }))
    )
  }, [artifacts, accMap])

  // 当前账号正在同步的任务：标题栏按钮同步显示进度，避免面板收起时看不到反馈
  const syncJob = attaches.find(
    (a) =>
      a.accountId === activeId &&
      (a.status === 'switching' || a.status === 'downloading' || a.status === 'injecting')
  )
  const syncLabel = syncJob
    ? syncJob.status === 'switching'
      ? '切换中…'
      : syncJob.status === 'injecting'
        ? '送入中…'
        : syncJob.total
          ? `同步中 ${Math.round(((syncJob.received ?? 0) / syncJob.total) * 100)}%`
          : '下载中…'
    : '同步文件'

  const fmtTime = (t: number): string => {
    const d = new Date(t)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}`
  }

  const submitSync = async (): Promise<void> => {
    const url = syncUrl.trim()
    if (!url || !activeId) return
    const accountId = activeId
    setSyncOpen(false)
    setSyncUrl('')
    await api.attachFromUrl(accountId, url)
  }

  const handleAdd = async (): Promise<void> => {
    if (!newName.trim()) {
      setAdding(false)
      return
    }
    await api.addAccount(newName)
    setNewName('')
    setAdding(false)
  }

  const handleRename = async (id: string): Promise<void> => {
    if (editName.trim()) await api.renameAccount(id, editName)
    setEditingId(null)
  }

  const handleDelete = async (a: Account): Promise<void> => {
    if (window.confirm(`确定删除账号「${a.name}」？\n该账号的登录数据将一并清除，且不可恢复。`)) {
      await api.deleteAccount(a.id)
    }
  }

  return (
    <div className="app">
      {/* 顶部：标签页栏 + 窗口控制 */}
      <header className={`titlebar ${isMac ? '' : 'win'}`}>
        {!isMac && <div className="app-title">豆包多开管理器</div>}
        <div className="tabstrip">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`tab ${t.id === activeId ? 'active' : ''}`}
              onClick={() => api.openAccount(t.id)}
              title={t.name}
            >
              <span className="tab-dot" style={{ background: t.color }} />
              <span className="tab-name">{t.name}</span>
              <span
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  api.closeTab(t.id)
                }}
              >
                ×
              </span>
            </div>
          ))}
        </div>
        {syncOpen && (
          <form
            className="sync-form"
            onSubmit={(e) => {
              e.preventDefault()
              void submitSync()
            }}
          >
            <input
              autoFocus
              placeholder="粘贴文件直链（http/https），回车同步"
              value={syncUrl}
              onChange={(e) => setSyncUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSyncOpen(false)
                  setSyncUrl('')
                }
              }}
            />
            <button type="submit" className="sync-ok" disabled={!syncUrl.trim() || !activeId}>
              同步
            </button>
            <button
              type="button"
              className="sync-cancel"
              onClick={() => {
                setSyncOpen(false)
                setSyncUrl('')
              }}
            >
              取消
            </button>
          </form>
        )}
        {!syncOpen && (
          <button
            className={`sync-btn ${syncJob ? 'active' : ''}`}
            disabled={!activeId || !!syncJob}
            title={activeId ? '把公网文件链接同步到当前对话' : '请先打开账号'}
            onClick={() => setSyncOpen(true)}
          >
            {syncJob ? (
              <span className="sync-spinner" />
            ) : (
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <path d="M7 1.5v7m0 0L4.4 5.9M7 8.5l2.6-2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M2.2 9.2v1.4a1.4 1.4 0 001.4 1.4h6.8a1.4 1.4 0 001.4-1.4V9.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            )}
            {syncLabel}
          </button>
        )}
        <button
          className={`panel-toggle ${panelOpen ? 'on' : ''}`}
          title="素材面板"
          onClick={() => setPanelOpen((v) => !v)}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="1" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.2" />
            <path d="M9 1v12" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        {!isMac && (
          <div className="win-controls">
            <button className="wc-btn" onClick={() => api.winControl('min')} title="最小化">
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
            </button>
            <button className="wc-btn" onClick={() => api.winControl('max')} title="最大化/还原">
              <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" /></svg>
            </button>
            <button className="wc-btn close" onClick={() => api.winControl('close')} title="关闭（隐藏到托盘）">
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" /></svg>
            </button>
          </div>
        )}
      </header>

      <div className="body">
        {/* 左侧：账号列表 */}
        <aside className="sidebar">
          <div className="side-head">
            {adding ? (
              <input
                className="add-input"
                autoFocus
                placeholder="账号名称，回车确认"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleAdd()
                  if (e.key === 'Escape') {
                    setAdding(false)
                    setNewName('')
                  }
                }}
                onBlur={() => void handleAdd()}
              />
            ) : (
              <button className="add-btn" onClick={() => setAdding(true)}>
                <svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                添加账号
              </button>
            )}
          </div>

          <div className="search-box">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <circle cx="6" cy="6" r="4.6" stroke="currentColor" strokeWidth="1.3" />
              <path d="M9.5 9.5L13 13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <input placeholder="搜索账号" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>

          <div className="acc-list">
            {filtered.map((a) => {
              const p = PRESENCE_META[presence[a.id] ?? 'unknown']
              return (
                <div
                  key={a.id}
                  className={`acc-item ${a.id === activeId ? 'active' : ''}`}
                  onClick={() => api.openAccount(a.id)}
                  onDoubleClick={() => {
                    setEditingId(a.id)
                    setEditName(a.name)
                  }}
                >
                  <Avatar name={a.name} color={a.color} />
                  {editingId === a.id ? (
                    <input
                      className="rename-input"
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleRename(a.id)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      onBlur={() => void handleRename(a.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <>
                      <div className="acc-info">
                        <div className="acc-name">{a.name}</div>
                        <div className={`acc-status ${p.className}`}>{p.label}</div>
                      </div>
                      <div className="acc-actions">
                        <button
                          title="重命名"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingId(a.id)
                            setEditName(a.name)
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                            <path d="M9.5 1.8l2.7 2.7L4.7 12H2V9.3l7.5-7.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                          </svg>
                        </button>
                        <button
                          title="删除"
                          className="danger"
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleDelete(a)
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                            <path d="M2 3.5h10M5.5 3.5V2h3v1.5M3.5 3.5L4 12h6l.5-8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
            {!filtered.length && <div className="acc-empty">{accounts.length ? '没有匹配的账号' : '还没有账号，点击上方「添加账号」开始'}</div>}
          </div>

          <div className="side-foot">
            共 {accounts.length} 个账号 · {loggedCount} 已登录 · 已打开 {openCount}
          </div>
        </aside>

        {/* 中间：网页容器 */}
        <main className="view-area" ref={viewRef}>
          {!activeId && (
            <div className="empty-state">
              <div className="empty-logo">豆</div>
              <h1>豆包多开管理器</h1>
              <p>每个账号拥有独立的隔离会话，登录互不干扰</p>
              <p className="sub">点击左侧账号打开标签页 · 关闭窗口会最小化到托盘</p>
            </div>
          )}
        </main>

        {/* 右侧：产物面板 */}
        {panelOpen && (
          <>
            <div className="panel-resizer" onMouseDown={startResize} />
            <aside className="art-panel" style={{ width: panelW }}>
            <div className="art-head">
              <div className="art-tabs">
                <button
                  className={panelTab === 'preview' ? 'on' : ''}
                  onClick={() => setPanelTab('preview')}
                >
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                    <rect x="1" y="2" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                    <circle cx="4.8" cy="5.5" r="1.1" fill="currentColor" />
                    <path d="M2.5 10.5l3-3 2 2 2.5-2.5 1.5 1.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
                  </svg>
                  预览
                </button>
                <button
                  className={panelTab === 'artifacts' ? 'on' : ''}
                  onClick={() => setPanelTab('artifacts')}
                >
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                    <path d="M1.5 3.5A1.5 1.5 0 013 2h2.6l1.2 1.5H11A1.5 1.5 0 0112.5 5v5A1.5 1.5 0 0111 11.5H3A1.5 1.5 0 011.5 10V3.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                  </svg>
                  产物
                </button>
              </div>
            </div>
            {panelTab === 'artifacts' && (
              <div className="art-sub">
                <select
                  className="art-filter"
                  value={artFilter}
                  onChange={(e) => setArtFilter(e.target.value)}
                >
                  <option value="all">全部账号</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <button className="art-clear" onClick={() => api.clearArtifacts()}>
                  清空
                </button>
              </div>
            )}
            {panelTab === 'preview' ? (
              pvItem ? (
                <div className="pv">
                  <div className="pv-stage">
                    {pvItem.kind === 'image' ? (
                      <img
                        src={`artifactstream://v/${pvItem.id}`}
                        alt={pvItem.filename}
                        style={{ transform: `scale(${pvZoom / 100})` }}
                      />
                    ) : (
                      <video src={`artifactstream://v/${pvItem.id}`} controls autoPlay />
                    )}
                  </div>
                  <div className="pv-bar">
                    <button
                      className="pv-ico"
                      disabled={pvIdx <= 0}
                      onClick={() => openPreview(artifacts[pvIdx - 1])}
                      title="上一个"
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M8.8 3L5 7l3.8 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <span className="pv-count">
                      {pvIdx + 1}/{artifacts.length}
                    </span>
                    <button
                      className="pv-ico"
                      disabled={pvIdx < 0 || pvIdx >= artifacts.length - 1}
                      onClick={() => openPreview(artifacts[pvIdx + 1])}
                      title="下一个"
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M5.2 3L9 7l-3.8 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    {pvItem.kind === 'image' && (
                      <>
                        <i className="pv-sep" />
                        <button
                          className="pv-ico"
                          onClick={() => setPvZoom((z) => Math.max(25, z - 25))}
                          title="缩小"
                        >
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M3 7h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                          </svg>
                        </button>
                        <span className="pv-count pv-zoom">{pvZoom}%</span>
                        <button
                          className="pv-ico"
                          onClick={() => setPvZoom((z) => Math.min(400, z + 25))}
                          title="放大"
                        >
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                          </svg>
                        </button>
                      </>
                    )}
                    <i className="pv-sep" />
                    <button
                      className="pv-ico pv-dl"
                      onClick={() => void api.downloadArtifact(pvItem.id)}
                      title="下载"
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M7 2v7m0 0L4.2 6.2M7 9l2.8-2.8M2.5 11.5h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="art-empty">
                  暂无预览
                  <span>点击「产物」标签里的卡片即可预览</span>
                </div>
              )
            ) : (
              <div className="art-list">
              {artList.map((a) => {
                const acc = accMap.get(a.accountId)
                return (
                  <div className="art-card" key={a.id}>
                    {a.kind === 'image' ? (
                      a.thumb ? (
                        <img className="art-thumb" src={a.thumb} onClick={() => openPreview(a)} alt={a.filename} />
                      ) : (
                        <div className="art-thumb placeholder">图片加载中…</div>
                      )
                    ) : a.thumb ? (
                      <div className="art-thumb video" onClick={() => openPreview(a)}>
                        <img src={a.thumb} alt={a.filename} />
                        <span className="play">▶</span>
                      </div>
                    ) : (
                      <VideoThumb
                        src={`artifactstream://v/${a.id}?thumb=1`}
                        name={a.filename}
                        onOpen={() => openPreview(a)}
                      />
                    )}
                    <div className="art-meta" title={a.prompt ?? a.filename}>
                      <span className="dot" style={{ background: acc?.color ?? '#ccc' }} title={acc?.name} />
                      <span className="aname">{acc?.name ?? '未知账号'}</span>
                      <span className="time">{fmtTime(a.time)}</span>
                      <button className="dl" onClick={() => void api.downloadArtifact(a.id)}>
                        下载
                      </button>
                    </div>
                    {a.prompt && <div className="art-prompt">{a.prompt}</div>}
                  </div>
                )
              })}
              {!artList.length && (
                <div className="art-empty">
                  还没有产物
                  <span>在账号里生成图片/视频后，会自动出现在这里</span>
                </div>
              )}
              </div>
            )}
          </aside>
          </>
        )}
      </div>

      {/* 右下角：下载提示 */}
      <div className="toast-area">
        {attaches.map((a) => {
          const pct = a.total && a.total > 0 ? Math.round(((a.received ?? 0) / a.total) * 100) : 0
          return (
            <div
              key={a.id}
              className={`toast ${a.status === 'failed' ? 'failed' : ''} ${a.status === 'done' ? 'done' : ''}`}
              title={a.reason ?? a.filePath ?? a.filename}
            >
              <div className="toast-row">
                <span
                  className={`toast-icon ${
                    a.status === 'failed' ? 'err' : a.status === 'done' ? 'ok' : 'run'
                  }`}
                >
                  {a.status === 'failed' ? '!' : a.status === 'done' ? '✓' : '↑'}
                </span>
                <span className="toast-name">{a.filename ?? '同步文件'}</span>
                <span className="toast-meta">
                  {a.status === 'switching' && '切换中…'}
                  {a.status === 'downloading' && (a.total ? `${pct}%` : '下载中…')}
                  {a.status === 'injecting' && '送入中…'}
                  {a.status === 'done' && '已注入'}
                  {a.status === 'failed' && '失败'}
                </span>
              </div>
              {a.status === 'failed' && a.reason && <div className="toast-reason">{a.reason}</div>}
              {a.status === 'downloading' && (
                <>
                  <div className="toast-bar">
                    <i style={{ width: `${pct}%` }} />
                  </div>
                  <div className="toast-foot">
                    <span className="toast-bytes">
                      {a.total
                        ? `${fmtBytes(a.received ?? 0)} / ${fmtBytes(a.total)}`
                        : `已下载 ${fmtBytes(a.received ?? 0)}`}
                    </span>
                    <button className="toast-cancel" onClick={() => api.cancelAttach(a.accountId)}>
                      取消
                    </button>
                  </div>
                </>
              )}
            </div>
          )
        })}
        {downloads.map((d) => {
          const known = d.total > 0
          const pct = known ? Math.round((d.received / d.total) * 100) : 0
          return (
            <div
              key={d.savePath}
              className={`toast ${d.status === 'failed' ? 'failed' : ''} ${d.status === 'done' ? 'done' : ''}`}
              title={d.status === 'done' ? '点击在访达中显示' : d.savePath}
              onClick={() => {
                if (d.status === 'done') api.revealDownload(d.savePath)
              }}
            >
              <div className="toast-row">
                <span
                  className={`toast-icon ${
                    d.status === 'failed' ? 'err' : d.status === 'done' ? 'ok' : 'run'
                  }`}
                >
                  {d.status === 'failed' ? '!' : d.status === 'done' ? '✓' : '↓'}
                </span>
                <span className="toast-name">{d.filename}</span>
                <span className="toast-meta">
                  {d.status === 'progressing' && (known ? `${pct}%` : `${fmtBytes(d.received)}`)}
                  {d.status === 'started' && '开始下载…'}
                  {d.status === 'done' && '已完成'}
                  {d.status === 'failed' && '下载失败'}
                </span>
              </div>
              {d.status !== 'done' && d.status !== 'failed' && (
                <>
                  <div className={`toast-bar${known ? '' : ' indeterminate'}`}>
                    <i style={known ? { width: `${pct}%` } : undefined} />
                  </div>
                  <div className="toast-foot">
                    <span className="toast-bytes">
                      {known
                        ? `${fmtBytes(d.received)} / ${fmtBytes(d.total)}`
                        : `${fmtBytes(d.received)} / 总长未知`}
                    </span>
                  </div>
                </>
              )}
              {d.status === 'done' && (
                <div className="toast-foot">
                  <span className="toast-bytes">{fmtBytes(d.total)}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
