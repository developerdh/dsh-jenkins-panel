/**
 * 面板会话 store 单测（0.1.5 挂载改造后）
 *
 * 覆盖：当前激活会话的跟踪、订阅通知、快照引用稳定性。
 * store 不依赖 DOM，node 环境即可运行。
 *
 * 0.1.5：宽度/持久化已移交给官方右侧栏列几何，故移除宽度 clamp/持久化用例。
 */
import { describe, expect, it } from 'vitest'

import { panelStore, PanelStore } from '../store.js'

describe('PanelStore（激活会话跟踪）', () => {
  it('starts with no active session', () => {
    const store = new PanelStore()
    expect(store.getActiveSessionId()).toBeUndefined()
    expect(store.getSnapshot().activeSessionId).toBeUndefined()
  })

  it('tracks the active session and exposes it via snapshot', () => {
    const store = new PanelStore()
    store.setActiveSession('s1')
    expect(store.getActiveSessionId()).toBe('s1')
    expect(store.getSnapshot().activeSessionId).toBe('s1')
    store.setActiveSession(undefined)
    expect(store.getActiveSessionId()).toBeUndefined()
  })

  it('notifies subscribers on session change; same value is a no-op', () => {
    const store = new PanelStore()
    let hits = 0
    const off = store.subscribe(() => {
      hits += 1
    })
    store.setActiveSession('s1')
    store.setActiveSession('s1') // 同值 → 不通知
    expect(hits).toBe(1)
    store.setActiveSession('s2')
    expect(hits).toBe(2)
    off()
    store.setActiveSession('s3')
    expect(hits).toBe(2)
  })

  it('keeps a stable snapshot reference until a change', () => {
    const store = new PanelStore()
    const first = store.getSnapshot()
    expect(store.getSnapshot()).toBe(first)
    store.setActiveSession('s1')
    expect(store.getSnapshot()).not.toBe(first)
  })
})

describe('panelStore 运行时单例', () => {
  it('exists with the expected API surface', () => {
    expect(typeof panelStore.setActiveSession).toBe('function')
    expect(typeof panelStore.subscribe).toBe('function')
    expect(typeof panelStore.getActiveSessionId).toBe('function')
  })
})
