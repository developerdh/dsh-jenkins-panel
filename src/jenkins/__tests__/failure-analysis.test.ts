/**
 * 失败自动分析推送器单测（会话回推）
 *
 * 覆盖：任务书内容要素（job/build/tail/只读约束）、notice source 形态（plugin + form），
 * 推送后 markAnalysisPushed、analysis 状态持久防重、会话不在线跳过（保持 not_analyzed）、
 * getAgent/followup 异常容错（不外溢、可重试）。
 * registry 以最小结构面桩替代（只用到 markAnalysisPushed）。
 */
import { describe, expect, it, vi } from 'vitest'

import { buildAnalysisPrompt, createFailureAnalysis } from '../failure-analysis.js'
import type { TriggerRecord, TriggerRegistry } from '../registry.js'

function record(overrides: Partial<TriggerRecord> = {}): TriggerRecord {
  return {
    id: 'rec-1',
    connection: 'prod',
    jobName: 'deploy',
    displayName: 'deploy',
    buildNumber: 3,
    params: { BRANCH: 'main' },
    status: 'fail',
    triggeredAt: 1,
    statusUpdatedAt: 2,
    sessionId: 'session-A',
    source: 'conversation',
    rawResult: 'FAILURE',
    analysis: 'not_analyzed',
    ...overrides,
  }
}

function stubRegistry(mark: ReturnType<typeof vi.fn> = vi.fn(async () => true)): TriggerRegistry {
  return { markAnalysisPushed: mark } as unknown as TriggerRegistry
}

describe('createFailureAnalysis（推送守卫与降级）', () => {
  it('推送到活跃 agent 并标记 pushed', async () => {
    const followup = vi.fn()
    const mark = vi.fn(async () => true)
    const analysis = createFailureAnalysis(stubRegistry(mark), {
      getAgent: () => ({ followup }),
      tailLines: 100,
    })
    await analysis.handle(record())

    expect(followup).toHaveBeenCalledTimes(1)
    const message = followup.mock.calls[0][0] as { id: unknown; role: string; source: Record<string, unknown>; content: Array<{ type: string; text: string }> }
    expect(message.role).toBe('user')
    expect(typeof message.id).toBe('string')
    expect(message.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-jenkins-panel', form: 'notice' })
    const text = message.content[0].text
    expect(text).toContain('「deploy」')
    expect(text).toContain('deploy #3')
    expect(text).toContain('连接 prod')
    expect(text).toContain('tail=100')
    expect(text).toContain('"BRANCH":"main"')
    expect(text).toContain('只读排查')
    expect(mark).toHaveBeenCalledWith('rec-1')
  })

  it('已推送（analysis=pushed/analyze_failed）不重复推送', async () => {
    const followup = vi.fn()
    const analysis = createFailureAnalysis(stubRegistry(), { getAgent: () => ({ followup }), tailLines: 100 })
    await analysis.handle(record({ analysis: 'pushed' }))
    await analysis.handle(record({ analysis: 'analyze_failed' }))
    expect(followup).not.toHaveBeenCalled()
  })

  it('同一进程内同一条记录只推一次（handled 二级防重）', async () => {
    const followup = vi.fn()
    const mark = vi.fn(async () => true)
    const analysis = createFailureAnalysis(stubRegistry(mark), { getAgent: () => ({ followup }), tailLines: 100 })
    await analysis.handle(record())
    await analysis.handle(record())
    expect(followup).toHaveBeenCalledTimes(1)
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('会话不在线跳过并记日志，不标记（保持 not_analyzed）', async () => {
    const logger = vi.fn()
    const mark = vi.fn(async () => true)
    const analysis = createFailureAnalysis(stubRegistry(mark), {
      getAgent: () => undefined,
      tailLines: 100,
      logger,
    })
    await analysis.handle(record())
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('会话不在线'))
    expect(mark).not.toHaveBeenCalled()
  })

  it('getAgent 抛错等同不在线：不外溢、不标记', async () => {
    const analysis = createFailureAnalysis(stubRegistry(), {
      getAgent: () => {
        throw new Error('registry gone')
      },
      tailLines: 100,
    })
    await expect(analysis.handle(record())).resolves.toBeUndefined()
  })

  it('followup 抛错时不标记且不外溢，重试可成功', async () => {
    const mark = vi.fn(async () => true)
    let shouldThrow = true
    const followup = vi.fn(() => {
      if (shouldThrow) throw new Error('disposed')
    })
    const analysis = createFailureAnalysis(stubRegistry(mark), { getAgent: () => ({ followup }), tailLines: 100 })
    await expect(analysis.handle(record())).resolves.toBeUndefined()
    expect(mark).not.toHaveBeenCalled()
    shouldThrow = false
    await analysis.handle(record())
    expect(mark).toHaveBeenCalledTimes(1)
  })
})

describe('buildAnalysisPrompt（任务书内容）', () => {
  it('缺 buildNumber 时只写任务名；无参数时写（无）', () => {
    const prompt = buildAnalysisPrompt(record({ buildNumber: undefined, params: {} }), 50)
    expect(prompt).toContain('「deploy」（deploy，连接 prod）')
    expect(prompt).toContain('触发参数：（无）')
    expect(prompt).toContain('tail=50')
  })

  it('包含只读约束与结构化输出要求', () => {
    const prompt = buildAnalysisPrompt(record(), 100)
    expect(prompt).toContain('build_trigger / build_retry / build_cancel / build_delete')
    expect(prompt).toContain('失败结论')
    expect(prompt).toContain('修复建议')
  })
})
