/**
 * 构建详情视图（CLIENT-M2-06 阶段 1/2/6；docs §3.3 BuildDetailView + 三个 SubView）
 *
 * 组装：构建头（显示名/连接/#号/状态/时间/耗时）+ 操作（重试/取消/删除，按状态显隐，
 * 操作后刷新 build.status）+ sub-tabs（日志/产物/工作空间）+ 返回导航。
 *
 * 进入参数 `BuildDetailEntry`：总览记录行 / 任务详情构建历史行 → `{ conn, jobName,
 * buildNumber?, displayName, status, params? }`（排队中记录 buildNumber=0 或未分配）。
 * 状态以 `build.status` 装载为准；装载前用 entry.status 兜底（queued/running/ok/fail/aborted）。
 *
 * `opButtonsFor` / `formatDuration` / `formatTime` 为纯函数，可单测。
 */
import { useEffect, useRef, useState } from 'react'

import {
  cancelBuild,
  deleteBuild,
  fetchBuildStatus,
  retryBuild,
  type BuildInfo,
} from '../api.js'
import { ArtifactsView } from './artifacts-view.js'
import { BuildLogView } from './build-log-view.js'
import { WorkspaceView } from './workspace-view.js'

export interface BuildDetailEntry {
  connection: string
  /** 任务名或路径（fullName 优先） */
  jobName: string
  displayName?: string
  /** 0 = 排队中（未分配）；undefined = 最新构建 */
  buildNumber?: number
  /** 进入时已知状态（queued/running/ok/fail/aborted；装载后以 build.status 为准） */
  status?: string
  /** 触发时记录的任务参数（总览记录行带入；排队中/未装载时回退展示） */
  params?: Record<string, unknown>
}

export interface BuildDetailViewProps {
  entry: BuildDetailEntry
  sessionId?: string
  /** 面板是否可见（0.1.5 起由宿主注入；下传日志视图的自动跟随门控） */
  visible: boolean
  onBack: () => void
}

export type BuildOp = 'retry' | 'cancel' | 'delete'
export type BuildSubTab = 'log' | 'artifacts' | 'workspace'

/** 构建中状态轮询间隔（用户 V7：状态需自动变化） */
const STATUS_POLL_MS = 5000

/**
 * 状态 → 操作按钮显隐（纯函数；docs/proposals/ui-button-states.md §2 矩阵）：
 * - 重试：仅终态（ok/unstable/fail/aborted，即非排队/构建中且有终态 result）——排队/构建中不能重试；
 * - 取消：仅在排队中或构建中（排队 = 取消排队，运行 = stop）；
 * - 删除：仅终态（含 unstable），补齐原 `fail||ok||aborted` 漏掉的 UNSTABLE。
 */
export function opButtonsFor(opts: { building: boolean; queued: boolean; result?: string }): Record<BuildOp, boolean> {
  const terminal = !opts.queued && !opts.building && opts.result != null
  return {
    retry: terminal,
    cancel: opts.queued || opts.building,
    delete: terminal,
  }
}

/** 耗时格式化（毫秒 → "1h 2m" / "3m 4s" / "5s"；缺省 —） */
export function formatDuration(ms?: number): string {
  if (ms == null) return '—'
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return `${hours}h ${restMinutes}m`
}

