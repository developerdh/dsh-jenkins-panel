/**
 * 多层级文件夹树（CLIENT-M2-04 阶段 3/4/5；docs/architecture.md §3.3、prototype .tree 口径）
 *
 * 数据源：`folder.tree?folder=<path>`（**懒加载单层**：展开文件夹时只取该层直接子节点，
 * 缺省 = 根层）；`FolderTreeNode { type:'folder'|'job', fullName, displayName, color, children? }`。
 *
 * 两种模式：
 * - 树模式（无搜索词）：根层懒加载 → 文件夹可折叠展开（展开状态保持），job 行状态点由
 *   `color` 驱动（`_anime` = 构建中，colorToStatus 映射）；
 * - 搜索模式（搜索词非空）：`jobs.search` 递归扁平命中 → 命中分支在树中展开（自动加载命中
 *   祖先文件夹链）并高亮命中文本（`.jenkins_matchHl`）；仅渲染命中分支与命中 job。
 *
 * 纯函数（colorToStatus/highlightParts/ancestorFolders/isAncestorOf）导出供单测，不依赖 DOM。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { fetchFolderTree, searchJobs, type TreeJobNode } from '../api.js'

export interface FolderTreeProps {
  connection: string
  sessionId?: string
  searchQuery: string
  /** 任务点击上抛（→ CLIENT-M2-05 任务详情） */
  onOpenJob: (job: TreeJobNode) => void
  /** 周期刷新令牌（父级面板刷新节奏递增；变化时对已加载层原地重拉，job color 状态自动更新） */
  refreshTick?: number
}

/** 状态点语义键（colorToStatus 输出；CSS 类 jenkins_st*） */
export type JobStatusKey = 'ok' | 'fail' | 'run' | 'disabled' | 'aborted' | 'warn'

/** color → 状态点映射（原型 colorToSt 口径：_anime=构建中；blue/red/grey/aborted/yellow 映射，其余/缺省 → warn） */
export function colorToStatus(color: string | undefined): JobStatusKey {
  if (color && /_anime$/.test(color)) return 'run'
  switch (color) {
    case 'blue':
      return 'ok'
    case 'red':
      return 'fail'
    case 'grey':
    case 'disabled':
      return 'disabled'
    case 'aborted':
      return 'aborted'
    default:
      // 含 undefined/''/yellow/未知色 → warn（原型 fallback 口径）
      return 'warn'
  }
}

const STATUS_CLASS: Record<JobStatusKey, string> = {
  ok: 'jenkins_stOk',
  fail: 'jenkins_stFail',
  run: 'jenkins_stRun',
  disabled: 'jenkins_stDisabled',
  aborted: 'jenkins_stAborted',
  warn: 'jenkins_stWarn',
}

/** 命中文本分段（用于 .match-hl 高亮；纯函数可单测） */
export function highlightParts(text: string, query: string): Array<{ text: string; match: boolean }> {
  const q = query.trim().toLowerCase()
  if (!q) return [{ text, match: false }]
  const lower = text.toLowerCase()
  const parts: Array<{ text: string; match: boolean }> = []
  let cursor = 0
  while (cursor < text.length) {
    const idx = lower.indexOf(q, cursor)
    if (idx < 0) {
      parts.push({ text: text.slice(cursor), match: false })
      break
    }
    if (idx > cursor) parts.push({ text: text.slice(cursor, idx), match: false })
    parts.push({ text: text.slice(idx, idx + q.length), match: true })
    cursor = idx + q.length
  }
  return parts
}

/** 命中 job 的祖先文件夹路径链（不含 job 自身，不含根） */
export function ancestorFolders(fullName: string): string[] {
  const parts = fullName.split('/').filter(Boolean)
  const out: string[] = []
  let acc = ''
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i]
    out.push(acc)
  }
  return out
}

/** folder 是否为 fullName 的祖先（命中分支展开判定） */
export function isAncestorOf(folder: string, fullName: string): boolean {
  return fullName.startsWith(`${folder}/`)
}

interface SearchState {
  query: string
  hits: TreeJobNode[]
  connection: string
}

interface RenderCtx {
  mode: 'tree' | 'search'
  cache: Record<string, TreeJobNode[]>
  loading: Record<string, boolean>
  errors: Record<string, string>
  openState: Record<string, boolean>
  hitsSet: Set<string>
  neededFolders: Set<string>
  query: string
  toggleFolder: (fullName: string) => void
  onOpenJob: (job: TreeJobNode) => void
}

