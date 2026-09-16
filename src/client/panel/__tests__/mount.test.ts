/**
 * 面板正文可见性判定单测（0.1.5 官方右侧栏桥接）
 *
 * `panelVisibleOf` 是 mount.tsx 桥接组件从槽位注入 `useTabInfo().tab.visible`
 * 派生面板可见性的纯函数层：info 缺失/坏形状必须兜底 true（官方槽位缺省时常显；
 * stale 信息绝不能把面板打成不可见），只有明确的 `visible: false` 才判不可见。
 */
import { describe, expect, it } from 'vitest'

import { panelVisibleOf } from '../mount.js'

describe('panelVisibleOf（官方 tab.visible 派生 + 坏形状兜底）', () => {
  it('undefined / null info → visible（官方槽位缺省时常显）', () => {
    expect(panelVisibleOf(undefined)).toBe(true)
    expect(panelVisibleOf(null)).toBe(true)
  })

  it('official shape: follows tab.visible', () => {
    expect(
      panelVisibleOf({ sidebar: { expanded: true, fullscreen: false }, tab: { visible: true } }),
    ).toBe(true)
    expect(
      panelVisibleOf({ sidebar: { expanded: false, fullscreen: false }, tab: { visible: false } }),
    ).toBe(false)
  })

  it('malformed info never hides the panel', () => {
    expect(panelVisibleOf({} as never)).toBe(true)
    expect(panelVisibleOf({ tab: undefined } as never)).toBe(true)
    expect(panelVisibleOf({ tab: {} } as never)).toBe(true)
  })
})
