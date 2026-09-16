/**
 * 配置 Schema 与 apply 双重校验单测（HOST-M1-05）
 *
 * 覆盖：assertConnectionNamesUnique（大小写不敏感唯一，重名清单）、Config 默认值、
 * Schema .pattern() 字符集校验（非法字符/超长）、apply() fail-loud（重名抛错且不注册工具）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, assertConnectionNamesUnique, Config, type ConfigShape } from '../index.js'

const VALID_CONFIG: ConfigShape = {
  defaultConnection: 'prod',
  connections: [
    { name: 'prod', url: 'https://jenkins.example.com', timeout: 30_000 },
    { name: 'test-env_1', url: 'https://test.example.com', username: 'ci', timeout: 30_000 },
  ],
  panel: { defaultWidth: 560 },
  registry: { maxPerSession: 200, ttlDays: 30, pollIntervalMs: 15_000 },
  analysis: { enabled: true, tailLines: 100 },
}

function mockCtx() {
  return {
    tools: { register: vi.fn() },
    credentials: { resolve: vi.fn(async () => ({ value: 'tok' })) },
    webServer: { register: vi.fn() },
    sessions: { get: vi.fn(() => undefined) },
    effect: vi.fn((fn: () => void) => { fn() }),
    // installSettingsSection 内部 ctx.inject(['settings'], cb)——settings 服务未挂载时静默跳过
    inject: vi.fn(() => () => {}),
  } as unknown as Parameters<typeof apply>[0]
}

describe('assertConnectionNamesUnique（大小写不敏感唯一，fail-loud）', () => {
  it('passes when names are unique (case-sensitive distinct)', () => {
    expect(() =>
      assertConnectionNamesUnique([
        { name: 'prod', url: 'u', timeout: 30_000 },
        { name: 'test', url: 'u', timeout: 30_000 },
      ]),
    ).not.toThrow()
  })

  it('throws with the duplicate list for case-insensitive dupes (prod/Prod)', () => {
    expect(() =>
      assertConnectionNamesUnique([
        { name: 'prod', url: 'u', timeout: 30_000 },
        { name: 'Prod', url: 'u', timeout: 30_000 },
      ]),
    ).toThrow(/大小写不敏感重复/)
  })

  it('lists every duplicate group', () => {
    try {
      assertConnectionNamesUnique([
        { name: 'prod', url: 'u', timeout: 30_000 },
        { name: 'PROD', url: 'u', timeout: 30_000 },
        { name: 'dev', url: 'u', timeout: 30_000 },
        { name: 'Dev', url: 'u', timeout: 30_000 },
        { name: 'DEV', url: 'u', timeout: 30_000 },
      ])
      expect.unreachable()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).toContain('[prod / PROD]')
      expect(message).toContain('[dev / Dev / DEV]')
      expect(message).toContain('fail-loud')
    }
  })

  it('passes for empty connections', () => {
    expect(() => assertConnectionNamesUnique([])).not.toThrow()
  })
})

describe('Config（Schemastery Schema：默认值与字符集 pattern）', () => {
  it('fills defaults for all four sections (no token field)', () => {
    const config = Config({} as ConfigShape)
    expect(config.defaultConnection).toBe('default')
    expect(config.connections).toEqual([])
    expect(config.panel.defaultWidth).toBe(560)
    expect(config.registry.maxPerSession).toBe(200)
    expect(config.registry.ttlDays).toBe(30)
    expect(config.registry.pollIntervalMs).toBe(15_000)
    // 失败自动分析：默认开 + 首拉日志 100 行
    expect(config.analysis.enabled).toBe(true)
    expect(config.analysis.tailLines).toBe(100)
    expect('token' in config).toBe(false)
  })

  it('fills timeout default and keeps valid names (incl. dash/underscore)', () => {
    const config = Config(VALID_CONFIG)
    expect(config.connections[0].timeout).toBe(30_000)
    expect(config.connections[1].name).toBe('test-env_1')
    expect(config.connections[1].timeout).toBe(30_000)
  })

  it('rejects names with illegal characters (fail-loud via .pattern())', () => {
    expect(() => Config({ ...VALID_CONFIG, connections: [{ name: 'bad name', url: 'u', timeout: 30_000 }] } as ConfigShape)).toThrow()
    expect(() => Config({ ...VALID_CONFIG, connections: [{ name: 'bad:name', url: 'u', timeout: 30_000 }] } as ConfigShape)).toThrow()
    expect(() => Config({ ...VALID_CONFIG, connections: [{ name: '/lead', url: 'u', timeout: 30_000 }] } as ConfigShape)).toThrow()
  })

  it('rejects names exceeding 32 chars', () => {
    const long = 'a'.repeat(33)
    expect(() => Config({ ...VALID_CONFIG, connections: [{ name: long, url: 'u', timeout: 30_000 }] } as ConfigShape)).toThrow()
    // 32 字符边界合法
    expect(() => Config({ ...VALID_CONFIG, connections: [{ name: 'a'.repeat(32), url: 'u', timeout: 30_000 }] } as ConfigShape)).not.toThrow()
  })
})

describe('apply()（双重校验 + 完整接线）', () => {
  let dir: string
  beforeEach(async () => {
    // 隔离 DSH_HOME，避免读到真实环境已持久化的 settings.json 影响校验结果
    dir = await mkdtemp(join(tmpdir(), 'dsh-jenkins-panel-cfg-'))
    vi.stubEnv('DSH_HOME', dir)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('accepts valid config and registers tools + routes', async () => {
    const ctx = mockCtx()
    await expect(apply(ctx, VALID_CONFIG)).resolves.toBeUndefined()
    expect(ctx.tools.register).toHaveBeenCalled()
    expect(ctx.webServer.register).toHaveBeenCalled()
  })

  it('fails loud on case-insensitive duplicate names before registering tools', async () => {
    const ctx = mockCtx()
    const dupConfig: ConfigShape = {
      ...VALID_CONFIG,
      connections: [
        { name: 'prod', url: 'u', timeout: 30_000 },
        { name: 'Prod', url: 'u', timeout: 30_000 },
      ],
    }
    await expect(apply(ctx, dupConfig)).rejects.toThrow(/大小写不敏感重复/)
    expect(ctx.tools.register).not.toHaveBeenCalled()
    expect(ctx.webServer.register).not.toHaveBeenCalled()
  })
})
