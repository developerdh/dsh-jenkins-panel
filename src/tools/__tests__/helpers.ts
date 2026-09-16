/**
 * 工具层测试助手（HOST-M1-06）：假客户端/假 deps/假执行上下文 + 执行入口。
 */
import { vi } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import type { JenkinsClient } from '../../jenkins/client.js'
import { createConnectionRegistry } from '../../jenkins/connection.js'
import type { TriggerRecord, TriggerRegistry } from '../../jenkins/registry.js'
import type { JenkinsToolsDeps } from '../shared.js'

/** 全方法假客户端（按需 override） */
export function fakeClient(overrides?: Partial<JenkinsClient>): JenkinsClient {
  return {
    listJobs: vi.fn(async () => []),
    getFolderChildren: vi.fn(async () => []),
    getAllJobsRecursive: vi.fn(async () => []),
    getJobInfo: vi.fn(async () => ({
      name: 'j', fullName: 'j', url: 'u', color: 'blue', buildable: true, inQueue: false,
      nextBuildNumber: 2, builds: [], property: [],
    })),
    getJobParams: vi.fn(async () => []),
    triggerBuild: vi.fn(async () => ({})),
    getBuildStatus: vi.fn(async () => ({ number: 1, url: 'u', building: false, result: 'SUCCESS' })),
    getBuildInfo: vi.fn(async () => ({ number: 1, url: 'u', building: false, result: 'SUCCESS' })),
    getBuildLog: vi.fn(async () => ({ jobName: 'j', buildNumber: 1, log: 'line1\nline2', totalLines: 2 })),
    getBuildHistory: vi.fn(async () => ({ jobName: 'j', builds: [], totalCount: 0 })),
    getAllBuildsForJob: vi.fn(async () => []),
    retryBuild: vi.fn(async () => ({})),
    cancelBuild: vi.fn(async () => {}),
    deleteBuild: vi.fn(async () => {}),
    getBuildArtifacts: vi.fn(async () => []),
    listQueue: vi.fn(async () => []),
    getQueueItem: vi.fn(async () => undefined),
    cancelQueueItem: vi.fn(async () => {}),
    getWorkspaceInfo: vi.fn(async () => ({ jobName: 'j', buildable: true })),
    wipeWorkspace: vi.fn(async () => {}),
    listViews: vi.fn(async () => []),
    getViewJobs: vi.fn(async () => []),
    ping: vi.fn(async () => ({ ok: true, latencyMs: 12 })),
    ...overrides,
  } as unknown as JenkinsClient
}

/** 假执行上下文（agent.id = session-1；可按需 override） */
export function fakeExec(overrides?: Partial<ToolRunContext>): ToolRunContext {
  return {
    signal: new AbortController().signal,
    agent: { id: 'session-1' } as never,
    ...overrides,
  } as unknown as ToolRunContext
}

export interface ToolTestBed {
  deps: JenkinsToolsDeps
  client: JenkinsClient
  getClient: ReturnType<typeof vi.fn>
  listConnections: ReturnType<typeof vi.fn>
  recordTrigger: ReturnType<typeof vi.fn>
}

/** 组装工具层 deps 测试床（client/getClient/listConnections/recordTrigger 均可配置断言） */
export function createBed(overrides?: Partial<JenkinsToolsDeps>): ToolTestBed {
  const client = fakeClient()
  const getClient = vi.fn(async () => client)
  const listConnections = vi.fn(async () => [{ name: 'prod', isDefault: true, hasToken: true }])
  const recordTrigger = vi.fn(
    async (input: Parameters<TriggerRegistry['recordTrigger']>[0]): Promise<TriggerRecord> => ({
      id: 'rec-1',
      connection: input.connection,
      jobName: input.jobName,
      displayName: input.displayName,
      queueId: input.queueId,
      buildNumber: input.buildNumber,
      params: input.params,
      status: 'queued',
      triggeredAt: 1,
      statusUpdatedAt: 1,
      sessionId: input.sessionId,
      source: 'conversation',
    }),
  )
  const deps: JenkinsToolsDeps = {
    registry: createConnectionRegistry({
      defaultConnection: 'prod',
      connections: [{ name: 'prod', url: 'https://jenkins.example.com', timeout: 30_000 }],
    }),
    getClient,
    listConnections,
    triggerRegistry: { recordTrigger } as unknown as TriggerRegistry,
    ...overrides,
  }
  return { deps, client, getClient, listConnections, recordTrigger }
}

/** 执行工具（args + 假 exec） */
export async function runTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  exec: ToolRunContext = fakeExec(),
): Promise<unknown> {
  return tool.execute(args, exec)
}
