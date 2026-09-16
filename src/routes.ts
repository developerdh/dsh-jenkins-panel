/**
 * host 路由 /jenkins/api/*（HOST-M1-09；docs/architecture.md §2.4、interface-and-data-model.md §5）
 *
 * 注册一个 prefix 路由 `/jenkins/api`（ctx.webServer.register，host web server 服务键实测为
 * `webServer`——architecture §2.1 记 'http' 不存在，见 HOST-M1-01 勘误①，接线与回流说明见变更记录）：
 * - `POST /jenkins/api/<method>`：面板取数（20 个 method），body `{ sessionId?, connection?, ...params }`；
 * - `GET /jenkins/api/file`：产物下载媒体路由（Content-Disposition: attachment，防路径穿越白名单校验）。
 *
 * 统一封装 `{ ok, value, error }`（HTTP 恒 200，面板只读信封；error = §7 用户友好文案）。
 * 与工具同源同能力：复用 client/connection/registry 与 tools/shared 的 resolveJobPath 等逻辑；
 * `connection` 可被任务视图切换器覆盖（body/query 传入），triggered.* 不按连接（跨连接混合）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

import { JenkinsApiError, JenkinsClient } from './jenkins/client.js'
import type { ConnectionRegistry, ConnectionSummary, JenkinsConnectionMeta } from './jenkins/connection.js'
import type { SavedSettings } from './jenkins/settings.js'
import type { TriggerRegistry, TriggerStatus } from './jenkins/registry.js'
import { UNKNOWN_WORKSPACE_ID } from './jenkins/registry.js'
import type { BuildResult } from './jenkins/types.js'
import { resolveJobPath } from './tools/shared.js'

/** 路由层依赖（接线方在 apply() 组装，同工具层形态） */
export interface JenkinsRoutesDeps {
  /** 连接注册表（默认连接名等） */
  registry: ConnectionRegistry
  /** 连接客户端工厂：clientFor(registry, ctx.credentials, name) 绑定 */
  getClient: (connection?: string) => Promise<JenkinsClient>
  /** 触发记录注册表（triggered.*） */
  triggerRegistry: TriggerRegistry
  /** conn.list 数据源：listConnections(registry, ctx.credentials) 绑定（不含 URL/凭据） */
  listConnections: () => Promise<ConnectionSummary[]>
  /** session.cwd：会话工作目录解析（接线方提供；缺省返回未接线错误） */
  getSessionCwd?: (sessionId: string) => Promise<string | undefined>
  /**
   * 会话 → 工作区 id（最佳努力；triggered.list 的 workspace='current' 用）。
   * 未接线/解析不到 → undefined（路由不按工作区过滤，回退全部）。
   */
  resolveWorkspaceId?: (sessionId: string) => Promise<string | undefined>
  /** 工作区 id → 当前显示名（实时名，改名联动）；未知 id / 缺省 → fallback */
  workspaceNameOf?: (workspaceId: string | undefined, fallback?: string) => string | undefined
  /** 连接设置读写（CLIENT-M2-07 自建链路：JSON 文件持久化 + registry.reload；缺省返回未接线错误） */
  settings?: {
    get: () => Promise<SavedSettings>
    update: (settings: SavedSettings) => Promise<void>
  }
}

/** POST body：{ sessionId?, connection?, ...params } */
type RouteBody = Record<string, unknown> & { sessionId?: string; connection?: string }

/** 错误 → 用户友好文本（client 错误已是 §7 文案） */
function toErrorMessage(err: unknown): string {
  if (err instanceof JenkinsApiError || err instanceof Error) return err.message
  return String(err)
}

function writeJson(res: ServerResponse, payload: unknown): void {
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

/** 读取 JSON body（空 body 视为 {}；非法 JSON 抛错进信封） */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw) as unknown)
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function requireSessionId(body: RouteBody): string {
  if (typeof body.sessionId !== 'string' || !body.sessionId) {
    throw new Error('缺少 sessionId')
  }
  return body.sessionId
}

