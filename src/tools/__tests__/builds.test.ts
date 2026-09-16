/**
 * 构建类工具单测（HOST-M1-06）：build_trigger/status/info/log/history/retry/cancel/delete/artifacts。
 * 覆盖：trigger 解析→合并参数→触发→写注册表、wait 流转、多候选停下询问、
 * log tail/limit 强制与超限提示、cancel/delete/retry 基础。
 */
import { describe, expect, it, vi } from 'vitest'

import { defineBuildTools } from '../builds.js'
import { UNKNOWN_WORKSPACE_ID } from '../../jenkins/registry.js'
import { createBed, fakeExec, runTool } from './helpers.js'

const JOBS = [
  { name: 'deploy', fullName: 'project/deploy', displayName: '部署', url: 'u1', color: 'blue' },
  { name: 'test', fullName: 'project/test', displayName: '测试', url: 'u2', color: 'red' },
]

function tools() {
  const bed = createBed()
  const byName = new Map(defineBuildTools(bed.deps).map((t) => [t.name, t]))
  return { bed, byName }
}

describe('jenkins_build_trigger', () => {
  it('resolves name → merges params → triggers → writes registry record', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOBS)
    bed.client.getJobParams = vi.fn(async () => [
      { name: 'BRANCH', type: 'StringParameterDefinition' as const, defaultParameterValue: { value: 'main' } },
      { name: 'EMPTY', type: 'StringParameterDefinition' as const, defaultParameterValue: { value: '' } },
    ])
    bed.client.triggerBuild = vi.fn(async () => ({ queueUrl: 'https://jenkins.example.com/queue/item/42/' }))

    const value = await runTool(byName.get('jenkins_build_trigger')!, {
      jobName: 'deploy',
      parameters: { BRANCH: 'fix' },
    }) as { queueId?: number }

    // 解析：displayName 部署 精确命中 project/deploy；合并参数 = 默认 main 被 fix 覆盖、空默认剔除
    expect(bed.client.triggerBuild).toHaveBeenCalledWith('project/deploy', { BRANCH: 'fix' })
    expect(value.queueId).toBe(42)
    // 注册表写入（缺省连接 prod、会话 session-1；V7 契约：未接 workspaceOf 时写入 sentinel；
    // 用户要求取消 wait → 不输出 buildNumber）
    expect(bed.recordTrigger).toHaveBeenCalledWith({
      connection: 'prod',
      jobName: 'project/deploy',
      displayName: '部署',
      queueId: 42,
      params: { BRANCH: 'fix' },
      sessionId: 'session-1',
      workspaceId: UNKNOWN_WORKSPACE_ID,
      workspaceName: undefined,
    })
  })

  it('returns lossless JSON when not waiting (no undefined fields)', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOBS)
    bed.client.getJobParams = vi.fn(async () => [])
    bed.client.triggerBuild = vi.fn(async () => ({ queueUrl: 'https://jenkins.example.com/queue/item/42/' }))

    const value = await runTool(byName.get('jenkins_build_trigger')!, { jobName: 'project/deploy' }) as Record<string, unknown>
    // 回归（用户报障）：无 wait 时 buildNumber/status 恒缺省，必须被收口剔除，
    // 否则 dsh-tools snapshotJsonValue 校验失败 → "value is not lossless JSON"
    expect(value).toEqual({ queueId: 42 })
    expect('buildNumber' in value).toBe(false)
    expect('status' in value).toBe(false)
  })

  it('wait 已取消（用户要求）：即使传入 wait 也无等待，触发即返回 { queueId }', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOBS)
    bed.client.getJobParams = vi.fn(async () => [])
    bed.client.triggerBuild = vi.fn(async () => ({ queueUrl: 'https://jenkins.example.com/queue/item/7/' }))
    bed.client.listQueue = vi.fn(async () => [{ id: 7, task: { name: 'deploy', url: 'u' }, stuck: false, blocked: false, buildable: true, timestamp: 1, executable: { number: 101, url: 'u' } }])
    bed.client.getBuildStatus = vi.fn(async () => ({ number: 101, url: 'u', building: false, result: 'SUCCESS' as const }))

    // 执行层已移除 wait 逻辑：模拟模型硬传 wait/pollInterval/timeout 也不触发轮询（dsh 参数校验层会拒绝未声明键）
    const value = await runTool(byName.get('jenkins_build_trigger')!, {
      jobName: 'project/deploy',
      wait: true,
      pollInterval: 1,
      timeout: 10,
    }) as Record<string, unknown>
    expect(value).toEqual({ queueId: 7 })
    expect(bed.client.listQueue).not.toHaveBeenCalled()
    expect(bed.client.getBuildStatus).not.toHaveBeenCalled()
    expect(bed.recordTrigger).toHaveBeenCalledWith(expect.objectContaining({ queueId: 7 }))
  })

  it('throws with candidates on ambiguous name (never auto-picks)', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => [...JOBS, { name: 'deploy', fullName: 'release/deploy', displayName: '发布部署', url: 'u3' }])
    await expect(runTool(byName.get('jenkins_build_trigger')!, { jobName: 'deploy' })).rejects.toThrow(/多候选停下询问|有 2 个匹配/)
    expect(bed.recordTrigger).not.toHaveBeenCalled()
  })

  it('skips registry write when no session context', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOBS)
    bed.client.getJobParams = vi.fn(async () => [])
    const exec = fakeExec({ agent: undefined })
    await runTool(byName.get('jenkins_build_trigger')!, { jobName: 'project/deploy' }, exec)
    expect(bed.recordTrigger).not.toHaveBeenCalled()
  })
})

