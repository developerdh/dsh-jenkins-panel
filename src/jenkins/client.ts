/**
 * Jenkins REST 客户端（移植自 docs/interface-and-data-model.md §4 映射表）
 *
 * 关键改造（architecture §2.2）：去掉「配置文件/env 变量」来源——本客户端只接收已解析的
 * `{ url, username, token, timeout }`（由 HOST-M1-03 connection.ts 构造），
 * 不感知 dsh 配置与凭据服务。
 *
 * 覆盖 §4 映射表全部行：job_list/job_info/job_params/folder.tree/jobs.search、
 * build_trigger/status/info/log/history/retry/cancel/delete/artifacts、
 * queue_list/cancel、workspace_info/cleanup、view_list/jobs。
 * 错误统一经 `mapError` 映射为 JenkinsApiError（message 逐条对齐 §7 错误模型）。
 *
 * 实现期记录（详见 HOST-M1-02 变更记录）：
 * - 默认 buildNumber 用 Jenkins `lastBuild` 别名（/job/<n>/lastBuild/...），免二次请求；
 * - workspace 探测用 GET（只读语义；§4 记 POST /ws 无实际语义，cleanup 仍为 POST doWipeOutWorkspace）；
 * - build_history 用 tree 范围 `builds[...]{0,cap}` + 客户端状态过滤（§4 `{start=0}` 语焉不详）；
 * - Jenkins CSRF crumb 未处理（已知缺口：开启 CSRF 时 POST 可能 403，留待 HOST-M1-09/FIN-M3-02）。
 */
import axios, { type AxiosAdapter, type AxiosInstance, type AxiosRequestConfig } from 'axios'
import type { Readable } from 'node:stream'

import type {
  Artifact,
  BuildHistory,
  BuildInfo,
  BuildResult,
  BuildSummary,
  FolderTreeNode,
  JobInfo,
  JobReference,
  LogOutput,
  ParameterDefinition,
  QueueItem,
  ViewInfo,
  WorkspaceInfo,
} from './types.js'

/** 客户端构造参数（由 connection.ts 提供；不含配置/凭据来源） */
export interface JenkinsClientOptions {
  /** Jenkins 端点根，如 https://jenkins.example.com（不含结尾斜杠） */
  url: string
  username?: string
  /** API Token（Basic 认证：username:token） */
  token: string
  /** 请求超时 ms（默认 30_000） */
  timeout?: number
  /** 仅供测试注入的 axios 适配器；运行时使用默认 HTTP 适配器 */
  adapter?: AxiosAdapter
}

/** 日志切片查询（tail 与 limit 至少其一；缺省 tail=500） */
export interface JenkinsLogQuery {
  /** 起始行号（0-based，含） */
  startLine?: number
  /** 从起始行向后取多少行 */
  limit?: number
  /** 取末尾 N 行（与 startLine/limit 互斥，优先 startLine/limit） */
  tail?: number
}

/** 构建历史查询 */
export interface JenkinsHistoryQuery {
  limit?: number
  status?: BuildResult
}

/**
 * 实时日志增量结果（progressiveText 续传协议；Jenkins 官方控制台同款）
 * - nextStart = X-Text-Size（日志总字节数，作为下一次请求的 start 游标）
 * - moreData  = X-More-Data（是否仍有更多输出；false = 构建已结束，停止轮询）
 */
export interface JenkinsProgressiveLog {
  text: string
  nextStart: number
  moreData: boolean
}

/** 错误种类（供工具/路由程序化处理，如 404 → 尝试验证路径） */
export type JenkinsErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'server-error'
  | 'network'
  | 'unknown'

/** 统一错误（message = §7 用户友好文案原文；detail 供调试） */
export class JenkinsApiError extends Error {
  readonly kind: JenkinsErrorKind
  readonly status?: number
  readonly detail?: string

  constructor(kind: JenkinsErrorKind, message: string, status?: number, detail?: string) {
    super(message)
    this.name = 'JenkinsApiError'
    this.kind = kind
    this.status = status
    this.detail = detail
  }
}

/** 默认日志切片：末 500 行（§3：tail/limit 必带其一，默认上限 500 行） */
const DEFAULT_LOG_TAIL = 500
/** jobs.search 递归最大深度（防失控） */
const DEFAULT_MAX_DEPTH = 20
/** build_history tree 范围上限（取全量后再状态过滤/切片） */
const HISTORY_TREE_CAP = 500

