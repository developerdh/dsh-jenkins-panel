/**
 * 队列/工作空间/结构/连接测试工具单测（HOST-M1-07）
 *
 * 覆盖：queue_list/cancel 透传、workspace_info 解析、workspace_cleanup **dry-run 默认预览**
 * 与二次确认执行（wipe 不泄漏）、folder_list 懒加载单层与 depth 递归、view_list/jobs、
 * connection_test 不泄漏 token 文本。
 */
import { describe, expect, it, vi } from 'vitest'

import { createConnectionRegistry } from '../../jenkins/connection.js'
import { defineOpsTools } from '../ops.js'
import { createBed, runTool } from './helpers.js'

const JOB = [{ name: 'deploy', fullName: 'project/deploy', displayName: '部署', url: 'u1', color: 'blue', _class: 'hudson.model.FreeStyleProject' }]

function tools() {
  const bed = createBed()
  const byName = new Map(defineOpsTools(bed.deps).map((t) => [t.name, t]))
  return { bed, byName }
}

describe('jenkins_queue_list / queue_cancel', () => {
  it('queue_list returns items and passes connection through', async () => {
    const { bed, byName } = tools()
    const items = [{ id: 7, task: { name: 'deploy', fullName: 'project/deploy', url: 'u' }, why: 'waiting', stuck: false, blocked: false, buildable: true, timestamp: 1 }]
    bed.client.listQueue = vi.fn(async () => items)
    const value = await runTool(byName.get('jenkins_queue_list')!, { connection: 'test' })
    expect(bed.getClient).toHaveBeenCalledWith('test')
    expect(bed.client.listQueue).toHaveBeenCalledOnce()
    expect(value).toEqual(items)
  })

  it('queue_cancel delegates to cancelQueueItem', async () => {
    const { bed, byName } = tools()
    const value = await runTool(byName.get('jenkins_queue_cancel')!, { queueId: 7 }) as { ok: boolean; message: string }
    expect(bed.client.cancelQueueItem).toHaveBeenCalledWith(7)
    expect(value.ok).toBe(true)
    expect(value.message).toContain('#7')
  })
})

describe('jenkins_workspace_info / workspace_cleanup', () => {
  it('workspace_info resolves jobName then fetches info', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOB)
    bed.client.getWorkspaceInfo = vi.fn(async () => ({ jobName: 'project/deploy', workspacePath: 'ws', buildable: true }))
    const value = await runTool(byName.get('jenkins_workspace_info')!, { jobName: 'deploy' })
    expect(bed.client.getWorkspaceInfo).toHaveBeenCalledWith('project/deploy')
    expect(value).toMatchObject({ jobName: 'project/deploy', workspacePath: 'ws' })
  })

  it('cleanup dry-runs by default: preview only, never wipes', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOB)
    const value = await runTool(byName.get('jenkins_workspace_cleanup')!, { jobName: 'deploy' }) as { dryRun: boolean; info?: unknown }
    expect(bed.client.getWorkspaceInfo).toHaveBeenCalled()
    expect(bed.client.wipeWorkspace).not.toHaveBeenCalled()
    expect(value.dryRun).toBe(true)
    expect(value.info).toBeDefined()
  })

  it('cleanup executes only with dryRun=false (二次确认语义)', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOB)
    const value = await runTool(byName.get('jenkins_workspace_cleanup')!, { jobName: 'deploy', dryRun: false }) as { dryRun: boolean; ok: boolean; message: string }
    expect(bed.client.wipeWorkspace).toHaveBeenCalledWith('project/deploy')
    expect(value.dryRun).toBe(false)
    expect(value.ok).toBe(true)
  })

  it('accepts days param (暂不生效，不报错)', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOB)
    await expect(runTool(byName.get('jenkins_workspace_cleanup')!, { jobName: 'deploy', days: 30 })).resolves.toMatchObject({ dryRun: true })
  })
})

describe('jenkins_folder_list / view_list / view_jobs', () => {
  it('folder_list lazy-loads single level by default (folder omitted = root)', async () => {
    const { bed, byName } = tools()
    bed.client.getFolderChildren = vi.fn(async () => [
      { name: 'deploy', fullName: 'project/deploy', type: 'job' as const, url: 'u', displayName: '部署', color: 'blue' },
    ])
    const value = await runTool(byName.get('jenkins_folder_list')!, {}) as unknown[]
    expect(bed.client.getFolderChildren).toHaveBeenCalledWith(undefined)
    expect(value).toHaveLength(1)
  })

  it('folder_list recursion with depth=2 fills folder children', async () => {
    const { bed, byName } = tools()
    bed.client.getFolderChildren = vi.fn(async (folder?: string) =>
      folder === undefined
        ? [{ name: 'devops', fullName: 'devops', type: 'folder' as const, url: 'u' }]
        : [{ name: 'deploy', fullName: 'devops/deploy', type: 'job' as const, url: 'u' }],
    )
    const value = await runTool(byName.get('jenkins_folder_list')!, { depth: 2 }) as Array<{ fullName: string; children?: unknown[] }>
    expect(bed.client.getFolderChildren).toHaveBeenNthCalledWith(1, undefined)
    expect(bed.client.getFolderChildren).toHaveBeenNthCalledWith(2, 'devops')
    expect(value[0].fullName).toBe('devops')
    expect(value[0].children).toEqual([{ name: 'deploy', fullName: 'devops/deploy', type: 'job', url: 'u' }])
  })

  it('view_list / view_jobs delegate with connection passthrough', async () => {
    const { bed, byName } = tools()
    bed.client.listViews = vi.fn(async () => [{ name: 'all', url: 'u', jobs: [] }])
    const views = await runTool(byName.get('jenkins_view_list')!, { connection: 'test' })
    expect(bed.client.listViews).toHaveBeenCalledOnce()
    expect(views).toEqual([{ name: 'all', url: 'u', jobs: [] }])

    bed.client.getViewJobs = vi.fn(async () => JOB)
    const jobs = await runTool(byName.get('jenkins_view_jobs')!, { viewName: 'all' })
    expect(bed.client.getViewJobs).toHaveBeenCalledWith('all')
    expect(jobs).toHaveLength(1)
  })
})

