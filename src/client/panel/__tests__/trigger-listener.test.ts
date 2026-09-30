/**
 * 触发联动纯状态机单测（0.1.5 挂载改造；0.2.0 fixture 迁移）
 *
 * 覆盖原「扫描 SessionSnapshot.nodes」的全部行为口径（0.1.5 影响报告 §4.2 的可替代性证明）：
 * - 只认 jenkins_build_trigger / jenkins_build_retry（其余工具 result 不动作）；
 * - 只认成功结果（isError → 不动作）；
 * - 按 callId 去重（同一 callId 只触发一次）；
 * - 初始基线只记账不动作（挂载前的历史结果不弹面板）；
 * - tool/call 记名、tool/result 取结果，两者以 callId 配对；
 * - 非 append 副本（surfaceOp='replace'）不参与。
 *
 * 0.2.0 形状（升级影响报告 §4.5）：tool-result 不再是 content block，事件 data.message
 * 为一级 `tool` role 消息——callId 读 `message.toolCallId`，isError 判定唯一判据
 * `message.isError === true`；`data.error`（含新 `reason` 字段）只是冗余投影，不参与判定。
 */
import { describe, expect, it } from 'vitest'

import { readToolCall, readToolResult, step, TRIGGER_TOOL_NAMES } from '../trigger-listener.js'

/** 造一条 tool/call 事件 */
function call(callId: string, name: string) {
  return { type: 'tool/call', seq: 1, data: { callId, name } }
}

/** 造一条 tool/result 事件（0.2.0 形状：message 为一级 tool role 消息） */
function result(callId: string, isError = false, surfaceOp: string | undefined = 'append') {
  return { type: 'tool/result', seq: 2, surfaceOp, data: { message: { toolCallId: callId, isError } } }
}

describe('readToolCall / readToolResult（事件形状解析）', () => {
  it('reads callId + name from tool/call', () => {
    expect(readToolCall(call('c1', 'jenkins_build_trigger'))).toEqual({ callId: 'c1', name: 'jenkins_build_trigger' })
  })

  it('rejects shape mismatches safely', () => {
    expect(readToolCall({ type: 'tool/result' })).toBeNull()
    expect(readToolCall({ type: 'tool/call', data: {} })).toBeNull()
    expect(readToolCall({ type: 'tool/call', data: { callId: '', name: 'x' } })).toBeNull()
    expect(readToolResult({ type: 'tool/call' })).toBeNull()
    expect(readToolResult({ type: 'tool/result', data: {} })).toBeNull()
    expect(readToolResult({ type: 'tool/result', data: { message: {} } })).toBeNull()
    // 旧 0.1.5 路径（source.callId）在 0.2.0 合同下不再被识别
    expect(readToolResult({ type: 'tool/result', data: { message: { source: { callId: 'c1' } } } } as never)).toBeNull()
  })

  it('treats a 0.2.0 failure event (message.isError + error.reason) as an error result', () => {
    expect(
      readToolResult({
        type: 'tool/result',
        data: { message: { toolCallId: 'c1', isError: true }, error: { name: 'ExecError', code: 'exec_failed', reason: 'boom' } },
      }),
    ).toEqual({ callId: 'c1', isError: true })
  })

  it('judges isError solely from message.isError; data.error is a redundant projection', () => {
    // data.error 存在但 message.isError 缺失 → 不判错（0.1.5 的兜底路径已删除）
    expect(
      readToolResult({ type: 'tool/result', data: { message: { toolCallId: 'c1' }, error: { name: 'x', code: 'y' } } }),
    ).toEqual({ callId: 'c1', isError: false })
  })

  it('ignores replacement (non-append) result copies', () => {
    expect(readToolResult(result('c1', false, 'replace'))).toBeNull()
    expect(readToolResult(result('c1', false, undefined))).toEqual({ callId: 'c1', isError: false })
  })
})

describe('step（触发判定状态机）', () => {
  it('fires only on a successful result of a trigger tool, after call pairing', () => {
    const seen = new Set<string>()
    const state = step(null, call('c1', 'jenkins_build_trigger'), seen, true).next
    expect(state).toEqual({ callId: 'c1', name: 'jenkins_build_trigger' })
    expect(step(state, result('c1'), seen, true).fire).toBe(true)
  })

  it('does not fire for a non-trigger tool', () => {
    const seen = new Set<string>()
    const state = step(null, call('c1', 'jenkins_job_list'), seen, true).next
    expect(step(state, result('c1'), seen, true).fire).toBe(false)
  })

  it('does not fire for an errored result', () => {
    const seen = new Set<string>()
    const state = step(null, call('c1', 'jenkins_build_retry'), seen, true).next
    expect(step(state, result('c1', true), seen, true).fire).toBe(false)
  })

  it('deduplicates by callId', () => {
    const seen = new Set<string>()
    const state = step(null, call('c1', 'jenkins_build_trigger'), seen, true).next
    expect(step(state, result('c1'), seen, true).fire).toBe(true)
    expect(step(state, result('c1'), seen, true).fire).toBe(false)
  })

  it('does not fire on the initial baseline (armed=false) but still records the callId', () => {
    const seen = new Set<string>()
    const state = step(null, call('c1', 'jenkins_build_trigger'), seen, false).next
    expect(step(state, result('c1'), seen, false).fire).toBe(false)
    // 已记账：再到达同一 callId（即便已武装）也不再动作
    expect(step(state, result('c1'), seen, true).fire).toBe(false)
  })

  it('does not fire when the result arrives without its call head', () => {
    const seen = new Set<string>()
    expect(step(null, result('c1'), seen, true).fire).toBe(false)
  })

  it('recognises both trigger tools', () => {
    expect([...TRIGGER_TOOL_NAMES].sort()).toEqual(['jenkins_build_retry', 'jenkins_build_trigger'])
  })
})
