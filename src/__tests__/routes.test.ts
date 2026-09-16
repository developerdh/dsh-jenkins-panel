/**
 * host 路由单测（HOST-M1-09）：/jenkins/api/* 信封分发 + 16 method + /jenkins/api/file 媒体路由。
 * 覆盖：body 校验、triggered 过滤分页、conn.list 无敏感字段、build.log 缺省 tail=500 与超限提示、
 * file 白名单防路径穿越、session.cwd 接线、未知方法/非法 JSON/非 POST。
 */
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, vi } from 'vitest'

import type { JenkinsClient } from '../jenkins/client.js'
import { createConnectionRegistry } from '../jenkins/connection.js'
import type { TriggerRegistry } from '../jenkins/registry.js'
import { registerJenkinsRoutes, type JenkinsRoutesDeps } from '../routes.js'

function fakeClient(overrides?: Partial<JenkinsClient>): JenkinsClient {
  return {
    getAllJobsRecursive: vi.fn(async () => []),
    getJobInfo: vi.fn(async () => ({ name: 'j', fullName: 'j', url: 'u', color: 'blue', buildable: true, inQueue: false, nextBuildNumber: 2, builds: [], property: [] })),
    getJobParams: vi.fn(async () => []),
    getBuildStatus: vi.fn(async () => ({ number: 1, url: 'u', building: false, result: 'SUCCESS' as const })),
    getBuildHistory: vi.fn(async () => ({ jobName: 'j', builds: [], totalCount: 0 })),
    getBuildLog: vi.fn(async () => ({ jobName: 'j', buildNumber: 1, log: 'a\nb', totalLines: 2 })),
    getProgressiveLog: vi.fn(async () => ({ text: 'new', nextStart: 42, moreData: true })),
    retryBuild: vi.fn(async () => {}),
    cancelBuild: vi.fn(async () => {}),
    deleteBuild: vi.fn(async () => {}),
    cancelQueueItem: vi.fn(async () => {}),
    getBuildArtifacts: vi.fn(async () => []),
    getFolderChildren: vi.fn(async () => []),
    listQueue: vi.fn(async () => []),
    getWorkspaceInfo: vi.fn(async () => ({ jobName: 'j', buildable: true })),
    wipeWorkspace: vi.fn(async () => {}),
    downloadArtifact: vi.fn(async () => ({ stream: Readable.from(['DATA']) })),
    ping: vi.fn(async () => ({ ok: true, latencyMs: 12 })),
    ...overrides,
  } as unknown as JenkinsClient
}

interface FakeRes {
  headers: Record<string, string>
  chunks: string[]
  payload: unknown
  /** end() 触发时 resolve（文件流经 pipe 异步写入后等待用） */
  settled: Promise<void>
}

function fakeRes(): ServerResponse & FakeRes {
  const state: FakeRes = { headers: {}, chunks: [], payload: undefined, settled: Promise.resolve() }
  let resolveDone!: () => void
  state.settled = new Promise<void>((resolve) => { resolveDone = resolve })
  const res = {
    get headers() { return state.headers },
    get chunks() { return state.chunks },
    get payload() { return state.payload },
    get settled() { return state.settled },
    setHeader(key: string, value: string) { state.headers[key.toLowerCase()] = String(value) },
    write(chunk: string | Buffer) { state.chunks.push(chunk.toString()) },
    end(chunk?: string | Buffer) {
      if (chunk) state.chunks.push(chunk.toString())
      const text = state.chunks.join('')
      if (text) {
        try { state.payload = JSON.parse(text) } catch { state.payload = text }
      }
      resolveDone()
    },
    // stream.pipe(dest) 需要的监听器/事件面
    on() { return res },
    once() { return res },
    emit() { return true },
  }
  return res as unknown as ServerResponse & FakeRes
}

function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const chunks = typeof body === 'string' ? [body] : body === undefined ? [] : [JSON.stringify(body)]
  const stream = Readable.from(chunks)
  return Object.assign(stream, { method, url }) as unknown as IncomingMessage
}