function requireString(body: RouteBody, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`缺少参数 ${key}`)
  }
  return value.trim()
}

function asInt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** 方法分发（20 个 method；triggered.* 走注册表，其余走 client，connection 可覆盖） */
function dispatch(method: string, body: RouteBody, deps: JenkinsRoutesDeps): Promise<unknown> {
  switch (method) {
    case 'triggered.list': {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
      const connection = typeof body.connection === 'string' ? body.connection : undefined
      // workspace：默认 'current'（只显示当前会话所在工作区）；'all' = 展示全部（跨工作区）
      const wantsCurrent = body.workspace !== 'all'
      const resolveWs =
        wantsCurrent && sessionId && deps.resolveWorkspaceId
          ? deps.resolveWorkspaceId(sessionId)
          : Promise.resolve(undefined)
      return resolveWs.then((workspaceId) => {
        const status = Array.isArray(body.status) ? (body.status as TriggerStatus[]) : undefined
        const result = deps.triggerRegistry.list({
          workspaceId,
          connection,
          status,
          limit: asInt(body.limit),
          offset: asInt(body.offset),
        })
        // 每条记录带「工作区显示名」：实时名优先（改名联动）→ 触发时快照兜底 → 未知工作区
        const records = result.records.map((r) => ({
          ...r,
          workspaceName:
            deps.workspaceNameOf?.(r.workspaceId, r.workspaceName) ??
            r.workspaceName ??
            (r.workspaceId && r.workspaceId !== UNKNOWN_WORKSPACE_ID ? '未知工作区' : undefined),
        }))
        // P0-b（用户报障：重启后「当前工作区」过滤看似失效）：解析不到时**仍**不过滤（保住记录可见性），
        // 但必须如实标注。旧实现把这种情形也当成功返回，面板 chip 显示「当前工作区」却列出全部工作区的
        // 记录 —— 等于 UI 说谎；现在面板据此显式提示（下一次轮询会自动纠正）。
        const workspaceResolved = !wantsCurrent || workspaceId !== undefined
        return { records, total: result.total, counts: result.counts, workspaceResolved }
      })
    }
    case 'triggered.delete': {
      const sessionId = requireSessionId(body)
      const id = typeof body.id === 'string' ? body.id : undefined
      return deps.triggerRegistry.delete(sessionId, id).then((deleted) => ({ deleted }))
    }
    case 'conn.list':
      return deps.listConnections()
    case 'conn.test':
      return connTest(body, deps)
    case 'session.cwd':
      return sessionCwd(body, deps)
    case 'job.info':
      return withResolvedClient(body, deps, (client, fullName) => client.getJobInfo(fullName))
    case 'job.params':
      return withResolvedClient(body, deps, (client, fullName) => client.getJobParams(fullName))
    case 'build.status':
      return withResolvedClient(body, deps, (client, fullName) => client.getBuildStatus(fullName, asInt(body.buildNumber)))
    case 'build.history':
      return withResolvedClient(body, deps, (client, fullName) =>
        client.getBuildHistory(fullName, {
          limit: asInt(body.limit),
          status: typeof body.status === 'string' ? (body.status as BuildResult) : undefined,
        }),
      )
    case 'build.log':
      return buildLog(body, deps)
    case 'build.log.stream':
      return buildLogStream(body, deps)
    case 'build.retry':
      return buildRetry(body, deps)
    case 'build.cancel':
      return buildCancel(body, deps)
    case 'build.delete':
      return buildDelete(body, deps)
    case 'build.artifacts':
      return withResolvedClient(body, deps, (client, fullName) => client.getBuildArtifacts(fullName, asInt(body.buildNumber)))
    case 'queue.list':
      return deps.getClient(body.connection).then((client) => client.listQueue())
    case 'workspace.info':
      return withResolvedClient(body, deps, (client, fullName) => client.getWorkspaceInfo(fullName))
    case 'workspace.cleanup':
      return workspaceCleanup(body, deps)
    case 'folder.tree':
      return deps.getClient(body.connection).then((client) => client.getFolderChildren(body.folder as string | undefined))
    case 'jobs.search':
      return jobsSearch(body, deps)
    case 'settings.get':
      return getSettings(deps)
    case 'settings.update':
      return updateSettings(body, deps)
    default:
      return Promise.reject(new Error(`未知路由方法：${method}`))
  }
}

