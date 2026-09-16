/**
 * 设置卡片纯函数单测（CLIENT-M2-07 阶段 7）
 *
 * 覆盖：连接名校验（与 host Schema.pattern + assertConnectionNamesUnique **同源规则**）、
 * 表单整体校验（URL/新增 Token 必填/timeout 回落）、凭据 ref 预览（镜像 host refOf）。
 */
import { describe, expect, it } from 'vitest'

import { credentialRefOf } from '../api.js'
import { connectionKeyPreview, sanitizeConnectionName, validateConnectionName, validateSettingsForm } from '../settings-card.js'

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