interface Bed {
  ctx: Context
  deps: JenkinsRoutesDeps
  client: JenkinsClient
  getClient: ReturnType<typeof vi.fn>
  triggerRegistry: { list: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }
  route: WebRoute
}

function createBed(overrides?: Partial<JenkinsRoutesDeps>): Bed {
  const client = fakeClient()
  const getClient = vi.fn(async () => client)
  const triggerRegistry = {
    list: vi.fn(() => ({ records: [], total: 0, counts: { all: 0, queued: 0, running: 0, ok: 0, fail: 0, aborted: 0 } })),
    delete: vi.fn(async () => 1),
  }
  const listConnections = vi.fn(async () => [{ name: 'prod', isDefault: true, hasToken: true }])
  const ctx = { webServer: { register: vi.fn() } } as unknown as Context
  const deps: JenkinsRoutesDeps = {
    registry: createConnectionRegistry({
      defaultConnection: 'prod',
      connections: [{ name: 'prod', url: 'https://jenkins.example.com', timeout: 30_000 }],
    }),
    getClient,
    triggerRegistry: triggerRegistry as unknown as TriggerRegistry,
    listConnections,
    ...overrides,
  }
  registerJenkinsRoutes(ctx, deps)
  const route = (ctx.webServer.register as ReturnType<typeof vi.fn>).mock.calls[0][0] as WebRoute
  return { ctx, deps, client, getClient, triggerRegistry, route }
}

async function invoke(route: WebRoute, method: string, url: string, body?: unknown): Promise<FakeRes> {
  const res = fakeRes()
  await route.handler(fakeReq(method, url, body), res as unknown as ServerResponse)
  return res
}

describe('路由注册与信封', () => {
  it('registers a prefix route at /jenkins/api', () => {
    const { route } = createBed()
    expect(route.kind).toBe('prefix')
    expect(route.path).toBe('/jenkins/api')
  })

  it('rejects non-POST and unknown methods with envelope errors', async () => {
    const { route } = createBed()
    const get = await invoke(route, 'GET', '/jenkins/api/triggered.list')
    expect(get.payload).toMatchObject({ ok: false, error: expect.stringContaining('不支持的方法') })

    const unknown = await invoke(route, 'POST', '/jenkins/api/nope')
    expect(unknown.payload).toMatchObject({ ok: false, error: '未知路由方法：nope' })
  })

  it('rejects malformed JSON body', async () => {
    const { route } = createBed()
    const res = await invoke(route, 'POST', '/jenkins/api/conn.list', '{oops')
    expect(res.payload).toMatchObject({ ok: false, error: '请求体不是合法 JSON' })
  })
})

