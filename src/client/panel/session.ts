/**
 * 当前会话跟踪（0.1.5 挂载改造）
 *
 * 原实现内联在 panel-host 的 mountPanel 里（`ctx.sessions.list` 的 ObservableSnapshot
 * 订阅 + panelStore.setActiveSession）。0.1.5 实测：`ctx.sessions.list` 契约原样保留，
 * 提供者由已消失的 `dsh-client-runtime` 变为 `@deepseek-ai/dsh-api-session-controller`
 * （ISessions.list，SessionListState.current = 当前会话 id）。
 *
 * 本 hook 只做「列表快照 → 当前会话 id」的 React 绑定，不触碰 store；会话切换后的
 * store 联动由调用方 effect 承担（单一写点）。
 */
import { useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** 读当前会话 id（无 sessions 服务 / 无会话 → undefined） */
export function useSessionId(ctx: ClientContext): string | undefined {
  const list = ctx.sessions?.list
  const subscribe = (onChange: () => void) => (list ? list.subscribe(onChange) : () => {})
  const getSnapshot = () => (list ? list.getSnapshot().current : undefined)
  return useSyncExternalStore(subscribe, getSnapshot)
}
