/**
 * 触发记录注册表单测（HOST-M1-08）
 *
 * 覆盖：recordTrigger 落盘、maxPerSession 淘汰最旧终态/在途保留、TTL 清理、
 * queued→running→ok 状态流转（queue 解析 + statusUpdatedAt + 落盘）、session 隔离、
 * triggered.list（过滤/分页）、triggered.delete（单条/清空）、损坏容错、
 * visible 门控 + refreshNow、轮询错误容错。
 * 使用临时目录 + 注入时钟/客户端工厂（不依赖真实 Jenkins）。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JenkinsClient } from '../client.js'
import type { BuildInfo, BuildResult } from '../types.js'
import {
  createTriggerRegistry,
  registryFile,
  UNKNOWN_WORKSPACE_ID,
  type TriggerInput,
  type TriggerRecord,
  type TriggerRegistryOptions,
} from '../registry.js'

let dir: string
let file: string
let now: Date

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-jenkins-panel-reg-'))
  file = join(dir, 'registry.json')
  now = new Date('2026-08-27T00:00:00.000Z')
})

afterEach(async () => {
  vi.useRealTimers()
  // Windows 下 rm 与写链/杀软偶发竞态：重试数次
  for (let i = 0; i < 5; i += 1) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  await rm(dir, { recursive: true, force: true })
})

function makeOptions(overrides?: Partial<TriggerRegistryOptions>): TriggerRegistryOptions {
  return {
    file,
    maxPerSession: 3,
    ttlDays: 30,
    pollIntervalMs: 1000,
    getClient: async () => fakeClient(),
    now: () => now,
    ...overrides,
  }
}

function fakeClient(overrides?: Partial<JenkinsClient>): JenkinsClient {
  return {
    listQueue: vi.fn(async () => []),
    getQueueItem: vi.fn(async () => undefined),
    getBuildStatus: vi.fn(async () => build({ result: 'SUCCESS' })),
    ...overrides,
  } as unknown as JenkinsClient
}

/** 构造最小 BuildInfo（result/building 可覆盖） */
function build(info: Partial<BuildInfo> = {}): BuildInfo {
  return { number: 1, url: 'u', ...info }
}

function recordInput(overrides?: Partial<TriggerInput>): TriggerInput {
  return {
    connection: 'prod',
    jobName: 'deploy',
    displayName: 'deploy',
    params: { BRANCH: 'main' },
    sessionId: 'session-A',
    ...overrides,
  }
}

async function diskRecords(): Promise<TriggerRecord[]> {
  const text = await readFile(file, 'utf8')
  const parsed = JSON.parse(text) as { records: TriggerRecord[] }
  return parsed.records
}

describe('recordTrigger 与持久化', () => {
  it('writes a queued record (no buildNumber) and persists to disk', async () => {
    const registry = await createTriggerRegistry(makeOptions())
    const record = await registry.recordTrigger(recordInput())
    expect(record.status).toBe('queued')
    expect(record.source).toBe('conversation')
    expect(record.sessionId).toBe('session-A')
    expect(record.params).toEqual({ BRANCH: 'main' })

    const persisted = await diskRecords()
    expect(persisted).toHaveLength(1)
    expect(persisted[0].id).toBe(record.id)
  })

  it('starts as running when buildNumber is known; reload sees persisted records', async () => {
    const registry = await createTriggerRegistry(makeOptions())
    await registry.recordTrigger(recordInput({ buildNumber: 7 }))
    expect((await diskRecords())[0].status).toBe('running')

    const reloaded = await createTriggerRegistry(makeOptions())
    expect(reloaded.all).toHaveLength(1)
    expect(reloaded.all[0].buildNumber).toBe(7)
  })

  it('registryFile joins the plugin subdirectory', () => {
    expect(registryFile('/data/profile')).toBe('/data/profile/dsh-jenkins-panel/registry.json')
    expect(registryFile('/data/profile/')).toBe('/data/profile/dsh-jenkins-panel/registry.json')
  })
})