describe('triggered.*（总览，跨连接混合）', () => {
  it('triggered.list passes workspace/connection/status/limit/offset to registry', async () => {
    const { route, triggerRegistry } = createBed()
    const res = await invoke(route, 'POST', '/jenkins/api/triggered.list', {
      sessionId: 's1', workspace: 'all', connection: 'prod', status: ['ok', 'fail'], limit: 10, offset: 5,
    })
    expect(triggerRegistry.list).toHaveBeenCalledWith(
      expect.objectContaining({ connection: 'prod', status: ['ok', 'fail'], limit: 10, offset: 5 }),
    )
    expect(res.payload).toEqual({
      ok: true,
      value: { records: [], total: 0, counts: { all: 0, queued: 0, running: 0, ok: 0, fail: 0, aborted: 0 }, workspaceResolved: true },
    })
  })

  it('triggered.list works without sessionId (workspace=all); triggered.delete delegates', async () => {
    const { route, triggerRegistry } = createBed()
    const all = await invoke(route, 'POST', '/jenkins/api/triggered.list', { workspace: 'all' })
    expect(all.payload).toMatchObject({ ok: true })

    const del = await invoke(route, 'POST', '/jenkins/api/triggered.delete', { sessionId: 's1', id: 'rec-9' })
    expect(triggerRegistry.delete).toHaveBeenCalledWith('s1', 'rec-9')
    expect(del.payload).toEqual({ ok: true, value: { deleted: 1 } })
  })

  it('P0-b：current 解析不到工作区时如实标注 workspaceResolved=false（不再静默放宽成「全部」）', async () => {
    // 用户报障：重启后面板 chip 显示「当前工作区」，却列出全部工作区的记录
    const { route, triggerRegistry } = createBed({ resolveWorkspaceId: async () => undefined })
    triggerRegistry.list.mockReturnValue({
      records: [
        {
          id: 'r-other', connection: 'prod', jobName: 'a/b', displayName: 'b', params: {},
          status: 'ok', triggeredAt: 1, statusUpdatedAt: 1, sessionId: 's-other',
          workspaceId: 'ws-other', source: 'conversation',
        },
      ],
      total: 1,
      counts: { all: 1, queued: 0, running: 0, ok: 1, fail: 0, aborted: 0 },
    })

    const res = await invoke(route, 'POST', '/jenkins/api/triggered.list', { sessionId: 's1', workspace: 'current' })
    const value = (res.payload as { value: { workspaceResolved: boolean; records: unknown[]; total: number } }).value
    expect(triggerRegistry.list).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: undefined }))
    expect(value.workspaceResolved).toBe(false) // ← 关键：不再谎报"已按当前工作区过滤"
    expect(value.total).toBe(1) // 记录仍返回（保住可见性），但已被显式标注
    expect(value.records).toHaveLength(1)
  })

  it('P0-b：current 解析成功 / all → workspaceResolved=true，且解析结果下传过滤', async () => {
    const resolved = createBed({ resolveWorkspaceId: async () => 'ws-1' })
    const cur = await invoke(resolved.route, 'POST', '/jenkins/api/triggered.list', { sessionId: 's1', workspace: 'current' })
    expect((cur.payload as { value: { workspaceResolved: boolean } }).value.workspaceResolved).toBe(true)
    expect(resolved.triggerRegistry.list).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-1' }))

    const all = createBed()
    const allRes = await invoke(all.route, 'POST', '/jenkins/api/triggered.list', { workspace: 'all' })
    expect((allRes.payload as { value: { workspaceResolved: boolean } }).value.workspaceResolved).toBe(true)
  })

  it('P0-b：current 但未带 sessionId → 同样标注 false（不假装过滤成功）', async () => {
    const { route } = createBed({ resolveWorkspaceId: async () => 'ws-1' })
    const res = await invoke(route, 'POST', '/jenkins/api/triggered.list', { workspace: 'current' })
    expect((res.payload as { value: { workspaceResolved: boolean } }).value.workspaceResolved).toBe(false)
  })
})

describe('conn.* / session.cwd', () => {
  it('conn.list returns summaries without URL/credentials', async () => {
    const { route } = createBed()
    const res = await invoke(route, 'POST', '/jenkins/api/conn.list', {})
    const value = (res.payload as { value: Array<Record<string, unknown>> }).value
    expect(value).toEqual([{ name: 'prod', isDefault: true, hasToken: true }])
    expect(value[0]).not.toHaveProperty('url')
    expect(value[0]).not.toHaveProperty('token')
  })

  it('conn.test returns ok/message on ping and degrades on failure', async () => {
    const bed = createBed()
    const ok = await invoke(bed.route, 'POST', '/jenkins/api/conn.test', {})
    expect(ok.payload).toMatchObject({ ok: true, value: { ok: true, message: expect.stringContaining('连接正常') } })

    const failing = createBed({ getClient: async () => { throw new Error('no token') } })
    const bad = await invoke(failing.route, 'POST', '/jenkins/api/conn.test', {})
    expect(bad.payload).toMatchObject({ ok: true, value: { ok: false, message: 'no token' } })
  })

  it('session.cwd resolves via injected getSessionCwd', async () => {
    const bed = createBed({ getSessionCwd: async () => '/workspaces/s1' })
    const res = await invoke(bed.route, 'POST', '/jenkins/api/session.cwd', { sessionId: 's1' })
    expect(res.payload).toEqual({ ok: true, value: { cwd: '/workspaces/s1' } })

    const unwired = createBed()
    const err = await invoke(unwired.route, 'POST', '/jenkins/api/session.cwd', { sessionId: 's1' })
    expect(err.payload).toMatchObject({ ok: false, error: expect.stringContaining('未接线') })
  })
})

