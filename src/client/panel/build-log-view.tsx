/**
 * 构建日志子视图（CLIENT-M2-06 阶段 3；docs §5 build.log / build.log.stream 契约）
 *
 * - tail/分段：`build.log` 强制 tail/limit（红线：禁全量拉取）；tail 模式默认尾部
 *   LOG_PAGE_SIZE=200 行（M2-06 验收口径）；分段 = start/limit 翻页回看（更早/更新/回到尾部）；
 * - 自动跟随：`build.log.stream` progressiveText 增量续传（1.5s 轮询）——先探针取
 *   X-Text-Size（start=huge 仅取头部，避免全量重拉），再按 nextStart 续传追加，
 *   moreData=false 停止；**面板 visible 门控**（0.1.5 起由宿主注入的 visible 布尔），关闭/折叠即停；
 *   「跟随中构建结束」自动翻回「关」，但**用户手动打开的开关不被自动停机覆盖**
 *   （终态构建手动开 → 按钮保持「开」、仅停止轮询，note 据实显示已结束）；
 * - 复制：navigator.clipboard 整段复制（失败静默）；失败高亮：[ERROR]/error 行标红
 *   （`.jenkins_logErr`），行号 `.jenkins_logLn`。
 *
 * 日志请求契约 `logQueryFor` 为纯函数，可单测（tail 必带 tail；page 必带 start+limit）。
 */
import { useEffect, useRef, useState } from 'react'

import { fetchBuildLog, fetchProgressiveLog, type LogOutput } from '../api.js'

/** 尾部分页页大小（M2-06 验收：tail 默认尾部 200 行） */
export const LOG_PAGE_SIZE = 200
/** 自动跟随轮询间隔（契约 1~2s） */
const FOLLOW_INTERVAL_MS = 1500
/** 探针用超大 start：仅取 X-Text-Size 头部（nextStart = 当前日志总字节），不下载内容 */
const PROBE_START = Number.MAX_SAFE_INTEGER

export type LogViewMode = { kind: 'tail' } | { kind: 'page'; start: number }

/**
 * 是否实际处于跟随（纯函数）：跟随开关开 **且** 流式接口未报告结束。
 * streamMoreData = null（尚未探测）按进行中处理——运行中构建本就应显示「构建进行中」；
 * false = 构建已结束（探针/续传 moreData=false），此时即使按钮为「开」也不再声称进行中。
 */
export function isFollowing(followOn: boolean, streamMoreData: boolean | null | undefined): boolean {
  return followOn && streamMoreData !== false
}

/** 日志请求契约（纯函数）：tail 模式必带 tail；page 模式必带 start+limit（红线：禁全量） */
export function logQueryFor(
  mode: LogViewMode,
  opts: { buildNumber?: number; pageSize?: number } = {},
): { buildNumber?: number; tail?: number; start?: number; limit?: number } {
  const pageSize = opts.pageSize ?? LOG_PAGE_SIZE
  if (mode.kind === 'page') {
    return { buildNumber: opts.buildNumber, start: mode.start, limit: pageSize }
  }
  return { buildNumber: opts.buildNumber, tail: pageSize }
}

export interface BuildLogViewProps {
  connection: string
  jobName: string
  /** 0/排队中 → empty；undefined = 最新构建 */
  buildNumber?: number
  queued: boolean
  sessionId?: string
  /** 面板是否可见（官方右侧栏展开且本页签激活；0.1.5 起由宿主注入，替代原 panelStore.isVisible） */
  visible: boolean
  /** 构建 URL（build.status 的 url，如 …/job/…/1061/；缺省则「完整日志」链接不显示） */
  buildUrl?: string
}

/** [ERROR]/error 行 → 失败高亮（纯函数，可单测） */
export function isErrorLine(line: string): boolean {
  return /\[ERROR\]|error/i.test(line)
}

