/**
 * resolver 单测（HOST-M1-04）
 *
 * 覆盖：评分器档位（fullName/displayName 严格与大小写不敏感等值/路径前缀/包含）、
 * searchJobs（exactMatch/排序/limit/中文 displayName/路径包含）、resolveJob
 * （精确/大小写不敏感/唯一模糊自动解析/同 displayName 多 job 消歧/多候选停下询问/
 * fuzzy=false 只精确/无匹配/斜杠路径）。
 */
import { describe, expect, it, vi } from 'vitest'

import type { JenkinsClient } from '../client.js'
import type { JobReference } from '../types.js'
import { jobToMatch, resolveJob, scoreJob, searchJobs } from '../resolver.js'

const FIXTURES: JobReference[] = [
  { name: 'deploy', fullName: 'project/deploy', displayName: '部署', url: 'u1', color: 'blue' },
  { name: 'test', fullName: 'project/test', displayName: '测试', url: 'u2', color: 'red' },
  { name: 'deploy', fullName: 'release/deploy', displayName: '发布部署', url: 'u3', color: 'grey' },
  { name: 'api', fullName: 'devops/api-gateway/build', displayName: '网关构建', url: 'u4', color: 'blue_anime' },
  { name: 'Deploy', fullName: 'legacy/Deploy', displayName: '旧版部署', url: 'u5', color: 'yellow' },
]

function client(): JenkinsClient {
  return { getAllJobsRecursive: vi.fn(async () => FIXTURES) } as unknown as JenkinsClient
}

describe('scoreJob（评分器档位）', () => {
  const job = { fullName: 'project/deploy', name: 'deploy', displayName: '部署' }

  it('fullName strict equality 100 > case-insensitive 95', () => {
    expect(scoreJob('project/deploy', job)?.score).toBe(100)
    expect(scoreJob('PROJECT/deploy', job)?.score).toBe(95)
  })

  it('displayName strict 90 > case-insensitive 85', () => {
    expect(scoreJob('部署', job)?.score).toBe(90)
    expect(scoreJob('部 署', job)).toBeNull() // 空格打断不匹配
  })

  it('path prefix 80 / displayName contains 70 / path contains 60 / none null', () => {
    expect(scoreJob('project', job)?.score).toBe(80)
    expect(scoreJob('部署中', { ...job, displayName: '部署中心' })?.score).toBe(70)
    expect(scoreJob('deploy', job)?.score).toBe(60)
    expect(scoreJob('不存在', job)).toBeNull()
    expect(scoreJob('', job)).toBeNull()
  })
})

describe('searchJobs', () => {
  it('中文 displayName 精确命中排最前，total 含包含命中，exactMatch 正确', async () => {
    const res = await searchJobs(client(), '部署')
    expect(res.matches[0].fullName).toBe('project/deploy')
    expect(res.matches[0].score).toBe(90)
    expect(res.total).toBe(3) // project/deploy(90) + release/deploy + legacy/Deploy（displayName 含「部署」70）
    expect(res.exactMatch).toBe(true)
    expect(res.matches.every((m) => m.fullName)).toBe(true)
  })

  it('路径包含多候选、limit 生效、无精确不置 exactMatch', async () => {
    const res = await searchJobs(client(), 'deploy', 1)
    expect(res.total).toBe(3) // project/deploy + release/deploy + legacy/Deploy（大小写不敏感）
    expect(res.matches).toHaveLength(1)
    expect(res.exactMatch).toBe(false)
  })

  it('exactMatch 在大小写不敏感等值（95/85）时也为 true', async () => {
    const res = await searchJobs(client(), 'PROJECT/deploy')
    expect(res.exactMatch).toBe(true)
  })
})

describe('resolveJob', () => {
  it('解析 fullName 严格等值（含斜杠路径）', async () => {
    const res = await resolveJob(client(), 'project/test')
    expect(res.resolved).toBe(true)
    expect(res.fullName).toBe('project/test')
  })

  it('解析 fullName 大小写不敏感等值', async () => {
    const res = await resolveJob(client(), 'LEGACY/Deploy')
    expect(res.resolved).toBe(true)
    expect(res.fullName).toBe('legacy/Deploy')
  })

  it('displayName 等值唯一 → 解析', async () => {
    const res = await resolveJob(client(), '测试')
    expect(res.resolved).toBe(true)
    expect(res.fullName).toBe('project/test')
  })

  it('同 displayName 多 job → 多候选消歧（绝不自动选择）', async () => {
    const dup = client()
    ;(dup.getAllJobsRecursive as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'order', fullName: 'devops/lib/order-service/deploy', displayName: '订单部署', url: 'a' },
      { name: 'order2', fullName: 'k8s/order-service/deploy', displayName: '订单部署', url: 'b' },
    ])
    const res = await resolveJob(dup, '订单部署')
    expect(res.resolved).toBe(false)
    expect(res.candidates).toHaveLength(2)
    expect(res.message).toContain('订单部署')
    expect(res.message).toContain('绝不自动选择')
  })

  it('唯一模糊命中 → 自动解析', async () => {
    const res = await resolveJob(client(), 'api-gateway')
    expect(res.resolved).toBe(true)
    expect(res.fullName).toBe('devops/api-gateway/build')
    expect(res.message).toContain('模糊匹配')
  })

  it('多候选 → resolved=false + candidates + 候选清单 message', async () => {
    const res = await resolveJob(client(), 'deploy')
    expect(res.resolved).toBe(false)
    expect(res.candidates?.length).toBeGreaterThan(1)
    expect(res.message).toContain('候选')
  })

  it('fuzzy=false：精确仍解析；仅模糊命中 → 未找到（fuzzy 已关闭）', async () => {
    const exact = await resolveJob(client(), 'project/test', false)
    expect(exact.resolved).toBe(true)

    const fuzzyOff = await resolveJob(client(), 'deploy', false)
    expect(fuzzyOff.resolved).toBe(false)
    expect(fuzzyOff.message).toContain('fuzzy 已关闭')
  })

  it('无匹配 → 友好 message；空输入 → 提示', async () => {
    const none = await resolveJob(client(), '完全不存在xyz')
    expect(none.resolved).toBe(false)
    expect(none.message).toContain('未找到')

    const empty = await resolveJob(client(), '   ')
    expect(empty.resolved).toBe(false)
    expect(empty.message).toContain('不能为空')
  })
})

describe('jobToMatch', () => {
  it('映射 JobReference → JobMatchInfo（含 url/color）', () => {
    const m = jobToMatch(FIXTURES[0], '路径包含', 60)
    expect(m.fullName).toBe('project/deploy')
    expect(m.name).toBe('deploy')
    expect(m.displayName).toBe('部署')
    expect(m.matchReason).toBe('路径包含')
    expect(m.score).toBe(60)
    expect(m.url).toBe('u1')
    expect(m.color).toBe('blue')
  })
})