describe('jenkins_connection_test', () => {
  it('returns ok + latencyMs on success (no credential text)', async () => {
    const { bed, byName } = tools()
    bed.client.ping = vi.fn(async () => ({ ok: true, latencyMs: 23 }))
    const value = await runTool(byName.get('jenkins_connection_test')!, {}) as { ok: boolean; message: string; latencyMs?: number }
    expect(value.ok).toBe(true)
    expect(value.latencyMs).toBe(23)
    expect(value.message).toContain('23ms')
    expect(JSON.stringify(value)).not.toContain('token')
  })

  it('returns ok=false with friendly message on failure (no token leaked)', async () => {
    const bed = createBed({ getClient: async () => { throw new Error('no token: JENKINS_TOKEN_PROD') } })
    const byName = new Map(defineOpsTools(bed.deps).map((t) => [t.name, t]))
    const value = await runTool(byName.get('jenkins_connection_test')!, {}) as { ok: boolean; message: string }
    expect(value.ok).toBe(false)
    expect(value.message).toContain('no token')
    // 错误文案可以含 ref 名（提示配置），但不得返回凭据值本身
    expect(value.message).not.toContain('tok123')
  })
})

describe('jenkins_connection_list', () => {
  it('lists all configured connections with endpoint url merged from registry (delegates hasToken/isDefault to the binding)', async () => {
    const listConnections = vi.fn(async () => [
      { name: 'prod', isDefault: true, hasToken: true },
      { name: 'test', isDefault: false, hasToken: false },
    ])
    const bed = createBed({
      registry: createConnectionRegistry({
        defaultConnection: 'prod',
        connections: [
          { name: 'prod', url: 'https://ci.prod.example.com', timeout: 30_000 },
          { name: 'test', url: 'https://ci.test.example.com', timeout: 30_000 },
        ],
      }),
      listConnections,
    })
    const byName = new Map(defineOpsTools(bed.deps).map((t) => [t.name, t]))
    const value = await runTool(byName.get('jenkins_connection_list')!, {}) as Array<{ name: string; url: string; isDefault: boolean; hasToken: boolean }>
    expect(listConnections).toHaveBeenCalledOnce()
    expect(value).toEqual([
      { name: 'prod', url: 'https://ci.prod.example.com', isDefault: true, hasToken: true },
      { name: 'test', url: 'https://ci.test.example.com', isDefault: false, hasToken: false },
    ])
  })

  it('returns the endpoint url (名称模糊时判别环境) but never leaks credentials', async () => {
    const bed = createBed()
    const byName = new Map(defineOpsTools(bed.deps).map((t) => [t.name, t]))
    const value = await runTool(byName.get('jenkins_connection_list')!, {}) as Array<Record<string, unknown>>
    // url = 连接端点配置（默认 prod 连接的 url 应返回，供判别环境）
    expect(value[0]).toMatchObject({ name: 'prod', url: 'https://jenkins.example.com', isDefault: true, hasToken: true })
    // 凭据值 / ref 名永不出现
    expect(JSON.stringify(value)).not.toContain('token')
    expect(JSON.stringify(value)).not.toContain('TOKEN_')
    expect(JSON.stringify(value)).not.toContain('tok123')
  })

  it('fails loudly when the listConnections binding is not wired', async () => {
    const bed = createBed({ listConnections: undefined })
    const byName = new Map(defineOpsTools(bed.deps).map((t) => [t.name, t]))
    await expect(runTool(byName.get('jenkins_connection_list')!, {})).rejects.toThrow(/未接线/)
  })
})

describe('缺口补齐（FIN-M3-02）', () => {
  it('folder_list clamps depth < 1 to single level (懒加载语义)', async () => {
    const { bed, byName } = tools()
    bed.client.getFolderChildren = vi.fn(async (folder?: string) =>
      folder === undefined
        ? [{ name: 'devops', fullName: 'devops', type: 'folder' as const, url: 'u' }]
        : [{ name: 'inner', fullName: 'devops/inner', type: 'job' as const, url: 'u' }],
    )
    const value = await runTool(byName.get('jenkins_folder_list')!, { depth: 0 }) as Array<{ children?: unknown[] }>
    expect(bed.client.getFolderChildren).toHaveBeenCalledTimes(1)
    expect(value[0].children).toBeUndefined() // depth 0 → 按 1 处理，不再递归
  })

  it('workspace_cleanup returns a confirm message only when dryRun=false', async () => {
    const { bed, byName } = tools()
    bed.client.getAllJobsRecursive = vi.fn(async () => JOB)
    const value = await runTool(byName.get('jenkins_workspace_cleanup')!, { jobName: 'deploy', dryRun: false }) as { message: string }
    expect(value.message).toContain('已清空工作空间')
  })
})
