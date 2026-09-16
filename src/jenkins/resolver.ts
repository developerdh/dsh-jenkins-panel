/**
 * 任务名称智能解析（HOST-M1-04；docs/architecture.md §2.3、interface-and-data-model.md §2.4/§3）
 *
 * 语义：**严格「多候选停下询问」**——绝不自动选第一个；任何多候选场景返回 `candidates`
 * 由 Agent 二次确认（`resolved=false` + 引导性 message）。
 *
 * 评分器（scoreJob，纯函数）：fullName 严格等值 100 > fullName 大小写不敏感等值 95 >
 * displayName 严格等值 90 > displayName 大小写不敏感等值 85 > 路径前缀 80 >
 * displayName 包含 70 > fullName/路径包含 60；无命中 null。
 *
 * - `searchJobs(client, query, limit?)` → `SearchJobsResult`（`exactMatch` = 存在 ≥85 分
 *   命中，即 fullName/displayName 完全一致（模大小写））；
 * - `resolveJob(client, path, fuzzy?)` → `ResolveJobResult`：fullName 等值 / displayName
 *   等值唯一 → 解析；同 displayName 多 job → **多候选消歧**；唯一模糊（fuzzy 允许）→
 *   解析；多候选 → `resolved=false` + candidates + 候选清单 message；
 *   `fuzzy=false` 只做精确匹配。
 *
 * 数据源复用 `client.getAllJobsRecursive()`（限深防环，HOST-M1-09 已有）。
 */
import type { JenkinsClient } from './client.js'
import type { JobMatchInfo, JobReference, ResolveJobResult, SearchJobsResult } from './types.js'

/** 评分档位（scoreJob 输出；分越高越精确） */
export type MatchScore = 100 | 95 | 90 | 85 | 80 | 70 | 60

export interface ScoreDetail {
  score: MatchScore
  reason: string
}

/** Job → JobMatchInfo（search/resolve 候选） */
export function jobToMatch(job: JobReference, matchReason: string, score: number): JobMatchInfo {
  return {
    fullName: job.fullName ?? job.name,
    name: job.name,
    displayName: job.displayName,
    description: job.description,
    matchReason,
    score,
    url: job.url,
    color: job.color,
  }
}

/**
 * 评分器（纯函数）：fullName 等值 > displayName 等值 > 路径前缀 > 包含；中文走 displayName。
 * 档位：fullName 严格 100 / 大小写不敏感 95 / displayName 严格 90 / 大小写不敏感 85 /
 * 路径前缀 80 / displayName 包含 70 / 路径包含 60。
 * @returns 命中档位与原因；无命中返回 null
 */
export function scoreJob(
  query: string,
  job: { fullName?: string; name: string; displayName?: string },
): ScoreDetail | null {
  const raw = query.trim()
  const q = raw.toLowerCase()
  if (!q) return null
  const fullName = job.fullName ?? job.name
  const displayName = job.displayName ?? job.name
  const fullLower = fullName.toLowerCase()
  const displayLower = displayName.toLowerCase()

  if (fullName === raw) return { score: 100, reason: 'fullName 精确匹配' }
  if (fullLower === q) return { score: 95, reason: 'fullName 匹配（大小写不敏感）' }
  if (displayName === raw) return { score: 90, reason: 'displayName 精确匹配' }
  if (displayLower === q) return { score: 85, reason: 'displayName 匹配（大小写不敏感）' }
  if (fullLower.startsWith(`${q}/`)) return { score: 80, reason: '路径前缀匹配' }
  if (displayLower.includes(q)) return { score: 70, reason: 'displayName 包含' }
  if (fullLower.includes(q)) return { score: 60, reason: '路径包含' }
  return null
}

/** 对全量 job 评分并按档位降序（searchJobs / resolveJob 共用） */
async function scoreAll(client: JenkinsClient, query: string): Promise<JobMatchInfo[]> {
  const all = await client.getAllJobsRecursive()
  const scored: JobMatchInfo[] = []
  for (const job of all) {
    const hit = scoreJob(query, job)
    if (hit) scored.push(jobToMatch(job, hit.reason, hit.score))
  }
  scored.sort((a, b) => b.score - a.score)
  return scored
}

/** searchJobs：智能搜索（多候选返回 matches 数组，绝不自动选择） */
export async function searchJobs(client: JenkinsClient, query: string, limit = 20): Promise<SearchJobsResult> {
  const started = Date.now()
  const scored = await scoreAll(client, query)
  return {
    matches: scored.slice(0, Math.max(0, limit)),
    total: scored.length,
    // exactMatch = 存在完全一致（模大小写）命中：fullName 等值(≥95) 或 displayName 等值(≥85)
    exactMatch: scored.some((m) => m.score >= 85),
    elapsedMs: Date.now() - started,
  }
}

/**
 * resolveJob：任务名解析（精确优先 → 唯一模糊自动解析 → 多候选停下询问）。
 * @param fuzzy 允许模糊匹配（缺省 true）；false 时只做精确（fullName/displayName 等值）
 */
export async function resolveJob(client: JenkinsClient, path: string, fuzzy = true): Promise<ResolveJobResult> {
  const target = path.trim()
  if (!target) {
    return { resolved: false, candidates: [], message: '任务名不能为空' }
  }
  const scored = await scoreAll(client, target)
  if (scored.length === 0) {
    return { resolved: false, candidates: [], message: `未找到任务 "${target}"，请核对名称或完整路径` }
  }

  const topScore = scored[0].score
  const topHits = scored.filter((m) => m.score === topScore)

  // fullName 等值（100/95）→ 唯一（fullName 唯一）
  if (topScore >= 95) {
    const hit = topHits[0]
    return { resolved: true, fullName: hit.fullName, candidates: topHits, message: `已解析：${hit.fullName}` }
  }
  // displayName 等值（90/85）：唯一 → 解析；同 displayName 多 job → 多候选消歧
  if (topScore >= 85) {
    if (topHits.length === 1) {
      const hit = topHits[0]
      return { resolved: true, fullName: hit.fullName, candidates: topHits, message: `已解析：${hit.fullName}` }
    }
    const list = topHits.map((m) => m.fullName).join('、')
    return {
      resolved: false,
      candidates: topHits,
      message: `任务名 "${target}" 有 ${topHits.length} 个同名任务（${list}），请指定完整路径（多候选停下询问，绝不自动选择）`,
    }
  }
  // 模糊（80/70/60）：fuzzy 允许 + 唯一 → 解析；多候选 → 停下询问；fuzzy 关闭 → 未找到
  if (fuzzy) {
    if (topHits.length === 1) {
      const hit = topHits[0]
      return { resolved: true, fullName: hit.fullName, candidates: topHits, message: `已解析（模糊匹配）：${hit.fullName}` }
    }
    const list = topHits.slice(0, 10).map((m) => m.fullName).join('、')
    return {
      resolved: false,
      candidates: topHits.slice(0, 10),
      message: `任务名 "${target}" 有 ${topHits.length} 个匹配（${list}…），请指定完整路径（多候选停下询问，绝不自动选择）`,
    }
  }
  return { resolved: false, candidates: [], message: `未找到任务 "${target}"（fuzzy 已关闭，不做模糊匹配）` }
}
