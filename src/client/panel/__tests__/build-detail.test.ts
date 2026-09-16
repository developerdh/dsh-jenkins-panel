/**
 * 构建详情纯函数单测（CLIENT-M2-06 阶段 7）
 *
 * 覆盖：状态→操作按钮显隐（opButtonsFor）、日志请求参数契约（logQueryFor，红线：
 * tail/limit 必带）、失败行判定（isErrorLine）、耗时/时间格式化、产物下载 URL、
 * entry.status 兜底（deriveState）。
 */
import { describe, expect, it } from 'vitest'

import { artifactDownloadUrl } from '../../api.js'
import {
  buildJobLink,
  buildStatusDotClass,
  buildStatusDotTitle,
  deriveState,
  entryParams,
  extractBuildParams,
  formatDuration,
  formatTime,
  opButtonsFor,
  type BuildDetailEntry,
} from '../build-detail-view.js'
import { isErrorLine, isFollowing, logQueryFor, LOG_PAGE_SIZE } from '../build-log-view.js'

describe('buildStatusDotClass / buildStatusDotTitle（标题头状态点映射）', () => {
  it('queued → queued（黄），building → run（蓝，CSS 自带闪烁）', () => {
    expect(buildStatusDotClass({ building: false, queued: true })).toBe('jenkins_stQueued')
    expect(buildStatusDotClass({ building: true, queued: false })).toBe('jenkins_stRun')
    expect(buildStatusDotTitle({ building: true, queued: false })).toBe('构建中')
  })

  it('terminal results map to ok/fail/aborted/warn', () => {
    expect(buildStatusDotClass({ building: false, queued: false, result: 'SUCCESS' })).toBe('jenkins_stOk')
    expect(buildStatusDotClass({ building: false, queued: false, result: 'FAILURE' })).toBe('jenkins_stFail')
    expect(buildStatusDotClass({ building: false, queued: false, result: 'ABORTED' })).toBe('jenkins_stAborted')
    expect(buildStatusDotClass({ building: false, queued: false, result: 'UNSTABLE' })).toBe('jenkins_stWarn')
    expect(buildStatusDotClass({ building: false, queued: false })).toBe('jenkins_stWarn')
  })
})

describe('opButtonsFor（状态 → 操作按钮显隐，ui-button-states.md 矩阵）', () => {
  it('running build: cancel only（运行中不能重试/删除）', () => {
    expect(opButtonsFor({ building: true, queued: false })).toEqual({ retry: false, cancel: true, delete: false })
  })

  it('queued build: cancel only', () => {
    expect(opButtonsFor({ building: false, queued: true })).toEqual({ retry: false, cancel: true, delete: false })
  })

  it('terminal build: retry + delete（含 unstable），no cancel', () => {
    expect(opButtonsFor({ building: false, queued: false, result: 'SUCCESS' })).toEqual({ retry: true, cancel: false, delete: true })
    expect(opButtonsFor({ building: false, queued: false, result: 'FAILURE' })).toMatchObject({ retry: true, delete: true, cancel: false })
    expect(opButtonsFor({ building: false, queued: false, result: 'UNSTABLE' })).toMatchObject({ retry: true, delete: true, cancel: false })
    expect(opButtonsFor({ building: false, queued: false, result: 'ABORTED' })).toMatchObject({ retry: true, delete: true, cancel: false })
  })

  it('unknown state: no ops（无终态 result 不显示重试/删除）', () => {
    expect(opButtonsFor({ building: false, queued: false, result: undefined })).toEqual({ retry: false, cancel: false, delete: false })
  })
})

describe('logQueryFor（日志请求参数契约：tail/limit 必带，禁全量）', () => {
  it('tail mode always carries tail', () => {
    expect(logQueryFor({ kind: 'tail' }, { buildNumber: 3 })).toEqual({ buildNumber: 3, tail: LOG_PAGE_SIZE })
    expect(logQueryFor({ kind: 'tail' }, { pageSize: 100 })).toEqual({ tail: 100 })
  })

  it('page mode always carries start + limit', () => {
    expect(logQueryFor({ kind: 'page', start: 400 }, { buildNumber: 3 })).toEqual({ buildNumber: 3, start: 400, limit: LOG_PAGE_SIZE })
  })

  it('never omits both tail and limit (red line: no unbounded fetch)', () => {
    const tail = logQueryFor({ kind: 'tail' })
    const page = logQueryFor({ kind: 'page', start: 0 })
    expect(tail.tail ?? tail.limit).toBeDefined()
    expect(page.tail ?? page.limit).toBeDefined()
    expect(page.limit).toBeDefined()
  })
})

describe('isErrorLine（失败高亮判定）', () => {
  it('flags [ERROR] and error lines, ignores normal lines', () => {
    expect(isErrorLine('[ERROR] image pull backoff')).toBe(true)
    expect(isErrorLine('Error from server: timeout')).toBe(true)
    expect(isErrorLine('error: command not found')).toBe(true)
    expect(isErrorLine('  12  [Pipeline] stage: Deploy')).toBe(false)
    expect(isErrorLine('SUCCESS — build finished')).toBe(false)
  })
})

describe('isFollowing（跟随实际状态：开关开且流未结束才视为跟随中）', () => {
  it('followOn 开 + 流未结束（true/null）→ 跟随中', () => {
    expect(isFollowing(true, true)).toBe(true)
    expect(isFollowing(true, null)).toBe(true)
    expect(isFollowing(true, undefined)).toBe(true)
  })

  it('开关关 → 不跟随（无论流状态）', () => {
    expect(isFollowing(false, true)).toBe(false)
    expect(isFollowing(false, null)).toBe(false)
    expect(isFollowing(false, false)).toBe(false)
  })

  it('开关开但流已结束（moreData=false）→ 不再视为跟随中（按钮「开」也不误报进行中）', () => {
    expect(isFollowing(true, false)).toBe(false)
  })
})

