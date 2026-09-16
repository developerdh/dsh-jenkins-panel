/**
 * 面板会话 store（0.1.5 挂载改造后）
 *
 * 0.1.5 起自研面板注册进官方右侧栏（`sidebar.right.pane.tab`）：
 * - **开关状态（expanded）归官方 `ctx.sidebarRight` 单一事实源**；
 * - **宽度（含拖拽调宽）归官方 `rightbar` 列几何**——插件不再自绘宽度。
 *
 * 故本 store 只保留「当前激活会话 id」这一仍属插件自有的状态：面板内容按会话隔离
 * （总览/任务视图的会话口径随 `ctx.sessions.list.current` 走）。
 *
 * visible（面板是否展开）：由官方库驱动（`isExpanded()`），不再由本 store 表达；
 * 面板内轮询门控改由宿主注入的 visible 布尔（panel-host 从官方状态派生后下传）。
 *
 * React 快照约定：`getActiveSessionId` 返回**稳定引用**；本 store 不依赖 DOM，
 * 可在 node 环境单测。
 */

export interface PanelStoreSnapshot {
  /** 当前激活会话 id（无会话 = undefined） */
  activeSessionId: string | undefined
}

export class PanelStore {
  private readonly listeners = new Set<() => void>()
  private activeSessionId: string | undefined
  private snapshot: PanelStoreSnapshot = { activeSessionId: undefined }

  /** 当前激活会话 id（稳定快照） */
  getActiveSessionId = (): string | undefined => this.activeSessionId

  /** 会话切换：面板内容（总览/任务）随当前会话走（ctx.sessions.list.current 变化时调用） */
  setActiveSession = (sessionId: string | undefined): void => {
    if (this.activeSessionId === sessionId) return
    this.activeSessionId = sessionId
    this.rebuild()
    this.emit()
  }

  /** React useSyncExternalStore 订阅 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 只读快照（调试/测试用；变更时整体重建，引用稳定） */
  getSnapshot = (): PanelStoreSnapshot => this.snapshot

  private rebuild(): void {
    this.snapshot = { activeSessionId: this.activeSessionId }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

export const panelStore = new PanelStore()