describe('job.* / build.*', () => {
  it('job.info resolves jobName then fetches info', async () => {
    const bed = createBed()
    bed.client.getAllJobsRecursive = vi.fn(async () => [{ name: 'deploy', fullName: 'project/deploy', displayName: '部署', url: 'u' }])
    const res = await invoke(bed.route, 'POST', '/jenkins/api/job.info', { jobName: 'deploy' })
    expect(bed.client.getJobInfo).toHaveBeenCalledWith('project/deploy')
    expect(res.payload).toMatchObject({ ok: true })
  })

  it('build.log defaults to tail 500 and appends pagination hint', async () => {
    const bed = createBed()
    bed.client.getAllJobsRecursive = vi.fn(async () => [{ name: 'deploy', fullName: 'project/deploy', url: 'u' }])
    bed.client.getBuildLog = vi.fn(async () => ({ jobName: 'project/deploy', buildNumber: 3, log: 'a\nb', totalLines: 100 }))
    const res = await invoke(bed.route, 'POST', '/jenkins/api/build.log', { jobName: 'deploy' })
    expect(bed.client.getBuildLog).toHaveBeenCalledWith('project/deploy', undefined, {
      startLine: undefined, limit: undefined, tail: 500,
    })
    expect((res.payload as { value: { log: string } }).value.log).toContain('共 100 行，已显示 2 行')

    await invoke(bed.route, 'POST', '/jenkins/api/build.log', { jobName: 'project/deploy', limit: 10 })
    expect(bed.client.getBuildLog).toHaveBeenLastCalledWith('project/deploy', undefined, {
      startLine: undefined, limit: 10, tail: undefined,
    })
  })

  it('build.status / artifacts / queue.list delegate with resolved connection', async () => {
    const bed = createBed()
    bed.client.getAllJobsRecursive = vi.fn(async () => [{ name: 'deploy', fullName: 'project/deploy', url: 'u' }])
    await invoke(bed.route, 'POST', '/jenkins/api/build.status', { jobName: 'deploy', buildNumber: 5 })
    expect(bed.client.getBuildStatus).toHaveBeenCalledWith('project/deploy', 5)

    await invoke(bed.route, 'POST', '/jenkins/api/queue.list', {})
    expect(bed.client.listQueue).toHaveBeenCalledOnce()
  })
})

