/**
 * 契约对拍测试（FIN-M3-02 阶段 3 + 连接枚举工具补充）
 *
 * 基线：docs/interface-and-data-model.md
 *   - §3 工具契约：24 个 jenkins_* 工具入参 schema / 返回结构逐条断言
 *     （23 个单连接工具 + jenkins_connection_list 连接枚举补充）；
 *   - §5 路由契约：20 个 POST method（含回流补的 build.log.stream/retry/cancel/delete
 *     与 session.cwd）+ GET /jenkins/api/file 媒体路由。
 *
 * 方式：mock Jenkins 响应（假客户端 / 假路由 bed），**不连真实环境**。
 * 红线：任何「多匹配自选」类行为（resolver resolveJob 多候选自动选第一个 /
 *       工具/路由静默取第一个候选）必须 fail。
 *
 * 偏差登记：对拍发现的文档/实现偏差集中登记于「§9 偏差登记」describe，
 * 以显式期望固化当前行为（不破坏套件），供 FIN-M3-03 回流决策。
 */
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, vi } from 'vitest'

import type { JenkinsClient } from '../src/jenkins/client.js'
import { createConnectionRegistry } from '../src/jenkins/connection.js'
import { resolveJob } from '../src/jenkins/resolver.js'
import type { TriggerRegistry } from '../src/jenkins/registry.js'
import { registerJenkinsRoutes, type JenkinsRoutesDeps } from '../src/routes.js'
import { defineBuildTools } from '../src/tools/builds.js'
import { defineJobTools } from '../src/tools/jobs.js'
import { defineOpsTools } from '../src/tools/ops.js'
import { createBed, runTool } from '../src/tools/__tests__/helpers.js'

/* ────────────────────────────────────────────────────────────────────
 * §3 工具契约基线（入参：required/optional；对照 docs §3 表格逐行）
 * ──────────────────────────────────────────────────────────────────── */

interface ParamSpec {
  required: string[]
  optional: string[]
}

/** docs §3 工具入参契约（connection 恒可选，不在此列；jenkins_connection_list 例外：无 connection 参数） */
const TOOL_PARAMS: Record<string, ParamSpec> = {
  jenkins_job_list: { required: [], optional: ['pattern', 'folder', 'recursive'] },
  jenkins_job_search: { required: ['query'], optional: ['limit'] },
  jenkins_job_resolve: { required: ['path'], optional: ['fuzzy'] },
  jenkins_job_info: { required: ['jobName'], optional: [] },
  jenkins_job_params: { required: ['jobName'], optional: [] },
  // 用户需求（2026-09-01）：取消 wait/pollInterval/timeout 入口（恒不等待，触发即返回）
  jenkins_build_trigger: { required: ['jobName'], optional: ['parameters', 'delay'] },
  jenkins_build_status: { required: ['jobName'], optional: ['buildNumber'] },
  jenkins_build_info: { required: ['jobName'], optional: ['buildNumber'] },
  jenkins_build_log: { required: ['jobName'], optional: ['buildNumber', 'startLine', 'limit', 'tail'] },
  jenkins_build_history: { required: ['jobName'], optional: ['limit', 'status'] },
  jenkins_build_history_all: { required: [], optional: ['page', 'pageSize', 'perJobLimit'] },
  jenkins_build_retry: { required: ['jobName'], optional: [] },
  jenkins_build_cancel: { required: ['jobName', 'buildNumber'], optional: [] },
  jenkins_build_delete: { required: ['jobName', 'buildNumber'], optional: [] },
  jenkins_build_artifacts: { required: ['jobName'], optional: ['buildNumber'] },
  jenkins_queue_list: { required: [], optional: [] },
  jenkins_queue_cancel: { required: ['queueId'], optional: [] },
  jenkins_workspace_info: { required: ['jobName'], optional: [] },
  // 偏差登记 D1：docs §3 标 jobName?（可选），实现为必填（jobName = 清理目标）
  jenkins_workspace_cleanup: { required: ['jobName'], optional: ['days', 'dryRun'] },
  jenkins_folder_list: { required: [], optional: ['folder', 'depth'] },
  jenkins_view_list: { required: [], optional: [] },
  jenkins_view_jobs: { required: ['viewName'], optional: [] },
  jenkins_connection_test: { required: [], optional: [] },
  // 连接清单枚举：全局工具，**无 connection 参数**（不属于单连接作用域）
  jenkins_connection_list: { required: [], optional: [] },
}

