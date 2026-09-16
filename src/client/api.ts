/**
 * 渲染层调用 host /jenkins/api/* 的封装（CLIENT-M2-04 实现）
 *
 * 契约（docs/interface-and-data-model.md §5 / src/routes.ts）：
 * - `POST /jenkins/api/<method>`，body `{ sessionId?, connection?, ...params }`；
 * - 统一信封 `{ ok, value, error }`（HTTP 恒 200，error = §7 用户友好文案）；
 * - 本文件提供泛型 callApi + 本任务（任务视图）域函数：conn.list / folder.tree / jobs.search。
 *   后续任务（M2-03/05/06）在此追加 triggered.* / job.info / build.* 等域函数。
 */

/** host 路由统一信封（HTTP 恒 200，面板只读信封） */
export interface ApiEnvelope<T> {
  ok: boolean
  value?: T
  error?: string
}

/** 路由调用公共参数 */
export interface ApiCallOptions {
  sessionId?: string
  connection?: string
}

/** 连接切换器数据源条目（conn.list；不含 URL/凭据，architecture §3.3） */
export interface ConnectionInfo {
  name: string
  isDefault: boolean
  hasToken: boolean
}

/** 文件夹树节点（folder.tree 契约，src/jenkins/types.ts 同形；client 侧镜像类型） */
export interface TreeJobNode {
  name: string
  fullName: string
  type: 'folder' | 'job'
  url: string
  displayName?: string
  description?: string
  color?: string
  children?: TreeJobNode[]
}

