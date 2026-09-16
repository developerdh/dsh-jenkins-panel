/**
 * Job 类工具单测（HOST-M1-06）：jenkins_job_list/search/resolve/info/params。
 * 覆盖：契约字段、connection 透传、名称过滤、搜索/解析多候选语义。
 */
import { describe, expect, it, vi } from 'vitest'

import { defineJobTools } from '../jobs.js'
import { createBed, runTool } from './helpers.js'

const JOB_FIXTURES = [
  { name: 'deploy', fullName: 'project/deploy', displayName: '部署', url: 'u1', color: 'blue', _class: 'hudson.model.FreeStyleProject', type: 'job' as const },
  { name: 'test', fullName: 'project/test', displayName: '测试', url: 'u2', color: 'red', _class: 'hudson.model.FreeStyleProject', type: 'job' as const },
  { name: 'deploy', fullName: 'release/deploy', displayName: '发布部署', url: 'u3', color: 'grey', _class: 'hudson.model.FreeStyleProject', type: 'job' as const },
]

function tools() {
  const bed = createBed()
  const byName = new Map(defineJobTools(bed.deps).map((t) => [t.name, t]))
  return { bed, byName }
}

describe('jenkins_job_list', () => {
  it('lists root jobs and passes connection through', async () => {
    const { bed, byName } = tools()
    bed.client.listJobs = vi.fn(async () => JOB_FIXTURES)
    const value = await runTool(byName.get('jenkins_job_list')!, { connection: 'test' })
    expect(bed.getClient).toHaveBeenCalledWith('test')
    expect(bed.client.listJobs).toHaveBeenCalledOnce()
    expect(value).toHaveLength(3)
  })

  it('recursive / folder / pattern variants', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOB_FIXTURES)
    const recursive = await runTool(byName.get('jenkins_job_list')!, { recursive: true })
    expect(bed.client.getAllJobsRecursive).toHaveBeenCalledOnce()
    expect(recursive).toHaveLength(3)

    bed.client.getFolderChildren = vi.fn(async () => JOB_FIXTURES.slice(0, 2))
    const folder = await runTool(byName.get('jenkins_job_list')!, { folder: 'project' })
    expect(bed.client.getFolderChildren).toHaveBeenCalledWith('project')
    expect(folder).toHaveLength(2)

    bed.client.listJobs = vi.fn(async () => JOB_FIXTURES)
    const filtered = await runTool(byName.get('jenkins_job_list')!, { pattern: 'release' })
    expect(bed.client.listJobs).toHaveBeenCalledOnce()
    expect(filtered).toHaveLength(1)
  })
})

describe('jenkins_job_search', () => {
  it('matches by displayName/fullName and reports exactMatch', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOB_FIXTURES)

    const value = await runTool(byName.get('jenkins_job_search')!, { query: '部署' }) as {
      matches: Array<{ fullName: string; score: number; matchReason: string }>
      total: number
      exactMatch: boolean
    }
    expect(value.matches[0].fullName).toBe('project/deploy') // displayName 精确 → 最高分
    expect(value.matches[0].score).toBe(90) // resolver 评分档位：displayName 严格等值（HOST-M1-04）
    expect(value.matches[0].matchReason).toBe('displayName 精确匹配')
    expect(value.total).toBe(2) // 发布部署 也命中（名称包含）
    expect(value.exactMatch).toBe(true)

    const fuzzy = await runTool(byName.get('jenkins_job_search')!, { query: 'deploy', limit: 1 }) as {
      matches: unknown[]
      total: number
      exactMatch: boolean
    }
    expect(fuzzy.total).toBe(2) // project/deploy + release/deploy
    expect(fuzzy.matches).toHaveLength(1) // limit 生效
    expect(fuzzy.exactMatch).toBe(false) // 无 fullName 精确匹配
  })
})

describe('jenkins_job_resolve', () => {
  it('resolves exact fullName', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOB_FIXTURES)
    const value = await runTool(byName.get('jenkins_job_resolve')!, { path: 'project/test' }) as { resolved: boolean; fullName?: string }
    expect(value.resolved).toBe(true)
    expect(value.fullName).toBe('project/test')
  })

  it('returns candidates on multiple matches (never auto-picks)', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOB_FIXTURES)
    const value = await runTool(byName.get('jenkins_job_resolve')!, { path: 'deploy' }) as { resolved: boolean; candidates?: unknown[]; message: string }
    expect(value.resolved).toBe(false)
    expect(value.candidates).toHaveLength(2)
    expect(value.message).toContain('候选')

    const noFuzzy = await runTool(byName.get('jenkins_job_resolve')!, { path: 'deploy', fuzzy: false }) as { resolved: boolean; message: string }
    expect(noFuzzy.resolved).toBe(false)
    expect(noFuzzy.message).toContain('fuzzy 已关闭')
  })
})

describe('jenkins_job_info / job_params', () => {
  it('resolves fuzzy jobName then fetches info', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOB_FIXTURES)
    bed.client.getJobInfo = vi.fn(async () => ({
      name: 'deploy', fullName: 'project/deploy', url: 'u1', color: 'blue', buildable: true, inQueue: false,
      nextBuildNumber: 5, builds: [], property: [],
    }))
    const value = await runTool(byName.get('jenkins_job_info')!, { jobName: 'project/deploy' }) as { fullName: string }
    expect(bed.client.getJobInfo).toHaveBeenCalledWith('project/deploy')
    expect(value.fullName).toBe('project/deploy')
  })

  it('job_params returns latest definitions without cache', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOB_FIXTURES)
    bed.client.getJobParams = vi.fn(async () => [{ name: 'BRANCH', type: 'StringParameterDefinition' as const }])
    const value = await runTool(byName.get('jenkins_job_params')!, { jobName: 'test', connection: 'prod' }) as unknown[]
    expect(bed.getClient).toHaveBeenCalledWith('prod')
    expect(bed.client.getJobParams).toHaveBeenCalledWith('project/test')
    expect(value).toHaveLength(1)
  })
})