/** 解析 jobName 后执行（routes 与工具同源：复用 resolveJobPath 多候选停下询问语义） */
async function withResolvedClient<T>(
  body: RouteBody,
  deps: JenkinsRoutesDeps,
  fn: (client: JenkinsClient, fullName: string) => Promise<T>,
): Promise<T> {
  const client = await deps.getClient(body.connection)
  const { fullName } = await resolveJobPath(client, requireString(body, 'jobName'))
  return fn(client, fullName)
}

/** 未保存连接测试客户端：body 带 url → 内联构造；否则按 connection 名解析 */
async function resolveTestClient(body: RouteBody, deps: JenkinsRoutesDeps): Promise<JenkinsClient> {
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  if (!url) return deps.getClient(body.connection)
  const name = typeof body.name === 'string' && body.name ? body.name : '未命名连接'
  const token = typeof body.token === 'string' ? body.token : ''
  if (!token) throw new Error(`连接 "${name}" 未填写 Token，无法测试`)
  const username = typeof body.username === 'string' && body.username ? body.username : undefined
  const timeout = typeof body.timeout === 'number' && body.timeout > 0 ? body.timeout : 30_000
  return new JenkinsClient({ url, username, token, timeout })
}

async function connTest(body: RouteBody, deps: JenkinsRoutesDeps): Promise<{ ok: boolean; message: string }> {
  try {
    const client = await resolveTestClient(body, deps)
    const result = await client.ping()
    return { ok: true, message: `连接正常（${result.latencyMs}ms）` }
  } catch (err) {
    return { ok: false, message: toErrorMessage(err) }
  }
}

/** settings.get：连接设置读取（defaultConnection + connections；token 不在此） */
async function getSettings(deps: JenkinsRoutesDeps): Promise<SavedSettings> {
  if (!deps.settings) throw new Error('settings.get 未接线（需注入 settings 读写）')
  return deps.settings.get()
}

/** settings.update：连接设置保存（写入 JSON + registry.reload；名称唯一性同源校验） */
async function updateSettings(body: RouteBody, deps: JenkinsRoutesDeps): Promise<{ ok: boolean; message: string }> {
  if (!deps.settings) throw new Error('settings.update 未接线（需注入 settings 读写）')
  const defaultConnection = typeof body.defaultConnection === 'string' ? body.defaultConnection : ''
  const connections = Array.isArray(body.connections) ? (body.connections as JenkinsConnectionMeta[]) : []
  const seen = new Set<string>()
  for (const c of connections) {
    if (!c || typeof c.name !== 'string' || !c.name) throw new Error('连接数据非法：缺少 name')
    const key = c.name.toLowerCase()
    if (seen.has(key)) throw new Error(`连接名大小写不敏感重复：${c.name}`)
    seen.add(key)
  }
  await deps.settings.update({ defaultConnection, connections })
  return { ok: true, message: '设置已保存' }
}

async function sessionCwd(body: RouteBody, deps: JenkinsRoutesDeps): Promise<{ cwd?: string }> {
  const sessionId = requireSessionId(body)
  if (!deps.getSessionCwd) {
    throw new Error('session.cwd 未接线（需注入 getSessionCwd）')
  }
  return { cwd: await deps.getSessionCwd(sessionId) }
}

