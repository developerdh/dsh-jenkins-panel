/**
 * 任务详情视图（CLIENT-M2-05；docs §3.3 JobDetailView、prototype .detail-head/.detail-kv 口径）
 *
 * 组装：任务头（displayName/fullName/conn/描述/颜色状态点）+ 参数定义**只读现拉**
 * （Password/Text 类不展示值）+ 构建历史（状态点映射 + 时间/耗时 + 「加载更多」分页）
 * → 构建历史行点击穿透到构建详情（M2-06 BuildDetailView）；返回任务树（JobsView 常驻挂载，
 * 展开状态保持）。
 *
 * 纯函数（shortType / renderParamValue / historyStatusKey）导出供单测，不依赖 DOM。
 */
import { useEffect, useState } from 'react'

import {
  fetchBuildHistory,
  fetchJobInfo,
  fetchJobParams,
  type BuildHistory,
  type JobInfo,
  type ParameterDefinition,
} from '../api.js'
import { colorToStatus } from './folder-tree.js'
import { formatDuration, formatTime, type BuildDetailEntry } from './build-detail-view.js'

export interface JobDetailEntry {
  connection: string
  /** 任务名或路径（fullName 优先） */
  jobName: string
  displayName?: string
}

export interface JobDetailViewProps {
  entry: JobDetailEntry
  sessionId?: string
  /** 面板是否可见（0.1.5 起由宿主注入；形状与兄弟视图一致，本视图暂未消费） */
  visible: boolean
  /** 构建历史行点击 → 构建详情（M2-06） */
  onOpenBuild: (entry: BuildDetailEntry) => void
  onBack: () => void
}

/** 历史每页条数 */
export const HISTORY_PAGE_SIZE = 20

/** 不展示值的参数类型（Password/Text——避免泄漏敏感/超长文本） */
const HIDDEN_VALUE_TYPES = new Set(['PasswordParameterDefinition', 'TextParameterDefinition'])

/**
 * 类型短名：'StringParameterDefinition' → 'String'；兼容完整类名 'hudson.model.StringParameterDefinition'
 * （原型 detail-kv 展示口径）。容错：参数值缺失 type/_class 时显示 '未知'，不抛错。
 */
export function shortType(type: string | null | undefined): string {
  if (typeof type !== 'string' || type === '') return '未知'
  const short = type.split('.').pop() ?? type
  return short.endsWith('ParameterDefinition') ? short.slice(0, -'ParameterDefinition'.length) : short
}

/** 参数值渲染（纯函数）：Password/Text 脱敏；默认值；choices 拼接；缺省 '—' */
export function renderParamValue(param: ParameterDefinition): string {
  const type = param.type ?? param._class
  if (HIDDEN_VALUE_TYPES.has(type)) return '••••••'
  const value = param.defaultParameterValue?.value
  const valueText = value === undefined || value === null || value === '' ? '' : String(value)
  const choicesText = Array.isArray(param.choices) && param.choices.length > 0 ? param.choices.join(' / ') : ''
  return [valueText, choicesText].filter(Boolean).join(' · ') || '—'
}

/** 默认值展示（纯函数）：Password/Text 脱敏，带「默认值：」前缀；无默认值 → '' */
export function renderParamDefault(param: ParameterDefinition): string {
  const type = param.type ?? param._class
  const value = param.defaultParameterValue?.value
  if (value === undefined || value === null || value === '') return ''
  const display = HIDDEN_VALUE_TYPES.has(type) ? '••••••' : String(value)
  return `默认值：${display}`
}

/** 选项展示（纯函数）：choices 以「选项：a / b / c」拼接；无 choices → '' */
export function renderParamChoices(param: ParameterDefinition): string {
  if (!Array.isArray(param.choices) || param.choices.length === 0) return ''
  return `选项：${param.choices.join(' / ')}`
}

/** 构建历史状态点（SUCCESS→ok / FAILURE→fail / ABORTED→aborted / 构建中→run / 其余→warn） */
export function historyStatusKey(build: { building: boolean; result?: string }): 'ok' | 'fail' | 'aborted' | 'run' | 'warn' {
  if (build.building) return 'run'
  switch (build.result) {
    case 'SUCCESS':
      return 'ok'
    case 'FAILURE':
      return 'fail'
    case 'ABORTED':
      return 'aborted'
    default:
      return 'warn' // UNSTABLE / NOT_BUILT / 未知
  }
}

const HISTORY_STATUS_CLASS: Record<'ok' | 'fail' | 'aborted' | 'run' | 'warn' | 'disabled', string> = {
  ok: 'jenkins_stOk',
  fail: 'jenkins_stFail',
  aborted: 'jenkins_stAborted',
  run: 'jenkins_stRun',
  warn: 'jenkins_stWarn',
  disabled: 'jenkins_stDisabled',
}