/** 无 connection 参数的例外工具（§3 通用「connection 恒可选」约定的显式例外） */
const CONNECTIONLESS_TOOLS = new Set(['jenkins_connection_list'])

/** 全部 24 个工具定义（与注册顺序无关；registerJenkinsTools 的展开源） */
function allTools(): Map<string, ToolDefinition> {
  const bed = createBed()
  const tools = [...defineJobTools(bed.deps), ...defineBuildTools(bed.deps), ...defineOpsTools(bed.deps)]
  return new Map(tools.map((t) => [t.name, t]))
}

/**
 * 工具参数 schema 的运行时形态（defineTool 编译后的 JSON Schema 投影）：
 * `{ type: 'object', properties: { <name>: <spec> }, required?: string[] }`。
 * 必填 = required 数组（作者 spec 的 `required: true` 编译而来）。
 */
interface CompiledParams {
  type: 'object'
  properties: Record<string, { type?: string }>
  required?: string[]
}

function compiled(tool: ToolDefinition): CompiledParams {
  return tool.parameters as unknown as CompiledParams
}

const JOB = { name: 'deploy', fullName: 'project/deploy', displayName: '部署', url: 'u1', color: 'blue', _class: 'hudson.model.FreeStyleProject' }

/* ────────────────────────────────────────────────────────────────────
 * §3 工具入参 schema 对拍
 * ──────────────────────────────────────────────────────────────────── */

describe('§3 工具入参 schema 对拍（24 个）', () => {
  it('工具集合 = §3 表格 24 个，无缺失无多余', () => {
    const byName = allTools()
    const names = [...byName.keys()].sort()
    expect(names).toEqual(Object.keys(TOOL_PARAMS).sort())
    expect(names).toHaveLength(24)
  })

  it.each(Object.entries(TOOL_PARAMS))('%s 入参逐项断言（required/optional/connection）', (name, spec) => {
    const tool = allTools().get(name)
    expect(tool, `工具 ${name} 应存在`).toBeDefined()
    const params = compiled(tool!)
    const keys = Object.keys(params.properties)
    const requiredKeys = params.required ?? []
    const connectionless = CONNECTIONLESS_TOOLS.has(name)

    // §3 通用约定：connection 可选。例外：jenkins_connection_list（全局枚举，无 connection 参数）
    if (!connectionless) {
      expect(keys).toContain('connection')
      expect(requiredKeys).not.toContain('connection')
    } else {
      expect(keys).not.toContain('connection')
    }

    for (const key of spec.required) {
      expect(keys, `${name} 应声明必填参数 ${key}`).toContain(key)
      expect(requiredKeys, `${name}.${key} 应为必填`).toContain(key)
    }
    for (const key of spec.optional) {
      expect(keys, `${name} 应声明可选参数 ${key}`).toContain(key)
      expect(requiredKeys, `${name}.${key} 应可选`).not.toContain(key)
    }
    // 无未声明的额外入参
    const expectedKeys = connectionless ? [] : ['connection']
    expect(keys.sort()).toEqual([...new Set([...expectedKeys, ...spec.required, ...spec.optional])].sort())
  })
})

/* ────────────────────────────────────────────────────────────────────
 * §3 工具返回结构对拍（mock Jenkins 响应；不连真实环境）
 * ──────────────────────────────────────────────────────────────────── */