/** build.log：必带 tail/limit（缺省 tail=500），超限追加分页提示（路由口径；工具层为拒绝） */
async function buildLog(body: RouteBody, deps: JenkinsRoutesDeps): Promise<unknown> {
  const client = await deps.getClient(body.connection)
  const { fullName } = await resolveJobPath(client, requireString(body, 'jobName'))
  const limit = asInt(body.limit)
  const tail = asInt(body.tail)
  const out = await client.getBuildLog(fullName, asInt(body.buildNumber), {
    startLine: asInt(body.start),
    limit,
    tail: limit == null && tail == null ? 500 : tail,
  })
  const shown = out.log.split('\n').length
  if (out.totalLines > shown) {
    out.log += `\n…（日志共 ${out.totalLines} 行，已显示 ${shown} 行；可用 start/limit 分页查看更多）`
  }
  return out
}

/**
 * build.log.stream：progressiveText 增量续传（文档 §5 契约；HOST-M1-09 遗漏补实现，
 * 归 CLIENT-M2-06 自动跟随使用）。返回 { text, nextStart, moreData }：
 * nextStart = X-Text-Size（作下次 start）、moreData = X-More-Data（false = 构建结束）。
 */
async function buildLogStream(body: RouteBody, deps: JenkinsRoutesDeps): Promise<unknown> {
  const client = await deps.getClient(body.connection)
  const { fullName } = await resolveJobPath(client, requireString(body, 'jobName'))
  return client.getProgressiveLog(fullName, asInt(body.buildNumber), asInt(body.startByte) ?? 0)
}

/** build.retry：复用上次构建参数重跑（POST /rebuild，无 wait——面板触发后自行刷新状态） */
async function buildRetry(body: RouteBody, deps: JenkinsRoutesDeps): Promise<{ ok: boolean; message: string }> {
  const client = await deps.getClient(body.connection)
  const { fullName } = await resolveJobPath(client, requireString(body, 'jobName'))
  await client.retryBuild(fullName, asInt(body.buildNumber))
  return { ok: true, message: `已重试 ${fullName}` }
}

/** build.cancel：排队中=取消排队（queueId 或按 jobName 查 queue.list），运行中=stop */
async function buildCancel(body: RouteBody, deps: JenkinsRoutesDeps): Promise<{ ok: boolean; message: string }> {
  const client = await deps.getClient(body.connection)
  const { fullName } = await resolveJobPath(client, requireString(body, 'jobName'))
  const buildNumber = asInt(body.buildNumber)
  if (buildNumber != null && buildNumber > 0) {
    await client.cancelBuild(fullName, buildNumber)
    return { ok: true, message: `已请求停止 ${fullName} #${buildNumber}` }
  }
  const queueId = asInt(body.queueId)
  if (queueId != null) {
    await client.cancelQueueItem(queueId)
    return { ok: true, message: `已取消排队项 #${queueId}` }
  }
  const queue = await client.listQueue()
  const item = queue.find((q) => (q.task?.fullName ?? q.task?.name) === fullName)
  if (!item) throw new Error(`未找到 ${fullName} 的排队中条目（无法取消）`)
  await client.cancelQueueItem(item.id)
  return { ok: true, message: `已取消排队项 #${item.id}` }
}

/** build.delete：删除构建记录（仅终态；面板按状态显隐按钮） */
async function buildDelete(body: RouteBody, deps: JenkinsRoutesDeps): Promise<{ ok: boolean; message: string }> {
  const client = await deps.getClient(body.connection)
  const { fullName } = await resolveJobPath(client, requireString(body, 'jobName'))
  const buildNumber = asInt(body.buildNumber)
  if (buildNumber == null) throw new Error('缺少参数 buildNumber')
  await client.deleteBuild(fullName, buildNumber)
  return { ok: true, message: `已删除构建 ${fullName} #${buildNumber}` }
}

async function workspaceCleanup(body: RouteBody, deps: JenkinsRoutesDeps): Promise<unknown> {
  const client = await deps.getClient(body.connection)
  const { fullName } = await resolveJobPath(client, requireString(body, 'jobName'))
  if (body.dryRun !== false) {
    // dry-run：只读预览（含工作空间信息）；days 参数暂不生效（见变更记录）
    return { dryRun: true, info: await client.getWorkspaceInfo(fullName) }
  }
  await client.wipeWorkspace(fullName)
  return { dryRun: false, ok: true, message: `已清空工作空间 ${fullName}` }
}

