/**
 * 跨 Job 构建历史查询服务。
 *
 * Jenkins 没有官方“全部 Job 构建历史”JSON API，因此这里按 Job 读取官方
 * `allBuilds` 区间，再在插件内按时间归并和分页。该服务只负责原始记录取数，
 * 不提供结果/时间/时长等客户端过滤，也不调用页面内部渐进式渲染接口。
 */
import type { JenkinsClient } from './client.js'
import type { AllBuildHistoryResult, BuildInfo, GlobalBuildSummary, JobReference } from './types.js'

export interface AllBuildHistoryQuery {
  /** 页码，从 1 开始 */
  page?: number
  /** 每页记录数 */
  pageSize?: number
  /** 单 Job 最大扫描窗口，防止历史过多的 Job 无界拉取 */
  perJobLimit?: number
}

export interface AllBuildHistoryOptions {
  /** 并发查询 Job 数（内部约束 1..8） */
  concurrency?: number
}

const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 500
const DEFAULT_PER_JOB_LIMIT = 500
const MAX_PER_JOB_LIMIT = 1000
const DEFAULT_CONCURRENCY = 4
const MAX_CONCURRENCY = 8

/** Folder/MultiBranch 等容器不是可产生构建的 Job，不能进入构建扫描列表。 */
function isContainer(node: JobReference): boolean {
  const cls = node._class ?? ''
  return cls.includes('Folder') || cls.includes('MultiBranch')
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须为正整数`)
  return value
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface JobScanSuccess {
  job: JobReference
  jobFullName: string
  builds: BuildInfo[]
}

interface JobScanFailure {
  job: JobReference
  jobFullName: string
  error: string
}

/** 有界并发 map，避免对大量 Job 使用无上限 Promise.all。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

function toGlobalBuild(connection: string, job: JobReference, build: BuildInfo): GlobalBuildSummary {
  const timestamp = typeof build.timestamp === 'number' ? build.timestamp : 0
  const jobName = job.name
  const jobFullName = job.fullName ?? job.name
  return {
    connection,
    jobName,
    jobFullName,
    jobDisplayName: job.displayName ?? job.name,
    number: build.number,
    displayName: build.displayName,
    fullDisplayName: build.fullDisplayName,
    description: build.description,
    result: build.result,
    building: build.building ?? false,
    timestamp,
    timestampIso: new Date(timestamp).toISOString(),
    duration: typeof build.duration === 'number' ? build.duration : 0,
    estimatedDuration: build.estimatedDuration,
    builtOn: build.builtOn,
    url: build.url,
  }
}

function compareBuilds(a: GlobalBuildSummary, b: GlobalBuildSummary): number {
  if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp
  if (a.jobFullName !== b.jobFullName) return a.jobFullName < b.jobFullName ? -1 : 1
  return b.number - a.number
}

/**
 * 获取一个 connection 下全部 Job 的历史构建摘要。
 *
 * 分页正确性：若取全局第 N 条之前的数据，每个 Job 只需扫描其最近 N 条；
 * 单 Job 自身第 N+1 条之后的数据不可能进入全局前 N 名。
 */
export async function getAllBuildHistory(
  client: JenkinsClient,
  connection: string,
  query: AllBuildHistoryQuery = {},
  options: AllBuildHistoryOptions = {},
): Promise<AllBuildHistoryResult> {
  const page = positiveInteger(query.page, DEFAULT_PAGE, 'page')
  const pageSize = positiveInteger(query.pageSize, DEFAULT_PAGE_SIZE, 'pageSize')
  const perJobLimit = positiveInteger(query.perJobLimit, DEFAULT_PER_JOB_LIMIT, 'perJobLimit')
  if (pageSize > MAX_PAGE_SIZE) throw new Error(`pageSize 不能超过 ${MAX_PAGE_SIZE}`)
  if (perJobLimit > MAX_PER_JOB_LIMIT) throw new Error(`perJobLimit 不能超过 ${MAX_PER_JOB_LIMIT}`)

  const offset = (page - 1) * pageSize
  if (offset + pageSize > perJobLimit) {
    throw new Error(`分页窗口超过 perJobLimit：page=${page}, pageSize=${pageSize}, perJobLimit=${perJobLimit}`)
  }
  const windowPerJob = offset + pageSize
  const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY)))

  const allNodes = await client.getAllJobsRecursive()
  const jobs = allNodes.filter((node) => !isContainer(node))
  const scanResults = await mapWithConcurrency<JobReference, JobScanSuccess | JobScanFailure>(jobs, concurrency, async (job) => {
    const jobFullName = job.fullName ?? job.name
    try {
      return { job, jobFullName, builds: await client.getAllBuildsForJob(jobFullName, windowPerJob) }
    } catch (err) {
      return { job, jobFullName, error: errorMessage(err) }
    }
  })

  const builds: GlobalBuildSummary[] = []
  const errors: Array<{ jobFullName: string; message: string }> = []
  let truncated = false
  for (const result of scanResults) {
    if ('error' in result) {
      errors.push({ jobFullName: result.jobFullName, message: result.error })
      continue
    }
    if (result.builds.length >= windowPerJob) truncated = true
    for (const build of result.builds) builds.push(toGlobalBuild(connection, result.job, build))
  }
  builds.sort(compareBuilds)

  const pageBuilds = builds.slice(offset, offset + pageSize)
  const scannedJobs = scanResults.length - errors.length
  return {
    connection,
    builds: pageBuilds,
    page: {
      page,
      pageSize,
      returned: pageBuilds.length,
      hasMore: truncated || offset + pageSize < builds.length,
    },
    scan: {
      totalJobs: jobs.length,
      scannedJobs,
      failedJobs: errors.length,
      buildCount: builds.length,
      perJobLimit,
      windowPerJob,
      truncated,
    },
    errors,
  }
}
