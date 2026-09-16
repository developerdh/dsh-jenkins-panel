/**
 * Jenkins 面板正文（官方右侧栏页签 body，0.1.5 挂载改造）
 *
 * 挂载（0.1.5 实测）：本组件注册进官方右侧栏的 keyed 槽位
 * `sidebar.right.pane.tab`（key = 页签类型的 id，见 `mount.ts`）。官方 `rightbar`
 * 列自己承担定位、几何、resize handle、展开/收起与推挤——**插件不再自绘容器、不再
 * 直挂 document.body、不再写固定 z-index 与推挤**（那是 0.1.1 自绘容器的产物）。
 *
 * 可见性（0.1.5 实测）：官方把「列是否展开」记在它自己的 store，页签 body 经
 * slot-owned `useTabInfo()` 读到 `tab.visible`（浮出窗体恒 true；停靠时 = 列展开且
 * 本页签为所在面板的激活页签）。面板内轮询门控（总览刷新 / 日志跟随）改吃这个
 * `visible` 布尔，语义与原 `panelStore.isVisible` 一致——关闭/折叠即停。
 *
 * 宽度（0.1.5 交给官方）：面板宽度（含拖拽调宽）由官方 `rightbar` 列几何承担，
 * 插件不再自绘 resize-grip、不再写宽度变量/存宽度（store 只保留当前会话 id）。
 *
 * 会话（0.1.5 实测）：`ctx.sessions.list`（ObservableSnapshot，`current` 为当前会话 id）
 * 原样保留，提供者由已消失的 dsh-client-runtime 变为 dsh-api-session-controller。
 *
 * 内容区（CLIENT-M2-03/04/05/06 接入，逐项保留）：tab 栏（总览/任务）+ `data-dsh-jenkins-panel-content`
 * 双视图**常驻挂载**（tab 与 detail 控制显隐——总览过滤/任务树展开状态在返回时保持）：
 * 总览（OverviewView：触发记录 + 状态过滤 + visible 门控轮询）→ 任务（JobsView：连接切换器 +
 * 折叠树）→ 任务点击 → 任务详情（JobDetailView）→ 构建历史行点击 → 构建详情（BuildDetailView：
 * 日志/产物/工作空间/操作）。
 */
