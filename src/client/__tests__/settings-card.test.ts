/**
 * 设置卡片纯函数单测（CLIENT-M2-07 阶段 7）
 *
 * 覆盖：连接名校验（与 host Schema.pattern + assertConnectionNamesUnique **同源规则**）、
 * 表单整体校验（URL/新增 Token 必填/timeout 回落）、凭据 ref 预览（镜像 host refOf）、
 * 删除连接的凭据清理判定与文案（方案 A：只读层不 unset、unset 后必须复核）。
 */
import { describe, expect, it } from 'vitest'

import { credentialRefOf } from '../api.js'
import {
  connectionKeyPreview,
  credentialCleanupPlan,
  credentialPreNote,
  credentialRemovalNote,
  credentialSourceLabel,
  sanitizeConnectionName,
  validateConnectionName,
  validateSettingsForm,
} from '../settings-card.js'

describe('validateConnectionName（与 host 双重校验同源规则）', () => {
  const existing = ['prod', 'test-env_1']

  it('accepts valid names (incl. dash/underscore)', () => {
    expect(validateConnectionName('new-conn', existing, null)).toBeNull()
    expect(validateConnectionName('test-env_2', existing, null)).toBeNull()
  })

  it('rejects empty / illegal chars / overlong', () => {
    expect(validateConnectionName('', existing, null)).toContain('请填写')
    expect(validateConnectionName('bad name', existing, null)).toContain('仅允许')
    expect(validateConnectionName('bad:name', existing, null)).toContain('仅允许')
    expect(validateConnectionName('a'.repeat(33), existing, null)).toContain('仅允许')
  })

  it('rejects case-insensitive duplicates with the dup name', () => {
    expect(validateConnectionName('PROD', existing, null)).toContain('大小写不敏感')
  })

  it('allows the editing connection itself', () => {
    expect(validateConnectionName('prod', existing, 'prod')).toBeNull()
  })
})

describe('validateSettingsForm', () => {
  const base = {
    name: 'prod',
    url: 'https://jenkins.example.com',
    username: '',
    timeout: 30_000,
    token: '',
    clearToken: false,
    editing: null as string | null,
    existingNames: ['test'],
  }

  it('new connection requires token', () => {
    const res = validateSettingsForm(base)
    expect(res.error).toContain('Token')
  })

  it('rejects non-http(s) URL and normalizes timeout (min 1000, fallback 30000)', () => {
    const withToken = { ...base, token: 'tok' }
    expect(validateSettingsForm({ ...withToken, url: 'ftp://x' }).error).toContain('http(s)')
    expect(validateSettingsForm({ ...withToken, timeout: 200 }).value?.timeout).toBe(1000)
    expect(validateSettingsForm({ ...withToken, timeout: Number.NaN }).value?.timeout).toBe(30_000)
  })

  it('passes and normalizes the value (username optional)', () => {
    const res = validateSettingsForm({ ...base, token: 'tok', username: ' ci ', timeout: 60_000 })
    expect(res.error).toBeNull()
    expect(res.value).toEqual({ name: 'prod', url: 'https://jenkins.example.com', username: 'ci', timeout: 60_000 })
  })

  it('editing allows empty token (keep unchanged)', () => {
    const res = validateSettingsForm({ ...base, editing: 'prod' })
    expect(res.error).toBeNull()
  })
})

describe('credentialRefOf / connectionKeyPreview（镜像 host refOf，V4 方案 A）', () => {
  it('derives ref: uppercase + dash to underscore', () => {
    expect(credentialRefOf('prod')).toBe('JENKINS_TOKEN_PROD')
    expect(credentialRefOf('test-env')).toBe('JENKINS_TOKEN_TEST_ENV')
  })

  it('key preview falls back to placeholder for empty name', () => {
    expect(connectionKeyPreview('')).toBe('JENKINS_TOKEN_—')
    expect(connectionKeyPreview('test-env')).toBe('JENKINS_TOKEN_TEST_ENV')
  })
})

