/**
 * dsh 0.2.0 client 宿主面（本地类型声明，随插件交付）
 *
 * 为什么不直接装官方包：`@deepseek-ai/dsh-api-session-controller` 等有 30+ 个
 * `^0.2.0-rc.2` peer，本工程 `.npmrc` 开着 `auto-install-peers=true`，安装会试图拉
 * 整个官方依赖图（0.1.5 升级时就曾因 `@deepseek-ai/dsh-sandbox` 无匹配版本卡死）。
 * 而这些包对本插件**只提供类型**，运行时由宿主播种（`dsh.client.inject` 的信息性
 * 清单负责模块到达顺序），故此处按公开 `.d.ts` 契约本地镜像必要面，避免把宿主实现
 * 拉进构建。
 *
 * 依据（0.2.0-rc.2 实测；全程对照 docs/reports/dsh-0.2.0-upgrade-impact.md）：
 * - `ctx.slots`：`@deepseek-ai/dsh-client-ui-renderer/lib/types/client/index.d.ts`
 * - `ctx.sidebarRight` / `ctx.sidebarRightTabs`：`@deepseek-ai/dsh-client-ui-sidebar-right/lib/types/client/index.d.ts`
 * - `ctx.sessions`：`@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/sessions.d.ts`
 * - `ctx.uiConversation`：`@deepseek-ai/dsh-client-ui-conversation/lib/types/client/index.d.ts`
 *
 * 0.2.0 相对 0.1.5 的镜像面变化：
 * - 会话层改引用计数 retain 模型：`SessionListState` **删除 `current` 字段**
 *   （官方注释：navigation belongs to view owners），快照只剩 `{ ids }`；行结构里
 *   `completed` 移除、新增 `retainedBy`（本插件均不消费）。「屏幕上的会话」的官方
 *   唯一语义出口是 `ISidebarRight.mounted`（ObservableSnapshot<SessionId | undefined>，
 *   主栏为会话 Conversation 时当前选中的会话，先于 React 渲染变更）——本插件的
 *   `useSessionId` 已整体换源到它（见 panel/session.ts）。
 * - ⚠️ retain 约束（R5）：`binding(id)` 语义收紧为「借用**已 retain** 的绑定，无
 *   retained generation 返回 undefined」。本插件不绑定 Session 对象（声明面仅保留
 *   最小形状），不踩 retain 责任；未来若面板需要绑 Session，必须走 `retain/using`。
 *
 * 来源与许可：类型面镜像自 MIT 许可的 `@deepseek-ai/dsh-*` 0.2.0 包（Copyright DeepSeek），
 * 仅保留本插件使用的最小面；随本仓库（MIT）分发。
 */
import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

/** `ctx.slots`（SlotRegistry 是 SlotCore 的 Service 包装；本插件只用 register/inject） */
interface SlotsFace {
  register: SlotCore['register']
  inject: SlotCore['inject']
}

/** 右侧栏页签类型注册面（stage 1） */
interface SidebarRightTabsFace {
  register: (definition: {
    readonly id: string
    readonly kind: string
    readonly priority?: 'extension' | 'builtin' | 'fallback'
    readonly title: (address: string) => string
    readonly patterns?: readonly string[]
  }) => () => void
  get: (kind: string) => { readonly id: string; readonly kind: string } | undefined
}

/** ObservableSnapshot 最小面（0.2.0 `ISidebarRight.mounted` 的载体类型） */
interface ObservableSnapshotLike<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
}

/** 右侧栏导航/呈现面（`ctx.sidebarRight`，ISidebarRight 必要子集） */
interface SidebarRightFace {
  openTab: (kind: string, options?: { readonly paneId?: unknown; readonly params?: unknown }) => void
  close: (tabId: unknown) => void
  active: () => { readonly id: unknown; readonly kind: string } | undefined
  isExpanded: () => boolean
  toggleExpanded: () => void
  /**
   * 「屏幕上的会话」：主栏为会话 Conversation 时当前选中的会话 id（0.2.0 新增）。
   * 0.2.0 起 `sessions.list.current` 已删除，这是官方唯一的当前会话语义出口，
   * 也是本插件 `useSessionId` 的快照源。
   */
  readonly mounted: ObservableSnapshotLike<string | undefined>
}

/** 会话列表面（`ctx.sessions.list`，0.2.0 SessionListState 的必要子集：无 `current`） */
interface SessionsListFace {
  getSnapshot: () => { readonly ids: readonly string[] }
  subscribe: (fn: () => void) => () => void
}

