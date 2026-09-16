/** 跨 Job 构建历史服务测试：官方 allBuilds 取数、归并分页、容器排除与部分失败容错。 */
import { describe, expect, it, vi } from 'vitest'

import type { JenkinsClient } from '../client.js'
import { getAllBuildHistory } from '../all-build-history.js'
import type { BuildInfo, JobReference } from '../types.js'

function clientWith(jobs: JobReference[], histories: Record<string, BuildInfo[] | Error>): JenkinsClient {
  return {
    getAllJobsRecursive: vi.fn(async () => jobs),
    getAllBuildsForJob: vi.fn(async (jobName: string) => {
      const value = histories[jobName]
      if (value instanceof Error) throw value
      return value ?? []
    }),
  } as unknown as JenkinsClient
}

const jobs: JobReference[] = [
  { name: 'folder', fullName: 'folder', url: 'u', _class: 'com.cloudbees.hudson.plugins.folder.Folder' },
  { name: 'alpha', fullName: 'folder/alpha', displayName: 'Alpha', url: 'u', _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob' },
  { name: 'beta', fullName: 'folder/beta', displayName: 'Beta', url: 'u', _class: 'hudson.model.FreeStyleProject' },
]

describe('getAllBuildHistory', () => {
  it('merges Job builds by timestamp and pages over the requested per-Job window', async () => {
    const client = clientWith(jobs, {
      'folder/alpha': [
        { number: 30, url: 'a30', timestamp: 30, duration: 5, result: 'SUCCESS', building: false },
        { number: 10, url: 'a10', timestamp: 10, duration: 4, result: 'FAILURE', building: false },
      ],
      'folder/beta': [
        { number: 20, url: 'b20', timestamp: 20, duration: 3, result: 'UNSTABLE', building: false },
      ],
    })

    const result = await getAllBuildHistory(client, 'prod', { page: 2, pageSize: 1, perJobLimit: 2 })
    expect(client.getAllBuildsForJob).toHaveBeenCalledTimes(2)
    expect(client.getAllBuildsForJob).toHaveBeenCalledWith('folder/alpha', 2)
    expect(client.getAllBuildsForJob).toHaveBeenCalledWith('folder/beta', 2)
    expect(result.builds.map((b) => `${b.jobFullName}#${b.number}`)).toEqual(['folder/beta#20'])
    expect(result.page).toEqual({ page: 2, pageSize: 1, returned: 1, hasMore: true })
    expect(result.scan).toMatchObject({ totalJobs: 2, scannedJobs: 2, failedJobs: 0, buildCount: 3, windowPerJob: 2, truncated: true })
  })

  it('returns successful Jobs and reports partial failures', async () => {
    const client = clientWith(jobs, {
      'folder/alpha': new Error('alpha unavailable'),
      'folder/beta': [{ number: 1, url: 'b1', timestamp: 1, duration: 2, result: 'SUCCESS', building: false }],
    })

    const result = await getAllBuildHistory(client, 'prod', { page: 1, pageSize: 1, perJobLimit: 5 })
    expect(result.builds).toHaveLength(1)
    expect(result.builds[0]).toMatchObject({ jobFullName: 'folder/beta', jobDisplayName: 'Beta', connection: 'prod' })
    expect(result.errors).toEqual([{ jobFullName: 'folder/alpha', message: 'alpha unavailable' }])
    expect(result.scan).toMatchObject({ totalJobs: 2, scannedJobs: 1, failedJobs: 1, truncated: true })
  })

  it('rejects a page window beyond perJobLimit', async () => {
    const client = clientWith(jobs, {})
    await expect(getAllBuildHistory(client, 'prod', { page: 2, pageSize: 2, perJobLimit: 3 })).rejects.toThrow(/分页窗口超过 perJobLimit/)
  })
})
