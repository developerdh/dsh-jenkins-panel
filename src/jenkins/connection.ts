/**
 * 连接层（docs/architecture.md §2.2/§6、interface-and-data-model.md §2.1）
 *
 * 职责：
 * - 连接元数据 = 端点配置（name/url/username/timeout），**不含 token**；
 * - token 走 dsh 凭据服务 credential-ref（V4 方案 A，用户决策 D4）：
 *   ref 名 = `JENKINS_TOKEN_<NAME>`（refOf：连接名大写化、`-`→`_`），
 *   取 token 一律 `ctx.credentials.resolve(credentialRef(refOf(name)))?.value`；
 * - `clientFor(registry, credentials, name?)` → 带认证的 JenkinsClient（默认连接兜底），
 *   无 token 抛 NoCredentialError——「AI 无需先切换即可读指定连接」的核心解法；
 * - `listConnections(registry, credentials)` → conn.list 数据源（名称/isDefault/hasToken，
 *   经 describe() 判 hasToken，永不暴露凭据值）。
 *
 * 连接名规范（`^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$` + 大小写不敏感唯一）的 Schema 与
 * apply() 双重 fail-loud 校验归 HOST-M1-05；本层只做 refOf 派生（幂等），
 * refOf 输出恒以 `JENKINS_TOKEN_` 开头且仅含 [A-Z0-9_]，满足 credential-ref 文法
 * （credentialRef() 运行时校验，派生结果安全）。
 */
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'

import { JenkinsClient } from './client.js'

/** 连接元数据 = 端点配置（token 不在此；凭据走 credential-ref，见 architecture §6） */
export interface JenkinsConnectionMeta {
  name: string
  url: string
  username?: string
  timeout: number
}

/** 凭据 ref 名派生（V4 方案 A）：`JENKINS_TOKEN_` + 连接名大写化 + `-`→`_`（幂等） */
export function refOf(name: string): string {
  return `JENKINS_TOKEN_${name.toUpperCase().replace(/-/g, '_')}`
}

/** 连接未配置/未找到（resolve 兜底失败；文案含连接名，提示检查参数或配置） */
export class UnknownConnectionError extends Error {
  constructor(name: string) {
    super(`未找到连接 "${name}"：请检查 connection 参数拼写或插件配置 connections 列表`)
    this.name = 'UnknownConnectionError'
  }
}

/** 连接存在但未配置 Token（凭据缺失；文案含连接名与 ref，提示去设置页写入） */
export class NoCredentialError extends Error {
  constructor(name: string) {
    super(`连接 "${name}" 未配置 API Token：请到设置页「Jenkins 连接」为凭据 ${refOf(name)} 设置 Token（credential-ref，V4 方案 A）`)
    this.name = 'NoCredentialError'
  }
}

/** createConnectionRegistry 输入（Config 的连接相关子集；panel/registry 等与本层无关） */
export interface ConnectionRegistryConfig {
  defaultConnection: string
  connections: readonly JenkinsConnectionMeta[]
}

/** 连接注册表：只含端点元数据（无 token），提供 resolve/has/reload */
export interface ConnectionRegistry {
  readonly defaultConnection: string
  readonly connections: readonly JenkinsConnectionMeta[]
  /** 按名解析连接；缺省/空白走默认连接；未找到抛 UnknownConnectionError */
  resolve(name?: string): JenkinsConnectionMeta
  has(name: string): boolean
  /** 运行时刷新（设置保存后调用，使新增/编辑/删除立即生效；CLIENT-M2-07 修复） */
  reload(cfg: ConnectionRegistryConfig): void
}

/** 构造连接注册表（名称唯一性等双重校验由 HOST-M1-05 在 apply() 负责） */
export function createConnectionRegistry(config: ConnectionRegistryConfig): ConnectionRegistry {
  let connections = [...config.connections]
  let defaultConnection = config.defaultConnection
  return {
    get defaultConnection() {
      return defaultConnection
    },
    get connections() {
      return connections
    },
    resolve(name) {
      const target = (name ?? '').trim() || defaultConnection
      const found = connections.find((c) => c.name === target)
      if (!found) throw new UnknownConnectionError(target)
      return found
    },
    has(name) {
      return connections.some((c) => c.name === name)
    },
    reload(cfg) {
      connections = [...cfg.connections]
      defaultConnection = cfg.defaultConnection
    },
  }
}

/** 凭据解析面（取 token 用；只依赖 resolve，便于单测注入） */
export type CredentialResolver = Pick<CredentialProvider, 'resolve'>

/** 凭据描述面（conn.list 判 hasToken 用；describe 永不暴露值） */
export type CredentialDescriber = Pick<CredentialProvider, 'describe'>

/**
 * clientFor：解析连接（默认兜底）→ 凭据 ref 取 token → 组装 JenkinsClient。
 * 无 token 抛 NoCredentialError（文案含连接名）；token 不进模型上下文/配置/日志。
 *
 * 签名说明（实现期）：architecture §2.2 记为 `clientFor(registry, name?)`（ctx 闭包捕获）；
 * 本实现将凭据面显式注入为第二参，签名 = `clientFor(registry, credentials, name?)`，
 * 调用方（M1-06/07/09）以 `clientFor(registry, ctx.credentials, name)` 使用。
 */
export async function clientFor(
  registry: ConnectionRegistry,
  credentials: CredentialResolver,
  name?: string,
): Promise<JenkinsClient> {
  const target = registry.resolve(name)
  const resolved = await credentials.resolve(credentialRef(refOf(target.name)))
  const token = resolved?.value
  if (!token) throw new NoCredentialError(target.name)
  return new JenkinsClient({
    url: target.url,
    username: target.username,
    token,
    timeout: target.timeout,
  })
}

/** conn.list 数据源条目（仅名称/是否默认/是否有 Token；不含 URL/凭据） */
export interface ConnectionSummary {
  name: string
  isDefault: boolean
  hasToken: boolean
}

/**
 * conn.list 数据源：逐连接 describe()（不暴露值）判 hasToken。
 * 供 CLIENT-M2-04 连接切换器与 HOST-M1-09 conn.list 路由复用。
 */
export async function listConnections(
  registry: ConnectionRegistry,
  credentials: CredentialDescriber,
): Promise<ConnectionSummary[]> {
  const out: ConnectionSummary[] = []
  for (const conn of registry.connections) {
    const info = await credentials.describe(credentialRef(refOf(conn.name)))
    out.push({
      name: conn.name,
      isDefault: conn.name === registry.defaultConnection,
      hasToken: info.configured,
    })
  }
  return out
}
