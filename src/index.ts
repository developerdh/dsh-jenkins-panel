/**
 * dsh-jenkins-panel host 入口（docs/architecture.md §2.1/§6）
 *
 * - `Config`：Schemastery Schema（defaultConnection/connections/panel/registry/analysis 五段，
 *   HOST-M1-01 落地；连接名字符集由 `.pattern()` 校验，fail-loud）；
 * - `assertConnectionNamesUnique`：连接名**大小写不敏感唯一**校验（fail-loud，重名清单）；
 * - `apply()`（FIN-M3-01 完整接线）：① 唯一性校验 → ② `createConnectionRegistry`（M1-03）
 *   → ③ `clientFor` 绑定 → ④ 触发记录注册表（createTriggerRegistry，数据目录 = `$DSH_HOME`，
 *   见 HOST-M1-08 变更记录：ctx.baseDir 非标准键，profile 数据目录经 DSH_HOME 计算）
 *   → ⑤ `registerJenkinsTools`（triggerRegistry 接线：build_trigger/retry 写总览记录）
 *   → ⑥ `registerJenkinsRoutes`（/jenkins/api/*：面板取数 + session.cwd 最佳努力接线）
 *   → ⑦ 设置持久化（V5 路径 1）；
 *   失败自动分析（analysis.enabled 默认开）：ctx.agents 回推触发会话，注册表 onBuildFailed
 *   → failure-analysis.handle → agent.followup 注入分析任务书（见 jenkins/failure-analysis.ts）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { loadSettings, saveSettings, settingsFile, type SavedSettings } from './jenkins/settings.js'

import { clientFor, createConnectionRegistry, listConnections, type JenkinsConnectionMeta } from './jenkins/connection.js'
import { createFailureAnalysis, type AnalysisAgentLike } from './jenkins/failure-analysis.js'
import { migrateLegacyDataDir } from './jenkins/legacy-migration.js'
import { createTriggerRegistry, registryFile, type TriggerRecord } from './jenkins/registry.js'
import { resolveWorkspaceIdOfSession, type WorkspaceRegistryLike } from './jenkins/workspace-resolve.js'
import { registerJenkinsRoutes } from './routes.js'
import { registerJenkinsTools } from './tools/index.js'

export const name = 'dsh-jenkins-panel'

/**
 * host 依赖注入（服务键均已在 dsh 0.1.1-rc.2 实测存在）：
 * - tools：@deepseek-ai/dsh-tools 提供的 ctx.tools（defineTool 注册表）
 * - credentials：@deepseek-ai/dsh-credentials 提供的 ctx.credentials（V4 方案 A：resolve(ref) 取 token）
 * - webServer：@deepseek-ai/dsh-host-webserver 提供的 ctx.webServer（/jenkins/api/* 路由；
 *   architecture §2.1 记 'http' 不存在，实测键为 webServer——HOST-M1-01 勘误）
 * - sessions：@deepseek-ai/dsh-session 提供的 ctx.sessions（session.cwd 取当前会话工作目录）
 * - workspaceRegistry：@deepseek-ai/dsh-workspace 提供的 ctx.workspaceRegistry（工作区 id/名解析）
 * - agents：dsh core agent 注册表 ctx.agents（失败自动分析回推触发会话用；
 *   服务缺失时分析功能降级为跳过，不影响插件其余能力）
 */
export const inject = ['tools', 'credentials', 'webServer', 'sessions', 'workspaceRegistry', 'agents']