describe('清理（maxPerSession / TTL）', () => {
  it('evicts oldest terminal records over the per-session cap; keeps in-flight', async () => {
    const client = fakeClient({
      getBuildStatus: vi.fn(async () => build({ result: 'SUCCESS' })),
    })
    // 用 jobName 区分：j-inflight 保持构建中
    const inflight = fakeClient({
      getBuildStatus: vi.fn(async () => build({ building: true })),
    })
    const registry = await createTriggerRegistry(
      makeOptions({
        getClient: async (connection) => (connection === 'inflight' ? inflight : client),
      }),
    )
    // 6 条记录：j1..j5 终态（ok）、j-inflight 在途；maxPerSession=3 → 淘汰 3 条最旧终态
    for (let i = 1; i <= 5; i += 1) {
      await registry.recordTrigger(recordInput({ jobName: `j${i}`, displayName: `j${i}`, connection: 'prod', buildNumber: i }))
      now = new Date(now.getTime() + 1000)
    }
    await registry.recordTrigger(recordInput({ jobName: 'j-inflight', displayName: 'j-inflight', connection: 'inflight', buildNumber: 99 }))
    now = new Date(now.getTime() + 1000)
    await registry.pollOnce() // j1..j5 → ok；j-inflight 保持 running

    const terminal = registry.all.filter((r) => r.status === 'ok')
    expect(terminal).toHaveLength(5)
    expect(registry.all.find((r) => r.jobName === 'j-inflight')?.status).toBe('running')

    // sweep：会话共 6 条，上限 3 → 淘汰最旧 3 条终态（j1/j2/j3），在途 j-inflight 保留
    const removed = registry.sweep()
    expect(removed).toBe(3)
    const names = registry.all.map((r) => r.jobName).sort()
    expect(names).toEqual(['j-inflight', 'j4', 'j5'])
    // 生产路径中持久化由 sweepAndSave/写入方负责；此处直接调 sweep 后显式落盘验证
    await registry.save()
    expect(await diskRecords()).toHaveLength(3)
  })

  it('prunes records older than ttlDays (all statuses)', async () => {
    const registry = await createTriggerRegistry(makeOptions({ ttlDays: 1 }))
    await registry.recordTrigger(recordInput({ jobName: 'old' }))
    now = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000)
    // 写入时 sweep 已把超期 old 清理（写入时机 = 清理时机之一）
    await registry.recordTrigger(recordInput({ jobName: 'fresh' }))
    expect(registry.all.map((r) => r.jobName)).toEqual(['fresh'])

    now = new Date(now.getTime() + 24 * 60 * 60 * 1000) // fresh 恰好 1 天（不超期）
    expect(registry.sweep()).toBe(0)
    now = new Date(now.getTime() + 1) // 超过 1 天
    expect(registry.sweep()).toBe(1)
    expect(registry.all).toHaveLength(0)
  })
})

describe('状态流转（queued→running→ok）', () => {
  it('resolves queueId→buildNumber via getQueueItem, then maps build status and persists', async () => {
    let building = true
    const client = fakeClient({
      getQueueItem: vi.fn(async () => ({ id: 42, task: { name: 'deploy', url: 'u' }, stuck: false, blocked: false, buildable: true, timestamp: 1, executable: { number: 7, url: 'u' } })),
      getBuildStatus: vi.fn(async () => build({ number: 7, building })),
    })
    const registry = await createTriggerRegistry(makeOptions({ getClient: async () => client }))
    await registry.recordTrigger(recordInput({ queueId: 42 })) // status queued

    await registry.pollOnce() // queued → running（getQueueItem 解析出 buildNumber 7）
    const running = registry.all[0]
    expect(running.status).toBe('running')
    expect(running.buildNumber).toBe(7)
    expect(running.statusUpdatedAt).toBeGreaterThanOrEqual(running.triggeredAt)

    building = false
    // 客户端切到已完成（getBuildStatus 返回 SUCCESS）
    client.getBuildStatus = vi.fn(async () => build({ number: 7, result: 'SUCCESS' }))
    await registry.pollOnce() // running → ok
    expect(registry.all[0].status).toBe('ok')

    const persisted = await diskRecords()
    expect(persisted[0]).toMatchObject({ status: 'ok', buildNumber: 7 })
  })

  it('maps UNSTABLE→ok, FAILURE→fail, ABORTED/NOT_BUILT→aborted, building→running', async () => {
    const results: Array<{ building: boolean; result?: BuildResult; expect: string }> = [
      { building: true, expect: 'running' },
      { building: false, result: 'SUCCESS', expect: 'ok' },
      { building: false, result: 'UNSTABLE', expect: 'ok' },
      { building: false, result: 'FAILURE', expect: 'fail' },
      { building: false, result: 'ABORTED', expect: 'aborted' },
      { building: false, result: 'NOT_BUILT', expect: 'aborted' },
    ]
    for (const [idx, c] of results.entries()) {
      const iterFile = join(dir, `iter-${idx}.json`) // 每次独立文件，避免 load 历史记录
      const client = fakeClient({
        getBuildStatus: vi.fn(async () => build({ building: c.building, result: c.result })),
      })
      const registry = await createTriggerRegistry(makeOptions({ file: iterFile, getClient: async () => client }))
      await registry.recordTrigger(recordInput({ jobName: 'map', buildNumber: 1 }))
      await registry.pollOnce()
      expect(registry.all[0].status).toBe(c.expect)
    }
  })

  it('keeps queued when queue item is not yet dispatched; tolerates poll errors', async () => {
    const client = fakeClient({
      getQueueItem: vi.fn(async () => undefined), // 未派发/无 executable；latest 无新 timestamp → 不兜底认领
    })
    const registry = await createTriggerRegistry(makeOptions({ getClient: async () => client }))
    await registry.recordTrigger(recordInput({ queueId: 99 }))
    await registry.pollOnce()
    expect(registry.all[0].status).toBe('queued')
    expect(registry.all[0].buildNumber).toBeUndefined()

    // getClient 抛错（如 NoCredentialError）：不崩溃、状态保持
    const failing = await createTriggerRegistry(
      makeOptions({
        file: join(dir, 'failing.json'),
        getClient: async () => {
          throw new Error('no token')
        },
      }),
    )
    await failing.recordTrigger(recordInput({ buildNumber: 1 }))
    await expect(failing.pollOnce()).resolves.toBeUndefined()
    expect(failing.all[0].status).toBe('running')
  })
})