describe('build.log.stream / build.retry / build.cancel / build.delete（CLIENT-M2-06 增补路由）', () => {
  function bedWithJob() {
    const bed = createBed()
    bed.client.getAllJobsRecursive = vi.fn(async () => [{ name: 'deploy', fullName: 'project/deploy', url: 'u' }])
    return bed
  }

  it('build.log.stream passes startByte/buildNumber and returns progressive payload', async () => {
    const bed = bedWithJob()
    bed.client.getProgressiveLog = vi.fn(async () => ({ text: '增量', nextStart: 128, moreData: true }))
    const res = await invoke(bed.route, 'POST', '/jenkins/api/build.log.stream', {
      jobName: 'deploy', buildNumber: 7, startByte: 100,
    })
    expect(bed.client.getProgressiveLog).toHaveBeenCalledWith('project/deploy', 7, 100)
    expect(res.payload).toEqual({ ok: true, value: { text: '增量', nextStart: 128, moreData: true } })
  })

  it('build.retry delegates to retryBuild and returns ok message', async () => {
    const bed = bedWithJob()
    const res = await invoke(bed.route, 'POST', '/jenkins/api/build.retry', { jobName: 'deploy' })
    expect(bed.client.retryBuild).toHaveBeenCalledWith('project/deploy', undefined)
    expect(res.payload).toMatchObject({ ok: true, value: { ok: true } })
  })

  it('build.cancel stops a running build by buildNumber', async () => {
    const bed = bedWithJob()
    const res = await invoke(bed.route, 'POST', '/jenkins/api/build.cancel', { jobName: 'deploy', buildNumber: 5 })
    expect(bed.client.cancelBuild).toHaveBeenCalledWith('project/deploy', 5)
    expect(res.payload).toMatchObject({ ok: true, value: { ok: true, message: expect.stringContaining('#5') } })
  })

  it('build.cancel cancels a queue item by queueId', async () => {
    const bed = bedWithJob()
    await invoke(bed.route, 'POST', '/jenkins/api/build.cancel', { jobName: 'deploy', queueId: 77 })
    expect(bed.client.cancelQueueItem).toHaveBeenCalledWith(77)
    expect(bed.client.cancelBuild).not.toHaveBeenCalled()
  })

  it('build.cancel falls back to queue.list lookup by jobName', async () => {
    const bed = bedWithJob()
    bed.client.listQueue = vi.fn(async () => [
      { id: 11, task: { name: 'deploy', fullName: 'project/deploy', url: 'u' }, why: 'waiting', stuck: false, blocked: false, buildable: true, timestamp: 0 },
    ])
    const res = await invoke(bed.route, 'POST', '/jenkins/api/build.cancel', { jobName: 'deploy' })
    expect(bed.client.cancelQueueItem).toHaveBeenCalledWith(11)
    expect(res.payload).toMatchObject({ ok: true, value: { ok: true, message: expect.stringContaining('#11') } })
  })

  it('build.cancel errors when queued item not found', async () => {
    const bed = bedWithJob()
    bed.client.listQueue = vi.fn(async () => [])
    const res = await invoke(bed.route, 'POST', '/jenkins/api/build.cancel', { jobName: 'deploy' })
    expect(res.payload).toMatchObject({ ok: false, error: expect.stringContaining('排队中') })
  })

  it('build.delete requires buildNumber and delegates to deleteBuild', async () => {
    const bed = bedWithJob()
    const missing = await invoke(bed.route, 'POST', '/jenkins/api/build.delete', { jobName: 'deploy' })
    expect(missing.payload).toMatchObject({ ok: false, error: expect.stringContaining('buildNumber') })

    const res = await invoke(bed.route, 'POST', '/jenkins/api/build.delete', { jobName: 'deploy', buildNumber: 3 })
    expect(bed.client.deleteBuild).toHaveBeenCalledWith('project/deploy', 3)
    expect(res.payload).toMatchObject({ ok: true, value: { ok: true, message: expect.stringContaining('#3') } })
  })
})

describe('folder.tree / jobs.search / workspace.cleanup', () => {
  it('folder.tree lazy-loads direct children of the folder', async () => {
    const bed = createBed()
    await invoke(bed.route, 'POST', '/jenkins/api/folder.tree', { folder: 'release' })
    expect(bed.client.getFolderChildren).toHaveBeenCalledWith('release')
  })

  it('jobs.search filters the flattened tree by q', async () => {
    const bed = createBed()
    bed.client.getAllJobsRecursive = vi.fn(async () => [
      { name: 'deploy', fullName: 'project/deploy', displayName: '部署', url: 'u' },
      { name: 'test', fullName: 'project/test', displayName: '测试', url: 'u' },
    ])
    const res = await invoke(bed.route, 'POST', '/jenkins/api/jobs.search', { q: 'deploy' })
    expect((res.payload as { value: unknown[] }).value).toHaveLength(1)
  })

  it('workspace.cleanup dry-runs by default and wipes on confirm', async () => {
    const bed = createBed()
    bed.client.getAllJobsRecursive = vi.fn(async () => [{ name: 'deploy', fullName: 'project/deploy', url: 'u' }])
    const preview = await invoke(bed.route, 'POST', '/jenkins/api/workspace.cleanup', { jobName: 'deploy' })
    expect(preview.payload).toMatchObject({ ok: true, value: { dryRun: true } })
    expect(bed.client.wipeWorkspace).not.toHaveBeenCalled()

    const wipe = await invoke(bed.route, 'POST', '/jenkins/api/workspace.cleanup', { jobName: 'deploy', dryRun: false })
    expect(bed.client.wipeWorkspace).toHaveBeenCalledWith('project/deploy')
    expect(wipe.payload).toMatchObject({ ok: true, value: { dryRun: false, ok: true } })
  })
})

