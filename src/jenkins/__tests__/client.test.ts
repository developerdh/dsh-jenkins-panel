/**
 * JenkinsClient 单测（HOST-M1-02）
 *
 * 用自定义 axios adapter 注入响应/错误，断言请求的 URL 拼装、tree 参数、
 * 认证头、form 编码、consoleText 分页切片与 §7 错误映射。
 * 注：自定义 adapter 收到的 config.url 为**相对路径**（baseURL 不在 adapter 前合并）；
 * params 保持对象形态（查询串序列化在默认 adapter 内，不经过自定义 adapter）。
 */
import { Readable } from 'node:stream'
import { AxiosError, type AxiosAdapter, type AxiosHeaders, type AxiosRequestConfig, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { describe, expect, it } from 'vitest'

import { JenkinsApiError, JenkinsClient, mapError } from '../client.js'

const U = 'https://jenkins.example.com'

type Handler = (config: AxiosRequestConfig) => { status?: number; data?: unknown; headers?: Record<string, string> } | Error

function makeAdapter(handler: Handler): AxiosAdapter {
  return async (config) => {
    const result = handler(config)
    if (result instanceof Error) throw result
    return {
      data: result.data ?? null,
      status: result.status ?? 200,
      statusText: 'OK',
      headers: result.headers ?? {},
      config: config as InternalAxiosRequestConfig,
    } as AxiosResponse
  }
}

function createClient(handler: Handler): JenkinsClient {
  return new JenkinsClient({
    url: U,
    username: 'alice',
    token: 'tok123',
    adapter: makeAdapter(handler),
  })
}

function httpError(status: number, cfg: AxiosRequestConfig): AxiosError {
  const c = cfg as InternalAxiosRequestConfig
  return new AxiosError(`Request failed with status code ${status}`, String(status), c, undefined, {
    data: {},
    status,
    statusText: 'ERR',
    headers: {},
    config: c,
  })
}

describe('JenkinsClient 构造', () => {
  it('rejects non-http endpoints', () => {
    expect(() => new JenkinsClient({ url: 'ftp://x', token: 't' })).toThrow(/非法 Jenkins 端点 URL/)
  })
})

describe('认证与 URL 拼装', () => {
  it('sends Basic auth (username:token) and hits /api/json with jobs tree', async () => {
    let seen: AxiosRequestConfig | undefined
    const client = createClient((cfg) => {
      seen = cfg
      return { data: { jobs: [] } }
    })
    const jobs = await client.listJobs()
    expect(jobs).toEqual([])
    expect(seen?.url).toBe('/api/json')
    expect(seen?.params).toEqual({ tree: 'jobs[name,url,color,_class,fullName,displayName,description]' })
    const headers = seen?.headers as AxiosHeaders | undefined
    expect(headers?.get('Authorization')).toBe(`Basic ${Buffer.from('alice:tok123').toString('base64')}`)
  })

  it('URL-encodes nested job path segments', async () => {
    const seen: AxiosRequestConfig[] = []
    const client = createClient((cfg) => {
      seen.push(cfg)
      return { data: { jobs: [] } }
    })
    await client.getFolderChildren('folder A/sub')
    expect(seen[0].url).toBe('/job/folder%20A/job/sub/api/json')
    expect(seen[0].params).toEqual({ tree: 'jobs[name,fullName,url,color,_class,displayName]' })
  })

  it('uses lastBuild alias when buildNumber omitted', async () => {
    const seen: AxiosRequestConfig[] = []
    const client = createClient((cfg) => {
      seen.push(cfg)
      return { data: { number: 9, url: 'u' } }
    })
    const info = await client.getBuildStatus('job')
    expect(seen[0].url).toBe('/job/job/lastBuild/api/json')
    expect(info.number).toBe(9)
  })
})

describe('Job 系列', () => {
  it('getJobInfo requests depth=1', async () => {
    const seen: AxiosRequestConfig[] = []
    const client = createClient((cfg) => {
      seen.push(cfg)
      return { data: { name: 'job', fullName: 'job', url: 'u', color: 'blue', buildable: true, inQueue: false, nextBuildNumber: 2, builds: [], property: [] } }
    })
    await client.getJobInfo('job')
    expect(seen[0].url).toBe('/job/job/api/json')
    expect(seen[0].params).toEqual({ depth: 1 })
  })

  it('getJobParams extracts parameterDefinitions from property', async () => {
    const client = createClient(() => ({
      data: {
        property: [
          { _class: 'hudson.model.ParametersDefinitionProperty', parameterDefinitions: [{ name: 'BRANCH', type: 'StringParameterDefinition' }] },
          { _class: 'other' },
        ],
      },
    }))
    const params = await client.getJobParams('job')
    expect(params).toEqual([{ name: 'BRANCH', type: 'StringParameterDefinition' }])
  })

  it('getAllJobsRecursive flattens folders recursively', async () => {
    const seen: string[] = []
    const client = createClient((cfg) => {
      seen.push(String(cfg.url))
      if (cfg.url === '/api/json') {
        return {
          data: {
            jobs: [
              { name: 'jobA', url: 'u', fullName: 'jobA', _class: 'hudson.model.FreeStyleProject' },
              { name: 'folder1', url: 'u', fullName: 'folder1', _class: 'com.cloudbees.hudson.plugins.folder.Folder' },
            ],
          },
        }
      }
      return {
        data: {
          jobs: [{ name: 'inner', url: 'u', fullName: 'folder1/inner', _class: 'hudson.model.FreeStyleProject' }],
        },
      }
    })
    const all = await client.getAllJobsRecursive()
    expect(all.map((j) => j.fullName)).toEqual(['jobA', 'folder1', 'folder1/inner'])
    expect(seen).toEqual(['/api/json', '/job/folder1/api/json'])
  })
})

describe('Build 系列', () => {
  it('triggers with form-encoded params via buildWithParameters and reads queue Location', async () => {
    const seen: AxiosRequestConfig[] = []
    const client = createClient((cfg) => {
      seen.push(cfg)
      return { status: 201, headers: { location: `${U}/queue/item/42/` } }
    })
    // fullName 'my-folder/my-job' → /job/my-folder/job/my-job/...（Jenkins 每级 /job/ 前缀约定）
    const r = await client.triggerBuild('my-folder/my-job', { BRANCH: 'main', FLAG: true })
    expect(seen[0].url).toBe('/job/my-folder/job/my-job/buildWithParameters')
    expect(seen[0].data).toBe('BRANCH=main&FLAG=true')
    const headers = seen[0].headers as AxiosHeaders | undefined
    expect(headers?.get('content-type')).toContain('application/x-www-form-urlencoded')
    expect(r.queueUrl).toBe(`${U}/queue/item/42/`)
  })

  it('triggers without params via /build', async () => {
    const seen: AxiosRequestConfig[] = []
    const client = createClient((cfg) => {
      seen.push(cfg)
      return { status: 201 }
    })
    await client.triggerBuild('job')
    expect(seen[0].url).toBe('/job/job/build')
  })

  it('slices consoleText by tail / startLine+limit and reports totalLines', async () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `line ${i}`)
    const text = `${lines.join('\n')}\n`
    const client = createClient((cfg) => {
      if (cfg.url?.endsWith('/consoleText')) return { data: text }
      return { data: { number: 42, url: 'u' } }
    })

    const tailed = await client.getBuildLog('job', 7, { tail: 10 })
    expect(tailed.buildNumber).toBe(7)
    expect(tailed.totalLines).toBe(1200)
    expect(tailed.log.split('\n').length).toBe(10)
    expect(tailed.log).toContain('line 1199')

    const sliced = await client.getBuildLog('job', 7, { startLine: 100, limit: 5 })
    expect(sliced.log).toBe('line 100\nline 101\nline 102\nline 103\nline 104')

    const defaulted = await client.getBuildLog('job', 7)
    expect(defaulted.log.split('\n').length).toBe(500)
    expect(defaulted.log.split('\n')[0]).toBe('line 700')
  })

  it('resolves last build number for LogOutput when buildNumber omitted', async () => {
    const client = createClient((cfg) => {
      if (cfg.url?.endsWith('/consoleText')) return { data: 'a\nb\nc\n' }
      return { data: { number: 42, url: 'u' } }
    })
    const out = await client.getBuildLog('job')
    expect(out.buildNumber).toBe(42)
    expect(out.totalLines).toBe(3)
  })

  it('filters build history by status and slices by limit', async () => {
    const builds = [
      { number: 3, url: 'u3', timestamp: 3, duration: 10, result: 'SUCCESS', building: false },
      { number: 2, url: 'u2', timestamp: 2, duration: 10, result: 'FAILURE', building: false },
      { number: 1, url: 'u1', timestamp: 1, duration: 10, result: 'SUCCESS', building: false },
    ]
    const seen: AxiosRequestConfig[] = []
    const client = createClient((cfg) => {
      seen.push(cfg)
      return { data: { builds } }
    })
    const h = await client.getBuildHistory('job', { status: 'SUCCESS', limit: 1 })
    expect(seen[0].params).toEqual({
      tree: 'builds[number,url,timestamp,duration,result,building]{0,1}',
    })
    expect(h.builds.map((b) => b.number)).toEqual([3])
    expect(h.totalCount).toBe(2)
  })

  it('build_artifacts / cancel / delete hit the expected endpoints', async () => {
    const seen: AxiosRequestConfig[] = []
    const client = createClient((cfg) => {
      seen.push(cfg)
      if (cfg.url?.endsWith('/api/json')) return { data: { artifacts: [{ displayPath: 'a.jar', fileName: 'a.jar', relativePath: 'target/a.jar' }] } }
      return {}
    })
    const artifacts = await client.getBuildArtifacts('job', 5)
    expect(seen[0].url).toBe('/job/job/5/api/json')
    expect(seen[0].params).toEqual({ tree: 'artifacts[displayPath,fileName,relativePath]' })
    expect(artifacts).toHaveLength(1)

    await client.cancelBuild('job', 5)
    expect(seen[1].url).toBe('/job/job/5/stop')
    await client.deleteBuild('job', 5)
    expect(seen[2].url).toBe('/job/job/5/doDelete')
  })
})