describe('triggered.list / delete', () => {
  async function seedSession() {
    const registry = await createTriggerRegistry(makeOptions())
    await registry.recordTrigger(recordInput({ jobName: 'a', sessionId: 'A' })) // queued
    now = new Date(now.getTime() + 1000)
    await registry.recordTrigger(recordInput({ jobName: 'b', sessionId: 'A', buildNumber: 1 })) // running
    now = new Date(now.getTime() + 1000)
    await registry.recordTrigger(recordInput({ jobName: 'c', sessionId: 'A', buildNumber: 2 })) // running
    now = new Date(now.getTime() + 1000)
    await registry.recordTrigger(recordInput({ jobName: 'x', sessionId: 'B', buildNumber: 3 })) // running
    // 让 A 的 b 变 ok
    await registry.pollOnce()
    return registry
  }

  it('isolates by sessionId and filters by status with pagination', async () => {
    const registry = await seedSession()
    const listA = registry.list({ sessionId: 'A' })
    expect(listA.total).toBe(3)
    expect(listA.records.map((r) => r.jobName)).toEqual(['c', 'b', 'a']) // 新的在前

    const okOnly = registry.list({ sessionId: 'A', status: ['ok'] })
    expect(okOnly.total).toBe(2) // b、c 均被轮询为 ok
    expect(okOnly.records.map((r) => r.jobName)).toEqual(['c', 'b'])

    // 关键：counts 恒为基础作用域分布（这里=会话A），**不受 status 过滤影响**（过滤只改数据区）
    expect(listA.counts).toEqual({ all: 3, queued: 1, running: 0, ok: 2, fail: 0, aborted: 0 })
    expect(okOnly.counts).toEqual({ all: 3, queued: 1, running: 0, ok: 2, fail: 0, aborted: 0 })

    const page = registry.list({ sessionId: 'A', limit: 1, offset: 1 })
    expect(page.records.map((r) => r.jobName)).toEqual(['b'])
    expect(page.total).toBe(3)

    const listB = registry.list({ sessionId: 'B' })
    expect(listB.records.map((r) => r.jobName)).toEqual(['x'])
  })

  it('filters by workspaceId and connection without status affecting counts', async () => {
    const registry = await createTriggerRegistry(makeOptions())
    await registry.recordTrigger(recordInput({ jobName: 'a', connection: 'prod', workspaceId: 'ws-1', workspaceName: '工作区一' })) // queued
    await registry.recordTrigger(recordInput({ jobName: 'b', connection: 'test', workspaceId: 'ws-1', workspaceName: '工作区一', buildNumber: 1 })) // running
    await registry.recordTrigger(recordInput({ jobName: 'c', connection: 'prod', workspaceId: 'ws-2', workspaceName: '工作区二', buildNumber: 2 })) // running

    const ws1 = registry.list({ workspaceId: 'ws-1' })
    expect(ws1.total).toBe(2)
    // a、b 触发时间相同 → 稳定排序保持插入序（a 在前）
    expect(ws1.records.map((r) => r.jobName)).toEqual(['a', 'b'])
    expect(ws1.counts).toEqual({ all: 2, queued: 1, running: 1, ok: 0, fail: 0, aborted: 0 })

    const ws1Prod = registry.list({ workspaceId: 'ws-1', connection: 'prod' })
    expect(ws1Prod.total).toBe(1)
    expect(ws1Prod.records.map((r) => r.jobName)).toEqual(['a'])
    expect(ws1Prod.counts.all).toBe(1)

    const unknownFallback = registry.list({ workspaceId: UNKNOWN_WORKSPACE_ID })
    expect(unknownFallback.total).toBe(0) // 未落 workspaceId 的记录归属 sentinel
    await registry.recordTrigger(recordInput({ jobName: 'legacy', connection: 'prod' }))
    const unknownAfter = registry.list({ workspaceId: UNKNOWN_WORKSPACE_ID })
    expect(unknownAfter.total).toBe(1)
  })

  it('deletes single record by id or clears the session', async () => {
    const registry = await seedSession()
    const target = registry.list({ sessionId: 'A' }).records[0] // 最新的 c
    const removedOne = await registry.delete('A', target.id)
    expect(removedOne).toBe(1)
    expect(registry.list({ sessionId: 'A' }).records.map((r) => r.jobName)).toEqual(['b', 'a'])

    const removedAll = await registry.delete('A')
    expect(removedAll).toBe(2)
    expect(registry.list({ sessionId: 'A' }).total).toBe(0)
    expect(registry.list({ sessionId: 'B' }).total).toBe(1) // 其他会话不受影响
    expect(await diskRecords()).toHaveLength(1)
  })

  it('deletes a record triggered by another session by id（用户报障：总览工作区聚合跨会话）', async () => {
    const registry = await seedSession()
    // 总览按工作区聚合时列表可能含其它会话触发的记录；单条删除只按全局唯一 id，不要求 sessionId 相等
    const other = registry.list({ sessionId: 'B' }).records[0] // B 会话的记录 x
    expect(other).toBeDefined()
    const removed = await registry.delete('A', other.id) // A 会话上下文删除 B 的记录
    expect(removed).toBe(1)
    expect(registry.list({ sessionId: 'B' }).total).toBe(0)
    // 清空语义不受影响：仍只清当前会话
    await registry.recordTrigger(recordInput({ jobName: 'y', sessionId: 'B', buildNumber: 4 }))
    const cleared = await registry.delete('B')
    expect(cleared).toBe(1)
    expect(registry.list({ sessionId: 'A' }).total).toBe(3)
  })
})

