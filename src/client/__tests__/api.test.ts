/**
 * client 侧 /jenkins/api/* 封装契约（FIN-M3-02 阶段 2 补齐）
 *
 * api.ts 是面板调用 host 路由的唯一入口（docs §5 契约的 client 镜像），此前无直接单测。
 * 覆盖：
 * - callApi 信封解包：ok=true → value；ok=false → 抛用户友好错误（§5 统一信封）；
 * - 各域函数请求形状：method、body（sessionId/connection 合并、参数透传）；
 * - 产物下载 URL（GET /jenkins/api/file 媒体路由参数编码）；
 * - credentialRefOf（镜像 host refOf，V4 方案 A）。
 * 全部 mock global fetch，不连真实环境。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  artifactDownloadUrl,
  callApi,
  cancelBuild,
  cleanupWorkspace,
  credentialRefOf,
  deleteBuild,
  isCredConfigured,
  unwrapRemote,
  deleteTriggered,
  fetchSettings,
  fetchBuildHistory,
  fetchBuildLog,
  fetchBuildStatus,
  fetchFolderTree,
  fetchJobInfo,
  fetchJobParams,
  fetchProgressiveLog,
  fetchTriggeredList,
  listConnections,
  retryBuild,
  searchJobs,
  testConnection,
  updateSettings,
} from '../api.js'

function mockFetchOnce(envelope: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    json: async () => envelope,
  })))
}

/** 最近一次 fetch 调用（method/url/body 断言用） */
function lastFetch(): { url: string; method: string; body: Record<string, unknown> } {
  const call = (fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)
  const [url, init] = call as [string, { method: string; body: string }]
  return { url, method: init.method, body: JSON.parse(init.body) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('callApi（统一信封，§5）', () => {
  it('POSTs to /jenkins/api/<method> with JSON body and returns value on ok', async () => {
    mockFetchOnce({ ok: true, value: { records: [] } })
    const value = await callApi<{ records: unknown[] }>('triggered.list', { limit: 5 }, { sessionId: 's1' })
    expect(value).toEqual({ records: [] })
    const call = lastFetch()
    expect(call.url).toBe('/jenkins/api/triggered.list')
    expect(call.method).toBe('POST')
    expect(call.body).toEqual({ sessionId: 's1', connection: undefined, limit: 5 })
  })

  it('throws the user-friendly error when envelope.ok is false', async () => {
    mockFetchOnce({ ok: false, error: '缺少 sessionId' })
    await expect(callApi('triggered.list', {}, {})).rejects.toThrow('缺少 sessionId')
  })

  it('falls back to a generic message when error is absent', async () => {
    mockFetchOnce({ ok: false })
    await expect(callApi('conn.list', {}, {})).rejects.toThrow(/conn\.list 调用失败/)
  })

  it('merges connection into the body when provided', async () => {
    mockFetchOnce({ ok: true, value: [] })
    await callApi('folder.tree', { folder: '' }, { sessionId: 's1', connection: 'prod' })
    const call = lastFetch()
    expect(call.body).toEqual({ sessionId: 's1', connection: 'prod', folder: '' })
  })
})

describe('conn / folder / search 域（M2-04 任务视图）', () => {
  it('listConnections hits conn.list without extra params', async () => {
    mockFetchOnce({ ok: true, value: [{ name: 'prod', isDefault: true, hasToken: true }] })
    const list = await listConnections({ sessionId: 's1' })
    expect(list).toHaveLength(1)
    expect(lastFetch().url).toBe('/jenkins/api/conn.list')
    expect(lastFetch().body).toEqual({ sessionId: 's1', connection: undefined })
  })

  it('fetchFolderTree sends folder ?? "" and the connection', async () => {
    mockFetchOnce({ ok: true, value: [] })
    await fetchFolderTree('prod', 'release')
    expect(lastFetch().url).toBe('/jenkins/api/folder.tree')
    expect(lastFetch().body).toMatchObject({ folder: 'release', connection: 'prod' })

    await fetchFolderTree('prod', undefined)
    expect(lastFetch().body).toMatchObject({ folder: '' })
  })

  it('searchJobs sends q + connection', async () => {
    mockFetchOnce({ ok: true, value: [] })
    await searchJobs('prod', '部署')
    expect(lastFetch().url).toBe('/jenkins/api/jobs.search')
    expect(lastFetch().body).toMatchObject({ q: '部署', connection: 'prod' })
  })
})

describe('build.* 域（M2-06 构建详情）', () => {
  it('fetchBuildStatus sends jobName/buildNumber', async () => {
    mockFetchOnce({ ok: true, value: { number: 5, url: 'u' } })
    await fetchBuildStatus('prod', 'deploy', 5)
    expect(lastFetch().url).toBe('/jenkins/api/build.status')
    expect(lastFetch().body).toMatchObject({ jobName: 'deploy', buildNumber: 5, connection: 'prod' })
  })

  it('fetchBuildLog spreads tail/start/limit query', async () => {
    mockFetchOnce({ ok: true, value: { jobName: 'deploy', buildNumber: 3, log: 'a', totalLines: 1 } })
    await fetchBuildLog('prod', 'deploy', { buildNumber: 3, start: 10, limit: 50 })
    expect(lastFetch().url).toBe('/jenkins/api/build.log')
    expect(lastFetch().body).toMatchObject({ jobName: 'deploy', buildNumber: 3, start: 10, limit: 50, connection: 'prod' })
  })

  it('fetchProgressiveLog sends startByte (0 default) for auto-follow', async () => {
    mockFetchOnce({ ok: true, value: { text: '', nextStart: 0, moreData: true } })
    await fetchProgressiveLog('prod', 'deploy', undefined, 0)
    expect(lastFetch().url).toBe('/jenkins/api/build.log.stream')
    expect(lastFetch().body).toMatchObject({ jobName: 'deploy', startByte: 0, connection: 'prod' })
    expect(lastFetch().body).not.toHaveProperty('buildNumber') // undefined 参数不落 body（缺省最新）
  })

  it('build operations map to retry/cancel/delete methods', async () => {
    mockFetchOnce({ ok: true, value: { ok: true, message: 'ok' } })
    await retryBuild('prod', 'deploy', 9)
    expect(lastFetch().url).toBe('/jenkins/api/build.retry')
    expect(lastFetch().body).toMatchObject({ jobName: 'deploy', buildNumber: 9 })

    await cancelBuild('prod', 'deploy', { buildNumber: 7 })
    expect(lastFetch().url).toBe('/jenkins/api/build.cancel')
    expect(lastFetch().body).toMatchObject({ jobName: 'deploy', buildNumber: 7 })

    await deleteBuild('prod', 'deploy', 4)
    expect(lastFetch().url).toBe('/jenkins/api/build.delete')
    expect(lastFetch().body).toMatchObject({ jobName: 'deploy', buildNumber: 4 })
  })

  it('cleanupWorkspace sends dryRun flag (preview vs confirm)', async () => {
    mockFetchOnce({ ok: true, value: { dryRun: true } })
    await cleanupWorkspace('prod', 'deploy', true)
    expect(lastFetch().url).toBe('/jenkins/api/workspace.cleanup')
    expect(lastFetch().body).toMatchObject({ jobName: 'deploy', dryRun: true })
  })

  it('artifactDownloadUrl encodes params into the GET /file media route', () => {
    const url = artifactDownloadUrl('prod', 'folder A/deploy', 5, 'target/app v1.jar')
    expect(url).toContain('/jenkins/api/file?')
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('jobName')).toBe('folder A/deploy')
    expect(params.get('buildNumber')).toBe('5')
    expect(params.get('relativePath')).toBe('target/app v1.jar')
    expect(params.get('connection')).toBe('prod')
  })
})

describe('job.* / build.history 域（M2-05 任务详情）', () => {
  it('fetchJobInfo / fetchJobParams hit job.info / job.params', async () => {
    mockFetchOnce({ ok: true, value: { name: 'j', fullName: 'j', url: 'u', buildable: true, inQueue: false, nextBuildNumber: 2, builds: [], property: [] } })
    await fetchJobInfo('prod', 'deploy')
    expect(lastFetch().url).toBe('/jenkins/api/job.info')
    expect(lastFetch().body).toMatchObject({ jobName: 'deploy' })

    mockFetchOnce({ ok: true, value: [] })
    await fetchJobParams('prod', 'deploy')
    expect(lastFetch().url).toBe('/jenkins/api/job.params')
  })

  it('fetchBuildHistory passes limit/status query', async () => {
    mockFetchOnce({ ok: true, value: { jobName: 'deploy', builds: [], totalCount: 0 } })
    await fetchBuildHistory('prod', 'deploy', { limit: 10, status: 'SUCCESS' })
    expect(lastFetch().url).toBe('/jenkins/api/build.history')
    expect(lastFetch().body).toMatchObject({ jobName: 'deploy', limit: 10, status: 'SUCCESS' })
  })
})

describe('triggered.* 域（M2-03 总览）', () => {
  it('fetchTriggeredList passes sessionId/workspace/connection/status/limit/offset', async () => {
    mockFetchOnce({ ok: true, value: { records: [], total: 0 } })
    await fetchTriggeredList({ sessionId: 's1', workspace: 'current', connection: 'prod', status: ['ok', 'fail'], limit: 20, offset: 0 })
    expect(lastFetch().url).toBe('/jenkins/api/triggered.list')
    expect(lastFetch().body).toMatchObject({ sessionId: 's1', workspace: 'current', connection: 'prod', status: ['ok', 'fail'], limit: 20, offset: 0 })
  })

  it('deleteTriggered sends id; omitting it clears the session (contract)', async () => {
    mockFetchOnce({ ok: true, value: { deleted: 1 } })
    await deleteTriggered('s1', 'rec-9')
    expect(lastFetch().body).toMatchObject({ sessionId: 's1', id: 'rec-9' })

    await deleteTriggered('s1')
    expect(lastFetch().body).toMatchObject({ sessionId: 's1' })
    expect(lastFetch().body).not.toHaveProperty('id') // 缺 id = 清空该会话（host 语义）
  })
})

describe('conn.test / credentialRefOf（M2-07 设置卡片）', () => {
  it('testConnection hits conn.test with optional connection', async () => {
    mockFetchOnce({ ok: true, value: { ok: true, message: '连接正常（12ms）', latencyMs: 12 } })
    const r = await testConnection('prod')
    expect(lastFetch().url).toBe('/jenkins/api/conn.test')
    expect(lastFetch().body).toMatchObject({ connection: 'prod' })
    expect(r.ok).toBe(true)
  })

  it('credentialRefOf mirrors host refOf (V4 方案 A)', () => {
    expect(credentialRefOf('prod')).toBe('JENKINS_TOKEN_PROD')
    expect(credentialRefOf('test-env')).toBe('JENKINS_TOKEN_TEST_ENV')
    expect(credentialRefOf('My-Conn')).toBe('JENKINS_TOKEN_MY_CONN')
  })
})

describe('settings / conn.test inline（CLIENT-M2-07 修复）', () => {
  it('fetchSettings hits settings.get', async () => {
    const value = { defaultConnection: 'prod', connections: [{ name: 'prod', url: 'https://j.example.com', timeout: 30_000 }] }
    mockFetchOnce({ ok: true, value })
    const got = await fetchSettings()
    expect(got).toEqual(value)
    expect(lastFetch().url).toBe('/jenkins/api/settings.get')
  })

  it('updateSettings posts defaultConnection + connections to settings.update', async () => {
    mockFetchOnce({ ok: true, value: { ok: true, message: '设置已保存' } })
    const settings = { defaultConnection: 'prod', connections: [{ name: 'prod', url: 'https://j.example.com', timeout: 30_000 }] }
    const res = await updateSettings(settings)
    expect(res.ok).toBe(true)
    expect(lastFetch().url).toBe('/jenkins/api/settings.update')
    expect(lastFetch().body).toMatchObject({ defaultConnection: 'prod', connections: settings.connections })
  })

  it('testConnection without name hits conn.test with inline url/token body', async () => {
    mockFetchOnce({ ok: true, value: { ok: true, message: '连接正常（12ms）' } })
    await testConnection(undefined, { name: 'new', url: 'https://j.example.com', token: 'tok', username: 'ci', timeout: 5000 })
    expect(lastFetch().url).toBe('/jenkins/api/conn.test')
    expect(lastFetch().body).toMatchObject({ url: 'https://j.example.com', token: 'tok', username: 'ci', timeout: 5000 })
  })
})

describe('isCredConfigured / unwrapRemote（0.1.5：ctx.remote.credentials 契约）', () => {
  const ref = 'JENKINS_TOKEN_PROD'

  it('reads configured from the describe value map (Record<ref, CredentialInfo>)', () => {
    expect(isCredConfigured({ [ref]: { configured: true, writable: true } }, ref)).toBe(true)
    expect(isCredConfigured({ [ref]: { configured: false, writable: true } }, ref)).toBe(false)
    expect(isCredConfigured({}, ref)).toBe(false)
    expect(isCredConfigured(undefined, ref)).toBe(false)
  })

  it('unwraps a successful RemoteResult', () => {
    expect(unwrapRemote({ ok: true, value: { [ref]: { configured: true, writable: true } } }, 'x')).toEqual({
      [ref]: { configured: true, writable: true },
    })
  })

  it('throws the host business message on RemoteResult error', () => {
    expect(() => unwrapRemote({ ok: false, error: { message: 'credential/rejected: read-only' } }, 'fallback')).toThrow(
      'credential/rejected: read-only',
    )
    expect(() => unwrapRemote(undefined, 'fallback')).toThrow('fallback')
  })
})