/** 会话服务面（`ctx.sessions`；0.2.0 retain 模型下本插件只保留最小读面） */
interface SessionsFace {
  readonly list: SessionsListFace
  /**
   * 0.2.0 语义收紧：仅返回**已 retain** 的绑定（无 retained generation → undefined）。
   * 本插件 client 代码不调用（仅声明面保留形状，供未来评估 retain/using）。
   */
  binding: (id: string) => { readonly session: { getSnapshot: () => unknown; subscribe: (fn: () => void) => () => void } } | undefined
}

/** Conversation Definition（`ctx.uiConversation.events.register` 的入参） */
interface ConversationNodeDefinitionLike {
  readonly kind: string
  readonly target?: string
  match: (event: never) => { readonly id: string; readonly role: 'start' | 'update' } | null
  start: (...args: never[]) => unknown
  update: (...args: never[]) => unknown
}

/** Conversation 装配面（`ctx.uiConversation`） */
interface UiConversationFace {
  readonly events: { register: (definition: ConversationNodeDefinitionLike) => () => void }
}

/**
 * 页签正文信息（`SidebarRightTabInfo` 必要子集）。
 *
 * keyed 槽位 `sidebar.right.pane.tab` 声明了槽位级 inject hooks
 * `{ hooks: { tabInfo: SlotHookFactory } }`（contract/slots.d.ts，0.2.0-rc.2 合同未变）；
 * 渲染器把 hooks 成员合成为 `use<Name>` 组件 prop（本例 `useTabInfo`），调用即得本面。
 * `tab.visible`：停靠 = 列展开且本页签激活；浮出恒 true（0.2.0 已文档化，语义不变）。
 * 0.2.0 的 `tab` 变为 `TabRecord & {...}`（新增 signal/actions 等字段，纯增量）。
 */
export interface SidebarRightTabInfoFace {
  readonly sidebar: { readonly expanded: boolean; readonly fullscreen: boolean }
  readonly tab: { readonly visible: boolean }
}

/* ── 插件页配置槽位（@deepseek-ai/dsh-client-ui-plugin-manager client/slot-contract 最小镜像；
 *    依据 0.2.0-rc.2 官方类型，仅保留本插件消费的面；注册经 ctx.slots，不 import 该包） ── */

/** settings 路径操作（`SettingsPathOpView` 最小镜像：空 path 寻址 section 根） */
export type SettingsPathOpLike =
  | { readonly op: 'set'; readonly path: string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: string[] }

/** 配置表单快照（`ConfigFormSnapshot` 最小镜像：本插件只消费 status/value/writable） */
export interface ConfigFormSnapshotLike {
  /** `loading` 到首个已接受段为止；`unavailable` = 命名空间对本客户端不可写/不可见（memory 模式） */
  readonly status: 'loading' | 'ready' | 'unavailable'
  /** 最近一次 schema 解析后的 section 值（= 插件 Config 形状，含默认值） */
  readonly value: Record<string, unknown> | undefined
  /** 宿主文档是否接受写入 */
  readonly writable: boolean
}

/** 宿主配置表单（`ConfigPageForm` 最小镜像：页面级快照 + 整段原子写，修订围栏由宿主承担） */
export interface ConfigPageFormLike {
  readonly state: ConfigFormSnapshotLike
  mutate: (ops: readonly SettingsPathOpLike[]) => Promise<boolean>
}

/** 插件页配置槽位 owner props（`PluginConfigViewProps` 最小镜像） */
export interface PluginConfigViewProps {
  /** `summary` = 行描述回退的一行摘要；`page` = 带保存控件的完整表单（bundle.config 只收到 page） */
  readonly view: 'summary' | 'page'
  /** 宿主持有的配置值与写入通道；缺席/不可写 = 本环境不可编辑（memory 模式等） */
  readonly form?: ConfigPageFormLike | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 渲染器拥有的 UI 组合注册表（`@deepseek-ai/dsh-client-ui-renderer`）。 */
    slots: SlotsFace
    /** 右侧栏页签类型注册表（`@deepseek-ai/dsh-client-ui-sidebar-right`）。 */
    sidebarRightTabs: SidebarRightTabsFace
    /** 右侧栏导航与呈现面（`@deepseek-ai/dsh-client-ui-sidebar-right`）。 */
    sidebarRight: SidebarRightFace
    /** Client Session 对象层（`@deepseek-ai/dsh-api-session-controller`）。 */
    sessions: SessionsFace
    /** 目标中立的 Conversation 注册表（`@deepseek-ai/dsh-client-ui-conversation`）。 */
    uiConversation: UiConversationFace
  }
}

export {}