describe('持久化容错与门控', () => {
  it('backs up a corrupted file and rebuilds empty', async () => {
    await writeFile(file, '{ not json !!!', 'utf8')
    const registry = await createTriggerRegistry(makeOptions())
    expect(registry.all).toHaveLength(0)
    const backups = await import('node:fs/promises').then((fs) => fs.readdir(dir))
    expect(backups.some((name) => name.includes('.corrupt-'))).toBe(true)
    // 重建后可正常写入
    await registry.recordTrigger(recordInput())
    expect(await diskRecords()).toHaveLength(1)
  })

  it('visible gate pauses timed polling; refreshNow bypasses it', async () => {
    vi.useFakeTimers()
    let calls = 0
    // 一直构建中（building=true）：记录保持 running，每次轮询都会调用 getBuildStatus
    const client = fakeClient({
      getBuildStatus: vi.fn(async () => {
        calls += 1
        return build({ building: true })
      }),
    })
    const registry = await createTriggerRegistry(
      makeOptions({ pollIntervalMs: 100, getClient: async () => client }),
    )
    await registry.recordTrigger(recordInput({ buildNumber: 1 }))

    registry.start()
    registry.setVisible(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toBe(0) // 不可见：定时轮询暂停

    registry.setVisible(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toBe(1) // 可见：轮询恢复

    registry.setVisible(false)
    await registry.refreshNow() // 强制即时刷新绕过门控
    expect(calls).toBe(2)

    registry.dispose()
  })

  it('daily sweep timer prunes over TTL without user action', async () => {
    vi.useFakeTimers()
    const registry = await createTriggerRegistry(makeOptions({ ttlDays: 1 }))
    await registry.recordTrigger(recordInput({ jobName: 'old' }))
    now = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000)
    registry.start()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000) // 每日 sweep 触发
    expect(registry.all).toHaveLength(0)
    registry.dispose()
  })

  it('watchAlways keeps timed polling running while the panel is not visible', async () => {
    vi.useFakeTimers()
    let calls = 0
    const client = fakeClient({
      getBuildStatus: vi.fn(async () => {
        calls += 1
        return build({ building: true })
      }),
    })
    const registry = await createTriggerRegistry(
      makeOptions({ pollIntervalMs: 100, getClient: async () => client, watchAlways: true }),
    )
    await registry.recordTrigger(recordInput({ buildNumber: 1 }))

    registry.start()
    registry.setVisible(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toBeGreaterThan(0) // 失败自动分析开启：面板不可见也持续轮询

    registry.dispose()
  })
})

describe('失败自动分析钩子（onBuildFailed / rawResult / analysis）', () => {
  it('fires onBuildFailed exactly once on in-flight → fail transition and stores rawResult', async () => {
    const onBuildFailed = vi.fn(async () => {})
    const info: Partial<BuildInfo> = { building: true } // build(info) 展开取当次值，改字段即改响应
    const client = fakeClient({ getBuildStatus: vi.fn(async () => build(info)) })
    const registry = await createTriggerRegistry(makeOptions({ getClient: async () => client, onBuildFailed }))
    const record = await registry.recordTrigger(recordInput({ buildNumber: 5 }))

    await registry.pollOnce() // building → 保持 running，不回调
    expect(onBuildFailed).not.toHaveBeenCalled()

    info.building = false
    info.result = 'FAILURE'
    await registry.pollOnce() // running → fail：流转瞬间回调一次
    expect(onBuildFailed).toHaveBeenCalledTimes(1)
    expect(onBuildFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: record.id, status: 'fail', rawResult: 'FAILURE' }),
    )

    await registry.pollOnce() // 终态不再轮询：不重复回调
    expect(onBuildFailed).toHaveBeenCalledTimes(1)
    expect((await diskRecords())[0].rawResult).toBe('FAILURE')
  })

  it('maps UNSTABLE to ok without firing onBuildFailed but keeps rawResult', async () => {
    const onBuildFailed = vi.fn(async () => {})
    const client = fakeClient({ getBuildStatus: vi.fn(async () => build({ building: false, result: 'UNSTABLE' })) })
    const registry = await createTriggerRegistry(makeOptions({ getClient: async () => client, onBuildFailed }))
    await registry.recordTrigger(recordInput({ buildNumber: 2 }))

    await registry.pollOnce()
    expect(onBuildFailed).not.toHaveBeenCalled() // UNSTABLE 不算失败，不自动分析
    const persisted = (await diskRecords())[0]
    expect(persisted.status).toBe('ok')
    expect(persisted.rawResult).toBe('UNSTABLE')
  })

  it('markAnalysisPushed persists analysis state and pushedAt', async () => {
    const registry = await createTriggerRegistry(makeOptions())
    const record = await registry.recordTrigger(recordInput({ buildNumber: 9 }))

    expect(await registry.markAnalysisPushed(record.id)).toBe(true)
    const persisted = (await diskRecords())[0]
    expect(persisted.analysis).toBe('pushed')
    expect(persisted.pushedAt).toBe(now.getTime())
    expect(await registry.markAnalysisPushed('missing-id')).toBe(false)
  })

  it('loads legacy records without analysis fields; transition and new fields still work', async () => {
    const onBuildFailed = vi.fn(async () => {})
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        records: [
          {
            id: 'legacy-1',
            connection: 'prod',
            jobName: 'deploy',
            displayName: 'deploy',
            buildNumber: 3,
            params: {},
            status: 'running',
            triggeredAt: now.getTime(),
            statusUpdatedAt: now.getTime(),
            sessionId: 'session-A',
            source: 'conversation',
          },
        ],
      }),
      'utf8',
    )
    const client = fakeClient({ getBuildStatus: vi.fn(async () => build({ building: false, result: 'FAILURE' })) })
    const registry = await createTriggerRegistry(makeOptions({ getClient: async () => client, onBuildFailed }))
    expect(registry.all[0].analysis).toBeUndefined() // 旧记录无 analysis 字段可加载

    await registry.pollOnce()
    expect(onBuildFailed).toHaveBeenCalledTimes(1) // 在途 → fail 流转照常回调
    await registry.markAnalysisPushed('legacy-1')

    const reloaded = await createTriggerRegistry(makeOptions())
    expect(reloaded.all[0].analysis).toBe('pushed') // 新字段随盘往返
    expect(reloaded.all[0].rawResult).toBe('FAILURE')
  })
})

// 旧记录 workspaceId 回填的相关用例已随该功能移除（2026-09-11，用户决策）：
// 原实现在 load() 里跑一次，而那一刻 ctx.sessions 必为空、解析必失败且无重试点，属"看似在
// 兜底"的死代码；存量缺字段记录是一次性历史数据（workspaceId 引入于 2026-08-31 之后不再产生），
// TTL 自动清理，且保留回填会在 P0-a 修复后开始静默改写历史记录。详见 src/jenkins/registry.ts。
