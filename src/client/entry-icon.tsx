/**
 * Jenkins 面板入口（宿主官方槽位，0.1.5 挂载改造）
 *
 * 位置：宿主 **`sidebar.footer.action`**（list 槽位，加性）——左侧栏底部入口，
 * 位置确定、任何会话（含新建会话）都可见。名称「Jenkins面板」；`wide`=展开栏显示文字、
 * narrow（56px rail）只显图标。
 *
 * 交互（0.1.5 改造）：点击开合**官方右侧栏**——打开 `ctx.sidebarRight.openTab(kind)`，
 * 收起 `ctx.sidebarRight.toggleExpanded()`；active 态读 `isExpanded()`。
 * 0.1.1 的 `panelStore.toggle/isVisible`（自绘容器开关）已随容器一起移除——
 * 开关状态现在是官方列的单一事实源。
 *
 * 与 dsh-eap-todo 共存：两者都注册 `sidebar.footer.action`（list 槽位），不同 id
 * （`dsh-jenkins-panel` vs `eap-todo-entry`）→ 并列共存不冲突，入口竖排共处左侧栏底部。
 */
import { useEffect, useState } from 'react'
import type { SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

import { isJenkinsPanelOpen, openJenkinsPanel, closeJenkinsPanel } from './panel/mount.js'

const SIDEBAR_FOOTER_SLOT = 'sidebar.footer.action' as keyof SlotMap & string

/** active 态类名（纯函数，可单测）：面板开 → 亮色 */
export function entryIconClass(active: boolean): string {
  return active ? 'jenkins_entryIcon jenkins_entryIconActive' : 'jenkins_entryIcon'
}

/** 面板开关是否展开（纯函数，供单测）：供 React 状态与官方列状态对齐 */
export function nextOpenState(current: boolean): boolean {
  return !current
}

const JENKINS_ICON_URL = 'https://www.jenkins.io/favicon.ico'

/**
 * 入口图标：点击开关官方右侧栏。
 * active 态不订阅官方 store（避免引入官方内部通道），改为点击后本地翻转 + 轻量轮询校准，
 * 保证「点击 → 高亮」即时、且外部收起（用户点官方 expand/collapse）后能跟随。
 */
function JenkinsEntry(props: { wide?: boolean; ctx?: ClientContext }) {
  const wide = props.wide !== false
  const ctx = props.ctx
  const [active, setActive] = useState(() => (ctx ? isJenkinsPanelOpen(ctx) : false))

  // 低频校准（500ms）：外部（官方列自身控件）改动后同步高亮；无 ctx/服务时保持本地值
  useEffect(() => {
    if (!ctx) return
    const timer = setInterval(() => setActive(isJenkinsPanelOpen(ctx)), 500)
    return () => clearInterval(timer)
  }, [ctx])

  const toggle = () => {
    if (!ctx) {
      setActive(nextOpenState)
      return
    }
    if (isJenkinsPanelOpen(ctx)) closeJenkinsPanel(ctx)
    else openJenkinsPanel(ctx)
    setActive((prev) => nextOpenState(prev))
  }

  return (
    <button
      type="button"
      className={entryIconClass(active)}
      data-dsh-jenkins-panel-entry=""
      aria-label="Jenkins 面板"
      aria-pressed={active}
      title="Jenkins 面板"
      onClick={toggle}
    >
      <img src={JENKINS_ICON_URL} alt="" draggable={false} width={16} height={16} className="jenkins_entryIconImg" referrerPolicy="no-referrer" />
      {wide && <span className="jenkins_entryLabel">Jenkins面板</span>}
    </button>
  )
}

/**
 * 注册入口图标（index.tsx 三 effect 之一）：`sidebar.footer.action` 加性槽位（id=dsh-jenkins-panel、
 * label「Jenkins面板」）；slot 类型面未装 → key 断言 + 参数放宽（as never，同 M2-02 模式）。
 * 槽位不可用时降级 no-op（不抛错）。返回 disposer。
 */
export function registerEntryIcon(ctx: ClientContext): () => void {
  try {
    return ctx.slots.inject(SIDEBAR_FOOTER_SLOT, () =>
      ctx.slots.register(
        { name: SIDEBAR_FOOTER_SLOT, id: 'dsh-jenkins-panel', label: () => 'Jenkins面板', inject: () => ({ ctx }) } as never,
        JenkinsEntry as never,
      ),
    )
  } catch {
    console.warn('[dsh-jenkins-panel] sidebar.footer.action 槽位注册失败（入口降级为无）')
    return () => {}
  }
}
