/**
 * 面板「任务」视图（CLIENT-M2-04；docs/architecture.md §3.3、prototype renderJobs 口径）
 *
 * 结构：连接切换器（conn-switcher，横向滚动）+ 搜索框 + 多层级文件夹树（folder-tree，
 * 懒加载/搜索展开命中分支）。数据源 `conn.list` / `folder.tree` / `jobs.search`。
 *
 * - 默认连接排最前（原型 connList 顺序）；无默认连接取列表首个；
 * - 连接切换 → 树整体重置（folder-tree key=connection）；
 * - 任务点击 → onOpenJob 上抛（→ CLIENT-M2-05 任务详情）。
 */
import { useEffect, useState } from 'react'

import { listConnections, type ConnectionInfo, type TreeJobNode } from '../api.js'
import { ConnSwitcher } from './conn-switcher.js'
import { FolderTree } from './folder-tree.js'

export interface JobsViewProps {
  sessionId?: string
  /** 面板是否可见（0.1.5 起由宿主注入；形状与兄弟视图一致，本视图暂未消费） */
  visible?: boolean
  /** 任务点击上抛（job + 当前连接名） */
  onOpenJob: (job: TreeJobNode, connection: string) => void
  /** 面板周期刷新令牌（panel-host 打开时 15s 递增）→ 驱动任务树状态自动刷新（用户报障） */
  refreshToken?: number
}

/** 默认连接排最前（原型顺序；纯函数可单测） */
export function orderConnections(list: ConnectionInfo[]): ConnectionInfo[] {
  return [...list].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

export function JobsView({ sessionId, onOpenJob, refreshToken }: JobsViewProps) {
  const [connections, setConnections] = useState<ConnectionInfo[] | null>(null)
  const [activeConn, setActiveConn] = useState('')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)

  // conn.list 加载 + 默认连接选中
  useEffect(() => {
    let cancelled = false
    setConnections(null)
    setError(null)
    listConnections({ sessionId })
      .then((list) => {
        if (cancelled) return
        const ordered = orderConnections(list)
        setConnections(ordered)
        setActiveConn((prev) =>
          prev && ordered.some((c) => c.name === prev) ? prev : (ordered.find((c) => c.isDefault) ?? ordered[0])?.name ?? '',
        )
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  if (error) {
    return <div className="jenkins_empty">加载失败：{error}</div>
  }
  if (!connections) {
    return <div className="jenkins_empty">加载连接…</div>
  }
  if (connections.length === 0) {
    return <div className="jenkins_empty">未配置 Jenkins 连接（设置页添加后刷新）</div>
  }

  return (
    <div className="jenkins_jobsView" data-dsh-jenkins-panel-jobs-view="">
      <ConnSwitcher connections={connections} value={activeConn} onChange={setActiveConn} />
      <div className="jenkins_search">
        <input
          type="search"
          value={query}
          placeholder="搜索任务（中文/名称/路径）…"
          onChange={(e) => setQuery(e.target.value)}
          data-dsh-jenkins-panel-search=""
        />
      </div>
      <FolderTree
        key={activeConn}
        connection={activeConn}
        sessionId={sessionId}
        searchQuery={query}
        refreshTick={refreshToken}
        onOpenJob={(job) => onOpenJob(job, activeConn)}
      />
    </div>
  )
}