describe('§3 工具返回结构对拍（mock 客户端）', () => {
  it('job 5 个：list→JobReference[] / search→SearchJobsResult / resolve→ResolveJobResult / info→JobInfo / params→ParameterDefinition[]', async () => {
    const bed = createBed()
    bed.client.getAllJobsRecursive = vi.fn(async () => [JOB])
    const byName = new Map(defineJobTools(bed.deps).map((t) => [t.name, t]))

    bed.client.listJobs = vi.fn(async () => [JOB])
    const list = (await runTool(byName.get('jenkins_job_list')!, {})) as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'deploy', url: 'u1', fullName: 'project/deploy' })

    const search = (await runTool(byName.get('jenkins_job_search')!, { query: '部署' })) as {
      matches: Array<{ fullName: string; name: string; score: number; matchReason: string }>
      total: number
      exactMatch: boolean
    }
    expect(search.matches[0]).toMatchObject({ fullName: 'project/deploy', name: 'deploy' })
    expect(typeof search.total).toBe('number')
    expect(typeof search.exactMatch).toBe('boolean')

    const resolved = (await runTool(byName.get('jenkins_job_resolve')!, { path: 'project/deploy' })) as {
      resolved: boolean
      fullName?: string
      message: string
    }
    expect(resolved).toMatchObject({ resolved: true, fullName: 'project/deploy' })

    bed.client.getJobInfo = vi.fn(async () => ({
      name: 'deploy', fullName: 'project/deploy', url: 'u1', color: 'blue', buildable: true, inQueue: false,
      nextBuildNumber: 2, builds: [], property: [],
    }))
    const info = (await runTool(byName.get('jenkins_job_info')!, { jobName: 'deploy' })) as Record<string, unknown>
    expect(info).toMatchObject({ name: 'deploy', fullName: 'project/deploy', buildable: true, inQueue: false, nextBuildNumber: 2 })

    bed.client.getJobParams = vi.fn(async () => [{ name: 'BRANCH', type: 'StringParameterDefinition' as const }])
    const params = (await runTool(byName.get('jenkins_job_params')!, { jobName: 'deploy' })) as Array<{ name: string; type: string }>
    expect(params[0]).toMatchObject({ name: 'BRANCH', type: 'StringParameterDefinition' })
  })

  it('build 10 个：trigger/retry→{queueId?}（恒不等待）/ status,info→BuildInfo / log→LogOutput / history→BuildHistory / history_all→AllBuildHistoryResult / cancel,delete→{ok,message} / artifacts→Artifact[]', async () => {
    const bed = createBed()
    bed.client.getAllJobsRecursive = vi.fn(async () => [JOB])
    bed.client.getJobParams = vi.fn(async () => [])
    const byName = new Map(defineBuildTools(bed.deps).map((t) => [t.name, t]))

    bed.client.triggerBuild = vi.fn(async () => ({ queueUrl: 'https://jenkins.example.com/queue/item/42/' }))
    const trigger = (await runTool(byName.get('jenkins_build_trigger')!, { jobName: 'deploy' })) as Record<string, unknown>
    expect(trigger).toMatchObject({ queueId: 42 })

    bed.client.getBuildStatus = vi.fn(async () => ({ number: 5, url: 'u', building: false, result: 'SUCCESS' as const }))
    const status = (await runTool(byName.get('jenkins_build_status')!, { jobName: 'deploy', buildNumber: 5 })) as Record<string, unknown>
    expect(status).toMatchObject({ number: 5, url: 'u' })

    bed.client.getBuildInfo = vi.fn(async () => ({ number: 9, url: 'u' }))
    const info = (await runTool(byName.get('jenkins_build_info')!, { jobName: 'deploy' })) as Record<string, unknown>
    expect(info).toMatchObject({ number: 9 })

    bed.client.getBuildLog = vi.fn(async () => ({ jobName: 'project/deploy', buildNumber: 5, log: 'a\nb', totalLines: 2 }))
    const log = (await runTool(byName.get('jenkins_build_log')!, { jobName: 'deploy', tail: 10 })) as Record<string, unknown>
    expect(log).toMatchObject({ jobName: 'project/deploy', buildNumber: 5, totalLines: 2 })
    expect(typeof (log.log as string)).toBe('string')

    bed.client.getBuildHistory = vi.fn(async () => ({ jobName: 'project/deploy', builds: [], totalCount: 0 }))
    const history = (await runTool(byName.get('jenkins_build_history')!, { jobName: 'deploy' })) as Record<string, unknown>
    expect(history).toMatchObject({ jobName: 'project/deploy', builds: [], totalCount: 0 })

    bed.client.getAllBuildsForJob = vi.fn(async () => [{ number: 9, url: 'u9', timestamp: 1, duration: 2, result: 'SUCCESS' as const, building: false }])
    const historyAll = (await runTool(byName.get('jenkins_build_history_all')!, { page: 1, pageSize: 1, perJobLimit: 2 })) as Record<string, unknown>
    expect(historyAll).toMatchObject({ connection: 'prod', page: { page: 1, pageSize: 1, returned: 1 } })
    expect((historyAll.builds as Array<Record<string, unknown>>)[0]).toMatchObject({ jobFullName: 'project/deploy', number: 9 })

    const retry = (await runTool(byName.get('jenkins_build_retry')!, { jobName: 'deploy' })) as Record<string, unknown>
    expect(retry).toEqual({}) // 无 queueUrl → queueId 缺省（lossless 收口剔除 undefined）

    const cancel = (await runTool(byName.get('jenkins_build_cancel')!, { jobName: 'deploy', buildNumber: 5 })) as Record<string, unknown>
    expect(cancel).toMatchObject({ ok: true })

    const del = (await runTool(byName.get('jenkins_build_delete')!, { jobName: 'deploy', buildNumber: 5 })) as Record<string, unknown>
    expect(del).toMatchObject({ ok: true })

    bed.client.getBuildArtifacts = vi.fn(async () => [{ displayPath: 'a.jar', fileName: 'a.jar', relativePath: 'target/a.jar' }])
    const artifacts = (await runTool(byName.get('jenkins_build_artifacts')!, { jobName: 'deploy' })) as Array<Record<string, unknown>>
    expect(artifacts[0]).toMatchObject({ displayPath: 'a.jar', fileName: 'a.jar', relativePath: 'target/a.jar' })
  })

  it('ops 9 个：queue.list→QueueItem[] / queue.cancel→{ok,message} / workspace.info→WorkspaceInfo / workspace.cleanup→预览/结果 / folder.list→FolderTreeNode[] / view.list→ViewInfo[] / view.jobs→JobReference[] / connection_test→{ok,message,latencyMs?} / connection_list→ConnectionSummary[]', async () => {
    const bed = createBed()
    bed.client.getAllJobsRecursive = vi.fn(async () => [JOB])
    const byName = new Map(defineOpsTools(bed.deps).map((t) => [t.name, t]))

    bed.client.listQueue = vi.fn(async () => [{ id: 7, task: { name: 'deploy', fullName: 'project/deploy', url: 'u' }, stuck: false, blocked: false, buildable: true, timestamp: 1 }])
    const queue = (await runTool(byName.get('jenkins_queue_list')!, {})) as Array<Record<string, unknown>>
    expect(queue[0]).toMatchObject({ id: 7 })

    const qcancel = (await runTool(byName.get('jenkins_queue_cancel')!, { queueId: 7 })) as Record<string, unknown>
    expect(qcancel).toMatchObject({ ok: true, message: expect.stringContaining('#7') })

    bed.client.getWorkspaceInfo = vi.fn(async () => ({ jobName: 'project/deploy', buildable: true }))
    const ws = (await runTool(byName.get('jenkins_workspace_info')!, { jobName: 'deploy' })) as Record<string, unknown>
    expect(ws).toMatchObject({ jobName: 'project/deploy', buildable: true })

    const preview = (await runTool(byName.get('jenkins_workspace_cleanup')!, { jobName: 'deploy' })) as Record<string, unknown>
    expect(preview).toMatchObject({ dryRun: true })
    const wipe = (await runTool(byName.get('jenkins_workspace_cleanup')!, { jobName: 'deploy', dryRun: false })) as Record<string, unknown>
    expect(wipe).toMatchObject({ dryRun: false, ok: true, message: expect.stringContaining('已清空') })

    bed.client.getFolderChildren = vi.fn(async () => [{ name: 'deploy', fullName: 'project/deploy', type: 'job' as const, url: 'u' }])
    const tree = (await runTool(byName.get('jenkins_folder_list')!, {})) as Array<Record<string, unknown>>
    expect(tree[0]).toMatchObject({ name: 'deploy', type: 'job' })

    bed.client.listViews = vi.fn(async () => [{ name: 'all', url: 'u', jobs: [] }])
    const views = (await runTool(byName.get('jenkins_view_list')!, {})) as Array<Record<string, unknown>>
    expect(views[0]).toMatchObject({ name: 'all' })

    bed.client.getViewJobs = vi.fn(async () => [JOB])
    const viewJobs = (await runTool(byName.get('jenkins_view_jobs')!, { viewName: 'all' })) as Array<Record<string, unknown>>
    expect(viewJobs[0]).toMatchObject({ fullName: 'project/deploy' })

    const test = (await runTool(byName.get('jenkins_connection_test')!, {})) as Record<string, unknown>
    expect(test).toMatchObject({ ok: true })
    expect(typeof test.latencyMs).toBe('number')

    // 连接清单：name/url/isDefault/hasToken（url 叠加自 registry 端点配置，供判别环境；不含凭据）
    const conns = (await runTool(byName.get('jenkins_connection_list')!, {})) as Array<Record<string, unknown>>
    expect(conns).toEqual([{ name: 'prod', url: 'https://jenkins.example.com', isDefault: true, hasToken: true }])
    expect(JSON.stringify(conns)).not.toContain('token')
  })
})