describe('/jenkins/api/file（产物下载媒体路由）', () => {
  const artifacts = [{ displayPath: 'target/a.jar', fileName: 'a.jar', relativePath: 'target/a.jar' }]

  function fileBed() {
    const bed = createBed()
    bed.client.getAllJobsRecursive = vi.fn(async () => [{ name: 'deploy', fullName: 'project/deploy', url: 'u' }])
    bed.client.getBuildArtifacts = vi.fn(async () => artifacts)
    return bed
  }

  it('validates against the artifact whitelist and streams the file', async () => {
    const bed = fileBed()
    const res = await invoke(bed.route, 'GET', '/jenkins/api/file?jobName=deploy&buildNumber=5&relativePath=target%2Fa.jar')
    await res.settled // 等待 pipe 异步流完
    expect(bed.client.downloadArtifact).toHaveBeenCalledWith('project/deploy', 5, 'target/a.jar')
    expect(res.headers['content-disposition']).toBe('attachment; filename="a.jar"')
    expect(res.chunks.join('')).toContain('DATA')
  })

  it('rejects path traversal and non-artifact paths', async () => {
    const bed = fileBed()
    const traversal = await invoke(bed.route, 'GET', '/jenkins/api/file?jobName=deploy&buildNumber=5&relativePath=..%2F..%2Fetc%2Fpasswd')
    expect(traversal.payload).toMatchObject({ ok: false, error: '非法的产物路径' })

    const notArtifact = await invoke(bed.route, 'GET', '/jenkins/api/file?jobName=deploy&buildNumber=5&relativePath=other.txt')
    expect(notArtifact.payload).toMatchObject({ ok: false, error: expect.stringContaining('不在构建') })
    expect(bed.client.downloadArtifact).not.toHaveBeenCalled()
  })

  it('rejects missing params', async () => {
    const bed = fileBed()
    const res = await invoke(bed.route, 'GET', '/jenkins/api/file?jobName=deploy')
    expect(res.payload).toMatchObject({ ok: false, error: expect.stringContaining('参数缺失') })
  })
})