describe('jenkins_build_log', () => {
  it('rejects when neither tail nor limit given', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOBS)
    await expect(runTool(byName.get('jenkins_build_log')!, { jobName: 'project/deploy' })).rejects.toThrow(/必须指定 tail 或 limit/)
  })

  it('slices via getBuildLog and appends pagination hint when truncated', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOBS)
    bed.client.getBuildLog = vi.fn(async () => ({ jobName: 'project/deploy', buildNumber: 3, log: 'a\nb', totalLines: 100 }))
    const value = await runTool(byName.get('jenkins_build_log')!, { jobName: 'deploy', tail: 10 }) as {
      log: string
      totalLines: number
    }
    expect(bed.client.getBuildLog).toHaveBeenCalledWith('project/deploy', undefined, { startLine: undefined, limit: undefined, tail: 10 })
    expect(value.log).toContain('共 100 行，已显示 2 行')
    expect(value.totalLines).toBe(100)
  })
})

describe('build_status / info / history / artifacts', () => {
  it('resolve and delegate to client methods', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOBS)

    const status = await runTool(byName.get('jenkins_build_status')!, { jobName: 'deploy', buildNumber: 5 })
    expect(bed.client.getBuildStatus).toHaveBeenCalledWith('project/deploy', 5)
    expect(status).toMatchObject({ number: 1, result: 'SUCCESS' })

    await runTool(byName.get('jenkins_build_info')!, { jobName: 'project/test', buildNumber: 2 })
    expect(bed.client.getBuildInfo).toHaveBeenCalledWith('project/test', 2)

    bed.client.getBuildHistory = vi.fn(async () => ({ jobName: 'project/deploy', builds: [{ number: 3, url: 'u', timestamp: 1, duration: 10, result: 'SUCCESS' as const, building: false }], totalCount: 1 }))
    const history = await runTool(byName.get('jenkins_build_history')!, { jobName: 'deploy', status: 'SUCCESS' }) as { totalCount: number }
    expect(bed.client.getBuildHistory).toHaveBeenCalledWith('project/deploy', { limit: 20, status: 'SUCCESS' })
    expect(history.totalCount).toBe(1)

    bed.client.getBuildArtifacts = vi.fn(async () => [{ displayPath: 'a.jar', fileName: 'a.jar', relativePath: 'target/a.jar' }])
    const artifacts = await runTool(byName.get('jenkins_build_artifacts')!, { jobName: 'project/deploy', buildNumber: 9 })
    expect(bed.client.getBuildArtifacts).toHaveBeenCalledWith('project/deploy', 9)
    expect(artifacts).toHaveLength(1)
  })

  it('history_all pages all Jobs through official allBuilds data', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOBS)
    bed.client.getAllBuildsForJob = vi.fn(async (jobName) => (
      jobName === 'project/deploy'
        ? [{ number: 2, url: 'd2', timestamp: 20, duration: 5, result: 'SUCCESS' as const, building: false }]
        : [{ number: 1, url: 't1', timestamp: 10, duration: 3, result: 'FAILURE' as const, building: false }]
    ))

    const value = await runTool(byName.get('jenkins_build_history_all')!, { page: 1, pageSize: 1, perJobLimit: 2 }) as {
      builds: Array<{ jobFullName: string; number: number }>
      scan: { totalJobs: number }
    }
    expect(bed.client.getAllBuildsForJob).toHaveBeenCalledWith('project/deploy', 1)
    expect(bed.client.getAllBuildsForJob).toHaveBeenCalledWith('project/test', 1)
    expect(value.builds).toEqual([expect.objectContaining({ jobFullName: 'project/deploy', number: 2 })])
    expect(value.scan.totalJobs).toBe(2)
  })
})