describe('Queue / Workspace / View 系列', () => {
  it('cancels queue item with id param', async () => {
    const seen: AxiosRequestConfig[] = []
    const client = createClient((cfg) => {
      seen.push(cfg)
      return {}
    })
    await client.cancelQueueItem(42)
    expect(seen[0].url).toBe('/queue/cancelItem')
    expect(seen[0].params).toEqual({ id: '42' })
  })

  it('returns workspace info from job info + read-only ws probe', async () => {
    const calls: string[] = []
    const client = createClient((cfg) => {
      calls.push(String(cfg.url))
      if (cfg.url === '/job/job/ws') return { status: 200 }
      return {
        data: {
          name: 'job',
          fullName: 'job',
          url: 'u',
          color: 'blue',
          buildable: true,
          inQueue: false,
          nextBuildNumber: 6,
          builds: [],
          property: [],
          lastBuild: { number: 5, url: 'u', timestamp: 1_700_000_000_000, result: 'SUCCESS' },
        },
      }
    })
    const info = await client.getWorkspaceInfo('job')
    expect(calls).toEqual(['/job/job/api/json', '/job/job/ws'])
    expect(info.workspacePath).toBe(`${U}/job/job/ws`)
    expect(info.lastBuildNumber).toBe(5)
    expect(info.lastBuildResult).toBe('SUCCESS')
    expect(info.buildable).toBe(true)
  })

  it('listViews / getViewJobs use view endpoints', async () => {
    const seen: AxiosRequestConfig[] = []
    const client = createClient((cfg) => {
      seen.push(cfg)
      if (cfg.url === '/view/My%20View/api/json') return { data: { jobs: [{ name: 'job', url: 'u' }] } }
      return { data: { views: [{ name: 'My View', url: 'u', jobs: [] }] } }
    })
    const views = await client.listViews()
    expect(seen[0].url).toBe('/api/json')
    expect(seen[0].params).toEqual({
      tree: 'views[name,url,description,jobs[name,url,color,_class,fullName,displayName,description]]',
    })
    expect(views).toHaveLength(1)

    const jobs = await client.getViewJobs('My View')
    expect(seen[1].url).toBe('/view/My%20View/api/json')
    expect(jobs).toHaveLength(1)
  })
})

