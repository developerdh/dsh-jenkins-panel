/**
 * 工具层共享助手（HOST-M1-06；名称解析自 HOST-M1-04 起迁移至 resolver.ts）
 *
 * 定义 `registerJenkinsTools(ctx, deps)` 的 deps 形态、输出渲染、lossless-JSON 断言、
 * 任务名称解析（resolveJobPath → 委托 resolver.resolveJob）与触发记录写入（recordTriggered）。
 *
 * 名称解析口径（architecture §2.3）：严格「多候选停下询问」——精确匹配优先；
 * 模糊唯一命中自动解析；多候选抛错（错误文案带候选清单，Agent 二次确认，绝不自动选第一个）。
 * 逻辑统一在 `src/jenkins/resolver.ts`（HOST-M1-04），本处为兼容壳。
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
// 0.1.5 起 dsh-tools 不再 re-export JsonValue（影响报告 §4.5），类型源改 dsh-util-values
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import type { JenkinsClient } from '../jenkins/client.js'
import { resolveJob } from '../jenkins/resolver.js'
import type { ConnectionRegistry, ConnectionSummary } from '../jenkins/connection.js'
import { UNKNOWN_WORKSPACE_ID, type TriggerRecord, type TriggerRegistry } from '../jenkins/registry.js'

/** 工具层依赖（registerJenkinsTools 第二参；架构 §2.1 形态，接线方在 apply() 组装） */
export interface JenkinsToolsDeps {
  /** 连接注册表（M1-03；缺省连接名等元信息） */
  registry: ConnectionRegistry
  /** 连接客户端工厂：`clientFor(registry, ctx.credentials, name)` 的绑定（接线方提供） */
  getClient: (connection?: string) => Promise<JenkinsClient>
  /**
   * 连接清单数据源（`listConnections(registry, ctx.credentials)` 绑定，conn.list 同源：
   * 仅 name/isDefault/hasToken，不含 URL/凭据——该口径服务于 Web 面板切换器）。
   * jenkins_connection_list 工具用；工具层会叠加 registry 的端点 url（非敏感）便于模型判别环境；
   * 缺省（未接线）时该工具直接报错提示。
   */
  listConnections?: () => Promise<ConnectionSummary[]>
  /** 触发记录注册表（M1-08）；build_trigger/retry 成功时写入（缺省不写） */
  triggerRegistry?: TriggerRegistry
  /** 从工具执行上下文解析 sessionId（缺省取 `exec.agent?.id`——dsh Agent.id 即会话 id） */
  sessionIdOf?: (exec: ToolRunContext) => string | undefined
  /** 会话 → 工作区 { id, name }（最佳努力；拿不到/抛错 → 归 sentinel UNKNOWN_WORKSPACE_ID） */
  workspaceOf?: (sessionId: string) => Promise<{ id: string; name: string } | undefined>
}

/** 文本内容块（output.render 用；ContentBlock 文本形态，无需显式类型导入） */
export function textContent(value: unknown): Array<{ type: 'text'; text: string }> {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/**
 * 归一化为 lossless-JSON（output.schema 用 json 节点时 execute 返回值收口）。
 *
 * 背景（用户报障）：`jenkins_build_trigger` 不等待时返回 `{ queueId, buildNumber: undefined, status: undefined }`，
 * dsh-tools 注册表对工具返回值做 `snapshotJsonValue` 校验——任何 `undefined` 值（对象属性/数组项/根）
 * 都会让校验失败，抛 `tool "<name>" returned invalid output: value is not lossless JSON`。
 *
 * 本函数在**单一收口**处剔除 `undefined`（对象属性删除、数组项置 null、根 undefined → null），
 * 其余值原样透传（不做多余拷贝语义外的改写）：Jenkins JSON 与模型参数本就是合法 JSON，
 * 真正的非法值（NaN/Infinity/循环引用/函数）仍会被 dsh 校验拦下，不在此静默吞掉。
 */
export function asJson(value: unknown): JsonValue {
  return dropUndefined(value) as JsonValue
}

function dropUndefined(value: unknown): unknown {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length)
    for (let i = 0; i < value.length; i++) out[i] = dropUndefined(value[i])
    return out
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const item = (value as Record<string, unknown>)[key]
    if (item === undefined) continue
    out[key] = dropUndefined(item)
  }
  return out
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 任务名称解析（委托 resolver.resolveJob：精确 → 唯一模糊 → 多候选抛错）。
 * @returns 解析后的 fullName 与 displayName
 * @throws 未找到 / 多候选（文案含候选清单，Agent 二次确认；绝不自动选择）
 */
export async function resolveJobPath(
  client: JenkinsClient,
  name: string,
): Promise<{ fullName: string; displayName?: string }> {
  const result = await resolveJob(client, name)
  if (result.resolved && result.fullName) {
    return { fullName: result.fullName, displayName: result.candidates?.[0]?.displayName }
  }
  throw new Error(result.message)
}

/** 触发记录写入（build_trigger/retry 成功时调用；无注册表或会话上下文则跳过） */
export async function recordTriggered(
  deps: JenkinsToolsDeps,
  exec: ToolRunContext,
  input: Omit<Parameters<TriggerRegistry['recordTrigger']>[0], 'sessionId' | 'workspaceId' | 'workspaceName'>,
): Promise<TriggerRecord | undefined> {
  const triggerRegistry = deps.triggerRegistry
  if (!triggerRegistry) return undefined
  const sessionId = deps.sessionIdOf ? deps.sessionIdOf(exec) : exec.agent?.id
  if (!sessionId) return undefined
  // 工作区：最佳努力解析；拿不到/抛错 → 固定 sentinel（「未知工作区」）
  let workspaceId = UNKNOWN_WORKSPACE_ID
  let workspaceName: string | undefined
  if (deps.workspaceOf) {
    try {
      const ws = await deps.workspaceOf(sessionId)
      workspaceId = ws?.id ?? UNKNOWN_WORKSPACE_ID
      workspaceName = ws?.name
    } catch {
      workspaceId = UNKNOWN_WORKSPACE_ID
    }
  }
  return triggerRegistry.recordTrigger({ ...input, sessionId, workspaceId, workspaceName })
}

/** 队列 Location → queueId */
export function queueIdFromUrl(queueUrl?: string): number | undefined {
  if (!queueUrl) return undefined
  const match = /\/queue\/item\/(\d+)\/?/.exec(queueUrl)
  return match ? Number(match[1]) : undefined
}

export { sleep }
