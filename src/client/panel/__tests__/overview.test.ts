/**
 * 总览视图纯函数单测（CLIENT-M2-03 阶段 6）
 *
 * 覆盖：状态过滤多选（matchesFilter：空选 = 全部）、状态点类映射（statusDotClass）、
 * 触发时间格式化（formatRecordTime）、triggered.list 查询构造（buildListQuery：
 * 空选不带 status）。
 */
import { describe, expect, it } from 'vitest'

import { buildListQuery, formatRecordTime, matchesFilter, statusDotClass, workspaceFilterNotice } from '../overview-view.js'
import type { TriggerStatus } from '../../api.js'

describe('matchesFilter（状态过滤多选）', () => {
  it('empty selection means all', () => {
    expect(matchesFilter('ok', new Set())).toBe(true)
    expect(matchesFilter('running', new Set())).toBe(true)
  })

  it('single/multi selection filters', () => {
    expect(matchesFilter('running', new Set<TriggerStatus>(['running']))).toBe(true)
    expect(matchesFilter('ok', new Set<TriggerStatus>(['running']))).toBe(false)
    expect(matchesFilter('fail', new Set<TriggerStatus>(['running', 'fail']))).toBe(true)
    expect(matchesFilter('queued', new Set<TriggerStatus>(['running', 'fail']))).toBe(false)
  })
})

describe('statusDotClass（状态点映射）', () => {
  it('maps each trigger status to a dot class', () => {
    expect(statusDotClass('ok')).toBe('jenkins_stOk')
    expect(statusDotClass('fail')).toBe('jenkins_stFail')
    expect(statusDotClass('running')).toBe('jenkins_stRun')
    expect(statusDotClass('queued')).toBe('jenkins_stQueued')
    expect(statusDotClass('aborted')).toBe('jenkins_stAborted')
  })
})

describe('formatRecordTime（触发时间显示）', () => {
  it('formats epoch ms to local HH:MM:SS', () => {
    expect(formatRecordTime(1_700_000_000_000)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })

  it('falls back to dash for invalid input', () => {
    expect(formatRecordTime(undefined)).toBe('—')
    expect(formatRecordTime(0)).toBe('—')
    expect(formatRecordTime(Number.NaN)).toBe('—')
    expect(formatRecordTime(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('buildListQuery（triggered.list 查询构造）', () => {
  it('omits status when selection is empty (all)', () => {
    expect(buildListQuery(new Set(), 50)).toEqual({ limit: 50 })
  })

  it('passes selected statuses in canonical order', () => {
    const selected = new Set<TriggerStatus>(['fail', 'queued'])
    expect(buildListQuery(selected, 50)).toEqual({ status: ['queued', 'fail'], limit: 50 })
  })
})

describe('workspaceFilterNotice（P0-b：当前工作区未解析时必须吭声）', () => {
  it('current + 未解析（false）→ 出提示', () => {
    expect(workspaceFilterNotice('current', false)).toContain('未能解析当前工作区')
  })

  it('current + 已解析 / 旧后端未标注 → 不提示', () => {
    expect(workspaceFilterNotice('current', true)).toBeNull()
    expect(workspaceFilterNotice('current', undefined)).toBeNull()
  })

  it('all → 永不提示（用户主动选了全部）', () => {
    expect(workspaceFilterNotice('all', false)).toBeNull()
    expect(workspaceFilterNotice('all', true)).toBeNull()
  })
})
