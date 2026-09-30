/**
 * 插件页配置接入单测（0.2.0 plugins.* 槽位）
 *
 * 覆盖（纯函数口径，与工程测试风格一致）：
 * - pageModeOf 渲染模式归约（summary / native / fallback 的全部分支）；
 * - 槽位 key 形状（row = `<包名>#<rowId>`，rowId 与 cordis.patch.yml 的 insert id 同源）；
 * - Config section 值的容错提取（settingsOfSection/analysisEnabledOf）；
 * - 根 set op 构建（sectionSetOp：保留未编辑字段、覆盖连接与 analysis.enabled）；
 * - 摘要文案（summaryTextOf：连接数/默认连接/分析开关；section 未知 → 中性能力描述）。
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  BUNDLE_CONFIG_SLOT,
  PLUGIN_ENTRY_ID,
  PLUGIN_PACKAGE_NAME,
  ROW_CONFIG_KEY,
  ROW_CONFIG_SLOT,
  pageModeOf,
} from '../plugin-page-config.js'
import { analysisEnabledOf, sectionSetOp, settingsOfSection, summaryTextOf } from '../settings-card.js'

describe('pageModeOf（page 渲染模式归约）', () => {
  it('非 page 视图 → summary（含 undefined/null props）', () => {
    expect(pageModeOf(undefined)).toBe('summary')
    expect(pageModeOf(null)).toBe('summary')
    expect(pageModeOf({ view: 'summary', form: undefined })).toBe('summary')
  })

  it('page + 快照就绪 → native（宿主表单通路）', () => {
    expect(pageModeOf({ view: 'page', form: { state: { status: 'ready' } } })).toBe('native')
  })

  it('page + form 缺席/unavailable/loading → fallback（路由通路降级，不再有不可写死胡同）', () => {
    expect(pageModeOf({ view: 'page' })).toBe('fallback')
    expect(pageModeOf({ view: 'page', form: undefined })).toBe('fallback')
    expect(pageModeOf({ view: 'page', form: { state: { status: 'unavailable' } } })).toBe('fallback')
    expect(pageModeOf({ view: 'page', form: { state: { status: 'loading' } } })).toBe('fallback')
    expect(pageModeOf({ view: 'page', form: { state: {} } })).toBe('fallback')
  })
})

describe('槽位 key 形状', () => {
  it('bundle 槽位 key = 包名；row 槽位 key = `<包名>#<rowId>`（rowId = cordis.patch.yml insert id）', () => {
    expect(BUNDLE_CONFIG_SLOT).toBe('plugins.bundle.config')
    expect(ROW_CONFIG_SLOT).toBe('plugins.row.config')
    expect(PLUGIN_PACKAGE_NAME).toBe('dsh-jenkins-panel')
    expect(PLUGIN_ENTRY_ID).toBe('@developerdh/dsh-jenkins-panel')
    expect(ROW_CONFIG_KEY).toBe('dsh-jenkins-panel#@developerdh/dsh-jenkins-panel')
  })

  it('守卫：PLUGIN_ENTRY_ID 与 cordis.patch.yml 声明的 insert id 同源（改名漏一处即失败）', () => {
    // 宿主按 patch 的行 id 组装 `plugins.row.config` 的 key；两处漂移会让该行的「配置」入口消失。
    const patch = readFileSync(new URL('../../../cordis.patch.yml', import.meta.url), 'utf8')
    const declared = [...patch.matchAll(/^\s*-\s*id:\s*(.+?)\s*$/gm)].map((m) => m[1].replace(/^['"]|['"]$/g, ''))
    expect(declared).toEqual([PLUGIN_ENTRY_ID])
  })
})

describe('settingsOfSection（Config section 容错提取）', () => {
  it('undefined / 非对象字段 → 全默认', () => {
    expect(settingsOfSection(undefined)).toEqual({ defaultConnection: '', connections: [] })
    expect(settingsOfSection({ connections: 'not-array', defaultConnection: 42 })).toEqual({
      defaultConnection: '',
      connections: [],
    })
  })

  it('逐项容错：非法条目剔除，timeout 非法回落 30000，username 非字符串剔除', () => {
    expect(
      settingsOfSection({
        defaultConnection: 'prod',
        connections: [
          { name: 'prod', url: 'https://a', username: 'u', timeout: 5000 },
          { name: '', url: 'https://b' },
          'garbage',
          null,
          { url: 'https://c' },
          { name: 'dev', url: 'https://d', timeout: Number.NaN },
        ],
      }),
    ).toEqual({
      defaultConnection: 'prod',
      connections: [
        { name: 'prod', url: 'https://a', username: 'u', timeout: 5000 },
        { name: 'dev', url: 'https://d', username: undefined, timeout: 30_000 },
      ],
    })
  })
})

describe('analysisEnabledOf（缺省 true 与 host Schema 默认一致）', () => {
  it('缺省/非对象/非布尔 → true；显式 false → false', () => {
    expect(analysisEnabledOf(undefined)).toBe(true)
    expect(analysisEnabledOf({})).toBe(true)
    expect(analysisEnabledOf({ analysis: 'x' })).toBe(true)
    expect(analysisEnabledOf({ analysis: { enabled: false } })).toBe(false)
    expect(analysisEnabledOf({ analysis: { enabled: 'no' } })).toBe(true)
  })
})

describe('sectionSetOp（整段根 set：保留未编辑字段）', () => {
  it('op 形状：set + 空 path（section 根）', () => {
    const op = sectionSetOp(undefined, { defaultConnection: 'a', connections: [], analysisEnabled: true })
    expect(op.op).toBe('set')
    expect(op.path).toEqual([])
  })

  it('保留 section 其余字段（panel/registry），覆盖连接字段与 analysis.enabled', () => {
    const section = {
      defaultConnection: 'old',
      connections: [{ name: 'old', url: 'https://old', timeout: 1 }],
      panel: { defaultWidth: 560 },
      registry: { maxPerSession: 200, ttlDays: 30, pollIntervalMs: 15_000 },
      analysis: { enabled: true, tailLines: 100 },
    }
    const op = sectionSetOp(section, {
      defaultConnection: 'prod',
      connections: [{ name: 'prod', url: 'https://prod', timeout: 30_000 }],
      analysisEnabled: false,
    })
    expect(op.value).toEqual({
      defaultConnection: 'prod',
      connections: [{ name: 'prod', url: 'https://prod', timeout: 30_000 }],
      panel: { defaultWidth: 560 },
      registry: { maxPerSession: 200, ttlDays: 30, pollIntervalMs: 15_000 },
      analysis: { enabled: false, tailLines: 100 },
    })
  })

  it('section 缺席时以空对象为底（analysis 只含 enabled）', () => {
    const op = sectionSetOp(undefined, { defaultConnection: '', connections: [], analysisEnabled: true })
    expect(op.value).toEqual({ defaultConnection: '', connections: [], analysis: { enabled: true } })
  })
})

describe('summaryTextOf（view: summary 一行摘要）', () => {
  it('section 未知（form 缺席）→ 中性能力描述，不臆断连接数', () => {
    expect(summaryTextOf(undefined)).toBe('管理 Jenkins 连接、默认连接与失败自动分析')
  })

  it('无连接 → 「尚未配置连接」；有连接 → 数量 + 默认名 + 分析状态', () => {
    expect(summaryTextOf({})).toContain('尚未配置连接')
    expect(summaryTextOf({ defaultConnection: 'prod', connections: [{ name: 'prod', url: 'u', timeout: 1 }] })).toContain(
      '1 个连接（默认 prod）',
    )
    expect(summaryTextOf({ defaultConnection: '', connections: [{ name: 'prod', url: 'u', timeout: 1 }] })).toContain(
      '默认 未设',
    )
    const on = summaryTextOf({ connections: [] })
    const off = summaryTextOf({ connections: [], analysis: { enabled: false } })
    expect(on).toContain('失败自动分析开')
    expect(off).toContain('失败自动分析关')
  })
})