describe('build_cancel / delete / retry', () => {
  it('cancel/delete resolve name and call client', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOBS)

    const cancel = await runTool(byName.get('jenkins_build_cancel')!, { jobName: 'deploy', buildNumber: 5 }) as { ok: boolean; message: string }
    expect(bed.client.cancelBuild).toHaveBeenCalledWith('project/deploy', 5)
    expect(cancel.ok).toBe(true)

    const del = await runTool(byName.get('jenkins_build_delete')!, { jobName: 'project/test', buildNumber: 2 }) as { ok: boolean }
    expect(bed.client.deleteBuild).toHaveBeenCalledWith('project/test', 2)
    expect(del.ok).toBe(true)
  })

  it('retry calls /rebuild and writes registry record', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOBS)
    const value = await runTool(byName.get('jenkins_build_retry')!, { jobName: 'project/deploy' })
    // wait 取消：不再预取 getBuildInfo
    expect(bed.client.getBuildInfo).not.toHaveBeenCalled()
    expect(bed.client.retryBuild).toHaveBeenCalledWith('project/deploy')
    expect(bed.recordTrigger).toHaveBeenCalledWith(expect.objectContaining({
      connection: 'prod',
      jobName: 'project/deploy',
      displayName: '部署',
      sessionId: 'session-1',
    }))
    expect(value).toEqual({}) // 无 queueUrl 时 queueId 缺省 → lossless 空对象
  })

  it('retry queueUrl 解析出 queueId 并返回 { queueId }', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOBS)
    bed.client.retryBuild = vi.fn(async () => ({ queueUrl: 'https://jenkins.example.com/queue/item/8/' }))
    const value = await runTool(byName.get('jenkins_build_retry')!, { jobName: 'project/deploy' }) as Record<string, unknown>
    expect(value).toEqual({ queueId: 8 })
    expect('buildNumber' in value).toBe(false)
    expect('status' in value).toBe(false)
  })

  it('retry wait 已取消（用户要求）：硬传 wait 也不等待、不轮询', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOBS)
    bed.client.getBuildStatus = vi.fn(async () => ({ number: 10, url: 'u', building: false, result: 'FAILURE' as const }))
    const value = await runTool(byName.get('jenkins_build_retry')!, { jobName: 'project/deploy', wait: true, pollInterval: 1, timeout: 10 }) as Record<string, unknown>
    expect(bed.client.getBuildStatus).not.toHaveBeenCalled()
    expect(bed.recordTrigger).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'project/deploy' }))
    expect(value).toEqual({})
  })
})

describe('缺口补齐（FIN-M3-02）', () => {
  it('build_trigger honors delay (delays trigger call)', async () => {
    vi.useFakeTimers()
    try {
      const { bed, byName } = tools()
      bed.client.getAllJobsRecursive = vi.fn(async () => JOBS)
      bed.client.getJobParams = vi.fn(async () => [])
      let triggered = false
      bed.client.triggerBuild = vi.fn(async () => {
        triggered = true
        return {}
      })
      const promise = runTool(byName.get('jenkins_build_trigger')!, { jobName: 'project/deploy', delay: 2 })
      await vi.advanceTimersByTimeAsync(1999)
      expect(triggered).toBe(false) // 未到 delay 不触发
      await vi.advanceTimersByTimeAsync(2)
      await promise
      expect(triggered).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('build_log passes startLine/limit through for pagination (not only tail)', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOBS)
    bed.client.getBuildLog = vi.fn(async () => ({ jobName: 'project/deploy', buildNumber: 3, log: 'x', totalLines: 1 }))
    await runTool(byName.get('jenkins_build_log')!, { jobName: 'deploy', startLine: 100, limit: 5 })
    expect(bed.client.getBuildLog).toHaveBeenCalledWith('project/deploy', undefined, {
      startLine: 100, limit: 5, tail: undefined,
    })
  })

  it('build_status/info/artifacts/history resolve fuzzy names before delegating', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => [...JOBS, { name: 'api-gateway', fullName: 'devops/api-gateway/build', displayName: '网关构建', url: 'u4' }])
    await runTool(byName.get('jenkins_build_status')!, { jobName: 'api-gateway' })
    expect(bed.client.getBuildStatus).toHaveBeenCalledWith('devops/api-gateway/build', undefined)
  })
})
