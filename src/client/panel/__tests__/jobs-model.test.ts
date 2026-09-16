/**
 * conn-switcher / jobs-view 纯函数单测（CLIENT-M2-04 阶段 7）
 *
 * 覆盖：横向溢出判定（hasOverflow）、连接默认排序（orderConnections）。
 */
import { describe, expect, it } from 'vitest'

import { hasOverflow } from '../conn-switcher.js'
import { orderConnections } from '../jobs-view.js'
import type { ConnectionInfo } from '../../api.js'

describe('hasOverflow（横向滚动溢出判定）', () => {
  it('detects overflow beyond client width +2px tolerance', () => {
    expect(hasOverflow(600, 400)).toBe(true)
    expect(hasOverflow(403, 400)).toBe(true)
    expect(hasOverflow(402, 400)).toBe(false) // 容差 2px 内不算溢出
    expect(hasOverflow(401, 400)).toBe(false)
    expect(hasOverflow(400, 400)).toBe(false)
    expect(hasOverflow(300, 400)).toBe(false)
  })
})

describe('orderConnections（默认连接排最前）', () => {
  const list: ConnectionInfo[] = [
    { name: 'test', isDefault: false, hasToken: true },
    { name: 'prod', isDefault: true, hasToken: true },
    { name: 'dev', isDefault: false, hasToken: false },
  ]

  it('moves the default connection first, keeps relative order otherwise', () => {
    expect(orderConnections(list).map((c) => c.name)).toEqual(['prod', 'test', 'dev'])
  })

  it('does not mutate the input and handles empty list', () => {
    const input = [...list]
    orderConnections(input)
    expect(input.map((c) => c.name)).toEqual(['test', 'prod', 'dev'])
    expect(orderConnections([])).toEqual([])
  })

  it('no default: keeps original order', () => {
    const noDefault: ConnectionInfo[] = [
      { name: 'a', isDefault: false, hasToken: true },
      { name: 'b', isDefault: false, hasToken: false },
    ]
    expect(orderConnections(noDefault).map((c) => c.name)).toEqual(['a', 'b'])
  })
})