/** 通用调用：解信封，ok=false 抛用户友好错误 */
export async function callApi<T>(
  method: string,
  params: Record<string, unknown> = {},
  opts: ApiCallOptions = {},
): Promise<T> {
  const res = await fetch(`/jenkins/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: opts.sessionId, connection: opts.connection, ...params }),
  })
  const envelope = (await res.json()) as ApiEnvelope<T>
  if (!envelope.ok) {
    throw new Error(envelope.error ?? `/jenkins/api/${method} 调用失败`)
  }
  return envelope.value as T
}

/** conn.list：连接切换器数据源（默认连接排最前由调用方处理） */
export function listConnections(opts: ApiCallOptions = {}): Promise<ConnectionInfo[]> {
  return callApi<ConnectionInfo[]>('conn.list', {}, opts)
}

/** folder.tree：取某层直接子节点（folder 缺省 = 根层，懒加载单层） */
export function fetchFolderTree(
  connection: string,
  folder: string | undefined,
  opts: ApiCallOptions = {},
): Promise<TreeJobNode[]> {
  return callApi<TreeJobNode[]>('folder.tree', { folder: folder ?? '' }, { ...opts, connection })
}

/** jobs.search：递归扁平搜索（按 displayName/fullName 命中，host 侧已过滤） */
export function searchJobs(connection: string, q: string, opts: ApiCallOptions = {}): Promise<TreeJobNode[]> {
  return callApi<TreeJobNode[]>('jobs.search', { q }, { ...opts, connection })
}

/* ── CLIENT-M2-06 构建详情域（build.* / workspace.*；契约见 docs §5 + src/routes.ts） ── */

/** 构建信息（build.status / build.info；host 返回 Jenkins /api/json 原始 JSON，此处声明渲染所需字段） */
export interface BuildInfo {
  number: number
  url: string
  building?: boolean
  duration?: number
  estimatedDuration?: number
  timestamp?: number
  result?: string
  /**
   * Jenkins 原始 actions（含构建采用参数 ParametersAction.parameters，供「构建参数」展示）。
   * host 透传原始 JSON，故此处仅为渲染层声明；无参构建或缺省 latest 时可能缺省。
   */
  actions?: Array<{
    _class?: string
    parameters?: Array<{ name?: string; value?: unknown }>
  }>
}

/** 构建日志输出（build.log：tail/limit 控制，totalLines = 完整日志行数） */
export interface LogOutput {
  jobName: string
  buildNumber: number
  log: string
  totalLines: number
}

/** 日志增量续传（build.log.stream：nextStart 作下次 start，moreData=false 构建结束） */
export interface ProgressiveLog {
  text: string
  nextStart: number
  moreData: boolean
}

/** 构建产物（build.artifacts） */
export interface Artifact {
  displayPath: string
  fileName: string
  relativePath: string
}

/** 工作空间信息（workspace.info） */
export interface WorkspaceInfo {
  jobName: string
  workspacePath?: string
  lastBuildTime?: string
  lastBuildNumber?: number
  lastBuildResult?: string
  buildable: boolean
}

/** 操作结果（build.retry/cancel/delete / workspace.cleanup 确认） */
export interface OpResult {
  ok: boolean
  message: string
}

/** build.status：构建信息（缺省最新构建） */
export function fetchBuildStatus(
  connection: string,
  jobName: string,
  buildNumber?: number,
  opts: ApiCallOptions = {},
): Promise<BuildInfo> {
  return callApi<BuildInfo>('build.status', { jobName, buildNumber }, { ...opts, connection })
}

/** build.log：tail/limit 必带其一（tail 默认尾部；分段 = start/limit 翻页） */
export function fetchBuildLog(
  connection: string,
  jobName: string,
  query: { buildNumber?: number; tail?: number; start?: number; limit?: number },
  opts: ApiCallOptions = {},
): Promise<LogOutput> {
  return callApi<LogOutput>('build.log', { jobName, ...query }, { ...opts, connection })
}

/** build.log.stream：progressiveText 增量续传（自动跟随用；startByte 缺省 0） */
export function fetchProgressiveLog(
  connection: string,
  jobName: string,
  buildNumber: number | undefined,
  startByte: number,
  opts: ApiCallOptions = {},
): Promise<ProgressiveLog> {
  return callApi<ProgressiveLog>('build.log.stream', { jobName, buildNumber, startByte }, { ...opts, connection })
}

/** build.artifacts：产物列表 */
export function fetchBuildArtifacts(
  connection: string,
  jobName: string,
  buildNumber?: number,
  opts: ApiCallOptions = {},
): Promise<Artifact[]> {
  return callApi<Artifact[]>('build.artifacts', { jobName, buildNumber }, { ...opts, connection })
}

/** workspace.info：工作空间信息 */
export function fetchWorkspaceInfo(
  connection: string,
  jobName: string,
  opts: ApiCallOptions = {},
): Promise<WorkspaceInfo> {
  return callApi<WorkspaceInfo>('workspace.info', { jobName }, { ...opts, connection })
}

/** workspace.cleanup：dryRun=true 预览（不执行），false 二次确认后执行 */
export function cleanupWorkspace(
  connection: string,
  jobName: string,
  dryRun: boolean,
  opts: ApiCallOptions = {},
): Promise<{ dryRun: boolean; info?: WorkspaceInfo; ok?: boolean; message?: string }> {
  return callApi('workspace.cleanup', { jobName, dryRun }, { ...opts, connection })
}

/** build.retry：复用上次参数重跑 */
export function retryBuild(connection: string, jobName: string, buildNumber?: number, opts: ApiCallOptions = {}): Promise<OpResult> {
  return callApi<OpResult>('build.retry', { jobName, buildNumber }, { ...opts, connection })
}

/** build.cancel：排队中=取消排队（queueId 或按 jobName 查 queue.list），运行中=stop */
export function cancelBuild(
  connection: string,
  jobName: string,
  opts: { buildNumber?: number; queueId?: number } = {},
  apiOpts: ApiCallOptions = {},
): Promise<OpResult> {
  return callApi<OpResult>('build.cancel', { jobName, ...opts }, { ...apiOpts, connection })
}

/** build.delete：删除构建记录（仅终态显示按钮） */
export function deleteBuild(connection: string, jobName: string, buildNumber: number, opts: ApiCallOptions = {}): Promise<OpResult> {
  return callApi<OpResult>('build.delete', { jobName, buildNumber }, { ...opts, connection })
}

/** 产物下载 URL（GET /jenkins/api/file 媒体路由；connection 走 query，handleFileDownload 契约） */
export function artifactDownloadUrl(connection: string, jobName: string, buildNumber: number, relativePath: string): string {
  const params = new URLSearchParams({
    jobName,
    buildNumber: String(buildNumber),
    relativePath,
    connection,
  })
  return `/jenkins/api/file?${params.toString()}`
}

/* ── CLIENT-M2-05 任务详情域（job.info / job.params / build.history；契约见 docs §5） ── */

/** 参数定义（§2.3；type 为 _class 判别值短名，如 'StringParameterDefinition'；_class 为原始全名兜底） */
export interface ParameterDefinition {
  name: string
  description?: string
  type: string
  _class?: string
  defaultParameterValue?: { value?: unknown }
  choices?: string[]
  max?: number
  min?: number
}

/** 构建摘要（构建历史条目） */
export interface BuildSummary {
  number: number
  url: string
  timestamp: number
  duration: number
  result: string
  building: boolean
}

/** 构建历史（totalCount = 状态过滤后总数，limit 切片前） */
export interface BuildHistory {
  jobName: string
  builds: BuildSummary[]
  totalCount: number
}

/** 任务信息（job.info；color/lastBuild* 供任务头状态点与信息展示） */
export interface JobInfo {
  name: string
  fullName: string
  url: string
  description?: string
  color?: string
  buildable: boolean
  inQueue: boolean
  lastBuild?: BuildInfo
  lastCompletedBuild?: BuildInfo
  lastFailedBuild?: BuildInfo
  lastSuccessfulBuild?: BuildInfo
  nextBuildNumber: number
  builds: Array<{ number: number; url: string }>
}

/** job.info：任务详情（名称/路径/描述/颜色/最近构建等） */
export function fetchJobInfo(connection: string, jobName: string, opts: ApiCallOptions = {}): Promise<JobInfo> {
  return callApi<JobInfo>('job.info', { jobName }, { ...opts, connection })
}

/** job.params：参数定义（现拉无缓存） */
export function fetchJobParams(connection: string, jobName: string, opts: ApiCallOptions = {}): Promise<ParameterDefinition[]> {
  return callApi<ParameterDefinition[]>('job.params', { jobName }, { ...opts, connection })
}

/** build.history：构建历史（limit 分页；status 可选过滤） */
export function fetchBuildHistory(
  connection: string,
  jobName: string,
  query: { limit?: number; status?: string } = {},
  opts: ApiCallOptions = {},
): Promise<BuildHistory> {
  return callApi<BuildHistory>('build.history', { jobName, ...query }, { ...opts, connection })
}

/* ── CLIENT-M2-03 总览域（triggered.list / triggered.delete；契约见 docs §5 + registry.ts） ── */

/** 触发记录状态（契约：queued→running→ok/fail/aborted） */
export type TriggerStatus = 'queued' | 'running' | 'ok' | 'fail' | 'aborted'

/** 触发记录（只存元数据；triggeredAt/statusUpdatedAt 为 epoch ms） */
export interface TriggerRecord {
  id: string
  connection: string
  jobName: string
  displayName: string
  queueId?: number
  buildNumber?: number
  params: Record<string, unknown>
  status: TriggerStatus
  triggeredAt: number
  statusUpdatedAt: number
  sessionId: string
  /** 所属工作区稳定 id（host 触发时解析；sentinel = 未知工作区） */
  workspaceId?: string
  /** 工作区显示名（host 已按「实时名优先 → 快照兜底 → 未知」解析好） */
  workspaceName?: string
  source: 'conversation'
}

/** 全会话状态分布（不受状态过滤影响；驱动总览 chips 计数） */
export interface TriggerCounts {
  all: number
  queued: number
  running: number
  ok: number
  fail: number
  aborted: number
}

/** triggered.list 返回（分页 + 状态过滤，跨连接混合，按 sessionId 隔离） */
export interface TriggeredListResult {
  records: TriggerRecord[]
  /** 状态过滤后的总数（分页前；「加载更多 x/total」用） */
  total: number
  /** 全会话状态分布（永不过滤；兼容旧后端缺省时前端回退按已加载记录统计） */
  counts?: TriggerCounts
  /**
   * 工作区过滤是否**真的**生效（P0-b）：
   * - `true`：`workspace='all'`（本就没要求过滤），或 `'current'` 且已解析出工作区；
   * - `false`：要求按当前工作区过滤但**未能解析**（会话不归属任何工作区）——此时 host
   *   返回的是**全部工作区**的记录，面板必须显式提示，不得假装过滤成功；
   * - 缺省（旧后端）：按"未标注"处理，不提示。
   */
  workspaceResolved?: boolean
}

/** triggered.list 查询（V7：默认按当前工作区聚合，非强制会话；connection/status 可再收敛） */
export interface TriggeredListQuery {
  /** 触发会话（用于 workspace='current' 解析当前工作区；可选） */
  sessionId?: string
  /** 工作区过滤：'current'（默认，当前会话工作区）| 'all'（全部） */
  workspace?: 'current' | 'all'
  /** 按连接过滤 */
  connection?: string
  /** 按状态过滤（数据区；counts 不受影响） */
  status?: TriggerStatus[]
  limit?: number
  offset?: number
}

/** triggered.list：对话触发的构建记录（默认当前工作区，跨会话聚合；可选连接/状态收敛） */
export function fetchTriggeredList(query: TriggeredListQuery = {}, opts: ApiCallOptions = {}): Promise<TriggeredListResult> {
  return callApi<TriggeredListResult>('triggered.list', query as Record<string, unknown>, opts)
}

/** triggered.delete：删除单条（id 缺省 = 清空该会话全部记录） */
export function deleteTriggered(sessionId: string, id?: string, opts: ApiCallOptions = {}): Promise<{ deleted: number }> {
  return callApi<{ deleted: number }>('triggered.delete', { sessionId, id }, opts)
}

/* ── CLIENT-M2-07 设置卡片域（conn.test + 凭据/设置 API 面，V4 方案 A + V5 路径 1） ── */

/** 连接元数据（settings 路由形状；token 不在此） */
export interface ConnectionMeta {
  name: string
  url: string
  username?: string
  timeout: number
}

/** 连接设置（settings.get/update 形状；token 走凭据服务） */
export interface JenkinsSettings {
  defaultConnection: string
  connections: ConnectionMeta[]
}

/** 未保存连接测试参数（conn.test 内联；不带 connection 名时按 url 直连） */
export interface ConnectionTestInline {
  name: string
  url: string
  username?: string
  token: string
  timeout?: number
}

/** conn.test：连接测试。已保存连接按 connection 名解析；未保存连接传 inline（url/username/token）直连 */
export function testConnection(
  connection?: string,
  inline?: ConnectionTestInline,
  opts: ApiCallOptions = {},
): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
  return callApi<{ ok: boolean; message: string; latencyMs?: number }>('conn.test', (inline as Record<string, unknown> | undefined) ?? {}, { ...opts, connection })
}

/** settings.get：连接设置读取（defaultConnection + connections） */
export function fetchSettings(opts: ApiCallOptions = {}): Promise<JenkinsSettings> {
  return callApi<JenkinsSettings>('settings.get', {}, opts)
}

/** settings.update：连接设置保存（写入 JSON + registry.reload） */
export function updateSettings(settings: JenkinsSettings, opts: ApiCallOptions = {}): Promise<{ ok: boolean; message: string }> {
  return callApi<{ ok: boolean; message: string }>('settings.update', { ...settings }, opts)
}

/** 凭据 ref 名派生（镜像 host connection.ts refOf，V4 方案 A）：`JENKINS_TOKEN_` + 大写化 + `-`→`_` */
export function credentialRefOf(name: string): string {
  return `JENKINS_TOKEN_${name.toUpperCase().replace(/-/g, '_')}`
}

/** CredentialView：dsh credentials.describe 的单 ref 视图（值永不过线） */
export interface CredentialView {
  /** 任一层是否提供非空值 */
  configured: boolean
  /** 胜出层（env / file / …，provider 词表） */
  source?: string
  /** credentials.set/unset 是否可影响该 ref */
  writable: boolean
}

/**
 * 凭据面（0.1.5 改造）：`ctx.remote.credentials.*`（影响报告 §4.1）。
 *
 * 0.1.5 移除了 `ctx.connection.api`（旧 RpcResponse 信封），改为 typert 远程命名空间
 * `ctx.remote.credentials`：参数扁平化，返回 `RemoteResult<T>`（判别式 ok/err）——
 * 类型安全由宿主承担，本插件不再手写信封解析与形状兜底。`CredentialInfo` 形状不变
 * （configured/source/writable）。
 */
export interface CredentialInfo {
  /** 任一层是否提供非空值 */
  configured: boolean
  /** 胜出层（env / file / …，provider 词表） */
  source?: string
  /** credentials.set/unset 是否可影响该 ref */
  writable: boolean
}

/** `RemoteResult<T>` 判别（@deepseek-ai/dsh-typert-protocol；宽松形状避免类型面依赖） */
export interface RemoteResultLike<T> {
  ok: boolean
  value?: T
  error?: { name?: string; code?: string; message?: string }
}

/** 从 `RemoteResult` 取成功值；err → 抛宿主给出的业务错误文案 */
export function unwrapRemote<T>(res: RemoteResultLike<T> | undefined, fallback: string): T {
  if (res?.ok) return res.value as T
  throw new Error(res?.error?.message ?? fallback)
}

/** 从 describe 结果判某 ref 是否已配置（0.1.5：值为 `Record<ref, CredentialInfo>`） */
export function isCredConfigured(res: Record<string, CredentialInfo> | undefined, ref: string): boolean {
  return res?.[ref]?.configured === true
}

/**
 * client 侧凭据/设置远端面（`ctx.remote`，0.1.5；类型面未装——宽松接口断言）。
 * 参数扁平化（0.1.5 契约），返回 `RemoteResult`。
 */
export interface RemoteFace {
  credentials: {
    describe: (refs: string[]) => Promise<RemoteResultLike<Record<string, CredentialInfo>>>
    set: (ref: string, value: string) => Promise<RemoteResultLike<void>>
    unset: (ref: string) => Promise<RemoteResultLike<void>>
  }
}

/** settings namespace 值（dsh-jenkins-panel = Config 形状的连接相关子集；token 不在此） */
export interface SettingsNamespaceValue {
  defaultConnection?: string
  connections?: Array<{ name: string; url: string; username?: string; timeout: number }>
}
