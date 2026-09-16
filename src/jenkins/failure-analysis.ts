/**
 * 构建失败自动分析推送器（触发会话回推；对应 docs/proposals/ai-analysis.md 的
 * original-session 路径——向指定 sessionId 注入 user message 并触发一轮）
 *
 * 注册表轮询发现「在途 → fail」流转（rawResult=FAILURE）时经 onBuildFailed 到达此处：
 * 向触发会话（record.sessionId）的活跃 agent 经 dsh 官方 followup 通道注入一条带类型化
 * source 的 user 消息——排队一个普通 follow-up turn 并唤醒 driver（空闲即开轮、运行中
 * 排队不打断）。会话内模型读任务书后调用 jenkins_build_log / jenkins_build_info 迭代
 * 排查，最终把失败分析总结直接输出在触发会话里；分析产物随会话转录持久化，注册表只记
 * analysis 状态防重复。
 *
 * 守卫与降级（均已与需求方确认）：
 * - record.analysis 已是 pushed/analyze_failed → 持久防重，直接跳过；
 * - handled 集合做进程内二级防重（防回调重放/竞态）；
 * - agent 不在线（ctx.agents.get 拿不到：dsh 重启后会话未重新打开、会话被释放、长构建
 *   期间进程退出等）→ 跳过并记日志，记录保持 not_analyzed；**不做补推队列**——正常构建
 *   分钟级出结果、会话几乎必然在线，离线属于已知放弃场景，面板总览的 fail 记录兜底；
 * - 只推本进程观察到的流转：重启加载到的历史 fail 终态不会到达此处（onBuildFailed 语义）。
 * - 分析任务书显式只读（禁 trigger/retry/cancel/delete），防止分析轮反过来触发构建成环。
 */
import { createUserMessage, type ContentBlock, type MessageSourceMap, type UserMessage } from '@deepseek-ai/dsh-llm'

import type { TriggerRecord, TriggerRegistry } from './registry.js'

/** 活跃 agent 的最小结构面（dsh Agent.followup；经 ctx.agents 注入，不依赖其运行时类型） */
export interface AnalysisAgentLike {
  followup(message: UserMessage): void
}

export interface FailureAnalysisOptions {
  /** 解析会话的活跃 agent（`ctx.agents.get(sessionId)` 绑定；undefined = 会话不在线） */
  getAgent: (sessionId: string) => AnalysisAgentLike | undefined
  /** 初始拉取日志的行数提示（jenkins_build_log 的 tail 参数，来自 Config.analysis.tailLines） */
  tailLines: number
  /** 分析消息的 plugin source 标识（缺省 'dsh-jenkins-panel'） */
  pluginName?: string
  /** 日志（默认带 [dsh-jenkins-panel] 前缀输出） */
  logger?: (message: string) => void
}

export interface FailureAnalysis {
  /** 处理一条刚流转为 fail 的记录（守卫不通过时静默跳过/记日志，绝不向上抛错） */
  handle(record: TriggerRecord): Promise<void>
}

/**
 * 构造注入会话的分析任务书。只带元数据不带日志正文：日志由会话内 agent 用
 * jenkins_build_log 自取（可按需迭代回溯），注入消息保持轻量、不撑会话上下文。
 */
export function buildAnalysisPrompt(record: TriggerRecord, tailLines: number): string {
  const build = record.buildNumber != null ? `${record.jobName} #${record.buildNumber}` : record.jobName
  const params = Object.keys(record.params ?? {}).length > 0 ? JSON.stringify(record.params) : '（无）'
  return [
    `[自动分析任务 | dsh-jenkins-panel] 你此前触发的 Jenkins 构建「${record.displayName}」（${build}，连接 ${record.connection}）已失败（result=FAILURE）。`,
    `触发参数：${params}。`,
    '请在会话中完成失败原因分析：',
    `1. 先用 jenkins_build_log（tail=${tailLines}）定位首个报错；不够时用 startLine/limit 向前回溯，或用 jenkins_build_info 查看构建参数与变更集（changeSet）。`,
    '2. 本次只做只读排查：不要调用 build_trigger / build_retry / build_cancel / build_delete。',
    '3. 最后输出结构化总结：① 失败结论（一句话）；② 关键报错（引用日志行）；③ 可能原因；④ 修复建议。',
  ].join('\n')
}

/** 创建失败分析推送器（接线方在注册表之后创建，把 handle 接到 onBuildFailed） */
export function createFailureAnalysis(registry: TriggerRegistry, options: FailureAnalysisOptions): FailureAnalysis {
  const handled = new Set<string>()
  const logger = options.logger ?? ((message: string) => console.log(message))
  return {
    async handle(record: TriggerRecord): Promise<void> {
      if (record.analysis && record.analysis !== 'not_analyzed') return
      if (handled.has(record.id)) return
      let agent: AnalysisAgentLike | undefined
      try {
        agent = options.getAgent(record.sessionId)
      } catch {
        agent = undefined
      }
      if (!agent || typeof agent.followup !== 'function') {
        logger(
          `[dsh-jenkins-panel] 会话不在线，跳过自动分析：${record.displayName}（${record.jobName}） sessionId=${record.sessionId}`,
        )
        return
      }
      // notice summary ≤ CONTEXT_SUMMARY_MAX_CHARS(120)：折叠行里的一句话 accounted
      const summary = `Jenkins 构建 ${record.displayName} 失败，自动分析失败原因`
      const source: MessageSourceMap['plugin'] = {
        kind: 'plugin',
        plugin: options.pluginName ?? 'dsh-jenkins-panel',
        form: 'notice',
        summary,
      }
      const content: ContentBlock[] = [{ type: 'text', text: buildAnalysisPrompt(record, options.tailLines) }]
      const message = createUserMessage({ content, source })
      handled.add(record.id)
      try {
        agent.followup(message)
      } catch (err) {
        handled.delete(record.id)
        logger(`[dsh-jenkins-panel] 注入分析任务失败（${record.jobName}）：${err instanceof Error ? err.message : String(err)}`)
        return
      }
      await registry.markAnalysisPushed(record.id)
    },
  }
}
