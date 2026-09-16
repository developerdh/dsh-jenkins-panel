/**
 * dsh 0.1.5 client 宿主面（本地类型声明，随插件交付）
 *
 * 为什么不直接装官方包：`@deepseek-ai/dsh-api-session-controller` 等有 30+ 个
 * `^0.1.5-rc.2` peer，本工程 `.npmrc` 开着 `auto-install-peers=true`，安装会试图拉
 * `@deepseek-ai/dsh-sandbox@>=0.1.5`（npm 上只有 0.0.1-rc.1 与 alpha/next tag）→
 * ERR_PNPM_NO_MATCHING_VERSION，且拖入整个官方依赖图。而这些包对本插件**只提供类型**，
 * 运行时由宿主播种（`dsh.client.inject` 的信息性清单负责模块到达顺序），故此处按公开
 * `.d.ts` 契约本地镜像必要面，避免把宿主实现拉进构建。
 *
 * 依据（0.1.5-rc.2 实测）：
 * - `ctx.slots`：`@deepseek-ai/dsh-client-ui-renderer/lib/types/client/index.d.ts`
 * - `ctx.sidebarRight` / `ctx.sidebarRightTabs`：`@deepseek-ai/dsh-client-ui-sidebar-right/lib/types/client/index.d.ts`
 * - `ctx.sessions`：`@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/sessions.d.ts`
 * - `ctx.uiConversation`：`@deepseek-ai/dsh-client-ui-conversation/lib/types/client/index.d.ts`
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

/** 右侧栏导航/呈现面（`ctx.sidebarRight`） */
interface SidebarRightFace {
  openTab: (kind: string, options?: { readonly paneId?: unknown; readonly params?: unknown }) => void
  close: (tabId: unknown) => void
  active: () => { readonly id: unknown; readonly kind: string } | undefined
  isExpanded: () => boolean
  toggleExpanded: () => void
}

/** 会话列表面（`ctx.sessions.list`，SessionListState 的必要子集） */
interface SessionsListFace {
  getSnapshot: () => { readonly current?: string | undefined; readonly ids: readonly string[] }
  subscribe: (fn: () => void) => () => void
}

/** 会话服务面（`ctx.sessions`） */
interface SessionsFace {
  readonly list: SessionsListFace
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
 * `{ hooks: { tabInfo: SlotHookFactory } }`（contract/slots.d.ts，0.1.5-rc.2）；
 * 渲染器把 hooks 成员合成为 `use<Name>` 组件 prop（本例 `useTabInfo`），调用即得本面。
 * `tab.visible`：停靠 = 列展开且本页签激活；浮出恒 true。
 */
export interface SidebarRightTabInfoFace {
  readonly sidebar: { readonly expanded: boolean; readonly fullscreen: boolean }
  readonly tab: { readonly visible: boolean }
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