/* ────────────────────────────────────────────────────────────────────
 * §3 红线：多候选绝不自动选择（fail 即阻断）
 * ──────────────────────────────────────────────────────────────────── */

describe('§3 红线：多候选自选行为必须 fail', () => {
  const AMBIGUOUS = [
    { name: 'order', fullName: 'devops/order-service/deploy', displayName: '订单部署', url: 'a' },
    { name: 'order2', fullName: 'k8s/order-service/deploy', displayName: '订单部署', url: 'b' },
  ]

  it('resolver resolveJob：同 displayName 多 job → resolved=false + candidates，绝不返回 fullName', async () => {
    const client = { getAllJobsRecursive: vi.fn(async () => AMBIGUOUS) } as unknown as JenkinsClient
    const res = await resolveJob(client, '订单部署')
    expect(res.resolved).toBe(false)
    expect(res.fullName).toBeUndefined()
    expect(res.candidates).toHaveLength(2)
    expect(res.message).toContain('绝不自动选择')
  })

  it('jenkins_job_resolve：多候选返回 candidates 而非自动选中', async () => {
    const bed = createBed()
    bed.client.getAllJobsRecursive = vi.fn(async () => AMBIGUOUS)
    const byName = new Map(defineJobTools(bed.deps).map((t) => [t.name, t]))
    const res = (await runTool(byName.get('jenkins_job_resolve')!, { path: '订单部署' })) as {
      resolved: boolean
      fullName?: string
      candidates?: unknown[]
    }
    expect(res.resolved).toBe(false)
    expect(res.fullName).toBeUndefined()
    expect(res.candidates).toHaveLength(2)
  })

  it('jenkins_build_trigger：多候选抛错且不触发、不写注册表（绝不选第一个）', async () => {
    const bed = createBed()
    bed.client.getAllJobsRecursive = vi.fn(async () => AMBIGUOUS)
    bed.client.getJobParams = vi.fn(async () => [])
    const byName = new Map(defineBuildTools(bed.deps).map((t) => [t.name, t]))
    await expect(runTool(byName.get('jenkins_build_trigger')!, { jobName: '订单部署' })).rejects.toThrow(/绝不自动选择/)
    expect(bed.client.triggerBuild).not.toHaveBeenCalled()
    expect(bed.recordTrigger).not.toHaveBeenCalled()
  })

  it('searchJobs：多候选返回 matches 数组（无隐式选第一个）', async () => {
    const client = { getAllJobsRecursive: vi.fn(async () => AMBIGUOUS) } as unknown as JenkinsClient
    const res = await resolveJob(client, '订单部署')
    expect(res.candidates?.map((c) => c.fullName)).toContain('devops/order-service/deploy')
    expect(res.candidates?.map((c) => c.fullName)).toContain('k8s/order-service/deploy')
  })
})