/** profile 数据目录（HOST-M1-08 口径：ctx.baseDir 非标准键；经 DSH_HOME 计算，与 dsh-home-paths 默认一致） */
function profileDataDir(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 插件配置形状（token 不入 Config；凭据走 ctx.credentials，见 architecture §6） */
export interface ConfigShape {
  defaultConnection: string
  connections: JenkinsConnectionMeta[]
  panel: {
    defaultWidth: number
  }
  registry: {
    maxPerSession: number
    ttlDays: number
    pollIntervalMs: number
  }
  analysis: {
    /** 失败自动分析总开关（默认开；同时控制注册表轮询常驻 watchAlways） */
    enabled: boolean
    /** 初始拉取日志的行数提示（注入会话的分析任务书带给模型） */
    tailLines: number
  }
}

/** 配置即 Schemastery Schema：非法配置 fail-loud（architecture §2.1/§6 双重校验之一：字符集） */
export const Config: Schema<ConfigShape> = Schema.object({
  defaultConnection: Schema.string().default('default'),
  connections: Schema.array(
    Schema.object({
      // 连接名 = 凭据 ref 名派生的一部分（JENKINS_TOKEN_<NAME>，V4 方案 A），必须符合命名规范。
      // 注：schemastery 3.18.1 的 .pattern() 仅接受 RegExp（无自定义 message 参数），
      // fail-loud 文案由 assertConnectionNamesUnique 与 Schema 校验共同承担（HOST-M1-01 勘误）。
      name: Schema.string()
        .pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/)
        .required(),
      url: Schema.string().required(),
      username: Schema.string(),
      timeout: Schema.number().default(30_000),
    }),
  ).default([]),
  // 面板（client 半读取）；对象字段默认值由 schemastery 自动填充（无需 .default({})）
  panel: Schema.object({
    defaultWidth: Schema.number().default(560), // 面板默认宽度 px（可拖动调宽并持久化）
  }),
  // 触发记录注册表（host 半）
  registry: Schema.object({
    maxPerSession: Schema.number().default(200), // 每会话最多保留的触发记录条数
    ttlDays: Schema.number().default(30), // 记录保留天数（超期清理）
    pollIntervalMs: Schema.number().default(15_000), // 在途记录（排队/构建中）状态轮询间隔
  }),
  // 构建失败自动分析（host 半：回推触发会话，见 jenkins/failure-analysis.ts）
  analysis: Schema.object({
    enabled: Schema.boolean().default(true), // 默认开：失败后自动在触发会话里分析原因
    tailLines: Schema.number().default(100), // 分析任务书建议的首拉日志行数
  }),
})

/**
 * 连接名大小写不敏感唯一校验（双重校验之二；architecture §6）。
 * `prod` 与 `Prod` 视为重名（大小写不敏感唯一）——连接名参与凭据 ref 派生
 * （`JENKINS_TOKEN_<NAME>`，V4 方案 A）与 URL/conn.list，必须唯一。
 * @throws 发现重名时抛错，文案含全部重名清单（fail-loud，供用户修正）
 */
export function assertConnectionNamesUnique(connections: readonly JenkinsConnectionMeta[]): void {
  const seen = new Map<string, string[]>()
  for (const conn of connections) {
    const key = conn.name.toLowerCase()
    const list = seen.get(key) ?? []
    list.push(conn.name)
    seen.set(key, list)
  }
  const dupes = [...seen.values()].filter((list) => list.length > 1)
  if (dupes.length > 0) {
    const detail = dupes.map((list) => `[${list.join(' / ')}]`).join('、')
    throw new Error(
      `连接名大小写不敏感重复：${detail}。连接名参与凭据 ref 派生（JENKINS_TOKEN_<NAME>）与 URL/conn.list，必须唯一（fail-loud）`,
    )
  }
}

/** 有效连接设置：持久化文件优先（跨重启保留），无文件回退插件的 composition Config */
function effectiveSettings(config: ConfigShape, saved: SavedSettings | null): SavedSettings {
  return saved ?? {
    defaultConnection: config.defaultConnection,
    connections: config.connections,
  }
}