describe('错误映射（§7 逐条）', () => {
  it.each([
    [401, 'unauthorized', '认证失败：检查该连接 API Token；提示去设置卡片测试'],
    [403, 'forbidden', '权限不足：当前用户无此操作权限'],
    [404, 'not-found', '资源未找到（含 URL）——任务名可能是路径，尝试验证'],
    [500, 'server-error', 'Jenkins 服务器内部错误，稍后重试'],
  ])('maps HTTP %i → kind=%s message=§7', async (status, kind, message) => {
    const client = createClient((cfg) => {
      throw httpError(status, cfg)
    })
    await expect(client.listJobs()).rejects.toMatchObject({ name: 'JenkinsApiError', kind, message, status })
  })

  it('maps no-response (network) errors to §7 network message', async () => {
    const client = createClient((cfg) => {
      throw new AxiosError('timeout of 30000ms exceeded', 'ETIMEDOUT', cfg as InternalAxiosRequestConfig)
    })
    await expect(client.listJobs()).rejects.toMatchObject({
      kind: 'network',
      message: '无法连接：检查 URL/网络/防火墙',
    })
  })

  it('mapError keeps context in detail and passes JenkinsApiError through', () => {
    const wrapped = mapError(new AxiosError('x', 'ECONNREFUSED'), 'listJobs')
    expect(wrapped.kind).toBe('network')
    expect(wrapped.detail).toContain('listJobs')
    expect(mapError(new JenkinsApiError('forbidden', '权限不足：当前用户无此操作权限', 403))).toBeInstanceOf(JenkinsApiError)
    expect(mapError(new Error('boom')).kind).toBe('unknown')
  })
})