async function jobsSearch(body: RouteBody, deps: JenkinsRoutesDeps): Promise<unknown> {
  const client = await deps.getClient(body.connection)
  const q = requireString(body, 'q').toLowerCase()
  const all = await client.getAllJobsRecursive()
  return all.filter(
    (j) =>
      (j.fullName ?? j.name).toLowerCase().includes(q) ||
      (j.displayName ?? j.name).toLowerCase().includes(q),
  )
}

/** GET /jenkins/api/file：产物下载媒体路由（白名单校验防路径穿越） */
async function handleFileDownload(
  url: URL,
  res: ServerResponse,
  deps: JenkinsRoutesDeps,
): Promise<void> {
  const jobName = url.searchParams.get('jobName')
  const buildNumber = Number(url.searchParams.get('buildNumber'))
  const relativePath = url.searchParams.get('relativePath')
  const connection = url.searchParams.get('connection') ?? undefined

  if (!jobName || !Number.isInteger(buildNumber) || !relativePath) {
    writeJson(res, { ok: false, error: 'file 路由参数缺失：jobName/buildNumber/relativePath 必填' })
    return
  }
  // 防路径穿越：拒绝父级引用/绝对路径，且必须命中构建产物白名单
  if (relativePath.includes('..') || relativePath.startsWith('/')) {
    writeJson(res, { ok: false, error: '非法的产物路径' })
    return
  }
  const client = await deps.getClient(connection)
  const { fullName } = await resolveJobPath(client, jobName)
  const artifacts = await client.getBuildArtifacts(fullName, buildNumber)
  const artifact = artifacts.find((a) => a.relativePath === relativePath)
  if (!artifact) {
    writeJson(res, { ok: false, error: `产物路径不在构建 #${buildNumber} 的产物清单中` })
    return
  }
  const { stream, contentType, contentLength } = await client.downloadArtifact(fullName, buildNumber, relativePath)
  const filename = artifact.fileName || relativePath.split('/').pop() || 'artifact'
  res.setHeader('content-disposition', `attachment; filename="${filename}"`)
  if (contentType) res.setHeader('content-type', contentType)
  if (contentLength) res.setHeader('content-length', contentLength)
  stream.pipe(res)
}

/** 统一入口：GET /file 媒体路由 + POST /<method> 信封分发 */
async function handleRequest(req: IncomingMessage, res: ServerResponse, deps: JenkinsRoutesDeps): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname.replace(/\/+$/, '')
    if (req.method === 'GET' && pathname === '/jenkins/api/file') {
      await handleFileDownload(url, res, deps)
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, { ok: false, error: `不支持的方法 ${req.method ?? '?'}（仅 POST）` })
      return
    }
    const method = pathname.slice('/jenkins/api/'.length)
    if (!method || !method.includes('.')) {
      writeJson(res, { ok: false, error: `未知路由方法：${method}` })
      return
    }
    const body = (await readJsonBody(req)) as RouteBody
    const value = await dispatch(method, body, deps)
    writeJson(res, { ok: true, value })
  } catch (err) {
    writeJson(res, { ok: false, error: toErrorMessage(err) })
  }
}

/**
 * 注册 /jenkins/api 前缀路由（WebRoute kind='prefix'，匹配 /jenkins/api/<method> 与 /jenkins/api/file）。
 * 接线方（apply/HOST-M1-05）组装 deps；本函数经 ctx.webServer.register 注册，随 fiber 卸载清理。
 */
export function registerJenkinsRoutes(ctx: Context, deps: JenkinsRoutesDeps): void {
  const route: WebRoute = {
    kind: 'prefix',
    path: '/jenkins/api',
    handler: (req, res) => handleRequest(req, res, deps),
  }
  ctx.webServer.register(route)
}