import { useEffect, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

// 构建期被改写成「运行时注入 <style>」模块（scripts/build-client.mjs），见该 CSS 头注
import '../jenkins.module.css'
import { listConnections, type TreeJobNode } from '../api.js'
import { panelStore } from './store.js'
import { useSessionId } from './session.js'
import { registerTriggerListener } from './trigger-listener.js'
import { OverviewView } from './overview-view.js'
import { JobsView } from './jobs-view.js'
import { JobDetailView } from './job-detail-view.js'
import { BuildDetailView, type BuildDetailEntry } from './build-detail-view.js'

/** 面板状态周期刷新间隔（用户 V7 点 1：状态更新时间需自动变化）；对齐 host registry 轮询 cadence */
const PANEL_REFRESH_MS = 15_000
/** Jenkins 官方 favicon（图标；与入口图标一致，用户 V7 要求） */
const JENKINS_ICON_URL = 'https://www.jenkins.io/favicon.ico'

/** 内容区导航状态：任务视图 / 任务详情（M2-05）/ 构建详情（M2-06） */
type PanelDetail =
  | { kind: 'job'; job: TreeJobNode; connection: string }
  | { kind: 'build'; entry: BuildDetailEntry }

/** 视图 tab（M2-03 引入：总览/任务，原型顺序，总览缺省激活） */
type PanelTab = 'overview' | 'jobs'

/**
 * 面板正文组件（页签 body）。`visible` 由 mount.tsx 桥接组件读槽位注入的
 * `useTabInfo().tab.visible` 派生后传入（官方槽位缺省时兜底 true）；`ctx` 同样由
 * 桥接组件经 apply 闭包传入（槽位框架不向正文组件传 ctx）。
 */
export function JenkinsPanel({ ctx, visible, sessionId }: { ctx: ClientContext; visible: boolean; sessionId: string | undefined }) {
  const [lastUpdated, setLastUpdated] = useState(() => new Date().toLocaleTimeString('zh-CN', { hour12: false }))
  // 视图 tab + 内容区导航（M2-03 总览 / M2-04 任务 / M2-05 任务详情 / M2-06 构建详情）
  const [tab, setTab] = useState<PanelTab>('overview')
  // 详情栈：任务列表 → 任务详情 → 构建详情（逐层入栈，返回逐层回退）。
  // 总览记录直达构建仅单层——返回即回总览列表，兼容总览/任务两处共用 BuildDetailView。
  const [detailStack, setDetailStack] = useState<PanelDetail[]>([])
  // 当前详情 = 栈顶；undefined → 展示当前 tab 的列表视图
  const detail = detailStack[detailStack.length - 1] ?? null
  // 周期刷新令牌：面板可见时每 15s 递增（驱动总览强制重拉；头部手动刷新按钮已移除）
  const [refreshToken, setRefreshToken] = useState(0)
  // 连接数（无配置 → 空态；CLIENT-M2-02 修复）：null = 加载中
  const [connCount, setConnCount] = useState<number | null>(null)

  // 连接数侦测（无配置 → 面板空态；改设置后由 settings 变更触发重拉按需）
  useEffect(() => {
    let cancelled = false
    listConnections()
      .then((list) => {
        if (!cancelled) setConnCount(list.length)
      })
      .catch(() => {
        if (!cancelled) setConnCount(0)
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  // 周期刷新（用户 V7 点 1）：面板可见时每 15s 更新「状态更新于」并触发总览重拉（对齐 host registry 轮询）
  useEffect(() => {
    if (!visible) return
    const timer = setInterval(() => {
      setLastUpdated(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
      setRefreshToken((n) => n + 1)
    }, PANEL_REFRESH_MS)
    return () => clearInterval(timer)
  }, [visible])

  /**
   * 触发联动（用户报障 + 需求，0.1.5 换通道）：
   * 1. 即时刷新——总览记录工具结果落库即重拉（原 15s 轮询）；
   * 2. 自动打开面板——对话中 `jenkins_build_trigger`/`jenkins_build_retry` 成功后展开右侧栏
   *    （用户确认：仅这两个工具、每次触发都开、**不切 tab**、保持当前视图/详情不动）。
   * 0.1.5 删除了 `SessionSnapshot.nodes`（影响报告 §4.2），原「扫描会话快照」改为注册官方
   * conversation definition（trigger-listener.ts）：语义等价（callId 去重、初始基线只记账、
   * 仅新到达的成功结果动作），且不依赖任何宿主内部结构。
   */
  useEffect(() => {
    if (!visible && !sessionId) return
    return registerTriggerListener(ctx, () => {
      setRefreshToken((n) => n + 1)
    })
  }, [ctx, sessionId])

  const switchTab = (next: PanelTab) => {
    setTab(next)
    setDetailStack([]) // 切 tab 返回对应列表视图
  }

  // 列表（总览记录 / 任务列表）直达详情：重置为单层，返回即回列表
  const openDetailFromList = (d: PanelDetail) => setDetailStack([d])
  // 从父级详情（任务详情）进入子级（构建详情）：入栈，返回回父级
  const openDetail = (d: PanelDetail) => setDetailStack((s) => [...s, d])
  // 返回：弹栈（有父级回父级，无则回当前 tab 列表）
  const closeDetail = () => setDetailStack((s) => s.slice(0, -1))

  return (
    <div className="jenkins_panel" data-dsh-jenkins-panel="" role="complementary" aria-label="Jenkins 面板">
      <div className="jenkins_panelInner">
        <header className="jenkins_header">
          <img src={JENKINS_ICON_URL} className="jenkins_logoImg" alt="" width={16} height={16} draggable={false} referrerPolicy="no-referrer" />
          <span className="jenkins_title">Jenkins面板</span>
          {/* 入口在左栏底部（sidebar.footer.action）：头部不放刷新/关闭按钮，
              避免与入口冲突；状态更新时间在标题后方、圆点放到文字后方。 */}
          <span className="jenkins_live">
            <span data-dsh-jenkins-panel-live-text="">状态更新于 {lastUpdated}</span>
            <span className="jenkins_liveDot" aria-hidden="true" />
          </span>
        </header>
        <div className="jenkins_tabs" data-dsh-jenkins-panel-tabs="" style={connCount === 0 ? { display: 'none' } : undefined}>
          <span className={tab === 'overview' ? 'jenkins_tab jenkins_tabOn' : 'jenkins_tab'} data-view="overview" onClick={() => switchTab('overview')}>
            总览
          </span>
          <span className={tab === 'jobs' ? 'jenkins_tab jenkins_tabOn' : 'jenkins_tab'} data-view="jobs" onClick={() => switchTab('jobs')}>
            任务
          </span>
        </div>
        <div className="jenkins_body" data-dsh-jenkins-panel-content="">
          {connCount === 0 && (
            <div className="jenkins_empty" data-dsh-jenkins-panel-empty="">
              尚未配置 Jenkins 连接。请到「设置 → Jenkins 连接」新增连接并设置 Token 后，此处即可浏览任务。
            </div>
          )}
          {/* 总览/任务双视图常驻挂载（tab 与 detail 控制显隐）——任务树展开状态/总览过滤在返回时保持 */}
          <div style={detail || tab !== 'overview' || connCount === 0 ? { display: 'none' } : undefined} data-dsh-jenkins-panel-overview-slot="">
            <OverviewView
              sessionId={sessionId}
              visible={visible}
              refreshToken={refreshToken}
              onOpenBuild={(entry) => openDetailFromList({ kind: 'build', entry })}
            />
          </div>
          <div style={detail || tab !== 'jobs' || connCount === 0 ? { display: 'none' } : undefined} data-dsh-jenkins-panel-jobs-slot="">
            <JobsView
              sessionId={sessionId}
              visible={visible}
              refreshToken={refreshToken}
              onOpenJob={(job, connection) => openDetailFromList({ kind: 'job', job, connection })}
            />
          </div>
          {detail?.kind === 'build' && (
            <BuildDetailView
              entry={detail.entry}
              sessionId={sessionId}
              visible={visible}
              onBack={closeDetail}
            />
          )}
          {detail?.kind === 'job' && (
            <JobDetailView
              entry={{
                connection: detail.connection,
                jobName: detail.job.fullName,
                displayName: detail.job.displayName ?? detail.job.name,
              }}
              sessionId={sessionId}
              visible={visible}
              onOpenBuild={(entry) => openDetail({ kind: 'build', entry })}
              onBack={closeDetail}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 页签正文（供 mount.ts 注册进官方 keyed 槽位 `sidebar.right.pane.tab`）：
 * 追踪当前会话（ctx.sessions.list），并从宿主注入的 `visible` 派生面板可见性。
 */
export function PanelBody(props: { ctx: ClientContext; visible?: boolean }) {
  const sessionId = useSessionId(props.ctx)
  // ctx.sessions.list 跟踪当前会话：随会话切换把面板宽度切到该会话的 key
  useEffect(() => {
    panelStore.setActiveSession(sessionId)
  }, [sessionId])
  return <JenkinsPanel ctx={props.ctx} visible={props.visible !== false} sessionId={sessionId} />
}