describe('实时日志增量（progressiveText，阶段 8）', () => {
  it('first call: start=0, reads X-Text-Size as nextStart and X-More-Data', async () => {
    const seen: AxiosRequestConfig[] = []
    const client = createClient((cfg) => {
      seen.push(cfg)
      return {
        data: 'line 1\nline 2\n',
        headers: { 'x-text-size': '12345', 'x-more-data': 'true' },
      }
    })
    const out = await client.getProgressiveLog('job', 5)
    expect(seen[0].url).toBe('/job/job/5/logText/progressiveText')
    expect(seen[0].params).toEqual({ start: 0 })
    expect(out).toEqual({ text: 'line 1\nline 2\n', nextStart: 12345, moreData: true })
  })

  it('continuation: passes nextStart back as start; moreData=false ends polling', async () => {
    const seen: AxiosRequestConfig[] = []
    const client = createClient((cfg) => {
      seen.push(cfg)
      return {
        data: 'more output',
        headers: { 'x-text-size': '20000', 'x-more-data': 'false' },
      }
    })
    const out = await client.getProgressiveLog('job', 5, 12345)
    expect(seen[0].params).toEqual({ start: 12345 })
    expect(out.nextStart).toBe(20000)
    expect(out.moreData).toBe(false)
  })

  it('omitted buildNumber uses lastBuild alias; negative start is clamped', async () => {
    const seen: AxiosRequestConfig[] = []
    const client = createClient((cfg) => {
      seen.push(cfg)
      return { data: '', headers: { 'x-text-size': '0', 'x-more-data': 'true' } }
    })
    await client.getProgressiveLog('job', undefined, -5)
    expect(seen[0].url).toBe('/job/job/lastBuild/logText/progressiveText')
    expect(seen[0].params).toEqual({ start: 0 })
  })
})