export function BuildLogView({ connection, jobName, buildNumber, queued, sessionId, visible, buildUrl }: BuildLogViewProps) {
  const [output, setOutput] = useState<LogOutput | null>(null)
  const [view, setView] = useState<LogViewMode>({ kind: 'tail' })
  const [reload, setReload] = useState(0)
  // 自动跟随默认开（用户 V7 决策）：仅门控 visible 且非排队；终态构建探针 moreData=false 即自动停。
  const [followOn, setFollowOn] = useState(true)
  // 流式接口最近一次 moreData（null = 尚未探测）：note 文案据实展示，避免「按钮开但构建已结束」误报进行中
  const [streamMoreData, setStreamMoreData] = useState<boolean | null>(null)
  // 用户手动打开跟随的标记：effect 自动停机不得覆盖用户显式操作——手动打开后首次探针
  // 发现终态时尊重开关（保持「开」，仅停止轮询）；跟随真正启动后清除，恢复自动停机。
  const manualEnableRef = useRef(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement | null>(null)


  // 构建/连接变化：重置视图为尾部（跟随回到默认开）
  useEffect(() => {
    setOutput(null)
    setError(null)
    setFollowOn(true)
    setStreamMoreData(null)
    manualEnableRef.current = false
    setView({ kind: 'tail' })
  }, [connection, jobName, buildNumber])

  // 加载当前视图切片（tail 或 page；排队中跳过；reload = 手动刷新）
  useEffect(() => {
    if (queued) return
    let cancelled = false
    setError(null)
    fetchBuildLog(connection, jobName, logQueryFor(view, { buildNumber }), { sessionId })
      .then((out) => {
        if (!cancelled) setOutput(out)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [view, reload, connection, jobName, buildNumber, sessionId, queued])

  // 自动跟随：探针取字节位 → 增量续传追加；visible/moreData 门控
  const followActive = followOn && visible && !queued
  useEffect(() => {
    if (!followActive) return
    let cancelled = false
    let timer: number | undefined
    let startByte = 0

    // 停止轮询。仅「跟随过程中构建结束」自动翻关（按钮回到「关」）；
    // 用户刚手动打开时尊重开关状态：保持「开」，只停止本轮轮询（终态无可续传）。
    const stopPolling = () => {
      if (manualEnableRef.current) {
        manualEnableRef.current = false
        return
      }
      setFollowOn(false)
    }

    const tick = async () => {
      if (cancelled) return
      try {
        const res = await fetchProgressiveLog(connection, jobName, buildNumber, startByte, { sessionId })
        if (cancelled) return
        setStreamMoreData(res.moreData)
        if (res.text) {
          setOutput((prev) => (prev ? { ...prev, log: prev.log + res.text } : prev))
        }
        startByte = res.nextStart
        if (res.moreData) {
          manualEnableRef.current = false // 跟随真正启动：后续构建结束自动停正常生效
        } else {
          stopPolling()
          return
        }
      } catch {
        // 瞬时错误：保持跟随，下一轮重试
      }
      timer = window.setTimeout(tick, FOLLOW_INTERVAL_MS)
    }

    // 探针：huge start 只拿头部（X-Text-Size），避免全量重拉
    const start = async () => {
      try {
        const probe = await fetchProgressiveLog(connection, jobName, buildNumber, PROBE_START, { sessionId })
        if (cancelled) return
        setStreamMoreData(probe.moreData)
        startByte = probe.nextStart
        if (probe.moreData) {
          manualEnableRef.current = false // 跟随真正启动：后续构建结束自动停正常生效
        } else {
          stopPolling()
          return
        }
      } catch {
        startByte = 0 // 探针失败：退化为从 0 续传（moreData 门控仍生效）
      }
      void tick()
    }
    void start()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [followActive, connection, jobName, buildNumber, sessionId])

  // 跟随中自动滚到底
  useEffect(() => {
    if (followOn && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [output, followOn])

  const totalLines = output?.totalLines ?? 0
  // 剥离路由追加的分页提示行（`…（日志共 N 行…）`——面板有独立 note，不渲染进日志）
  const rawLines = (output?.log ?? '').split('\n')
  const lines = rawLines[rawLines.length - 1]?.startsWith('…（日志共') ? rawLines.slice(0, -1) : rawLines
  const lineBase = view.kind === 'page' ? view.start : Math.max(0, totalLines - lines.length)
  // 完整日志链接：构建 URL + /console（如 …/job/…/1061/console）；buildUrl 缺省则无链接
  const consoleHref = buildUrl ? `${buildUrl.replace(/\/+$/, '')}/console` : undefined

  const handleCopy = async () => {
    if (!output) return
    try {
      // 只复制日志正文（与展示一致：剥离路由追加的「…（日志共 N 行…）」分页提示行）
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 非安全上下文/无权限：静默
    }
  }

  const toggleFollow = () => {
    if (followOn) {
      setFollowOn(false)
    } else {
      manualEnableRef.current = true // 用户显式打开：探针发现终态时尊重开关，不自动翻回「关」
      setFollowOn(true)
      setView({ kind: 'tail' }) // 跟随只在尾部有意义
    }
  }

  if (queued) {
    return (
      <div>
        <div className="jenkins_logEmpty">排队中：等待执行器分配…</div>
        <div className="jenkins_note">构建尚未开始，状态由 host 自动轮询更新。</div>
      </div>
    )
  }

  if (error && !output) {
    return <div className="jenkins_empty">加载失败：{error}</div>
  }

  return (
    <div className="jenkins_logView">
      {error && <div className="jenkins_tnodeError">{error}</div>}
      {/* 提示信息移到日志框上方（用户 V7 要求），日志框下探填满其余高度 */}
      <div className="jenkins_note">
        {view.kind === 'page'
          ? `分段查看：第 ${view.start + 1}–${Math.min(totalLines, view.start + LOG_PAGE_SIZE)} 行 / 共 ${totalLines} 行。`
          : isFollowing(followOn, streamMoreData)
            ? '构建进行中：日志自动跟随，可切「分段」回看。'
            : `已显示尾部 ${lines.length} 行（共 ${totalLines} 行）；可「分段」查看更多。`}
        {consoleHref && !isFollowing(followOn, streamMoreData) && (
          <>
            点击
            <a className="jenkins_noteLink" href={consoleHref} target="_blank" rel="noopener noreferrer" title="在 Jenkins 新窗口打开完整日志（console）">
              查看完整日志
            </a>
          </>
        )}
      </div>
      <pre className="jenkins_log" ref={logRef}>
        {lines.map((line, i) => (
          <div key={i} className={isErrorLine(line) ? 'jenkins_logLine jenkins_logErr' : 'jenkins_logLine'}>
            <span className="jenkins_logLn">{lineBase + i + 1}</span>
            {line || ' '}
          </div>
        ))}
      </pre>
      {/* 操作按钮移到日志框下方（用户 V10 反馈），仍居右展示 */}
      <div className="jenkins_toolbar">
        <button type="button" className="jenkins_pillBtn" onClick={() => setReload((n) => n + 1)}>
          刷新
        </button>
        {view.kind === 'page' ? (
          <>
            <button type="button" className="jenkins_pillBtn" onClick={() => setView((v) => (v.kind === 'page' ? { kind: 'page', start: Math.max(0, v.start - LOG_PAGE_SIZE) } : v))}>
              ◀ 更早
            </button>
            <button type="button" className="jenkins_pillBtn" onClick={() => setView((v) => (v.kind === 'page' ? { kind: 'page', start: Math.min(Math.max(0, totalLines - LOG_PAGE_SIZE), v.start + LOG_PAGE_SIZE) } : v))}>
              更新 ▶
            </button>
            <button type="button" className="jenkins_pillBtn" onClick={() => setView({ kind: 'tail' })}>
              回到尾部
            </button>
          </>
        ) : (
          <button type="button" className="jenkins_pillBtn" onClick={() => setView({ kind: 'page', start: Math.max(0, totalLines - LOG_PAGE_SIZE) })} disabled={totalLines <= LOG_PAGE_SIZE}>
            分段
          </button>
        )}
        <button type="button" className="jenkins_pillBtn" onClick={handleCopy} disabled={!output}>
          {copied ? '已复制' : '复制'}
        </button>
        <button type="button" className={`jenkins_pillBtn${followOn ? ' jenkins_pillBtnOn' : ''}`} onClick={toggleFollow}>
          自动跟随：{followOn ? '开' : '关'}
        </button>
      </div>
    </div>
  )
}