export function FolderTree({ connection, sessionId, searchQuery, onOpenJob, refreshTick }: FolderTreeProps) {
  // 子树缓存：folder path（''=根层）→ 直接子节点；ref 镜像防并发加载竞态
  const cacheRef = useRef<Record<string, TreeJobNode[]>>({})
  const loadingRef = useRef<Record<string, boolean>>({})
  const [cache, setCache] = useState<Record<string, TreeJobNode[]>>({})
  const [openState, setOpenState] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [search, setSearch] = useState<SearchState | null>(null)
  const [fatalError, setFatalError] = useState<string | null>(null)

  const commitCache = (folder: string, children: TreeJobNode[]) => {
    cacheRef.current = { ...cacheRef.current, [folder]: children }
    setCache(cacheRef.current)
  }
  const setFolderLoading = (folder: string, on: boolean) => {
    loadingRef.current = { ...loadingRef.current, [folder]: on }
    setLoading(loadingRef.current)
  }
  const setFolderError = (folder: string, message: string) => {
    setErrors((prev) => ({ ...prev, [folder]: message }))
  }

  /** 懒加载某层子节点（幂等：已加载/加载中直接返回） */
  const loadFolder = useCallback(
    async (folder: string) => {
      if (cacheRef.current[folder] !== undefined || loadingRef.current[folder]) return
      setFolderLoading(folder, true)
      try {
        const children = await fetchFolderTree(connection, folder === '' ? undefined : folder, { sessionId })
        commitCache(folder, children)
      } catch (err) {
        setFolderError(folder, err instanceof Error ? err.message : String(err))
      } finally {
        setFolderLoading(folder, false)
      }
    },
    [connection, sessionId],
  )

  // 连接/会话变化：重置并加载根层
  useEffect(() => {
    cacheRef.current = {}
    loadingRef.current = {}
    setCache({})
    setOpenState({})
    setErrors({})
    setSearch(null)
    setFatalError(null)
    void loadFolder('')
  }, [connection, sessionId, loadFolder])

  // 搜索：jobs.search 扁平命中 → 命中分支展开
  useEffect(() => {
    const q = searchQuery.trim()
    if (!q) {
      setSearch(null)
      return
    }
    let cancelled = false
    setSearch(null)
    setFatalError(null)
    searchJobs(connection, q, { sessionId })
      .then((hits) => {
        if (!cancelled) setSearch({ query: q, hits, connection })
      })
      .catch((err) => {
        if (!cancelled) setFatalError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [connection, sessionId, searchQuery])

  // 搜索模式：自动加载命中祖先文件夹链（缓存去重；连接已切换时跳过旧结果）
  useEffect(() => {
    if (!search || search.connection !== connection) return
    const needed = new Set<string>()
    for (const hit of search.hits) {
      for (const folder of ancestorFolders(hit.fullName)) needed.add(folder)
    }
    for (const folder of needed) void loadFolder(folder)
  }, [search, connection, loadFolder])

  /**
   * 周期刷新（用户报障：任务列表构建状态不自动更新——任务构建完仍是蓝点闪）。
   * refreshTick 递增（面板打开期间父级 15s 节奏）→ 对**已加载层**原地重拉并替换节点数据
   * （folder.tree 返回的 job color 含 `_anime` 构建中标记，刷新后蓝点→绿/红自动更新）。
   * - 保持 openState/展开层级与已加载数据（只换数据不重置树）；
   * - 搜索模式跳过（命中结果由 jobs.search 驱动，刷新无意义且会干扰搜索态）；
   * - 单层失败静默保留旧数据（下轮重试）。
   */
  useEffect(() => {
    if (refreshTick === undefined || refreshTick <= 0) return
    if (searchQuery.trim()) return // 搜索模式不刷新
    const folders = Object.keys(cacheRef.current)
    if (folders.length === 0) return
    let cancelled = false
    void (async () => {
      const next: Record<string, TreeJobNode[]> = {}
      let changed = false
      for (const folder of folders) {
        if (cancelled) return
        try {
          const children = await fetchFolderTree(connection, folder === '' ? undefined : folder, { sessionId })
          next[folder] = children
          changed = true
        } catch {
          // 瞬时错误：保留旧数据，下轮重试
        }
      }
      if (cancelled || !changed) return
      cacheRef.current = { ...cacheRef.current, ...next }
      setCache(cacheRef.current)
    })()
    return () => {
      cancelled = true
    }
  }, [refreshTick, searchQuery, connection, sessionId])

  const toggleFolder = (fullName: string) => {
    setOpenState((prev) => ({ ...prev, [fullName]: !prev[fullName] }))
    void loadFolder(fullName) // 展开时懒加载（幂等）
  }

  const hitsSet = useMemo(() => new Set((search?.hits ?? []).map((h) => h.fullName)), [search])
  const neededFolders = useMemo(() => {
    const set = new Set<string>()
    if (search) {
      for (const hit of search.hits) {
        for (const folder of ancestorFolders(hit.fullName)) set.add(folder)
      }
    }
    return set
  }, [search])

  if (fatalError) {
    return <div className="jenkins_empty">加载失败：{fatalError}</div>
  }

  const rootChildren = cache['']
  if (!rootChildren) {
    return <div className="jenkins_empty">加载中…</div>
  }

  if (search && search.hits.length === 0) {
    return <div className="jenkins_empty">无匹配任务</div>
  }

  const ctx: RenderCtx = {
    mode: search ? 'search' : 'tree',
    cache,
    loading,
    errors,
    openState,
    hitsSet,
    neededFolders,
    query: search?.query ?? '',
    toggleFolder,
    onOpenJob,
  }

  return (
    <div className="jenkins_tree" data-dsh-jenkins-panel-tree="">
      {renderNodes(rootChildren, 0, ctx)}
    </div>
  )
}

function renderNodes(nodes: TreeJobNode[], depth: number, ctx: RenderCtx): ReactNode[] {
  const out: ReactNode[] = []
  for (const node of nodes) {
    const row = renderNode(node, depth, ctx)
    if (row !== null) out.push(row)
  }
  return out
}

function renderNode(node: TreeJobNode, depth: number, ctx: RenderCtx): ReactNode | null {
  if (ctx.mode === 'search') {
    if (node.type === 'folder') {
      // 命中分支的祖先文件夹：展开显示（含自身命中的文件夹）
      if (!ctx.neededFolders.has(node.fullName) && !ctx.hitsSet.has(node.fullName)) return null
      return renderFolderRow(node, depth, ctx, true)
    }
    if (!ctx.hitsSet.has(node.fullName)) return null
    return renderJobRow(node, depth, ctx)
  }
  // 树模式
  if (node.type === 'folder') return renderFolderRow(node, depth, ctx, false)
  return renderJobRow(node, depth, ctx)
}

function renderFolderRow(node: TreeJobNode, depth: number, ctx: RenderCtx, forcedOpen: boolean): ReactNode {
  const open = forcedOpen || !!ctx.openState[node.fullName]
  const children = ctx.cache[node.fullName]
  const isLoading = !!ctx.loading[node.fullName]
  const error = ctx.errors[node.fullName]
  const count = children?.length

  return (
    <div key={node.fullName}>
      <div
        className={isLoading ? 'jenkins_tnode jenkins_tnodeLoading' : 'jenkins_tnode'}
        data-fold={node.fullName}
        style={{ paddingLeft: depth * 14 + 6 }}
        onClick={() => ctx.toggleFolder(node.fullName)}
        title={node.fullName}
      >
        <span className="jenkins_twist">{open ? '▾' : '▸'}</span>
        <span className="jenkins_fico" aria-hidden="true">📁</span>
        <span className="jenkins_tnodeName">
          <span className="jenkins_tnodeDisplay">{highlight(node.displayName ?? node.name, ctx.query)}</span>
        </span>
        {count !== undefined && <span className="jenkins_tnodeCount">{count}</span>}
      </div>
      {error && <div className="jenkins_tnodeError">{error}</div>}
      {(open || forcedOpen) && (
        <div className="jenkins_treeChildren">
          {isLoading && <div className="jenkins_tnodeLoadingRow">加载中…</div>}
          {children ? renderNodes(children, depth + 1, ctx) : null}
        </div>
      )}
    </div>
  )
}

function renderJobRow(node: TreeJobNode, depth: number, ctx: RenderCtx): ReactNode {
  const status = colorToStatus(node.color)
  return (
    <div
      key={node.fullName}
      className="jenkins_tnode"
      data-go-tree-job={node.fullName}
      style={{ paddingLeft: depth * 14 + 6 }}
      onClick={() => ctx.onOpenJob(node)}
      title={node.fullName}
    >
      <span className="jenkins_twist" />
      <span className={`jenkins_st ${STATUS_CLASS[status]}`} />
      <span className="jenkins_tnodeName">
        <span className="jenkins_tnodeDisplay">{highlight(node.displayName ?? node.name, ctx.query)}</span>
        <span className="jenkins_tnodePath">{node.fullName}</span>
      </span>
    </div>
  )
}

/** 命中文本 → 高亮 span（非命中原样返回） */
function highlight(text: string, query: string): ReactNode {
  const parts = highlightParts(text, query)
  if (parts.length === 1 && !parts[0].match) return text
  return parts.map((part, i) =>
    part.match ? (
      <span key={i} className="jenkins_matchHl">{part.text}</span>
    ) : (
      part.text
    ),
  )
}
