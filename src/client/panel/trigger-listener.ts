/**
 * 触发联动（0.1.5 换通道；原实现：panel-host 扫描 `SessionSnapshot.nodes`）
 *
 * ⚠️ 迁移依据（影响报告 §4.2 + 0.1.5 实测）：0.1.5 删除了 `SessionSnapshot.nodes`，
 * 原「扫描会话快照里 tool-result 节点」的路径必然静默失效。报告推荐的「秒级轮询
 * triggered.list」是**用户可见行为退化**（即时 → 最多 15s），与本次硬性约束「不得改变
 * 已实现的功能行为」冲突。故采用 0.1.5 的正统扩展点：注册自定义 Conversation Definition
 * （与官方 chat 包的 tool 卡同一条路径；官方 `toolDefinition` 的 match/buildViewNode 是活例），
 * 语义与原扫描等价且不依赖任何宿主内部结构。
 *
 * 实测要点（决定了实现形态）：
 * - `tool/result` 事件**不含工具名**，只有 `data.message.source.callId`；工具名在配对的
 *   `tool/call`（`data.callId` + `data.name`）。故本 Definition 必须**同时**匹配两类事件，
 *   以 callId 为 Context 身份：`tool/call` = start（记住 name），`tool/result` = update
 *   （比对 name 是否命中触发类工具、是否报错）。
 * - 只消费 `surfaceOp === 'append'` 的 result（官方 chat 同款）：替换副本不属用户可见记录。
 *
 * 行为保持（与 0.1.1 版逐条对照）：
 * 1. 只认 `jenkins_build_trigger` / `jenkins_build_retry`；
 * 2. 只有**成功**结果（非 isError）才动作；
 * 3. 按 `callId` 去重；
 * 4. **初始基线只记账不动作**——挂载时窗口内的历史结果不触发（避免刷新页面/挂载面板时
 *    因历史触发而弹开），只有**新到达**的结果才刷新 + 展开。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** 触发类工具名（与原面板一致：仅这两个触发即时刷新 + 自动展开） */
export const TRIGGER_TOOL_NAMES = new Set(['jenkins_build_trigger', 'jenkins_build_retry'])

/** definition kind（本插件自有命名空间，避免与官方 definition 撞 key） */
export const DEFINITION_KIND = 'dsh-jenkins-panel-trigger-watch'

/** 事件最小形状（0.1.5 SessionEvent；仅取本处需要的字段，形状不符即安全跳过） */
interface EventLike {
  type?: string
  seq?: number
  time?: number
  surfaceOp?: string
  sourceEventSeqs?: unknown
  data?: {
    callId?: unknown
    name?: unknown
    message?: { source?: { callId?: unknown }; content?: Array<{ isError?: unknown }> }
    error?: unknown
  }
}

/** Definition 的 Context State：一个 callId 的调用头（name 由 tool/call 记下） */
interface CallState {
  callId: string
  name: string | null
}

/** 从 tool/call 事件取 `{ callId, name }`；形状不符 → null */
export function readToolCall(event: EventLike): { callId: string; name: string } | null {
  if (event?.type !== 'tool/call') return null
  const callId = event.data?.callId
  const name = event.data?.name
  if (typeof callId !== 'string' || callId === '') return null
  if (typeof name !== 'string' || name === '') return null
  return { callId, name }
}

/** 从 tool/result 事件取 `{ callId, isError }`；非 append 副本 / 形状不符 → null */
export function readToolResult(event: EventLike): { callId: string; isError: boolean } | null {
  if (event?.type !== 'tool/result') return null
  // 只认 append 来源（官方 chat 同款：替换副本是模型侧影子，非用户可见记录）
  if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return null
  const callId = event.data?.message?.source?.callId
  if (typeof callId !== 'string' || callId === '') return null
  const block = event.data?.message?.content?.[0]
  return { callId, isError: block?.isError === true || event.data?.error !== undefined }
}

/**
 * 纯状态机（导出供单测）：给定 State 与一条事件，算出下一个 State，
 * 并返回「本事件是否应触发联动」。
 *
 * @param state - 当前 State（null = 尚未见过该 callId）
 * @param event - 候选事件
 * @param seen - 已触发过的 callId 集合（跨事件去重，调用方持有）
 * @param armed - 是否已过初始基线（false = 只记账不动作）
 * @returns 下一个 State 与是否触发
 */
export function step(
  state: CallState | null,
  event: EventLike,
  seen: Set<string>,
  armed: boolean,
): { next: CallState | null; fire: boolean } {
  const call = readToolCall(event)
  if (call) return { next: { callId: call.callId, name: call.name }, fire: false }
  const result = readToolResult(event)
  if (!result) return { next: state, fire: false }
  if (seen.has(result.callId)) return { next: state, fire: false }
  seen.add(result.callId)
  if (!armed) return { next: state, fire: false } // 初始基线：仅记账
  if (result.isError) return { next: state, fire: false }
  if (!state || state.callId !== result.callId || state.name === null) return { next: state, fire: false }
  if (!TRIGGER_TOOL_NAMES.has(state.name)) return { next: state, fire: false }
  return { next: state, fire: true }
}

/**
 * 注册触发监听（返回 disposer）。`onTriggered` 在**新到达**的成功触发结果上调用一次。
 *
 * @param ctx - client 根 context（需要 ctx.uiConversation.events）
 * @param onTriggered - 新触发到达时的回调（刷新总览 + 展开右侧栏由调用方承担）
 */
export function registerTriggerListener(ctx: ClientContext, onTriggered: () => void): () => void {
  const events = ctx.uiConversation?.events
  if (!events?.register) return () => {}

  // 挂载之后才「武装」：初始窗口里的历史结果只记账（保持原 initial-baseline 语义）
  let armed = false
  queueMicrotask(() => {
    armed = true
  })

  const seen = new Set<string>()
  const dispose = events.register({
    kind: DEFINITION_KIND,
    match: (event: EventLike) => {
      const call = readToolCall(event)
      if (call) return { id: call.callId, role: 'start' as const }
      const result = readToolResult(event)
      if (result) return { id: result.callId, role: 'update' as const }
      return null
    },
    start: () => ({ callId: null as string | null, name: null as string | null }),
    update: (context: { state: CallState }, match: { event: EventLike }) => {
      const outcome = step(context.state, match.event, seen, armed)
      if (outcome.fire) onTriggered()
      return outcome.next ?? context.state
    },
  })

  return () => {
    dispose()
  }
}
