/**
 * 会话 → 工作区解析单测（P0-a 回归）
 *
 * 用户报障：重启后打开面板，总览「当前工作区」过滤看似失效。根因：解析只走
 * `ctx.sessions.get(sessionId).cwd` → `workspaceRegistry.resolveByPath(cwd)`，
 * 而 `ctx.sessions` 只认**本进程已加载**的会话；进程刚启动（或面板早于会话加载）时
 * 解析恒为 undefined，host 随后把「按工作区过滤」静默降级为「不过滤」。
 *
 * 本测试锁定两级解析：① 路径归属优先（既有口径）；② `sessionIds` 索引兜底
 * （来自启动时 `SessionPersistence.list()` 的会话头投影，**不依赖内存会话**）。
 */
import { describe, expect, it, vi } from 'vitest'

import { resolveWorkspaceIdOfSession } from '../workspace-resolve.js'

describe('resolveWorkspaceIdOfSession（P0-a：重启后仍可解析）', () => {
  it('① 路径归属优先：会话 cwd 命中 workspace 即返回', async () => {
    const registry = {
      resolveByPath: vi.fn(async () => ({ id: 'ws-a' })),
      list: vi.fn(() => [{ id: 'ws-b', sessionIds: ['session-1'] }]),
    }
    const id = await resolveWorkspaceIdOfSession('session-1', {
      getSessionCwd: async () => 'D:/ws/a',
      workspaceRegistry: registry,
    })
    expect(id).toBe('ws-a')
    expect(registry.resolveByPath).toHaveBeenCalledWith('D:/ws/a')
    expect(registry.list).not.toHaveBeenCalled() // 主路径命中就不查索引
  })

  it('② 兜底：拿不到 cwd（会话不在本进程内存）时按 sessionIds 索引解析', async () => {
    const id = await resolveWorkspaceIdOfSession('session-old', {
      getSessionCwd: async () => undefined,
      workspaceRegistry: {
        resolveByPath: vi.fn(async () => undefined),
        list: () => [
          { id: 'ws-other', sessionIds: ['session-other'] },
          { id: 'ws-target', sessionIds: ['session-old'] },
        ],
      },
    })
    expect(id).toBe('ws-target')
  })

  it('② 兜底：cwd 存在但该路径不归属任何 workspace 时也走索引', async () => {
    const id = await resolveWorkspaceIdOfSession('session-2', {
      getSessionCwd: async () => 'D:/ungrouped',
      workspaceRegistry: {
        resolveByPath: async () => undefined,
        list: () => [{ id: 'ws-y', sessionIds: ['session-2'] }],
      },
    })
    expect(id).toBe('ws-y')
  })

  it('两级都不命中 → undefined（由调用方如实呈现，绝不静默放宽语义）', async () => {
    const id = await resolveWorkspaceIdOfSession('session-3', {
      getSessionCwd: async () => 'D:/nowhere',
      workspaceRegistry: { resolveByPath: async () => undefined, list: () => [{ id: 'ws-z', sessionIds: [] }] },
    })
    expect(id).toBeUndefined()
  })

  it('解析任一侧抛错 → undefined，不向上抛（fail-soft，不阻塞总览）', async () => {
    await expect(
      resolveWorkspaceIdOfSession('session-4', {
        getSessionCwd: async () => {
          throw new Error('sessions unwired')
        },
        workspaceRegistry: {
          resolveByPath: async () => {
            throw new Error('fs gone')
          },
          list: () => {
            throw new Error('boom')
          },
        },
      }),
    ).resolves.toBeUndefined()
  })

  it('workspaceRegistry 未接线（无 list/resolveByPath）→ undefined', async () => {
    await expect(resolveWorkspaceIdOfSession('session-5', { getSessionCwd: async () => 'D:/x' })).resolves.toBeUndefined()
  })

  it('空 sessionId → undefined，且不查询任何来源', async () => {
    const getSessionCwd = vi.fn(async () => 'D:/x')
    expect(await resolveWorkspaceIdOfSession('   ', { getSessionCwd })).toBeUndefined()
    expect(getSessionCwd).not.toHaveBeenCalled()
  })
})