export function JobDetailView({ entry, sessionId, visible: _visible, onOpenBuild, onBack }: JobDetailViewProps) {
  const { connection, jobName, displayName } = entry
  const [info, setInfo] = useState<JobInfo | null>(null)
  const [params, setParams] = useState<ParameterDefinition[] | null>(null)
  const [history, setHistory] = useState<BuildHistory | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 并行加载：job.info + job.params（现拉无缓存）+ build.history（首页）
  useEffect(() => {
    let cancelled = false
    setInfo(null)
    setParams(null)
    setHistory(null)
    setError(null)
    Promise.all([
      fetchJobInfo(connection, jobName, { sessionId }),
      fetchJobParams(connection, jobName, { sessionId }),
      fetchBuildHistory(connection, jobName, { limit: HISTORY_PAGE_SIZE }, { sessionId }),
    ])
      .then(([jobInfo, jobParams, buildHistory]) => {
        if (cancelled) return
        setInfo(jobInfo)
        setParams(jobParams)
        setHistory(buildHistory)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [connection, jobName, sessionId])

  const loadMore = async () => {
    const next = (history?.builds.length ?? 0) + HISTORY_PAGE_SIZE
    try {
      const more = await fetchBuildHistory(connection, jobName, { limit: next }, { sessionId })
      setHistory(more)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (error) {
    return (
      <div>
        <div className="jenkins_back" onClick={onBack}>‹ 返回任务列表</div>
        <div className="jenkins_empty">加载失败：{error}</div>
      </div>
    )
  }

  const statusClass = info?.color ? HISTORY_STATUS_CLASS[colorToStatus(info.color)] : undefined

  return (
    <div data-dsh-jenkins-panel-job-detail="">
      <div className="jenkins_buildHeaderRow">
        <div className="jenkins_back" onClick={onBack}>‹ 返回任务列表</div>
        <div className="jenkins_buildTitle">
          <span>{displayName ?? info?.name ?? jobName}</span>
          {connection && (
            <>
              <span className="jenkins_buildSep">·</span>
              <span className="jenkins_connTag">{connection}</span>
            </>
          )}
          {statusClass && <span className={`jenkins_st ${statusClass}`} style={{ marginLeft: 8 }} />}
        </div>
      </div>
      <div className="jenkins_detailHead">
        <div className="jenkins_detailSub">
          {info?.url ? (
            <a className="jenkins_jobLink" href={info.url} target="_blank" rel="noopener noreferrer" title="在 Jenkins 新窗口中打开该任务">
              {info?.fullName ?? jobName}
            </a>
          ) : (
            info?.fullName ?? jobName
          )}
        </div>
        {info?.description && <div className="jenkins_kv" style={{ marginTop: 6 }}>{info.description}</div>}
        {info && (
          <div className="jenkins_kv" style={{ marginTop: 4 }}>
            <span className="jenkins_kvKey">可构建：</span>
            {info.buildable ? '是' : '否'}
            {info.inQueue ? ' · 队列中' : ''}
            {info.nextBuildNumber > 0 ? ` · 下一个构建 #${info.nextBuildNumber}` : ''}
          </div>
        )}
      </div>

      <div className="jenkins_groupTitle">参数定义</div>
      {params === null ? (
        <div className="jenkins_empty">加载参数…</div>
      ) : params.length === 0 ? (
        <div className="jenkins_empty">该任务无参数</div>
      ) : (
        <div className="jenkins_paramDefBox">
          {params.map((p, idx) => {
            const def = renderParamDefault(p)
            const choices = renderParamChoices(p)
            return (
              <div key={p.name ?? `param-${idx}`} className="jenkins_paramDef">
                <div className="jenkins_paramDefHead">
                  <span className="jenkins_paramDefName">{p.name ?? `参数 ${idx + 1}`}</span>
                  <span className="jenkins_paramDefType">{shortType(p.type ?? p._class)}</span>
                </div>
                {p.description && <div className="jenkins_paramDefDesc">{p.description}</div>}
                {(def || choices) && (
                  <div className="jenkins_paramDefMeta">
                    {def && <span>{def}</span>}
                    {choices && <span>{choices}</span>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="jenkins_groupTitle">构建历史{history ? `（${history.totalCount}）` : ''}</div>
      {history === null ? (
        <div className="jenkins_empty">加载历史…</div>
      ) : history.builds.length === 0 ? (
        <div className="jenkins_empty">暂无构建记录</div>
      ) : (
        <>
          {history.builds.map((b) => {
            const key = historyStatusKey(b)
            return (
              <div
                key={b.number}
                className="jenkins_row"
                data-go-build={b.number}
                onClick={() =>
                  onOpenBuild({
                    connection,
                    jobName,
                    buildNumber: b.number,
                    displayName: displayName ?? info?.name ?? jobName,
                    status: b.building ? 'running' : b.result === 'SUCCESS' ? 'ok' : b.result === 'FAILURE' ? 'fail' : 'aborted',
                  })
                }
                title={`打开构建 #${b.number}`}
              >
                <span className={`jenkins_st ${HISTORY_STATUS_CLASS[key]}`} />
                <span className="jenkins_rowMain">
                  <span className="jenkins_pathText">#{b.number}</span>
                </span>
                <span className="jenkins_metaRight">
                  {formatTime(b.timestamp)}
                  {b.duration != null ? ` · ${formatDuration(b.duration)}` : ''}
                  {b.building ? ' · 构建中' : b.result ? ` · ${b.result}` : ''}
                </span>
              </div>
            )
          })}
          {history.builds.length < history.totalCount && (
            <div className="jenkins_toolbar" style={{ marginTop: 8 }}>
              <button type="button" className="jenkins_pillBtn" onClick={loadMore}>
                加载更多（{history.builds.length}/{history.totalCount}）
              </button>
            </div>
          )}
        </>
      )}
      <div className="jenkins_note">构建历史行点击进入构建详情。</div>
    </div>
  )
}