describe('ping', () => {
  it('hits /api/json with minimal tree and returns ok', async () => {
    const seen: AxiosRequestConfig[] = []
    const client = createClient((cfg) => {
      seen.push(cfg)
      return {}
    })
    const r = await client.ping()
    expect(r.ok).toBe(true)
    expect(typeof r.latencyMs).toBe('number')
    expect(seen[0].url).toBe('/api/json')
    expect(seen[0].params).toEqual({ tree: 'jobs[name]{0,1}' })
  })
})

describe('缺口补齐（FIN-M3-02）', () => {
  it('downloadArtifact URL-encodes each relativePath segment and passes response headers', async () => {
    const seen: AxiosRequestConfig[] = []
    const client = createClient((cfg) => {
      seen.push(cfg)
      return {
        data: Readable.from(['BYTES']),
        headers: { 'content-type': 'application/octet-stream', 'content-length': '5' },
      }
    })
    const out = await client.downloadArtifact('folder A/deploy', 5, 'target/app v1.jar')
    expect(seen[0].url).toBe('/job/folder%20A/job/deploy/5/artifact/target/app%20v1.jar')
    expect(seen[0].responseType).toBe('stream')
    expect(out.contentType).toBe('application/octet-stream')
    expect(out.contentLength).toBe('5')
    expect(out.stream).toBeDefined()
  })

  it('getAllJobsRecursive stops at maxDepth (folder loop guard)', async () => {
    const seen: string[] = []
    const client = createClient((cfg) => {
      seen.push(String(cfg.url))
      return {
        data: {
          jobs: [
            { name: `f${seen.length}`, fullName: `f${seen.length}`, url: 'u', _class: 'com.cloudbees.hudson.plugins.folder.Folder' },
          ],
        },
      }
    })
    const all = await client.getAllJobsRecursive(2)
    // f1（根）→ f2（depth1）→ f3（depth2）→ 再下钻 depth3 > 2 停止
    expect(all.map((j) => j.fullName)).toEqual(['f1', 'f2', 'f3'])
    expect(seen).toHaveLength(3)
  })

  it('getBuildHistory uses the default 500-cap tree range when limit is omitted', async () => {
    const seen: AxiosRequestConfig[] = []
    const client = createClient((cfg) => {
      seen.push(cfg)
      return { data: { builds: [] } }
    })
    await client.getBuildHistory('job')
    expect(seen[0].params).toEqual({ tree: 'builds[number,url,timestamp,duration,result,building]{0,500}' })
  })

  it('getAllBuildsForJob requests allBuilds tree projection and range', async () => {
    const seen: AxiosRequestConfig[] = []
    const client = createClient((cfg) => {
      seen.push(cfg)
      return { data: { allBuilds: [{ number: 7, url: 'u', timestamp: 1, duration: 2, result: 'SUCCESS' }] } }
    })
    const builds = await client.getAllBuildsForJob('folder/deploy', 25)
    expect(seen[0].url).toBe('/job/folder/job/deploy/api/json')
    expect(seen[0].params).toEqual({
      tree: 'allBuilds[number,url,displayName,fullDisplayName,description,result,building,timestamp,duration,estimatedDuration,builtOn]{0,25}',
    })
    expect(builds.map((b) => b.number)).toEqual([7])
  })

  it('getProgressiveLog maps HTTP errors to JenkinsApiError', async () => {
    const client = createClient((cfg) => {
      throw httpError(401, cfg)
    })
    await expect(client.getProgressiveLog('job', 5, 0)).rejects.toMatchObject({
      name: 'JenkinsApiError',
      kind: 'unauthorized',
      status: 401,
    })
  })

  it('jobPath rejects empty names with a friendly error', async () => {
    const client = createClient((_cfg) => ({ data: {} }))
    // getJobInfo 为非 async 包装器：jobPath 在参数求值时同步抛错
    expect(() => client.getJobInfo('')).toThrow(JenkinsApiError)
    expect(() => client.getJobInfo('///')).toThrow(/非法 job 名称/)
  })

  it('getJobParams returns [] when no parameterDefinitions property exists', async () => {
    const client = createClient(() => ({ data: { property: [{ _class: 'hudson.model.JobProperty' }] } }))
    const params = await client.getJobParams('job')
    expect(params).toEqual([])
  })
})
