/**
 * Jenkins 数据模型（移植自 docs/interface-and-data-model.md §2.2–§2.4）
 *
 * 唯一依据：docs/interface-and-data-model.md（`jenkins-mcp` 参考仓库不在本项目内）。
 * §2.1 连接类型（ConnectionsConfigItem）归 HOST-M1-03（connection.ts）——客户端不接收
 * 配置/凭据来源，只接收已解析的 { url, username, token, timeout }。
 * 类型形状与文档逐条对齐；注释标注文档出处。
 */

/* ── §2.2 Job / 构建 ─────────────────────────────────────────────── */

/** 构建结果（Jenkins result 枚举；`IN_PROGRESS` 为本插件对 building 的归一化表示） */
export type BuildResult =
  | 'SUCCESS'
  | 'FAILURE'
  | 'UNSTABLE'
  | 'ABORTED'
  | 'NOT_BUILT'
  | 'IN_PROGRESS'

/** Job 状态色（Jenkins color）；带 `_anime` 后缀 = 构建中（如 'blue_anime'） */
export type JobColor =
  | 'blue'
  | 'red'
  | 'yellow'
  | 'grey'
  | 'disabled'
  | 'notbuilt'
  | 'aborted'
  | string

/** Job 轻量引用（列表/树节点/视图成员；folder 的 _class 含 'Folder'） */
export interface JobReference {
  name: string
  url: string
  color?: string
  _class?: string
  fullName?: string
  displayName?: string
  description?: string
}

/** Job 详情（GET /job/<fullName>/api/json?depth=1 归一化） */
export interface JobInfo {
  name: string
  fullName: string
  url: string
  description?: string
  color: JobColor
  buildable: boolean
  inQueue: boolean
  lastBuild?: BuildInfo
  lastCompletedBuild?: BuildInfo
  lastFailedBuild?: BuildInfo
  lastSuccessfulBuild?: BuildInfo
  nextBuildNumber: number
  builds: BuildReference[]
  property: JobProperty[]
}

/**
 * Job 属性（原始 property 数组元素）。
 * 注：docs §2.2 仅出现 `JobProperty[]` 而未定义其形状，此处以最小结构落地
 * （保留 _class 与其余原始字段），不臆造契约。
 */
export interface JobProperty {
  _class?: string
  [key: string]: unknown
}

/** 构建信息（number/url 必有；其余字段由 Jenkins 返回与否决定） */
export interface BuildInfo {
  number: number
  url: string
  building?: boolean
  displayName?: string
  fullDisplayName?: string
  description?: string
  duration?: number
  estimatedDuration?: number
  timestamp?: number
  result?: BuildResult
  builtOn?: string
}

/** 构建引用（JobInfo.builds 元素） */
export interface BuildReference {
  number: number
  url: string
}

/** 构建摘要（构建历史条目） */
export interface BuildSummary {
  number: number
  url: string
  timestamp: number
  duration: number
  result: BuildResult
  building: boolean
}

/** 构建历史（jobName + 摘要列表；totalCount = 状态过滤后总数，limit 切片前） */
export interface BuildHistory {
  jobName: string
  builds: BuildSummary[]
  totalCount: number
}

/** 跨 Job 构建历史摘要（jenkins_build_history_all 返回条目） */
export interface GlobalBuildSummary {
  connection: string
  jobName: string
  jobFullName: string
  jobDisplayName?: string
  number: number
  displayName?: string
  fullDisplayName?: string
  description?: string
  result?: BuildResult
  building: boolean
  timestamp: number
  timestampIso: string
  duration: number
  estimatedDuration?: number
  builtOn?: string
  url: string
}

/** 跨 Job 构建历史分页/扫描元信息 */
export interface AllBuildHistoryResult {
  connection: string
  builds: GlobalBuildSummary[]
  page: {
    page: number
    pageSize: number
    returned: number
    hasMore: boolean
  }
  scan: {
    totalJobs: number
    scannedJobs: number
    failedJobs: number
    buildCount: number
    perJobLimit: number
    windowPerJob: number
    truncated: boolean
  }
  errors: Array<{ jobFullName: string; message: string }>
}

/** 构建日志输出（tail/limit 控制；totalLines = 完整日志行数） */
export interface LogOutput {
  jobName: string
  buildNumber: number
  log: string
  totalLines: number
}

/** 构建产物 */
export interface Artifact {
  displayPath: string
  fileName: string
  relativePath: string
}

/* ── §2.3 参数 ───────────────────────────────────────────────────── */

/** Jenkins 参数定义类型（ParameterDefinition 的 _class 判别值） */
export type ParameterType =
  | 'StringParameterDefinition'
  | 'ChoiceParameterDefinition'
  | 'BooleanParameterDefinition'
  | 'PasswordParameterDefinition'
  | 'TextParameterDefinition'
  | 'RunParameterDefinition'
  | 'FileParameterDefinition'
  | 'ExtendedChoiceParameterDefinition'
  | 'ListedGitLabBranchesParameterDefinition'
  | 'GitLabMRRevisionParameterDefinition'

/** 参数定义（job_params 返回元素） */
export interface ParameterDefinition {
  name: string
  description?: string
  type: ParameterType
  /** Jenkins 原始判别值（如 hudson.model.StringParameterDefinition）；type 缺省时由它派生 */
  _class?: string
  defaultParameterValue?: { value?: unknown }
  choices?: string[]
  max?: number
  min?: number
}

/* ── §2.4 队列 / 工作空间 / 结构 ─────────────────────────────────── */

/** 队列项（/queue/api/json 元素） */
export interface QueueItem {
  id: number
  task: JobReference
  why?: string
  stuck: boolean
  blocked: boolean
  buildable: boolean
  timestamp: number
  params?: string
  /**
   * 排队项对应构建（构建已派发时存在；queue→buildNumber 解析所需，HOST-M1-08 轮询用）。
   * 注：docs §2.4 未列此字段（Jenkins queue item 原始字段），待 FIN-M3-03 回流
   * interface-and-data-model.md §2.4。
   */
  executable?: { number: number; url?: string }
}

/** 工作空间信息（workspacePath = 工作空间 URL；lastBuild* 来自 job.lastBuild） */
export interface WorkspaceInfo {
  jobName: string
  workspacePath?: string
  lastBuildTime?: string
  lastBuildNumber?: number
  lastBuildResult?: string
  buildable: boolean
}

/** 文件夹树节点（folder.tree：type='folder'|'job'，children 懒加载） */
export interface FolderTreeNode {
  name: string
  fullName: string
  type: 'folder' | 'job'
  url: string
  displayName?: string
  description?: string
  color?: string
  children?: FolderTreeNode[]
}

/** 视图信息（view_list 返回） */
export interface ViewInfo {
  name: string
  url: string
  description?: string
  jobs: JobReference[]
}

/** 任务匹配信息（search/resolve 候选；多候选停下询问，绝不自选） */
export interface JobMatchInfo {
  fullName: string
  name: string
  displayName?: string
  description?: string
  matchReason: string
  score: number
  url?: string
  color?: string
}

/** 任务搜索结果 */
export interface SearchJobsResult {
  matches: JobMatchInfo[]
  total: number
  exactMatch: boolean
  elapsedMs?: number
}

/** 任务解析结果（多候选时 resolved=false + candidates） */
export interface ResolveJobResult {
  resolved: boolean
  fullName?: string
  candidates?: JobMatchInfo[]
  message: string
}