describe('缺口补齐（FIN-M3-02：body 校验 / 方法集契约）', () => {
  /** 可解析任务 + 全能力 bed（供 §5 方法集完整性断言） */
  function fullBed() {
    const bed = createBed({ getSessionCwd: async () => '/ws' })
    bed.client.getAllJobsRecursive = vi.fn(async () => [{ name: 'deploy', fullName: 'project/deploy', displayName: '部署', url: 'u' }])
    return bed
  }

  it('jobs.search requires q (body 校验 → 信封错误)', async () => {
    const bed = fullBed()
    const res = await invoke(bed.route, 'POST', '/jenkins/api/jobs.search', {})
    expect(res.payload).toMatchObject({ ok: false, error: '缺少参数 q' })
  })

  it('triggered.delete with omitted id delegates clear-all semantics', async () => {
    const bed = createBed()
    await invoke(bed.route, 'POST', '/jenkins/api/triggered.delete', { sessionId: 's1' })
    expect(bed.triggerRegistry.delete).toHaveBeenCalledWith('s1', undefined)
  })

  it('build.log passes start/limit/tail through (分段模式)', async () => {
    const bed = fullBed()
    await invoke(bed.route, 'POST', '/jenkins/api/build.log', { jobName: 'deploy', start: 50, limit: 20 })
    expect(bed.client.getBuildLog).toHaveBeenLastCalledWith('project/deploy', undefined, {
      startLine: 50, limit: 20, tail: undefined,
    })
  })

  it('build.retry passes buildNumber; build.log.stream defaults startByte 0', async () => {
    const bed = fullBed()
    await invoke(bed.route, 'POST', '/jenkins/api/build.retry', { jobName: 'deploy', buildNumber: 9 })
    expect(bed.client.retryBuild).toHaveBeenCalledWith('project/deploy', 9)

    await invoke(bed.route, 'POST', '/jenkins/api/build.log.stream', { jobName: 'deploy', buildNumber: 7 })
    expect(bed.client.getProgressiveLog).toHaveBeenCalledWith('project/deploy', 7, 0)
  })

  it('queue.list / folder.tree / workspace.info pass connection and folder defaults', async () => {
    const bed = fullBed()
    await invoke(bed.route, 'POST', '/jenkins/api/queue.list', { connection: 'test' })
    expect(bed.getClient).toHaveBeenLastCalledWith('test')
    expect(bed.client.listQueue).toHaveBeenCalled()

    await invoke(bed.route, 'POST', '/jenkins/api/folder.tree', {})
    expect(bed.client.getFolderChildren).toHaveBeenCalledWith(undefined) // 缺省根

    await invoke(bed.route, 'POST', '/jenkins/api/workspace.info', { jobName: 'deploy' })
    expect(bed.client.getWorkspaceInfo).toHaveBeenCalledWith('project/deploy')
  })

  it('conn.test reports latency in the message', async () => {
    const bed = createBed()
    bed.client.ping = vi.fn(async () => ({ ok: true, latencyMs: 34 }))
    const res = await invoke(bed.route, 'POST', '/jenkins/api/conn.test', {})
    expect(res.payload).toMatchObject({ ok: true, value: { ok: true, message: expect.stringContaining('34ms') } })
  })

  it('rejects methods without a dot and empty method segments', async () => {
    const bed = createBed()
    const noDot = await invoke(bed.route, 'POST', '/jenkins/api/foo')
    expect(noDot.payload).toMatchObject({ ok: false, error: '未知路由方法：foo' })

    const empty = await invoke(bed.route, 'POST', '/jenkins/api/')
    expect(empty.payload).toMatchObject({ ok: false, error: '未知路由方法：' })
  })

  it('all 20 documented §5 POST methods dispatch to ok envelopes (方法集契约)', async () => {
    const bed = fullBed()
    // docs/interface-and-data-model.md §5 路由表 20 个 POST method（含回流补的
    // build.log.stream / build.retry / build.cancel / build.delete 与 session.cwd）
    const cases: Array<[string, Record<string, unknown>]> = [
      ['triggered.list', { sessionId: 's1' }],
      ['triggered.delete', { sessionId: 's1', id: 'r1' }],
      ['job.info', { jobName: 'deploy' }],
      ['job.params', { jobName: 'deploy' }],
      ['build.status', { jobName: 'deploy' }],
      ['build.history', { jobName: 'deploy' }],
      ['build.log', { jobName: 'deploy', tail: 100 }],
      ['build.log.stream', { jobName: 'deploy' }],
      ['build.retry', { jobName: 'deploy' }],
      ['build.cancel', { jobName: 'deploy', queueId: 1 }],
      ['build.delete', { jobName: 'deploy', buildNumber: 3 }],
      ['build.artifacts', { jobName: 'deploy' }],
      ['queue.list', {}],
      ['workspace.info', { jobName: 'deploy' }],
      ['workspace.cleanup', { jobName: 'deploy' }],
      ['folder.tree', {}],
      ['jobs.search', { q: 'deploy' }],
      ['conn.list', {}],
      ['conn.test', {}],
      ['session.cwd', { sessionId: 's1' }],
    ]
    for (const [method, body] of cases) {
      const res = await invoke(bed.route, 'POST', `/jenkins/api/${method}`, body)
      expect(res.payload, `method ${method} 应返回 ok 信封`).toMatchObject({ ok: true })
      expect((res.payload as { value?: unknown }).value).toBeDefined()
    }
  })

  it('resolver multi-candidate red line: routes never auto-pick — envelope error instead', async () => {
    const bed = fullBed()
    // 两个同名 displayName 任务 → resolveJobPath 多候选停下询问 → 信封 ok:false
    bed.client.getAllJobsRecursive = vi.fn(async () => [
      { name: 'order', fullName: 'devops/order/deploy', displayName: '订单部署', url: 'a' },
      { name: 'order2', fullName: 'k8s/order/deploy', displayName: '订单部署', url: 'b' },
    ])
    const res = await invoke(bed.route, 'POST', '/jenkins/api/job.info', { jobName: '订单部署' })
    expect(res.payload).toMatchObject({ ok: false, error: expect.stringContaining('候选') })
    expect(bed.client.getJobInfo).not.toHaveBeenCalled() // 绝不自动选第一个
  })
})