/** 时间格式化（本地 HH:MM:SS；缺省空串） */
export function formatTime(ts?: number): string {
  if (ts == null) return ''
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

/** entry.status（触发记录口径）→ 装载前兜底状态 */
export function deriveState(
  entry: BuildDetailEntry,
  info: BuildInfo | null,
): { building: boolean; queued: boolean; result?: string } {
  if (info) {
    return { building: !!info.building, queued: false, result: info.result }
  }
  const st = entry.status
  return {
    queued: st === 'queued' || entry.buildNumber === 0,
    building: st === 'running',
    result: st === 'ok' ? 'SUCCESS' : st === 'fail' ? 'FAILURE' : st === 'aborted' ? 'ABORTED' : undefined,
  }
}

/** 标题头状态点 CSS 类（纯函数；构建状态 → 状态点，与任务详情/总览同款圆点）：
 * 排队中→黄、构建中→蓝（jenkins_stRun 自带 1s 闪烁）、SUCCESS→绿、FAILURE→红、
 * ABORTED→灰、UNSTABLE/NOT_BUILT/未知→黄。 */
export function buildStatusDotClass(opts: { building: boolean; queued: boolean; result?: string }): string {
  if (opts.queued) return 'jenkins_stQueued'
  if (opts.building) return 'jenkins_stRun'
  switch (opts.result) {
    case 'SUCCESS':
      return 'jenkins_stOk'
    case 'FAILURE':
      return 'jenkins_stFail'
    case 'ABORTED':
      return 'jenkins_stAborted'
    default:
      return 'jenkins_stWarn' // UNSTABLE / NOT_BUILT / 未知
  }
}

/** 状态点标题文案（纯函数） */
export function buildStatusDotTitle(opts: { building: boolean; queued: boolean; result?: string }): string {
  if (opts.queued) return '排队中'
  if (opts.building) return '构建中'
  switch (opts.result) {
    case 'SUCCESS':
      return '成功'
    case 'FAILURE':
      return '失败'
    case 'ABORTED':
      return '已取消'
    default:
      return '未知'
  }
}

/** 构建参数条目（name = 参数名，value = 展示值） */
export interface BuildParam {
  name: string
  value: string
}

/** 值 → 展示文本（对象 JSON 序列化；其余 String；空/缺失 → '—'） */
function paramValueText(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/**
 * 从 build.status 的 actions.parameters 提取**实际采用**的构建参数（纯函数；无则空数组）。
 * Jenkins 参数模型：parameters 位于 _class=ParametersAction 的 action 内（数组顺序即定义顺序）。
 */
export function extractBuildParams(info: BuildInfo | null): BuildParam[] {
  if (!info) return []
  const out: BuildParam[] = []
  for (const action of info.actions ?? []) {
    const list = action?.parameters
    if (!Array.isArray(list)) continue
    for (const p of list) {
      if (!p || typeof p.name !== 'string' || !p.name) continue
      out.push({ name: p.name, value: paramValueText(p.value) })
    }
  }
  return out
}

/** entry.params（触发记录采样的参数）→ BuildParam[]（纯函数；无则空数组） */
export function entryParams(entry: BuildDetailEntry): BuildParam[] {
  const p = entry.params
  if (!p || typeof p !== 'object') return []
  return Object.entries(p).map(([name, value]) => ({ name, value: paramValueText(value) }))
}

/**
 * 从构建 URL 派生任务页 URL（用户优化：任务名为链接，点击新窗口打开对应任务界面）。
 * Jenkins 构建 URL 形如 `.../job/<folder>/job/<job>/<N>/`，去掉尾部构建号段即任务页。
 */
export function buildJobLink(buildUrl?: string): string | undefined {
  if (!buildUrl) return undefined
  const trimmed = buildUrl.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return undefined
  return `${trimmed.slice(0, idx)}/`
}

export function BuildDetailView({ entry, sessionId, visible, onBack }: BuildDetailViewProps) {
  const { connection, jobName, buildNumber, displayName } = entry
  const [info, setInfo] = useState<BuildInfo | null>(null)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState<BuildOp | null>(null)
  const [opMessage, setOpMessage] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<BuildSubTab>('log')

  const { building, queued, result } = deriveState(entry, info)

  // 装载构建状态（操作后 reload 刷新）
  useEffect(() => {
    if (queued) return
    let cancelled = false
    setLoadError(null)
    fetchBuildStatus(connection, jobName, buildNumber && buildNumber > 0 ? buildNumber : undefined, { sessionId })
      .then((status) => {
        if (!cancelled) setInfo(status)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [connection, jobName, buildNumber, sessionId, queued, reload])

  // 构建中状态轮询（用户 V7 点 1：状态需自动变化）：仅构建中轮询，终态即停 →
  // 操作按钮（取消 → 重试/删除）与头部的「构建中/耗时」随之自动刷新。
  useEffect(() => {
    if (queued || !building) return
    let cancelled = false
    const timer = setInterval(() => {
      fetchBuildStatus(connection, jobName, buildNumber && buildNumber > 0 ? buildNumber : undefined, { sessionId })
        .then((status) => {
          if (!cancelled) setInfo(status)
        })
        .catch(() => {
          // 瞬时错误静默，下一轮重试（状态未变无需打断）
        })
    }, STATUS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [connection, jobName, buildNumber, sessionId, queued, building])

  const buttons = opButtonsFor({ building, queued, result })

  // 任务触发的参数信息：优先 build.status 的实际采用参数（actions.parameters），
  // 无则回退触发记录采样（entry.params，排队中/未装载时）——每行一个参数展示。
  const fromInfo = extractBuildParams(info)
  const paramList = fromInfo.length > 0 ? fromInfo : entryParams(entry)

  // 任务名链接：由构建 URL 派生任务页地址（打开新窗口，免登录按用户要求不处理）
  const jobHref = buildJobLink(info?.url)

  // 操作提示自动消失（与总览删除提示同款：用户反馈常驻提示不必要）：3s 后清除；
  // timer ref 防竞态（连续操作时旧 timer 不得清掉新消息），卸载时清理。
  const opTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flashMessage = (message: string) => {
    setOpMessage(message)
    if (opTimerRef.current) clearTimeout(opTimerRef.current)
    opTimerRef.current = setTimeout(() => setOpMessage(null), 3000)
  }
  useEffect(
    () => () => {
      if (opTimerRef.current) clearTimeout(opTimerRef.current)
    },
    [],
  )

  const runOp = async (op: BuildOp) => {
    setBusy(op)
    setOpMessage(null)
    try {
      if (op === 'retry') {
        const res = await retryBuild(connection, jobName, buildNumber && buildNumber > 0 ? buildNumber : undefined, { sessionId })
        flashMessage(res.message)
      } else if (op === 'cancel') {
        const res = await cancelBuild(connection, jobName, { buildNumber: buildNumber && buildNumber > 0 ? buildNumber : undefined }, { sessionId })
        flashMessage(res.message)
      } else {
        const res = await deleteBuild(connection, jobName, buildNumber ?? 0, { sessionId })
        flashMessage(res.message)
      }
      setReload((n) => n + 1) // 操作后刷新状态
    } catch (err) {
      flashMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const tabs: Array<{ key: BuildSubTab; label: string }> = [
    { key: 'log', label: '日志' },
    { key: 'artifacts', label: '产物' },
    { key: 'workspace', label: '工作空间' },
  ]

  return (
    <div data-dsh-jenkins-panel-build-detail="">
      <div className="jenkins_buildHeaderRow">
        <div className="jenkins_back" onClick={onBack}>‹ 返回</div>
        <div className="jenkins_buildTitle">
          <span>{displayName ?? jobName}</span>
          {connection && (
            <>
              <span className="jenkins_buildSep">·</span>
              <span className="jenkins_connTag">{connection}</span>
            </>
          )}
          <span className="jenkins_buildSep">·</span>
          <span className="jenkins_connTag">{queued ? '排队中' : buildNumber && buildNumber > 0 ? `#${buildNumber}` : '最新构建'}</span>
          <span
            className={`jenkins_st ${buildStatusDotClass({ building, queued, result })}`}
            style={{ marginLeft: 8 }}
            title={`构建状态：${buildStatusDotTitle({ building, queued, result })}`}
          />
        </div>
      </div>
      <div className="jenkins_detailHead">
        <div className="jenkins_detailTop">
          <div className="jenkins_detailSub">
            {jobHref ? (
              <a className="jenkins_jobLink" href={jobHref} target="_blank" rel="noopener noreferrer" title="在 Jenkins 新窗口中打开该任务">
                {jobName}
              </a>
            ) : (
              jobName
            )}
            {info?.timestamp ? ` · ${formatTime(info.timestamp)}` : ''}
            {info?.duration != null ? ` · 耗时 ${formatDuration(info.duration)}` : ''}
          </div>
          <div className="jenkins_ops">
            {buttons.retry && (
              <button type="button" className="jenkins_pillBtn" onClick={() => runOp('retry')} disabled={busy !== null}>
                {busy === 'retry' ? '重试中…' : '重试'}
              </button>
            )}
            {buttons.cancel && (
              <button type="button" className="jenkins_pillBtn jenkins_pillBtnDanger" onClick={() => runOp('cancel')} disabled={busy !== null}>
                {busy === 'cancel' ? '取消中…' : queued ? '取消排队' : '取消'}
              </button>
            )}
            {buttons.delete && (
              <button type="button" className="jenkins_pillBtn jenkins_pillBtnDanger" onClick={() => runOp('delete')} disabled={busy !== null}>
                {busy === 'delete' ? '删除中…' : '删除'}
              </button>
            )}
          </div>
        </div>
        {paramList.length > 0 && (
          <div className="jenkins_params">
            <div className="jenkins_paramsTitle">构建参数</div>
            {paramList.map((p) => (
              <div className="jenkins_paramRow" key={p.name}>
                <span className="jenkins_paramKey">
                  {p.name}
                  <span className="jenkins_paramColon">:</span>
                </span>
                <span className="jenkins_paramValue">{p.value}</span>
              </div>
            ))}
          </div>
        )}
        {loadError && <div className="jenkins_tnodeError">{loadError}</div>}
        {opMessage && <div className="jenkins_opMessage">{opMessage}</div>}
      </div>

      <div className="jenkins_subTabs">
        {tabs.map((t) => (
          <span
            key={t.key}
            className={tab === t.key ? 'jenkins_subTab jenkins_subTabOn' : 'jenkins_subTab'}
            data-sub={t.key}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </span>
        ))}
      </div>

      {tab === 'log' && (
        <BuildLogView connection={connection} jobName={jobName} buildNumber={buildNumber} queued={queued} sessionId={sessionId} visible={visible} buildUrl={info?.url} />
      )}
      {tab === 'artifacts' && (
        <ArtifactsView connection={connection} jobName={jobName} buildNumber={buildNumber} queued={queued} sessionId={sessionId} />
      )}
      {tab === 'workspace' && <WorkspaceView connection={connection} jobName={jobName} queued={queued} sessionId={sessionId} />}
    </div>
  )
}
