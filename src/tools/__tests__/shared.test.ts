/**
 * 工具层共享助手直测（FIN-M3-02 阶段 2 补齐）
 *
 * 覆盖此前仅被间接覆盖的 shared.ts 导出：
 * - queueIdFromUrl（Location 头 → queueId 解析；无匹配/空 → undefined）
 * - resolveJobPath（精确解析 / 未找到 / **多候选停下询问抛错**——红线：绝不自动选第一个）
 * - recordTriggered（无注册表跳过 / 无会话上下文跳过 / 正常写入）
 * - textContent / asJson（输出渲染与 lossless-JSON 收口）
 */
import { describe, expect, it, vi } from 'vitest'

import type { JenkinsClient } from '../../jenkins/client.js'
import { UNKNOWN_WORKSPACE_ID, type TriggerRegistry } from '../../jenkins/registry.js'
import { asJson, queueIdFromUrl, recordTriggered, resolveJobPath, textContent, type JenkinsToolsDeps } from '../shared.js'
import { fakeExec } from './helpers.js'

const JOBS = [
  { name: 'deploy', fullName: 'project/deploy', displayName: '部署', url: 'u1', color: 'blue' },
  { name: 'deploy', fullName: 'release/deploy', displayName: '发布部署', url: 'u2', color: 'grey' },
  { name: 'api', fullName: 'devops/api-gateway/build', displayName: '网关构建', url: 'u3', color: 'blue_anime' },
]

function clientWith(overrides?: Partial<JenkinsClient>): JenkinsClient {
  return {
    getAllJobsRecursive: vi.fn(async () => JOBS),
    ...overrides,
  } as unknown as JenkinsClient
}

describe('queueIdFromUrl（队列 Location → queueId）', () => {
  it('extracts the numeric queue id from the Location header', () => {
    expect(queueIdFromUrl('https://jenkins.example.com/queue/item/42/')).toBe(42)
    expect(queueIdFromUrl('/queue/item/7')).toBe(7)
  })

  it('returns undefined for empty / non-matching URLs', () => {
    expect(queueIdFromUrl(undefined)).toBeUndefined()
    expect(queueIdFromUrl('')).toBeUndefined()
    expect(queueIdFromUrl('https://jenkins.example.com/job/deploy/')).toBeUndefined()
    expect(queueIdFromUrl('/queue/item/abc')).toBeUndefined()
  })
})

describe('resolveJobPath（委托 resolver：精确 → 唯一模糊 → 多候选停下询问）', () => {
  it('resolves exact fullName and carries displayName', async () => {
    const { fullName, displayName } = await resolveJobPath(clientWith(), 'project/deploy')
    expect(fullName).toBe('project/deploy')
    expect(displayName).toBe('部署')
  })

  it('resolves a unique fuzzy match automatically', async () => {
    const { fullName } = await resolveJobPath(clientWith(), 'api-gateway')
    expect(fullName).toBe('devops/api-gateway/build')
  })

  it('throws with candidate list on multiple matches — never auto-picks the first', async () => {
    await expect(resolveJobPath(clientWith(), 'deploy')).rejects.toThrow(/候选|多候选/)
    await expect(resolveJobPath(clientWith(), 'deploy')).rejects.toThrow(/绝不自动选择/)
  })

  it('throws a friendly message when nothing matches', async () => {
    await expect(resolveJobPath(clientWith(), '完全不存在')).rejects.toThrow(/未找到/)
  })
})

describe('recordTriggered（触发记录写入守卫）', () => {
  it('skips when no trigger registry is wired', async () => {
    const deps = { triggerRegistry: undefined } as unknown as JenkinsToolsDeps
    const result = await recordTriggered(deps, fakeExec(), {
      connection: 'prod',
      jobName: 'project/deploy',
      displayName: '部署',
      params: {},
    })
    expect(result).toBeUndefined()
  })

  it('skips when the session context is missing', async () => {
    const recordTrigger = vi.fn(async () => ({}))
    const deps = { triggerRegistry: { recordTrigger } } as unknown as JenkinsToolsDeps
    const result = await recordTriggered(deps, fakeExec({ agent: undefined }), {
      connection: 'prod',
      jobName: 'project/deploy',
      displayName: '部署',
      params: {},
    })
    expect(result).toBeUndefined()
    expect(recordTrigger).not.toHaveBeenCalled()
  })

  it('writes with sessionId from exec.agent.id by default', async () => {
    const recordTrigger = vi.fn(async () => ({}))
    const deps = { triggerRegistry: { recordTrigger } } as unknown as JenkinsToolsDeps
    await recordTriggered(deps, fakeExec(), {
      connection: 'prod',
      jobName: 'project/deploy',
      displayName: '部署',
      queueId: 42,
      params: { BRANCH: 'main' },
    })
    expect(recordTrigger).toHaveBeenCalledWith({
      connection: 'prod',
      jobName: 'project/deploy',
      displayName: '部署',
      queueId: 42,
      params: { BRANCH: 'main' },
      sessionId: 'session-1',
      // V7 契约：workspaceOf 未接线时仍写入 sentinel（「未知工作区」），workspaceName 缺省为 undefined
      workspaceId: UNKNOWN_WORKSPACE_ID,
      workspaceName: undefined,
    })
  })

  it('honors a custom sessionIdOf resolver', async () => {
    const recordTrigger = vi.fn(async () => ({}))
    const deps = {
      triggerRegistry: { recordTrigger } as unknown as TriggerRegistry,
      sessionIdOf: () => 'custom-session',
    } as unknown as JenkinsToolsDeps
    await recordTriggered(deps, fakeExec(), {
      connection: 'prod',
      jobName: 'j',
      displayName: 'j',
      params: {},
    })
    expect(recordTrigger).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'custom-session' }))
  })
})

describe('textContent / asJson', () => {
  it('textContent renders objects as pretty JSON blocks', () => {
    const blocks = textContent({ ok: true, n: 1 })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('text')
    expect(JSON.parse(blocks[0].text)).toEqual({ ok: true, n: 1 })
  })

  it('textContent passes strings through verbatim', () => {
    expect(textContent('hello')).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('asJson strips undefined into lossless JSON (funnel guard)', () => {
    const value = { nested: { arr: [1, 2], undef: undefined }, top: undefined, keep: 'x' }
    const out = asJson(value) as Record<string, unknown>
    // 对象属性剔除、数组项保留（无 undefined 项）
    expect(out).toEqual({ nested: { arr: [1, 2] }, keep: 'x' })
    expect('top' in out).toBe(false)
  })

  it('asJson converts undefined array items to null and root undefined to null', () => {
    const arr = asJson([1, undefined, 3]) as Array<unknown>
    expect(arr).toHaveLength(3)
    expect(arr[1]).toBeNull()
    expect(asJson(undefined)).toBeNull()
  })

  it('asJson leaves valid JSON values intact', () => {
    expect(asJson({ ok: true, n: 42, s: 'x', nil: null })).toEqual({ ok: true, n: 42, s: 'x', nil: null })
    expect(asJson([1, 'a', false, null])).toEqual([1, 'a', false, null])
  })
})