describe('settings.get / settings.update / conn.test inline（CLIENT-M2-07 修复）', () => {
  it('settings.get returns the stored settings object', async () => {
    const bed = createBed()
    const stored = { defaultConnection: 'prod', connections: [{ name: 'prod', url: 'https://j.example.com', timeout: 30_000 }] }
    bed.deps.settings = { get: vi.fn(async () => stored), update: vi.fn(async () => {}) }
    const res = await invoke(bed.route, 'POST', '/jenkins/api/settings.get', {})
    expect(res.payload).toMatchObject({ ok: true, value: stored })
  })

  it('settings.update rejects case-insensitive duplicate names without saving', async () => {
    const bed = createBed()
    const update = vi.fn(async () => {})
    bed.deps.settings = { get: vi.fn(async () => ({ defaultConnection: '', connections: [] })), update }
    const body = { defaultConnection: 'prod', connections: [
      { name: 'prod', url: 'https://j.example.com', timeout: 30_000 },
      { name: 'PROD', url: 'https://x', timeout: 1 },
    ] }
    const res = await invoke(bed.route, 'POST', '/jenkins/api/settings.update', body)
    expect(res.payload).toMatchObject({ ok: false, error: expect.stringContaining('重复') })
    expect(update).not.toHaveBeenCalled()
  })

  it('settings.update ok path persists the list', async () => {
    const bed = createBed()
    const update = vi.fn(async () => {})
    bed.deps.settings = { get: vi.fn(async () => ({ defaultConnection: '', connections: [] })), update }
    const body = { defaultConnection: 'prod', connections: [{ name: 'prod', url: 'https://j.example.com', timeout: 30_000 }] }
    const res = await invoke(bed.route, 'POST', '/jenkins/api/settings.update', body)
    expect(res.payload).toMatchObject({ ok: true })
    expect(update).toHaveBeenCalledWith({ defaultConnection: 'prod', connections: [{ name: 'prod', url: 'https://j.example.com', timeout: 30_000 }] })
  })

  it('conn.test supports unsaved inline connection (url/token) without resolving by name', async () => {
    const bed = createBed()
    // 内联路径构造真实 JenkinsClient（不注入 fake），无真实服务器 → 返回连接失败；
    // 关键在于**不走 getClient 按名解析**（未保存连接本就不在注册表）
    const res = await invoke(bed.route, 'POST', '/jenkins/api/conn.test', {
      name: 'new', url: 'https://127.0.0.1:1/jenkins', username: 'ci', token: 'tok', timeout: 1000,
    })
    expect(res.payload).toMatchObject({ ok: true, value: { ok: false } })
    expect(bed.getClient).not.toHaveBeenCalled()
  })

  it('conn.test without url still resolves by name', async () => {
    const bed = createBed()
    bed.client.ping = vi.fn(async () => ({ ok: true, latencyMs: 8 }))
    const res = await invoke(bed.route, 'POST', '/jenkins/api/conn.test', { connection: 'prod' })
    expect(res.payload).toMatchObject({ ok: true })
    expect(bed.getClient).toHaveBeenCalledWith('prod')
  })
})
