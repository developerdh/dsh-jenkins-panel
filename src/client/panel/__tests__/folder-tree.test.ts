/**
 * folder-tree 纯函数单测（CLIENT-M2-04 阶段 7）
 *
 * 覆盖：colorToStatus 映射（_anime=构建中）、highlightParts 命中分段、
 * ancestorFolders 祖先链、isAncestorOf 命中分支判定。
 */
import { describe, expect, it } from 'vitest'

import { ancestorFolders, colorToStatus, highlightParts, isAncestorOf } from '../folder-tree.js'

describe('colorToStatus（状态点映射）', () => {
  it('maps jenkins colors to status keys', () => {
    expect(colorToStatus('blue')).toBe('ok')
    expect(colorToStatus('red')).toBe('fail')
    expect(colorToStatus('grey')).toBe('disabled')
    expect(colorToStatus('disabled')).toBe('disabled')
    expect(colorToStatus('aborted')).toBe('aborted')
    expect(colorToStatus('yellow')).toBe('warn')
  })

  it('_anime suffix means building (run)', () => {
    expect(colorToStatus('blue_anime')).toBe('run')
    expect(colorToStatus('red_anime')).toBe('run')
    expect(colorToStatus('grey_anime')).toBe('run')
  })

  it('unknown/absent color falls back to warn', () => {
    expect(colorToStatus(undefined)).toBe('warn')
    expect(colorToStatus('')).toBe('warn')
    expect(colorToStatus('not-a-color')).toBe('warn')
  })
})

describe('highlightParts（搜索命中分段）', () => {
  it('no query returns single non-match part', () => {
    expect(highlightParts('订单部署', '')).toEqual([{ text: '订单部署', match: false }])
    expect(highlightParts('订单部署', '   ')).toEqual([{ text: '订单部署', match: false }])
  })

  it('splits text into match/non-match parts (case-insensitive)', () => {
    expect(highlightParts('Gateway Deploy', 'gateway')).toEqual([
      { text: 'Gateway', match: true },
      { text: ' Deploy', match: false },
    ])
  })

  it('handles multiple occurrences', () => {
    expect(highlightParts('部署-测试-部署', '部署')).toEqual([
      { text: '部署', match: true },
      { text: '-测试-', match: false },
      { text: '部署', match: true },
    ])
  })

  it('no match returns single non-match part', () => {
    expect(highlightParts('前端打包', 'gateway')).toEqual([{ text: '前端打包', match: false }])
  })
})

describe('ancestorFolders / isAncestorOf（命中分支展开）', () => {
  it('derives ancestor folder chain of a job fullName', () => {
    expect(ancestorFolders('devops/lib/order-service/deploy')).toEqual(['devops', 'devops/lib', 'devops/lib/order-service'])
  })

  it('top-level job has no ancestors', () => {
    expect(ancestorFolders('gateway/deploy')).toEqual(['gateway'])
    expect(ancestorFolders('seed-job')).toEqual([])
  })

  it('tolerates leading/trailing slashes (last segment = job)', () => {
    expect(ancestorFolders('/devops/lib/x/')).toEqual(['devops', 'devops/lib'])
    expect(ancestorFolders('devops/lib/x/')).toEqual(['devops', 'devops/lib'])
  })

  it('isAncestorOf matches folder prefix boundary only', () => {
    expect(isAncestorOf('devops', 'devops/lib/order/deploy')).toBe(true)
    expect(isAncestorOf('devops/lib', 'devops/lib/order/deploy')).toBe(true)
    // 前缀边界：devops 不能命中 devops2/... 下的任务
    expect(isAncestorOf('devops', 'devops2/lib/deploy')).toBe(false)
    expect(isAncestorOf('devops/lib', 'devops/lib')).toBe(false)
  })
})