describe('sanitizeConnectionName（CLIENT-M2-07 修复：名称输入白名单 + 截断）', () => {
  it('strips characters outside [A-Za-z0-9_-] and caps at 32', () => {
    expect(sanitizeConnectionName('prod')).toBe('prod')
    expect(sanitizeConnectionName('业务说明：-- ID,PID... SQL 脚本')).toBe('IDPIDSQL')
    expect(sanitizeConnectionName('A'.repeat(40))).toHaveLength(32)
    expect(sanitizeConnectionName('my-conn_1')).toBe('my-conn_1')
  })

  it('connectionKeyPreview stays single-line & capped for junk input', () => {
    const preview = connectionKeyPreview('业务说明：-- ID,PID\nSQL 脚本 内容很长')
    expect(preview).not.toMatch(/\n/)
    expect(preview.startsWith('JENKINS_TOKEN_')).toBe(true)
  })
})

describe('credentialCleanupPlan（删除连接时的凭据处置判定，方案 A）', () => {
  it('未配置 → none（provider 对不存在 ref 的 unset 本身就是 no-op）', () => {
    expect(credentialCleanupPlan(undefined)).toBe('none')
    expect(credentialCleanupPlan({ configured: false, writable: true })).toBe('none')
  })

  it('启动环境变量提供（writable:false）→ none：对该层 unset 会被 provider 拒绝，不能调用', () => {
    expect(credentialCleanupPlan({ configured: true, source: 'env', writable: false })).toBe('none')
  })

  it('可写层（存储/.env 兜底）→ unset：是否真删由 unset 后的 describe 复核决定', () => {
    expect(credentialCleanupPlan({ configured: true, source: 'file', writable: true })).toBe('unset')
    expect(credentialCleanupPlan({ configured: true, source: 'project-env', writable: true })).toBe('unset')
  })
})

describe('credentialSourceLabel（provider 来源词表 → 中文层名）', () => {
  it('maps env / project-env / user-env and falls back to the managed store', () => {
    expect(credentialSourceLabel('env')).toBe('启动环境变量')
    expect(credentialSourceLabel('project-env')).toBe('项目 .env')
    expect(credentialSourceLabel('user-env')).toBe('$DSH_HOME/.env')
    expect(credentialSourceLabel('file')).toBe('凭据存储')
    expect(credentialSourceLabel(undefined)).toBe('凭据存储')
  })
})

describe('credentialPreNote（不执行 unset 时的理由；空串 = 交给复核措辞）', () => {
  it('状态未知 / 本未设置 / 只读层各说各话', () => {
    expect(credentialPreNote('JENKINS_TOKEN_PROD', undefined)).toContain('状态未知')
    expect(credentialPreNote('JENKINS_TOKEN_PROD', { configured: false, writable: true })).toContain('本未设置')
    const envNote = credentialPreNote('JENKINS_TOKEN_PROD', { configured: true, source: 'env', writable: false })
    expect(envNote).toContain('启动环境变量')
    expect(envNote).toContain('请自行清理')
  })

  it('可写层 → 空串（先 unset 再按复核结果措辞，不得提前宣称成功）', () => {
    expect(credentialPreNote('JENKINS_TOKEN_PROD', { configured: true, source: 'file', writable: true })).toBe('')
  })
})

describe('credentialRemovalNote（unset 后复核：静默 no-op 不得说成已删除）', () => {
  it('复核为未配置 → 空串（唯一可以说「已一并清理」的情形）', () => {
    expect(credentialRemovalNote('JENKINS_TOKEN_PROD', { configured: false, writable: true })).toBe('')
  })

  it('复核失败 → 如实说「未能复核」，不假定已删', () => {
    expect(credentialRemovalNote('JENKINS_TOKEN_PROD', undefined)).toContain('未能复核')
  })

  it('仍 configured → 必须给出「仍在、需自行清理」，任何来源层都不例外', () => {
    for (const source of ['env', 'file', 'project-env', 'user-env', undefined]) {
      const note = credentialRemovalNote('JENKINS_TOKEN_TEST_ENV', { configured: true, source, writable: true })
      expect(note, `source=${String(source)}`).toContain('请自行清理')
      expect(note).toContain('JENKINS_TOKEN_TEST_ENV')
    }
  })
})
