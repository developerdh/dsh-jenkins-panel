/**
 * 当前会话跟踪（0.2.0 换源改造）
 *
 * 0.1.5：读 `ctx.sessions.list`（ObservableSnapshot）快照的 `current` 字段
 * （原实现内联在 panel-host 的 mountPanel 里，0.1.5 挂载改造时抽为本 hook）。
 *
 * 0.2.0：会话层改引用计数 retain 模型，`SessionListState` **删除 `current` 字段**
 * （官方注释：navigation belongs to view owners）——旧路径在 0.2.0 必然失效。
 * 「屏幕上的会话」的官方唯一语义出口是 `ctx.sidebarRight.mounted`
 * （ObservableSnapshot<string | undefined>：主栏为会话 Conversation 时当前选中的
 * 会话 id，先于 React 渲染变更）。本 hook 快照源**整体切换**到它（升级影响报告
 * §4.6 定案，不采用 session-scoped 标准 prop 方案；对槽位「每会话重挂/复用」的
 * 框架语义差异免疫），仍是全插件唯一的会话源单点——panel-host/store/overview/
 * jobs 全链路经本 hook 自动跟随，无第二处改动。
 *
 * 本 hook 只做「mounted 快照 → 当前会话 id」的 React 绑定，不触碰 store；会话切换后的
 * store 联动由调用方 effect 承担（单一写点）。
 */
import { useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** 读当前会话 id（无 sidebarRight 服务 / 屏幕上无会话 → undefined） */
export function useSessionId(ctx: ClientContext): string | undefined {
  const mounted = ctx.sidebarRight?.mounted
  const subscribe = (onChange: () => void) => (mounted ? mounted.subscribe(onChange) : () => {})
  const getSnapshot = () => (mounted ? mounted.getSnapshot() : undefined)
  return useSyncExternalStore(subscribe, getSnapshot)
}
