/**
 * 连接层单测（HOST-M1-03）
 *
 * 覆盖：refOf 派生、registry resolve（默认兜底/显式/未找到/has）、
 * clientFor（token 组装、无 token 抛 NoCredentialError、未找到连接）、
 * listConnections（hasToken 经 describe、isDefault）。
 * client 模块用 vi.mock 替换（只验证 connection 层的接线与参数组装）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'

const { MockJenkinsClient } = vi.hoisted(() => ({ MockJenkinsClient: vi.fn() }))

vi.mock('../client.js', () => ({ JenkinsClient: MockJenkinsClient }))

import {
  NoCredentialError,
  UnknownConnectionError,
  clientFor,
  createConnectionRegistry,
  listConnections,
  refOf,
  type JenkinsConnectionMeta,
} from '../connection.js'

const config = {
  defaultConnection: 'prod',
  connections: [
    { name: 'prod', url: 'https://jenkins.example.com', username: 'bot', timeout: 30_000 },
    { name: 'test-env', url: 'https://test.jenkins.example.com', timeout: 60_000 },
  ] satisfies JenkinsConnectionMeta[],
}

function registry() {
  return createConnectionRegistry(config)
}

function credentialsResolving(value: string | undefined) {
  return {
    resolve: vi.fn(async () => (value === undefined ? undefined : { value, source: 'env' })),
  } as unknown as Pick<CredentialProvider, 'resolve'>
}

function credentialsDescribing(configuredRefs: string[]) {
  return {
    describe: vi.fn(async (ref: string) => ({
      configured: configuredRefs.includes(ref),
      source: configuredRefs.includes(ref) ? 'env' : undefined,
      writable: true,
    })),
  } as unknown as Pick<CredentialProvider, 'describe'>
}

describe('refOf（V4 方案 A 派生）', () => {
  it.each([
    ['prod', 'JENKINS_TOKEN_PROD'],
    ['test-env', 'JENKINS_TOKEN_TEST_ENV'],
    ['My-Conn', 'JENKINS_TOKEN_MY_CONN'],
    ['default', 'JENKINS_TOKEN_DEFAULT'],
  ])('derives %s → %s', (name, ref) => {
    expect(refOf(name)).toBe(ref)
  })
})

describe('createConnectionRegistry', () => {
  it('registry holds endpoint metadata only (no token field)', () => {
    const r = registry()
    expect(r.connections).toHaveLength(2)
    expect(r.connections[0]).toEqual({ name: 'prod', url: 'https://jenkins.example.com', username: 'bot', timeout: 30_000 })
    expect('token' in r.connections[0]).toBe(false)
  })

  it('resolve falls back to defaultConnection (undefined/blank)', () => {
    const r = registry()
    expect(r.resolve().name).toBe('prod')
    expect(r.resolve('').name).toBe('prod')
    expect(r.resolve('   ').name).toBe('prod')
  })

  it('resolve finds explicit connection', () => {
    const r = registry()
    expect(r.resolve('test-env').url).toBe('https://test.jenkins.example.com')
  })

  it('resolve throws UnknownConnectionError with the missing name', () => {
    const r = registry()
    expect(() => r.resolve('nope')).toThrow(UnknownConnectionError)
    expect(() => r.resolve('nope')).toThrow(/未找到连接 "nope"/)
  })

  it('has() reports presence', () => {
    const r = registry()
    expect(r.has('prod')).toBe(true)
    expect(r.has('nope')).toBe(false)
  })
})

describe('clientFor', () => {
  beforeEach(() => {
    MockJenkinsClient.mockClear()
  })

  it('resolves token via credential-ref and constructs JenkinsClient', async () => {
    const credentials = credentialsResolving('tok-123')
    const client = await clientFor(registry(), credentials)
    expect(client).toBeDefined()
    expect(credentials.resolve).toHaveBeenCalledWith('JENKINS_TOKEN_PROD')
    expect(MockJenkinsClient).toHaveBeenCalledWith({
      url: 'https://jenkins.example.com',
      username: 'bot',
      token: 'tok-123',
      timeout: 30_000,
    })
  })

  it('uses explicit connection (default not consulted)', async () => {
    const credentials = credentialsResolving('tok-test')
    await clientFor(registry(), credentials, 'test-env')
    expect(credentials.resolve).toHaveBeenCalledWith('JENKINS_TOKEN_TEST_ENV')
    expect(MockJenkinsClient).toHaveBeenCalledWith({
      url: 'https://test.jenkins.example.com',
      token: 'tok-test',
      timeout: 60_000,
    })
  })

  it('throws NoCredentialError with connection name when token missing', async () => {
    const credentials = credentialsResolving(undefined)
    const promise = clientFor(registry(), credentials, 'test-env')
    await expect(promise).rejects.toThrow(NoCredentialError)
    await expect(promise).rejects.toThrow(/未配置 API Token/)
    await expect(promise).rejects.toThrow(/test-env/)
    await expect(promise).rejects.toThrow(/JENKINS_TOKEN_TEST_ENV/)
    expect(MockJenkinsClient).not.toHaveBeenCalled()
  })

  it('throws UnknownConnectionError for missing connection', async () => {
    const credentials = credentialsResolving('tok')
    await expect(clientFor(registry(), credentials, 'nope')).rejects.toThrow(UnknownConnectionError)
    expect(MockJenkinsClient).not.toHaveBeenCalled()
  })
})

describe('listConnections（conn.list 数据源）', () => {
  it('reports name/isDefault/hasToken without exposing values', async () => {
    const credentials = credentialsDescribing(['JENKINS_TOKEN_PROD'])
    const list = await listConnections(registry(), credentials)
    expect(list).toEqual([
      { name: 'prod', isDefault: true, hasToken: true },
      { name: 'test-env', isDefault: false, hasToken: false },
    ])
    expect(credentials.describe).toHaveBeenCalledTimes(2)
  })
})