/** 判定 Jenkins 节点是否为文件夹（folder/multibranch 均为可下钻容器） */
function isFolderLike(node: JobReference): boolean {
  const cls = node._class ?? ''
  return cls.includes('Folder') || cls.includes('MultiBranch')
}

/**
 * 读取响应头（兼容 axios AxiosHeaders 与普通对象形态）：
 * AxiosHeaders 提供 .get(name)（归一化大小写），普通对象直接索引。
 */
function headerValue(headers: unknown, name: string): string | undefined {
  const h = headers as Record<string, unknown> & { get?: (n: string) => unknown }
  if (h && typeof h.get === 'function') {
    const v = h.get(name)
    if (typeof v === 'string') return v
  }
  const direct = h?.[name]
  return typeof direct === 'string' ? direct : undefined
}

/**
 * 错误映射（message 与 §7 逐条一致；context 仅进 detail，不污染用户文案）：
 * 401 → 认证失败：检查该连接 API Token；提示去设置卡片测试
 * 403 → 权限不足：当前用户无此操作权限
 * 404 → 资源未找到（含 URL）——任务名可能是路径，尝试验证
 * 500+ → Jenkins 服务器内部错误，稍后重试
 * 网络（ETIMEDOUT/ECONNREFUSED/ENOTFOUND/ECONNABORTED 等）→ 无法连接：检查 URL/网络/防火墙
 */
export function mapError(err: unknown, context?: string): JenkinsApiError {
  const detail = context ? `${context}: ${err instanceof Error ? err.message : String(err)}` : err instanceof Error ? err.message : String(err)
  if (axios.isAxiosError(err)) {
    const status = err.response?.status
    if (status === 401) {
      return new JenkinsApiError('unauthorized', '认证失败：检查该连接 API Token；提示去设置卡片测试', status, detail)
    }
    if (status === 403) {
      return new JenkinsApiError('forbidden', '权限不足：当前用户无此操作权限', status, detail)
    }
    if (status === 404) {
      return new JenkinsApiError('not-found', '资源未找到（含 URL）——任务名可能是路径，尝试验证', status, detail)
    }
    if (status && status >= 500) {
      return new JenkinsApiError('server-error', 'Jenkins 服务器内部错误，稍后重试', status, detail)
    }
    // 无响应 = 网络层错误（超时/连接拒绝/DNS）
    return new JenkinsApiError('network', '无法连接：检查 URL/网络/防火墙', undefined, detail)
  }
  if (err instanceof JenkinsApiError) return err
  return new JenkinsApiError('unknown', `Jenkins 请求失败：${String(err)}`, undefined, detail)
}

export class JenkinsClient {
  private readonly http: AxiosInstance
  private readonly url: string

