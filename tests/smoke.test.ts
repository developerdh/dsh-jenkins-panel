import { describe, expect, it } from 'vitest'

import { apply, Config, inject, name, type ConfigShape } from '../src/index.js'

describe('dsh-jenkins-panel host entry (HOST-M1-01 scaffold smoke)', () => {
  it('exports plugin identity', () => {
    expect(name).toBe('dsh-jenkins-panel')
    expect(typeof apply).toBe('function')
  })

  it('declares host service injections (tools + credentials)', () => {
    expect(Array.isArray(inject)).toBe(true)
    expect(inject).toContain('tools')
    expect(inject).toContain('credentials')
  })

  it('Config schema applies defaults and carries no token fields', () => {
    // 部分输入（{}）由 schemastery 在运行时补全默认值；此处仅验证默认值形态
    const config = Config({} as ConfigShape)
    expect(config.defaultConnection).toBe('default')
    expect(config.connections).toEqual([])
    expect(config.panel.defaultWidth).toBe(560)
    expect(config.registry.maxPerSession).toBe(200)
    expect(config.registry.ttlDays).toBe(30)
    expect(config.registry.pollIntervalMs).toBe(15_000)
    // token 不入 Config（凭据走 ctx.credentials credential-ref，architecture §6）
    expect('token' in config).toBe(false)
  })
})