export async function apply(ctx: Context, config: ConfigShape): Promise<void> {
  // ⓪ 旧数据目录一次性迁移（包名 dsh-jenkins → dsh-jenkins-panel；必须在任何读盘之前，
  //   把 $DSH_HOME/dsh-jenkins/{settings,registry}.json 整体搬到 $DSH_HOME/dsh-jenkins-panel/）
  await migrateLegacyDataDir(profileDataDir())
  const file = settingsFile(profileDataDir())
  // ① 启动加载连接设置（CLIENT-M2-07 修复：持久化文件优先，跨刷新/重启保留）
  const saved = await loadSettings(file)
  let currentSettings = effectiveSettings(config, saved)
  // ① 连接名双重校验：字符集（Config.pattern）+ 大小写不敏感唯一（均 fail-loud）
  assertConnectionNamesUnique(currentSettings.connections)
  // ② 连接注册表构造（M1-03）：只含端点元数据（无 token），提供 resolve/has/reload
  const registry = createConnectionRegistry(currentSettings)
  // ③ 客户端工厂绑定（M1-03 签名：clientFor(registry, credentials, name?)；无 token 抛 NoCredentialError）
  const getClient = (name?: string) => clientFor(registry, ctx.credentials, name)
  // ④ 工作区解析接线（V7 决策：工具/路由共用同一解析。P0-a 起不再依赖内存会话，见 jenkins/workspace-resolve.ts）
  const getSessionCwd = async (sessionId: string): Promise<string | undefined> => {
    try {
      const session = ctx.sessions.get(sessionId as never) as { cwd?: string; header?: { cwd?: string } } | undefined
      const cwd = session?.cwd ?? session?.header?.cwd
      return typeof cwd === 'string' ? cwd : undefined
    } catch {
      return undefined
    }
  }
  const workspaceRegistry = (ctx as unknown as {
    workspaceRegistry?: WorkspaceRegistryLike & {
      get: (id: string) => { title: string } | undefined
    }
  }).workspaceRegistry
  /**
   * 会话 → 工作区 id（工具写记录 + 路由过滤共用同一口径）。
   * P0-a：两级解析——① 会话 cwd → resolveByPath（既有）；② workspace.sessionIds 索引兜底
   * （来自持久会话头投影，**不依赖会话在本进程内存里**，即"重启后"场景）。两级都解析不到
   * 返回 undefined，由调用方如实呈现（路由置 workspaceResolved=false，不再静默放宽为"全部"）。
   */
  const resolveWorkspaceId = (sessionId: string): Promise<string | undefined> =>
    resolveWorkspaceIdOfSession(sessionId, { getSessionCwd, workspaceRegistry })
  const workspaceNameOf = (workspaceId: string | undefined, fallback?: string): string | undefined => {
    if (!workspaceId) return undefined
    try {
      return workspaceRegistry?.get(workspaceId)?.title ?? fallback
    } catch {
      return fallback
    }
  }
  const workspaceOf = async (sessionId: string): Promise<{ id: string; name: string } | undefined> => {
    const id = await resolveWorkspaceId(sessionId)
    if (!id) return undefined
    return { id, name: workspaceNameOf(id) ?? '' }
  }
  // ⑤ 失败自动分析的回推通道（dsh core ctx.agents 服务键；服务缺失/异常时降级为跳过：
  //   记录保持 not_analyzed，面板总览的 fail 记录兜底——见 jenkins/failure-analysis.ts 头注）
  const agentsRegistry = (ctx as unknown as { agents?: { get: (id: string) => AnalysisAgentLike | undefined } }).agents
  const getAgent = (sessionId: string): AnalysisAgentLike | undefined => {
    try {
      return agentsRegistry?.get(sessionId)
    } catch {
      return undefined
    }
  }
  // ⑥ 触发记录注册表（M1-08）：数据目录 = $DSH_HOME（HOST-M1-08 口径），file = $DSH_HOME/dsh-jenkins-panel/registry.json
  //   analysis.enabled（默认开）双职责：注册表 watchAlways 常驻轮询（面板关闭也能发现失败）
  //   + 在途→fail 流转瞬间回调分析推送器（handleBuildFailed 指向后置赋值，轮询定时器晚于此生效）
  let handleBuildFailed: ((record: TriggerRecord) => Promise<void>) | undefined
  const triggerRegistry = await createTriggerRegistry({
    file: registryFile(profileDataDir()),
    maxPerSession: config.registry.maxPerSession,
    ttlDays: config.registry.ttlDays,
    pollIntervalMs: config.registry.pollIntervalMs,
    getClient,
    watchAlways: config.analysis.enabled,
    onBuildFailed: config.analysis.enabled
      ? (record) => (handleBuildFailed ? handleBuildFailed(record) : undefined)
      : undefined,
  })
  if (config.analysis.enabled) {
    handleBuildFailed = createFailureAnalysis(triggerRegistry, {
      getAgent,
      tailLines: config.analysis.tailLines,
    }).handle
  }
  // ⑦ 轮询（在途记录状态流转）+ 每日 sweep；卸载时释放定时器
  ctx.effect(() => {
    triggerRegistry.start()
    return () => triggerRegistry.dispose()
  }, 'dsh-jenkins-panel: trigger registry lifecycle')
  // ⑧ 工具注册（triggerRegistry 接线：build_trigger/retry 成功时写总览记录 + 工作区解析；
  //   listConnections 接线：jenkins_connection_list 枚举连接清单，与 conn.list 路由同源）
  registerJenkinsTools(ctx, {
    registry,
    getClient,
    triggerRegistry,
    workspaceOf,
    listConnections: () => listConnections(registry, ctx.credentials),
  })
  // ⑨ /jenkins/api/* 路由（HOST-M1-09）：面板取数；workspace='current' 解析当前工作区，conn.list 数据源 = listConnections 绑定
  registerJenkinsRoutes(ctx, {
    registry,
    getClient,
    triggerRegistry,
    listConnections: () => listConnections(registry, ctx.credentials),
    getSessionCwd,
    resolveWorkspaceId,
    workspaceNameOf,
    settings: {
      get: async () => currentSettings,
      update: async (next) => {
        assertConnectionNamesUnique(next.connections)
        currentSettings = next
        registry.reload(next)
        await saveSettings(file, next)
      },
    },
  })
}