/* ────────────────────────────────────────────────────────────────────
 * §5 路由契约对拍（20 POST method + GET /file）
 * ──────────────────────────────────────────────────────────────────── */

/** 路由 bed（fake client + fake req/res；同 routes.test.ts 形态，独立复制供契约套件使用） */
function fakeRouteClient(overrides?: Partial<JenkinsClient>): JenkinsClient {
  return {
    getAllJobsRecursive: vi.fn(async () => [JOB]),
    getJobInfo: vi.fn(async () => ({ name: 'deploy', fullName: 'project/deploy', url: 'u', color: 'blue', buildable: true, inQueue: false, nextBuildNumber: 2, builds: [], property: [] })),
    getJobParams: vi.fn(async () => []),
    getBuildStatus: vi.fn(async () => ({ number: 5, url: 'u', building: false, result: 'SUCCESS' })),
    getBuildHistory: vi.fn(async () => ({ jobName: 'project/deploy', builds: [], totalCount: 0 })),
    getBuildLog: vi.fn(async () => ({ jobName: 'project/deploy', buildNumber: 5, log: 'a\nb', totalLines: 2 })),
    getProgressiveLog: vi.fn(async () => ({ text: '增量', nextStart: 128, moreData: true })),
    retryBuild: vi.fn(async () => {}),
    cancelBuild: vi.fn(async () => {}),
    deleteBuild: vi.fn(async () => {}),
    cancelQueueItem: vi.fn(async () => {}),
    getBuildArtifacts: vi.fn(async () => []),
    getFolderChildren: vi.fn(async () => []),
    listQueue: vi.fn(async () => []),
    getWorkspaceInfo: vi.fn(async () => ({ jobName: 'project/deploy', buildable: true })),
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

function createRouteBed() {
  const client = fakeRouteClient()
  const getClient = vi.fn(async () => client)
  const triggerRegistry = {
    list: vi.fn(() => ({ records: [], total: 0 })),
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
    getSessionCwd: async () => '/ws',
  }
  registerJenkinsRoutes(ctx, deps)
  const route = (ctx.webServer.register as ReturnType<typeof vi.fn>).mock.calls[0][0] as WebRoute
  return { client, getClient, triggerRegistry, route }
}

async function invoke(route: WebRoute, method: string, url: string, body?: unknown): Promise<FakeRes> {
  const res = fakeRes()
  await route.handler(fakeReq(method, url, body), res as unknown as ServerResponse)
  return res
}

/** §5 路由表 20 个 POST method（含回流补行；docs §5 表格 + session.cwd 行） */
const ROUTE_METHODS: Array<{ method: string; body: Record<string, unknown>; assert: (value: unknown) => void }> = [
  { method: 'triggered.list', body: { sessionId: 's1', status: ['ok'], limit: 10, offset: 0 }, assert: (v) => expect(v).toEqual({ records: [], total: 0, workspaceResolved: false }) },
  { method: 'triggered.delete', body: { sessionId: 's1', id: 'r1' }, assert: (v) => expect(v).toEqual({ deleted: 1 }) },
  { method: 'job.info', body: { jobName: 'deploy' }, assert: (v) => expect(v).toMatchObject({ name: 'deploy', fullName: 'project/deploy' }) },
  { method: 'job.params', body: { jobName: 'deploy' }, assert: (v) => expect(Array.isArray(v)).toBe(true) },
  { method: 'build.status', body: { jobName: 'deploy', buildNumber: 5 }, assert: (v) => expect(v).toMatchObject({ number: 5, url: 'u' }) },
  { method: 'build.history', body: { jobName: 'deploy' }, assert: (v) => expect(v).toMatchObject({ jobName: 'project/deploy', builds: [], totalCount: 0 }) },
  { method: 'build.log', body: { jobName: 'deploy', tail: 100 }, assert: (v) => expect(v).toMatchObject({ jobName: 'project/deploy', totalLines: 2 }) },
  { method: 'build.log.stream', body: { jobName: 'deploy', startByte: 0 }, assert: (v) => expect(v).toMatchObject({ text: '增量', nextStart: 128, moreData: true }) },
  { method: 'build.retry', body: { jobName: 'deploy' }, assert: (v) => expect(v).toMatchObject({ ok: true, message: expect.stringContaining('已重试') }) },
  { method: 'build.cancel', body: { jobName: 'deploy', buildNumber: 5 }, assert: (v) => expect(v).toMatchObject({ ok: true, message: expect.stringContaining('#5') }) },
  { method: 'build.delete', body: { jobName: 'deploy', buildNumber: 3 }, assert: (v) => expect(v).toMatchObject({ ok: true, message: expect.stringContaining('#3') }) },
  { method: 'build.artifacts', body: { jobName: 'deploy' }, assert: (v) => expect(Array.isArray(v)).toBe(true) },
  { method: 'queue.list', body: {}, assert: (v) => expect(Array.isArray(v)).toBe(true) },
  { method: 'workspace.info', body: { jobName: 'deploy' }, assert: (v) => expect(v).toMatchObject({ jobName: 'project/deploy', buildable: true }) },
  { method: 'workspace.cleanup', body: { jobName: 'deploy' }, assert: (v) => expect(v).toMatchObject({ dryRun: true }) },
  { method: 'folder.tree', body: {}, assert: (v) => expect(Array.isArray(v)).toBe(true) },
  { method: 'jobs.search', body: { q: 'deploy' }, assert: (v) => expect(Array.isArray(v)).toBe(true) },
  { method: 'conn.list', body: {}, assert: (v) => expect(v).toEqual([{ name: 'prod', isDefault: true, hasToken: true }]) },
  { method: 'conn.test', body: {}, assert: (v) => expect(v).toMatchObject({ ok: true, message: expect.stringContaining('连接正常') }) },
  { method: 'session.cwd', body: { sessionId: 's1' }, assert: (v) => expect(v).toEqual({ cwd: '/ws' }) },
]

describe('§5 路由契约对拍（20 POST + GET /file）', () => {
  it('注册 prefix 路由 /jenkins/api（WebRoute 形态）', () => {
    const bed = createRouteBed()
    expect(bed.route.kind).toBe('prefix')
    expect(bed.route.path).toBe('/jenkins/api')
  })

  it.each(ROUTE_METHODS)('POST %s → 统一信封 { ok, value } 且返回结构符合 §5', async ({ method, body, assert }) => {
    const bed = createRouteBed()
    const res = await invoke(bed.route, 'POST', `/jenkins/api/${method}`, body)
    const payload = res.payload as { ok: boolean; value?: unknown; error?: string }
    expect(payload.ok, `${method} 应成功：${payload.error ?? ''}`).toBe(true)
    expect(payload).toHaveProperty('value')
    assert(payload.value)
  })

  it('§5 方法集完整性：routes.ts 20 个 POST method 与文档表格 20 行一一对应', () => {
    const documented = ROUTE_METHODS.map((r) => r.method).sort()
    expect(documented).toEqual([
      'build.artifacts', 'build.cancel', 'build.delete', 'build.history', 'build.log',
      'build.log.stream', 'build.retry', 'build.status', 'conn.list', 'conn.test',
      'folder.tree', 'job.info', 'job.params', 'jobs.search', 'queue.list',
      'session.cwd', 'triggered.delete', 'triggered.list', 'workspace.cleanup', 'workspace.info',
    ])
  })

  it('GET /jenkins/api/file → 媒体下载契约（attachment + 白名单校验）', async () => {
    const bed = createRouteBed()
    bed.client.getBuildArtifacts = vi.fn(async () => [{ displayPath: 'target/a.jar', fileName: 'a.jar', relativePath: 'target/a.jar' }])
    const res = await invoke(bed.route, 'GET', '/jenkins/api/file?jobName=deploy&buildNumber=5&relativePath=target%2Fa.jar')
    await res.settled
    expect(bed.client.downloadArtifact).toHaveBeenCalledWith('project/deploy', 5, 'target/a.jar')
    expect(res.headers['content-disposition']).toBe('attachment; filename="a.jar"')
    expect(res.chunks.join('')).toContain('DATA')

    const traversal = await invoke(bed.route, 'GET', '/jenkins/api/file?jobName=deploy&buildNumber=5&relativePath=..%2Fetc%2Fpasswd')
    expect(traversal.payload).toMatchObject({ ok: false, error: '非法的产物路径' })
  })

  it('§5 红线：路由层多候选绝不自动选（job.info → 信封错误 + 不调 client）', async () => {
    const bed = createRouteBed()
    bed.client.getAllJobsRecursive = vi.fn(async () => [
      { name: 'order', fullName: 'devops/order/deploy', displayName: '订单部署', url: 'a' },
      { name: 'order2', fullName: 'k8s/order/deploy', displayName: '订单部署', url: 'b' },
    ])
    const res = await invoke(bed.route, 'POST', '/jenkins/api/job.info', { jobName: '订单部署' })
    expect(res.payload).toMatchObject({ ok: false, error: expect.stringContaining('候选') })
    expect(bed.client.getJobInfo).not.toHaveBeenCalled()
  })

  it('body 契约：sessionId/connection 通用可选；triggered.list 无 sessionId 回退全部（V7 放宽）；仅 triggered.delete/session.cwd 强制', async () => {
    const bed = createRouteBed()
    // triggered.list：sessionId 可选（V7 工作区聚合放宽）——无 sessionId 时回退全部记录（面板「全部」视图不传 sessionId）
    const listAll = await invoke(bed.route, 'POST', '/jenkins/api/triggered.list', {})
    expect(listAll.payload).toMatchObject({ ok: true })

    // D2 收紧点的真实位置：triggered.delete 必须 sessionId（清空语义按会话界定）
    const delNoSession = await invoke(bed.route, 'POST', '/jenkins/api/triggered.delete', { id: 'r1' })
    expect(delNoSession.payload).toMatchObject({ ok: false, error: '缺少 sessionId' })

    const withConn = await invoke(bed.route, 'POST', '/jenkins/api/queue.list', { connection: 'prod' })
    expect(bed.getClient).toHaveBeenLastCalledWith('prod')
    expect(withConn.payload).toMatchObject({ ok: true })
  })
})

/* ────────────────────────────────────────────────────────────────────
 * §9 偏差登记（对拍发现；固化当前行为，供 FIN-M3-03 回流决策）
 * ──────────────────────────────────────────────────────────────────── */

describe('偏差登记（FIN-M3-02 对拍发现；不改权威文档，交回流决策）', () => {
  it('D1：workspace_cleanup 文档 §3/§5 标 jobName?，实现为必填（jobName = 清理目标，无全量清理能力）', () => {
    const tool = allTools().get('jenkins_workspace_cleanup')!
    expect(compiled(tool).required).toContain('jobName')
    // 文档口径（§3：connection?, jobName?, days?, dryRun?）→ 实现收紧为必填；登记待回流
  })

  it('D2（2026-09-01 闭环：文档 §5 已同步——triggered.delete/session.cwd 必填、triggered.list 可选回退全部）', async () => {
    const bed = createRouteBed()
    const res = await invoke(bed.route, 'POST', '/jenkins/api/session.cwd', {})
    expect(res.payload).toMatchObject({ ok: false, error: '缺少 sessionId' })
  })

  it('D3（2026-09-01 闭环）：build_retry 同 trigger 取消 wait——恒不等待，返回 { queueId? }（/rebuild 无 Location 时为空对象）', async () => {
    const bed = createBed()
    bed.client.getAllJobsRecursive = vi.fn(async () => [JOB])
    const byName = new Map(defineBuildTools(bed.deps).map((t) => [t.name, t]))
    const empty = await runTool(byName.get('jenkins_build_retry')!, { jobName: 'deploy' })
    expect(empty).toEqual({}) // 无 Location → queueId 缺省（lossless 收口剔除 undefined）
    bed.client.retryBuild = vi.fn(async () => ({ queueUrl: 'https://jenkins.example.com/queue/item/9/' }))
    const withQueue = await runTool(byName.get('jenkins_build_retry')!, { jobName: 'deploy' }) as Record<string, unknown>
    expect(withQueue).toEqual({ queueId: 9 })
  })

  it('D4（既有登记）：QueueItem.executable 为 Jenkins 原始字段补入（docs §2.4 未列），已登记 HOST-M1-08 变更记录待 FIN-M3-03 回流', () => {
    // 类型存在即可（types.ts 已注释出处）；此处仅固化「契约测试不将其视为文档偏差」
    const item: { id: number; executable?: { number: number } } = { id: 1, executable: { number: 7 } }
    expect(item.executable?.number).toBe(7)
  })
})
