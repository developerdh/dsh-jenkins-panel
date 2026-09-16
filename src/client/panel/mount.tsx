/**
 * 面板挂载（0.1.5 官方右侧栏；替代原 body 级自绘容器）
 *
 * 官方两段式注册（0.1.5 实测，与官方 guide 页签同路径）：
 * 1. 页签类型 → `ctx.sidebarRightTabs.register({ id, kind, priority, title })`
 *    （id 是「实现身份」，也是第二段 body 注册用的 key；kind 是 `openTab` 用的判别符）
 * 2. 页签正文 → keyed 槽位 `sidebar.right.pane.tab` 注册，key = 上一步的 id
 *
 * 打开：`ctx.sidebarRight.openTab(kind)`（列会在同一步展开——内容看不见就等于没打开）。
 * 收起：`ctx.sidebarRight.toggleExpanded()` / `isExpanded()` —— 官方列自身状态是唯一事实源。
 *
 * 与 0.1.1 自绘容器的差异（本次改造的实质）：
 * - 不再 `document.body.appendChild` 固定含块、不再 createRoot、不再写 z-index / 推挤；
 * - 不再自建互斥（那是自绘容器与 better-sidebar 争同一块右侧空间的产物）；
 * - 官方列负责定位、几何、resize handle、展开/收起与列推挤。
 *
 * 容错：宿主未提供 sidebarRight（非 Web 形态 / 加载顺序未到）时降级为 no-op（不抛错），
 * 与本插件既有的 `as never` + try/catch 韧性风格一致。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'

import type { SidebarRightTabInfoFace } from '../types/dsh-0.1.5.js'
import { PanelBody } from './panel-host.js'

/** 页签类型 id（实现身份，= 正文注册的 key）；用包名，天然全局唯一 */
const TAB_ID = 'dsh-jenkins-panel'
/** 页签 kind（openTab 判别符） */
export const TAB_KIND = 'dsh-jenkins-panel'

/**
 * 官方右侧栏服务读取（未提供 → undefined）。
 * 类型来自 `src/client/types/dsh-0.1.5.d.ts` 的本地声明；运行时读**可选**（ctx 代理对
 * 未 provide 的服务读取返回 undefined，故这里不依赖 inject 守卫顺序，容错读一遍）。
 */
function sidebarRightOf(ctx: ClientContext): ClientContext['sidebarRight'] | undefined {
  try {
    return ctx.sidebarRight
  } catch {
    return undefined
  }
}

function sidebarRightTabsOf(ctx: ClientContext): ClientContext['sidebarRightTabs'] | undefined {
  try {
    return ctx.sidebarRightTabs
  } catch {
    return undefined
  }
}

/** 展开右侧栏（无服务 → no-op）。入口图标与触发联动共用。 */
export function openJenkinsPanel(ctx: ClientContext): void {
  try {
    sidebarRightOf(ctx)?.openTab(TAB_KIND)
  } catch {
    // 列未挂载（无会话 / 未装配）→ 静默降级
  }
}

/** 收起右侧栏（无服务 → no-op） */
export function closeJenkinsPanel(ctx: ClientContext): void {
  try {
    const sidebar = sidebarRightOf(ctx)
    if (!sidebar) return
    if (sidebar.isExpanded()) sidebar.toggleExpanded()
  } catch {
    // 同上
  }
}

/** 面板是否正在展示（无服务 / 未展开 → false） */
export function isJenkinsPanelOpen(ctx: ClientContext): boolean {
  try {
    return sidebarRightOf(ctx)?.isExpanded() === true
  } catch {
    return false
  }
}

/**
 * 「页签正文可见性」判定（纯函数，供单测）：官方 `SidebarRightTabInfo.tab.visible`
 * （停靠 = 列展开且本页签激活；浮出恒 true）。info 缺失/形状不完整 → 兜底 true
 * （与「官方槽位缺省时常显」的降级语义一致；stale/坏形状绝不能把面板打成不可见）。
 */
export function panelVisibleOf(info: SidebarRightTabInfoFace | undefined | null): boolean {
  return info?.tab?.visible !== false
}

/**
 * 注册页签类型 + 正文（index.tsx 三 effect 之一）。
 * 返回 disposer：逆序注销正文与类型（官方 register 的 disposer 已是幂等）。
 */
export function registerPanel(ctx: ClientContext): () => void {
  const tabs = sidebarRightTabsOf(ctx)
  if (!tabs) {
    console.warn('[dsh-jenkins-panel] 宿主未提供 sidebarRightTabs：面板注册降级为无（其余功能不受影响）')
    return () => {}
  }

  // 第一段：页签类型。page 类（不声明 patterns：`openTab(kind)` 打开，不识别资源地址）。
  // priority 'extension'（缺省即此）＝产品外插件的最高档，与官方 guide 的 'builtin' 不冲突
  // （kind 不同；即便撞档也由 coexists 规则拒绝并抛清晰错误）。
  const disposeType = tabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    priority: 'extension',
    title: () => 'Jenkins面板',
  })

  /**
   * 第二段：正文（keyed 槽位，key = 页签类型 id）。
   *
   * 桥接组件（官方 guide 同款形态，guide 定义于 apply 闭包内）：槽位框架传给正文
   * 组件的 props 只有框架标准面 + 槽位级 inject hooks（`useTabInfo`）+ 描述符 inject
   * 返回值——**不含 ctx**（0.1.5-rc.2 SlotCore/渲染器实测）。ctx 在框架里没有传递
   * 通道（「业务数据经 apply 闭包的 ctx 获取，不存在绑定对象参数」），因此组件定义
   * 在本闭包内捕获 ctx；0.1.5 升级首版直接注册 PanelBody、组件读 `props.ctx` 得
   * undefined → 渲染抛 TypeError → 槽位错误边界把 entry 从 keyed 槽位除名 → 页签
   * 整片空白（TabSlot 打开、正文零内容）的根因即此。
   *
   * 可见性：读槽位注入的 `useTabInfo().tab.visible`（响应式，随列展开/收起、页签
   * 切换更新）；prop 缺席（官方槽位未装配）→ panelVisibleOf 兜底 true。
   * 槽位类型面（SlotMap 声明合并）未装 → key 断言 + 参数放宽（as never，既有风格）。
   */
  function PanelBodyBridge(props: { useTabInfo?: () => SidebarRightTabInfoFace | undefined }) {
    const visible = panelVisibleOf(props.useTabInfo?.())
    return <PanelBody ctx={ctx} visible={visible} />
  }

  let disposeBody: () => void = () => {}
  try {
    disposeBody = ctx.slots.inject('sidebar.right.pane.tab' as never, () =>
      ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: TAB_ID } as never,
        PanelBodyBridge as never,
      ),
    ) as unknown as () => void
  } catch {
    console.warn('[dsh-jenkins-panel] sidebar.right.pane.tab 槽位注册失败（面板正文降级为无）')
  }

  return () => {
    disposeBody()
    disposeType()
  }
}