  constructor(options: JenkinsClientOptions) {
    const baseUrl = options.url.replace(/\/+$/, '')
    if (!/^https?:\/\//.test(baseUrl)) {
      throw new Error(`[dsh-jenkins-panel] 非法 Jenkins 端点 URL：${options.url}`)
    }
    this.url = baseUrl
    const username = options.username ?? ''
    const auth = `Basic ${Buffer.from(`${username}:${options.token}`).toString('base64')}`
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: options.timeout ?? 30_000,
      headers: { Authorization: auth },
      adapter: options.adapter,
    })
  }

  /* ── 内部工具 ─────────────────────────────────────────────────── */

  /** job fullName → /job/<seg>/job/<seg>/...（每段 URL 编码，fullName 以 / 分隔） */
  private jobPath(fullName: string): string {
    const segments = fullName.split('/').filter(Boolean)
    if (segments.length === 0) throw new JenkinsApiError('unknown', `非法 job 名称：${fullName}`)
    return segments.map((s) => `/job/${encodeURIComponent(s)}`).join('')
  }

  /** 构建子路径：缺省 buildNumber 用 lastBuild 别名 */
  private buildPath(fullName: string, buildNumber?: number): string {
    return `${this.jobPath(fullName)}/${buildNumber ?? 'lastBuild'}`
  }

  /** 统一请求封装：GET，出错走 mapError */
  private async get<T>(path: string, config?: AxiosRequestConfig, context?: string): Promise<T> {
    try {
      const res = await this.http.get<T>(path, config)
      return res.data
    } catch (err) {
      throw mapError(err, context ?? path)
    }
  }

  /** 统一请求封装：POST（config 可含 data/params），出错走 mapError */
  private async post(path: string, config?: AxiosRequestConfig, context?: string): Promise<void> {
    try {
      await this.http.post(path, config?.data, config)
    } catch (err) {
      throw mapError(err, context ?? path)
    }
  }

  /** 扁平化取「jobs」字段（root/folder/view 的 /api/json 通用） */
  private async fetchJobs(path: string, tree: string, context: string): Promise<JobReference[]> {
    const raw = await this.get<{ jobs?: JobReference[] }>(path, { params: { tree } }, context)
    return raw.jobs ?? []
  }

  /* ── Job 系列（§4 job_list / job_info / job_params / folder.tree / jobs.search） ── */

  /** job_list：根级任务列表 */
  listJobs(): Promise<JobReference[]> {
    return this.fetchJobs('/api/json', 'jobs[name,url,color,_class,fullName,displayName,description]', 'listJobs')
  }

  /** job_info：任务详情（depth=1 带回 builds/property 等） */
  getJobInfo(jobName: string): Promise<JobInfo> {
    return this.get<JobInfo>(`${this.jobPath(jobName)}/api/json`, { params: { depth: 1 } }, `jobInfo:${jobName}`)
  }

  /** job_params：参数定义现拉（无持久缓存，§1）。显式取 name/type/_class/description/默认值/choices/max/min——
   * `[...]` 简写对某些 Jenkins 版本只返回 `_class`；契约 `type` 为判别值短名，缺省时从 `_class` 派生。 */
  getJobParams(jobName: string): Promise<ParameterDefinition[]> {
    return this.get<{
      property: Array<{ parameterDefinitions?: Array<ParameterDefinition & { _class?: string }> }>
    }>(
      `${this.jobPath(jobName)}/api/json`,
      {
        params: {
          tree: 'property[parameterDefinitions[name,type,_class,description,defaultParameterValue[value],choices,max,min]]',
        },
      },
      `jobParams:${jobName}`,
    ).then((job) => {
      const found = job.property.find((p) => Array.isArray(p.parameterDefinitions))
      const defs = found?.parameterDefinitions ?? []
      return defs.map((d): ParameterDefinition => ({
        ...d,
        type: ((d._class ?? '').split('.').pop() || d.type) as ParameterDefinition['type'],
      }))
    })
  }

  /** folder.tree：取指定文件夹（缺省根）的直接子节点，转 FolderTreeNode（children 懒加载） */
  async getFolderChildren(folderPath?: string): Promise<FolderTreeNode[]> {
    const raw = await this.get<{ jobs?: JobReference[] }>(
      folderPath ? `${this.jobPath(folderPath)}/api/json` : '/api/json',
      { params: { tree: 'jobs[name,fullName,url,color,_class,displayName]' } },
      folderPath ? `folderTree:${folderPath}` : 'folderTree:root',
    )
    return (raw.jobs ?? []).map((j) => ({
      name: j.name,
      fullName: j.fullName ?? j.name,
      type: isFolderLike(j) ? 'folder' : 'job',
      url: j.url,
      displayName: j.displayName,
      description: j.description,
      color: j.color,
    }))
  }

  /** jobs.search 数据源：递归扁平化全部 job/folder（folder 以 _class 标记，供搜索命中分支展开） */
  async getAllJobsRecursive(maxDepth: number = DEFAULT_MAX_DEPTH): Promise<JobReference[]> {
    const out: JobReference[] = []
    const visit = async (path: string | undefined, depth: number): Promise<void> => {
      if (depth > maxDepth) return
      const children = await this.fetchJobs(
        path ? `${this.jobPath(path)}/api/json` : '/api/json',
        'jobs[name,url,color,_class,fullName,displayName,description]',
        path ? `recursive:${path}` : 'recursive:root',
      )
      for (const node of children) {
        out.push(node)
        if (isFolderLike(node) && node.fullName) {
          await visit(node.fullName, depth + 1)
        }
      }
    }
    await visit(undefined, 0)
    return out
  }

  /* ── Build 系列（§4 build_trigger/status/info/log/history/retry/cancel/delete/artifacts） ── */

  /** build_trigger：触发构建；带参数走 buildWithParameters（form-urlencoded），无参数走 build */
  async triggerBuild(jobName: string, parameters?: Record<string, unknown>): Promise<{ queueUrl?: string }> {
    const entries = parameters ? Object.entries(parameters) : []
    const path = `${this.jobPath(jobName)}/${entries.length > 0 ? 'buildWithParameters' : 'build'}`
    try {
      const config: AxiosRequestConfig = entries.length > 0
        ? {
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            data: new URLSearchParams(entries.map(([k, v]) => [k, v == null ? '' : String(v)] as [string, string])).toString(),
          }
        : {}
      const res = await this.http.post(path, config.data, config)
      const location = typeof res.headers?.location === 'string' ? res.headers.location : undefined
      return { queueUrl: location }
    } catch (err) {
      throw mapError(err, `triggerBuild:${jobName}`)
    }
  }

  /** build_status/info：构建信息（缺省最新构建，lastBuild 别名） */
  getBuildInfo(jobName: string, buildNumber?: number): Promise<BuildInfo> {
    return this.get<BuildInfo>(
      `${this.buildPath(jobName, buildNumber)}/api/json`,
      undefined,
      `buildInfo:${jobName}#${buildNumber ?? 'last'}`,
    )
  }

  /** build_status：与 getBuildInfo 同端点（语义别名，供路由/工具按名调用） */
  getBuildStatus(jobName: string, buildNumber?: number): Promise<BuildInfo> {
    return this.getBuildInfo(jobName, buildNumber)
  }

  /** build_log：consoleText + 分页切片（startLine/limit/tail；缺省 tail=500） */
  async getBuildLog(jobName: string, buildNumber?: number, query: JenkinsLogQuery = {}): Promise<LogOutput> {
    const text = await this.get<string>(
      `${this.buildPath(jobName, buildNumber)}/consoleText`,
      undefined,
      `buildLog:${jobName}#${buildNumber ?? 'last'}`,
    )
    const lines = text.split('\n')
    // 末尾换行产生的空串不计入行数（对齐 Jenkins console 展示）
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    const totalLines = lines.length

    let start = 0
    let end = totalLines
    if (query.startLine != null || query.limit != null) {
      start = Math.max(0, query.startLine ?? 0)
      end = query.limit != null ? Math.min(totalLines, start + Math.max(0, query.limit)) : totalLines
    } else {
      const tail = Math.max(0, query.tail ?? DEFAULT_LOG_TAIL)
      start = Math.max(0, totalLines - tail)
    }
    const slice = lines.slice(start, end).join('\n')
    const resolved = buildNumber ?? (await this.resolveBuildNumber(jobName))
    return { jobName, buildNumber: resolved, log: slice, totalLines }
  }

  /** 解析实际构建号（缺省 lastBuild 时供 LogOutput.buildNumber 使用） */
  private async resolveBuildNumber(jobName: string): Promise<number> {
    try {
      const info = await this.getBuildInfo(jobName)
      return info.number
    } catch {
      return -1
    }
  }

  /**
   * build_log 实时增量（progressiveText，Jenkins 官方控制台同款）：
   * 只返回从 startByte 字节偏移起的新增文本；调用方把 nextStart 作为下次 start 续传，
   * moreData=false 即构建结束。配套路由透传（HOST-M1-09 build.log.stream）与
   * 面板自动跟随（CLIENT-M2-06，1~2s 轮询）。
   */
  async getProgressiveLog(jobName: string, buildNumber?: number, startByte = 0): Promise<JenkinsProgressiveLog> {
    const path = `${this.buildPath(jobName, buildNumber)}/logText/progressiveText`
    try {
      const res = await this.http.get(path, { params: { start: Math.max(0, startByte) } })
      const headers = res.headers
      const totalSize = Number.parseInt(headerValue(headers, 'x-text-size') ?? '0', 10)
      const moreData = headerValue(headers, 'x-more-data')?.toLowerCase() === 'true'
      return {
        text: typeof res.data === 'string' ? res.data : '',
        nextStart: Number.isFinite(totalSize) ? totalSize : 0,
        moreData,
      }
    } catch (err) {
      throw mapError(err, `progressiveLog:${jobName}#${buildNumber ?? 'last'}`)
    }
  }

  /** build_history：builds tree 范围 + 客户端状态过滤（§4；totalCount = 过滤后总数） */
  async getBuildHistory(jobName: string, query: JenkinsHistoryQuery = {}): Promise<BuildHistory> {
    const cap = Math.max(1, query.limit ?? HISTORY_TREE_CAP)
    const raw = await this.get<{ builds?: BuildSummary[] }>(
      `${this.jobPath(jobName)}/api/json`,
      { params: { tree: `builds[number,url,timestamp,duration,result,building]{0,${cap}}` } },
      `buildHistory:${jobName}`,
    )
    const all = raw.builds ?? []
    const status = query.status
    const filtered = status
      ? all.filter((b) => (status === 'IN_PROGRESS' ? b.building : b.result === status))
      : all
    const limit = query.limit
    const builds = limit ? filtered.slice(0, Math.max(0, limit)) : filtered
    return { jobName, builds, totalCount: filtered.length }
  }

  /**
   * build_history_all 的单 Job 数据源：按需读取最近 N 条保留构建。
   * 使用 Jenkins 官方 `allBuilds` tree 投影与数组区间 `{0,N}`，不做任何结果/时间过滤。
   */
  async getAllBuildsForJob(jobName: string, limit: number): Promise<BuildInfo[]> {
    const cap = Math.max(1, Math.floor(limit))
    const raw = await this.get<{ allBuilds?: BuildInfo[] }>(
      `${this.jobPath(jobName)}/api/json`,
      {
        params: {
          tree: `allBuilds[number,url,displayName,fullDisplayName,description,result,building,timestamp,duration,estimatedDuration,builtOn]{0,${cap}}`,
        },
      },
      `allBuildHistory:${jobName}`,
    )
    return raw.allBuilds ?? []
  }

  /** build_retry：复用上次构建参数重跑（POST /rebuild），返回队列 Location（供触发记录解析队列项） */
  async retryBuild(jobName: string, buildNumber?: number): Promise<{ queueUrl?: string }> {
    try {
      const res = await this.http.post(`${this.buildPath(jobName, buildNumber)}/rebuild`)
      const location = typeof res.headers?.location === 'string' ? res.headers.location : undefined
      return { queueUrl: location }
    } catch (err) {
      throw mapError(err, `retryBuild:${jobName}`)
    }
  }

  /** build_cancel：停止构建 */
  async cancelBuild(jobName: string, buildNumber: number): Promise<void> {
    await this.post(`${this.jobPath(jobName)}/${buildNumber}/stop`, undefined, `cancelBuild:${jobName}#${buildNumber}`)
  }

  /** build_delete：删除构建 */
  async deleteBuild(jobName: string, buildNumber: number): Promise<void> {
    await this.post(`${this.jobPath(jobName)}/${buildNumber}/doDelete`, undefined, `deleteBuild:${jobName}#${buildNumber}`)
  }

  /** build_artifacts：构建产物列表 */
  async getBuildArtifacts(jobName: string, buildNumber?: number): Promise<Artifact[]> {
    const raw = await this.get<{ artifacts?: Artifact[] }>(
      `${this.buildPath(jobName, buildNumber)}/api/json`,
      { params: { tree: 'artifacts[displayPath,fileName,relativePath]' } },
      `buildArtifacts:${jobName}#${buildNumber ?? 'last'}`,
    )
    return raw.artifacts ?? []
  }

  /**
   * 产物下载流（/jenkins/api/file 媒体路由用；HOST-M1-09 补充能力）。
   * Jenkins artifact URL：/job/<fullName>/<n>/artifact/<relativePath>（relativePath 逐段编码）。
   * 调用方须先用 getBuildArtifacts 白名单校验 relativePath（防路径穿越，路由层负责）。
   */
  async downloadArtifact(
    jobName: string,
    buildNumber: number,
    relativePath: string,
  ): Promise<{ stream: Readable; contentType?: string; contentLength?: string }> {
    const encoded = relativePath.split('/').filter(Boolean).map(encodeURIComponent).join('/')
    const path = `${this.jobPath(jobName)}/${buildNumber}/artifact/${encoded}`
    try {
      const res = await this.http.get(path, { responseType: 'stream' })
      return {
        stream: res.data as Readable,
        contentType: headerValue(res.headers, 'content-type'),
        contentLength: headerValue(res.headers, 'content-length'),
      }
    } catch (err) {
      throw mapError(err, `artifact:${jobName}#${buildNumber}`)
    }
  }

  /* ── Queue 系列（§4 queue_list / queue_cancel） ── */

  /** queue_list：队列项（供排队中记录解析 queueId→buildNumber；仅活跃队列） */
  async listQueue(): Promise<QueueItem[]> {
    const raw = await this.get<{ items?: QueueItem[] }>('/queue/api/json', undefined, 'queueList')
    return raw.items ?? []
  }

  /**
   * queue_item：按 id 取队列项（含派发后的 `executable.number`）。
   * Jenkins 一旦派发构建，队列项就会离开 `/queue/api/json`（listQueue 查不到），
   * 但 `/queue/item/<id>` 仍可查（带 executable），故这是排队记录解析 buildNumber 的可靠路径。
   * 项已过期/不存在 → undefined（交由注册表兜底裁决）。
   */
  async getQueueItem(queueId: number): Promise<QueueItem | undefined> {
    try {
      return await this.get<QueueItem>(`/queue/item/${queueId}/api/json`, undefined, `queueItem:${queueId}`)
    } catch {
      return undefined
    }
  }

  /** queue_cancel：取消排队项 */
  async cancelQueueItem(queueId: number): Promise<void> {
    await this.post('/queue/cancelItem', { params: { id: String(queueId) } }, `queueCancel:${queueId}`)
  }

  /* ── Workspace 系列（§4 workspace_info / workspace_cleanup） ── */

  /** workspace_info：job 信息（lastBuild/buildable）+ 工作空间探测（GET 只读；404=从未构建） */
  async getWorkspaceInfo(jobName: string): Promise<WorkspaceInfo> {
    const job = await this.getJobInfo(jobName)
    let workspacePath: string | undefined
    try {
      await this.http.get(`${this.jobPath(jobName)}/ws`)
      workspacePath = `${this.url}${this.jobPath(jobName)}/ws`
    } catch {
      workspacePath = undefined // 探测失败视为无工作空间（不抛错：只读语义）
    }
    return {
      jobName,
      workspacePath,
      lastBuildTime: job.lastBuild?.timestamp != null ? new Date(job.lastBuild.timestamp).toISOString() : undefined,
      lastBuildNumber: job.lastBuild?.number,
      lastBuildResult: job.lastBuild?.result,
      buildable: job.buildable,
    }
  }

  /** workspace_cleanup：清空工作空间（dry-run 由工具层只调 info，不发此请求） */
  async wipeWorkspace(jobName: string): Promise<void> {
    await this.post(`${this.jobPath(jobName)}/doWipeOutWorkspace`, undefined, `wipeWorkspace:${jobName}`)
  }

  /* ── View 系列（§4 view_list / view_jobs） ── */  /** view_list：全部视图（含各自 jobs） */
  async listViews(): Promise<ViewInfo[]> {
    const raw = await this.get<{ views?: ViewInfo[] }>(
      '/api/json',
      {
        params: {
          tree: 'views[name,url,description,jobs[name,url,color,_class,fullName,displayName,description]]',
        },
      },
      'viewList',
    )
    return raw.views ?? []
  }

  /** view_jobs：指定视图的 job 列表 */
  getViewJobs(viewName: string): Promise<JobReference[]> {
    return this.fetchJobs(
      `/view/${encodeURIComponent(viewName)}/api/json`,
      'jobs[name,url,color,_class,fullName,displayName,description]',
      `viewJobs:${viewName}`,
    )
  }

  /* ── 连接自检（供 jenkins_connection_test 与 conn.test 复用） ── */

  /** 连接测试：轻量 GET /api/json（tree 取最小负载），返回 ok + 延迟；失败抛 JenkinsApiError 由调用方映射 */
  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const started = Date.now()
    await this.get<unknown>('/api/json', { params: { tree: 'jobs[name]{0,1}' } }, 'ping')
    return { ok: true, latencyMs: Date.now() - started }
  }
}