describe('formatDuration / formatTime', () => {
  it('formats durations and defaults', () => {
    expect(formatDuration(undefined)).toBe('—')
    expect(formatDuration(5_000)).toBe('5s')
    expect(formatDuration(184_000)).toBe('3m 4s')
    expect(formatDuration(3_720_000)).toBe('1h 2m')
  })

  it('formatTime returns local HH:MM:SS or empty', () => {
    expect(formatTime(undefined)).toBe('')
    expect(formatTime(1_700_000_000_000)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })
})

describe('artifactDownloadUrl（/jenkins/api/file 媒体路由参数）', () => {
  it('encodes jobName/relativePath and passes connection', () => {
    const url = artifactDownloadUrl('prod', 'project/deploy', 12, 'dist/app.jar')
    expect(url).toBe('/jenkins/api/file?jobName=project%2Fdeploy&buildNumber=12&relativePath=dist%2Fapp.jar&connection=prod')
  })

  it('handles special characters in paths (URLSearchParams: space → +)', () => {
    const url = artifactDownloadUrl('test env', 'a/b', 1, 'x y#1.txt')
    expect(url).toContain('relativePath=x+y%231.txt')
    expect(url).toContain('connection=test+env')
  })
})

describe('deriveState（entry.status 装载前兜底）', () => {
  const entry: BuildDetailEntry = { connection: 'prod', jobName: 'deploy' }

  it('build.status info wins when loaded', () => {
    expect(deriveState(entry, { number: 5, url: 'u', building: true })).toEqual({ building: true, queued: false, result: undefined })
    expect(deriveState(entry, { number: 5, url: 'u', building: false, result: 'SUCCESS' })).toEqual({
      building: false,
      queued: false,
      result: 'SUCCESS',
    })
  })

  it('maps trigger-record statuses before info loads', () => {
    expect(deriveState({ ...entry, status: 'queued', buildNumber: 0 }, null)).toEqual({ building: false, queued: true, result: undefined })
    expect(deriveState({ ...entry, status: 'running' }, null)).toEqual({ building: true, queued: false, result: undefined })
    expect(deriveState({ ...entry, status: 'ok' }, null)).toMatchObject({ result: 'SUCCESS' })
    expect(deriveState({ ...entry, status: 'fail' }, null)).toMatchObject({ result: 'FAILURE' })
    expect(deriveState({ ...entry, status: 'aborted' }, null)).toMatchObject({ result: 'ABORTED' })
  })

  it('buildNumber 0 implies queued', () => {
    expect(deriveState({ ...entry, buildNumber: 0 }, null)).toMatchObject({ queued: true })
  })
})

describe('extractBuildParams / entryParams（构建参数提取，每行一个）', () => {
  const paramAction = {
    _class: 'hudson.model.ParametersAction',
    parameters: [
      { name: 'BRANCH', value: 'main' },
      { name: 'ENV', value: 'prod' },
    ],
  }

  it('extracts actual parameters from build.status actions.parameters', () => {
    const info = {
      number: 1060,
      url: 'u',
      actions: [
        { _class: 'hudson.model.CauseAction' },
        paramAction,
      ],
    }
    expect(extractBuildParams(info)).toEqual([
      { name: 'BRANCH', value: 'main' },
      { name: 'ENV', value: 'prod' },
    ])
  })

  it('returns empty when no actions/parameters', () => {
    expect(extractBuildParams(null)).toEqual([])
    expect(extractBuildParams({ number: 1, url: 'u' })).toEqual([])
    expect(extractBuildParams({ number: 1, url: 'u', actions: [{ _class: 'CauseAction' }] })).toEqual([])
  })

  it('maps entry.params (trigger record) one per line; empty/missing value → dash', () => {
    const entry: BuildDetailEntry = { connection: 'prod', jobName: 'deploy', params: { BRANCH: 'main', ENV: '' } }
    expect(entryParams(entry)).toEqual([
      { name: 'BRANCH', value: 'main' },
      { name: 'ENV', value: '—' },
    ])
    expect(entryParams({ connection: 'prod', jobName: 'deploy' })).toEqual([])
  })

  it('stringifies object/boolean values', () => {
    const entry: BuildDetailEntry = { connection: 'prod', jobName: 'deploy', params: { flags: ['a', 'b'], dry: true } }
    expect(entryParams(entry)).toEqual([
      { name: 'flags', value: JSON.stringify(['a', 'b']) },
      { name: 'dry', value: 'true' },
    ])
  })
})

describe('buildJobLink（任务名链接：由构建 URL 派生任务页地址）', () => {
  it('strips the trailing build-number segment to get the job page URL', () => {
    expect(buildJobLink('https://jenkins.example/job/devops/console/162/')).toBe('https://jenkins.example/job/devops/console/')
    expect(buildJobLink('https://jenkins.example/job/devops/console/162')).toBe('https://jenkins.example/job/devops/console/')
    expect(buildJobLink('https://jenkins.example/job/folder/job/myjob/42/')).toBe('https://jenkins.example/job/folder/job/myjob/')
  })

  it('returns undefined when no build URL is available', () => {
    expect(buildJobLink(undefined)).toBeUndefined()
    expect(buildJobLink('')).toBeUndefined()
  })
})
