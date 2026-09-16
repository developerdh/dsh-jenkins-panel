/**
 * 入口图标纯函数单测（CLIENT-M2-02 阶段 4）
 *
 * 覆盖：面板开/关 → active 态类名映射（entryIconClass）。
 */
import { describe, expect, it } from 'vitest'

import { entryIconClass, nextOpenState } from '../entry-icon.js'

describe('entryIconClass（active 态映射）', () => {
  it('always carries the base icon class', () => {
    expect(entryIconClass(false)).toBe('jenkins_entryIcon')
    expect(entryIconClass(true)).toContain('jenkins_entryIcon')
  })

  it('active state adds the highlight class (面板开 → 点亮)', () => {
    expect(entryIconClass(true)).toContain('jenkins_entryIconActive')
    expect(entryIconClass(false)).not.toContain('jenkins_entryIconActive')
  })
})

describe('nextOpenState（0.1.5：入口点击翻转官方列展开态）', () => {
  it('toggles', () => {
    expect(nextOpenState(false)).toBe(true)
    expect(nextOpenState(true)).toBe(false)
  })
})
