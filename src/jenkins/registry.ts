/**
 * 触发记录注册表（docs/architecture.md §2.5、interface-and-data-model.md §5、PRD §4.3）
 *
 * host 侧：对话触发构建的元数据落盘（按 sessionId 隔离）、保留策略清理
 * （每会话上限 + 全局 TTL，在途不淘汰）、面板打开期间轮询在途记录状态
 * （queued→running→ok/fail/aborted，visible 门控）——总览视图（CLIENT-M2-03）数据源。
 *
 * 设计要点：
 * - **只存元数据**（connection/jobName/buildNumber/params/status/时间戳），不存日志/产物；
 * - 持久化路径由**接线方注入**（`file`）：`<profile 数据目录>/dsh-jenkins-panel/registry.json`。
 *   实测（dsh 0.1.1-rc.2）：`ctx.baseDir` 不是 Context 标准键（仅 `hmr.baseDir` 服务字段），
 *   profile 数据目录需经 `dsh-home-paths`（`$DSH_HOME`，profile 位于其下）或接线方自有
 *   baseDir 计算——归 HOST-M1-09 接线 + FIN-M3-03 回流 architecture §2.5；
 * - 原子写：同目录 `.tmp` 写入 + fsync + rename（与官方 `dsh-storage-json` 的 writeAtomic
 *   同语义，避免依赖存储 hub 接线）；写入经**单写链**串行化（轮询写回 vs 手动删除不并发）；
 * - 损坏容错：load 时 JSON 解析失败 → 备份为 `.corrupt-<ts>` 并重建空表；
 * - 轮询经注入的 `getClient(connection?)`（M1-03 clientFor 绑定）取客户端，
 *   `queued` 记录先经 `getQueueItem(queueId)` 解析 `queueId→executable.number`（构建派发后
 *   队列项离开 /queue/api/json，必须按 id 查队列项；listQueue 只能取到未派发项），
 *   再 `getBuildStatus` 判状态（兜底用任务最新构建裁决）；错误按条捕获（日志留痕），
 *   状态保持原样下轮重试；
 * - `visible` 门控：定时轮询仅在可见时执行；`refreshNow()` 强制即时刷新（绕过门控）；
 *   `watchAlways`（失败自动分析开启）时轮询常驻，不受面板可见性影响；
 * - 失败自动分析钩子：在途 → fail 流转瞬间回调 `onBuildFailed`（仅本进程观察到的流转，
 *   重启加载的终态不回调），分析推送见 failure-analysis.ts；
 * - 定时器（轮询 + 每日 sweep）随 `start()/dispose()` 启停并 `unref()`（不阻塞进程退出）。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { JenkinsClient } from './client.js'
import type { BuildResult } from './types.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** 触发记录状态（契约：queued→running→ok/fail/aborted） */
export type TriggerStatus = 'queued' | 'running' | 'ok' | 'fail' | 'aborted'

/** 失败自动分析推送状态（缺省/旧记录 undefined 视为 not_analyzed） */
export type AnalysisState = 'not_analyzed' | 'pushed' | 'analyze_failed'

/** 触发记录（只存元数据；triggeredAt/statusUpdatedAt 为 epoch ms） */
export interface TriggerRecord {
  id: string
  connection: string
  jobName: string
  displayName: string
  queueId?: number
  buildNumber?: number
  params: Record<string, unknown>
  status: TriggerStatus
  triggeredAt: number
  statusUpdatedAt: number
  sessionId: string
  /** 所属工作区稳定 id（触发时解析；拿不到 → 固定 sentinel，见 UNKNOWN_WORKSPACE_ID） */
  workspaceId?: string
  /** 工作区名快照（触发时；展示时优先实时名，作为兜底） */
  workspaceName?: string
  source: 'conversation'
  /** Jenkins 原始 result（最近一次状态刷新所见；UNSTABLE 区分与失败自动分析的触发依据） */
  rawResult?: BuildResult
  /** 失败自动分析推送状态（failure-analysis.ts 维护；undefined = 旧记录，视为 not_analyzed） */
  analysis?: AnalysisState
  /** 最近一次推送分析任务的时间（epoch ms） */
  pushedAt?: number
}

/** recordTrigger 入参（由 HOST-M1-06 build_trigger 成功触发后提供） */
export interface TriggerInput {
  connection: string
  jobName: string
  displayName: string
  queueId?: number
  buildNumber?: number
  params: Record<string, unknown>
  sessionId: string
  workspaceId?: string
  workspaceName?: string
}

/** 无法解析工作区时的固定 sentinel（不参与「当前工作区」过滤，展示为「未知工作区」） */
export const UNKNOWN_WORKSPACE_ID = 'dsh-jenkins-panel:unknown'

/** 注册表保留策略/轮询配置（来自 Config.registry，HOST-M1-01 已建 Schema） */
export interface TriggerRegistryConfig {
  maxPerSession: number
  ttlDays: number
  pollIntervalMs: number
}

export interface TriggerRegistryOptions extends TriggerRegistryConfig {
  /** 持久化文件路径（接线方注入：<profile 数据目录>/dsh-jenkins-panel/registry.json） */
  file: string
  /** 连接客户端工厂：`clientFor(registry, ctx.credentials, name)` 的绑定（M1-03） */
  getClient: (connection?: string) => Promise<JenkinsClient>
  /**
   * 在途 → fail 流转瞬间的回调（失败自动分析入口）。只在**本进程观察到的流转**触发：
   * 重启加载到的历史 fail 终态、插件 dispose 窗口内错过的流转都不会回调（设计如此，不补推）。
   * 回调错误被捕获记日志，不影响轮询循环与其余记录的刷新。
   */
  onBuildFailed?: (record: TriggerRecord) => void | Promise<void>
  /** true 时定时轮询不受 visible 门控（失败自动分析的常驻检测：面板关闭也要能发现失败） */
  watchAlways?: boolean
  /** 时钟注入（测试用）；默认 new Date */
  now?: () => Date
  /** 日志（默认带 [dsh-jenkins-panel] 前缀输出） */
  logger?: (message: string) => void
}

/** triggered.list 查询（分页 + 状态过滤，跨连接混合，按 sessionId 隔离） */
export interface TriggerListQuery {
  /** 按工作区过滤（路由已把 'current' 解析为具体 id；缺省不按工作区过滤 = 全部） */
  workspaceId?: string
  /** 按连接过滤 */
  connection?: string
  /** 按会话过滤（可选；不再强制会话隔离，仅作细化） */
  sessionId?: string
  status?: TriggerStatus[]
  limit?: number
  offset?: number
}

/** 全会话状态分布（**不受状态过滤影响**；驱动总览 chips 计数——过滤只影响数据区，不改统计） */
export interface TriggerCounts {
  all: number
  queued: number
  running: number
  ok: number
  fail: number
  aborted: number
}

/** triggered.list 返回 */
export interface TriggerListResult {
  records: TriggerRecord[]
  /** 状态过滤后的总数（分页前；「加载更多 x/total」用） */
  total: number
  /** 全会话状态分布（永不过滤） */
  counts: TriggerCounts
}

/** 构建结果 → 触发状态映射（契约无 UNSTABLE/NOT_BUILT 独立状态，归并口径见下） */
function mapBuildResult(result: BuildResult | undefined, building: boolean | undefined): TriggerStatus {
  if (building) return 'running'
  switch (result) {
    case 'SUCCESS':
      return 'ok'
    case 'UNSTABLE':
      return 'ok' // 不稳定视为完成（归 ok，契约无独立状态）
    case 'FAILURE':
      return 'fail'
    case 'ABORTED':
    case 'NOT_BUILT':
      return 'aborted' // 未构建视为跳过/取消
    case undefined:
      return 'running' // 无 result 且非 building：保守视为运行中，下轮再查
    default:
      return 'running'
  }
}

function isTriggerRecord(value: unknown): value is TriggerRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return typeof r.id === 'string' && typeof r.sessionId === 'string' && typeof r.jobName === 'string'
}

export class TriggerRegistry {
  private records: TriggerRecord[] = []
  private visible = true
  private dirty = false
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private sweepTimer: ReturnType<typeof setInterval> | undefined
  private writeChain: Promise<void> = Promise.resolve()
  private readonly options: TriggerRegistryOptions
  private readonly now: () => Date
  private readonly logger: (message: string) => void

  constructor(options: TriggerRegistryOptions) {
    this.options = options
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger ?? ((message) => console.log(message))
  }

  /** 全部记录（只读快照视图，供调试/路由复用） */
  get all(): readonly TriggerRecord[] {
    return this.records
  }

  /** 从磁盘加载（损坏容错：备份 + 重建空表） */
  async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.options.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.records = []
        return
      }
      throw err
    }
    try {
      const parsed = JSON.parse(text) as { version?: number; records?: unknown }
      this.records = Array.isArray(parsed.records) ? parsed.records.filter(isTriggerRecord) : []
    } catch {
      const backup = `${this.options.file}.corrupt-${this.now().getTime()}`
      await rename(this.options.file, backup).catch(() => {})
      this.logger(`[dsh-jenkins-panel] 注册表文件损坏，已备份至 ${backup} 并重建空表`)
      this.records = []
    }
  }

  /*
   * 旧记录 workspaceId 回填已于 2026-09-11 移除（用户决策，见当日报障核实）。
   *
   * 原实现（V7 报障时加入）：在 `load()` 里对缺失 workspaceId 的记录按 sessionId → 工作区补写。
   * 问题：它**只在启动那一刻跑一次**，而那一刻 `ctx.sessions` 必然为空、解析必然失败，且没有任何
   * 重试点（不随 sweep / 会话加载 / 设置保存重跑）——永远补不上自己要补的记录，属"看似在兜底"
   * 的死代码；单测把 resolveWorkspaceOfSession mock 成成功，故真实时序从未被覆盖。
   *
   * 数据面核实：缺该字段的记录全部产生于 `workspaceId` 引入（2026-08-31，commit 7b8adcc）之前，
   * 之后写入的记录恒带该字段（最差 `UNKNOWN_WORKSPACE_ID` sentinel），故这是一次性历史数据问题、
   * 不会复发；默认 TTL 30 天会自行清掉存量。更关键的是：P0-a 使会话→工作区解析不再依赖内存会话后，
   * 若保留本回填，它就会开始**静默改写**这些历史记录——用户已明确不要该行为，故一并移除。
   */

  /** 写入触发记录（status 初始：有 buildNumber → running，否则 queued）；触发后立即落盘 + 清理 */
  async recordTrigger(input: TriggerInput): Promise<TriggerRecord> {
    const at = this.now().getTime()
    const record: TriggerRecord = {
      id: randomUUID(),
      connection: input.connection,
      jobName: input.jobName,
      displayName: input.displayName,
      queueId: input.queueId,
      buildNumber: input.buildNumber,
      params: input.params,
      status: input.buildNumber ? 'running' : 'queued',
      triggeredAt: at,
      statusUpdatedAt: at,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName,
      source: 'conversation',
      analysis: 'not_analyzed',
    }
    this.records.push(record)
    this.sweep()
    await this.save()
    return record
  }

  /** triggered.list：按 工作区/连接/会话（可选）+ 状态 过滤 + 分页；counts 恒为「基础作用域」分布（不受 status 影响） */
  list(query: TriggerListQuery = {}): TriggerListResult {
    let scoped = this.records
    if (query.workspaceId) scoped = scoped.filter((r) => (r.workspaceId ?? UNKNOWN_WORKSPACE_ID) === query.workspaceId)
    if (query.connection) scoped = scoped.filter((r) => r.connection === query.connection)
    if (query.sessionId) scoped = scoped.filter((r) => r.sessionId === query.sessionId)
    const filtered = query.status && query.status.length > 0
      ? scoped.filter((r) => query.status!.includes(r.status))
      : scoped
    const sorted = [...filtered].sort((a, b) => b.triggeredAt - a.triggeredAt)
    const offset = Math.max(0, query.offset ?? 0)
    const limit = query.limit != null ? Math.max(0, query.limit) : sorted.length
    const counts: TriggerCounts = { all: scoped.length, queued: 0, running: 0, ok: 0, fail: 0, aborted: 0 }
    for (const r of scoped) counts[r.status] += 1
    return { records: sorted.slice(offset, offset + limit), total: filtered.length, counts }
  }

  /**
   * triggered.delete：id 缺省 = 清空该会话；返回删除条数。
   * 单条删除**只按全局唯一 id**（不要求 sessionId 相等）——用户报障：总览按工作区跨会话
   * 聚合，列表可能含其它会话触发的记录；若按 sessionId 过滤则删不掉（提示 0 条且未删除）。
   * 记录 id = randomUUID 全局唯一，无跨会话误删风险；清空（id 缺省）语义保持按会话。
   */
  async delete(sessionId: string, id?: string): Promise<number> {
    const before = this.records.length
    this.records = id
      ? this.records.filter((r) => r.id !== id)
      : this.records.filter((r) => r.sessionId !== sessionId)
    await this.save()
    return before - this.records.length
  }

  /** 清理：① TTL 超期全清；② 每会话超限优先淘汰最旧终态（在途不淘汰）；返回移除条数 */
  sweep(): number {
    const at = this.now().getTime()
    const ttlMs = this.options.ttlDays * DAY_MS
    let removed = 0

    this.records = this.records.filter((r) => {
      if (at - r.triggeredAt > ttlMs) {
        removed += 1
        return false
      }
      return true
    })

    const bySession = new Map<string, TriggerRecord[]>()
    for (const r of this.records) {
      const group = bySession.get(r.sessionId)
      if (group) group.push(r)
      else bySession.set(r.sessionId, [r])
    }
    const kept: TriggerRecord[] = []
    for (const group of bySession.values()) {
      // 在途（queued/running）永不淘汰；只从终态里按最旧优先淘汰
      const terminal = group
        .filter((r) => r.status !== 'queued' && r.status !== 'running')
        .sort((a, b) => a.triggeredAt - b.triggeredAt) // 最旧在前
      const drop = Math.max(0, group.length - this.options.maxPerSession)
      const dropIds = new Set(terminal.slice(0, drop).map((r) => r.id))
      removed += dropIds.size
      kept.push(...group.filter((r) => !dropIds.has(r.id)))
    }
    this.records = kept
    return removed
  }

  /** 启动：加载后清理 + 启动轮询与每日 sweep 定时器（unref，不阻塞进程退出） */
  start(): void {
    this.stop()
    void this.sweepAndSave()
    this.pollTimer = setInterval(() => {
      // watchAlways（失败自动分析开启时）：面板关闭也持续检测，不能跟着 visible 停
      if (this.visible || this.options.watchAlways) void this.pollOnce()
    }, Math.max(50, this.options.pollIntervalMs))
    this.pollTimer.unref()
    this.sweepTimer = setInterval(() => {
      void this.sweepAndSave()
    }, DAY_MS)
    this.sweepTimer.unref()
  }

  /** 停止定时器 */
  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.pollTimer = undefined
    this.sweepTimer = undefined
  }

  /** 释放（停止定时器；写盘已按次完成，无需额外 flush） */
  dispose(): void {
    this.stop()
  }

  /** visible 门控：面板折叠/关闭时暂停定时轮询 */
  setVisible(visible: boolean): void {
    this.visible = visible
  }

  /** 强制即时刷新（绕过 visible 门控；打开构建详情/手动刷新时调用） */
  async refreshNow(): Promise<void> {
    await this.pollOnce()
  }

  /** 轮询一轮：在途记录（queued/running）逐条刷新；有变更即写盘 */
  async pollOnce(): Promise<void> {
    const inFlight = this.records.filter((r) => r.status === 'queued' || r.status === 'running')
    for (const record of inFlight) {
      try {
        await this.refreshRecord(record)
      } catch (err) {
        this.logger(`[dsh-jenkins-panel] 状态轮询失败（${record.jobName}#${record.buildNumber ?? record.queueId ?? '?'}）：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (this.dirty) {
      this.dirty = false
      await this.save()
    }
  }

  /** 单条在途记录刷新：queued 先解析 buildNumber；无派发保持 queued */
  private async refreshRecord(record: TriggerRecord): Promise<void> {
    const client = await this.options.getClient(record.connection)
    let buildNumber = record.buildNumber
    if (record.status === 'queued' && !buildNumber) {
      // 主路径：按 queueId 取队列项（含派发后的 executable.number）。注意不能再用 listQueue ——
      // 构建一旦派发就会离开 /queue/api/json，listQueue 查不到会让记录永远卡在 queued（用户 V7 报障）。
      if (record.queueId !== undefined) {
        const queueItem = await client.getQueueItem(record.queueId)
        buildNumber = queueItem?.executable?.number
      }
      // 兜底：队列项已清理/无 queueId（如 retry 未拿到 queueId）→ 用任务最新一次构建裁决。
      // 仅当该构建晚于（容 30s 时钟偏差）本记录触发时刻、且未被其它在途记录占用才认领，避免误配历史构建。
      if (!buildNumber) {
        try {
          const latest = await client.getBuildStatus(record.jobName)
          const sameJob = record.jobName
          const claimed = new Set(
            this.records
              .filter((r) => r !== record && r.jobName === sameJob && r.buildNumber != null && r.buildNumber > 0)
              .map((r) => r.buildNumber as number),
          )
          if (
            latest?.number != null &&
            latest.number > 0 &&
            !claimed.has(latest.number) &&
            latest.timestamp != null &&
            latest.timestamp >= record.triggeredAt - 30_000
          ) {
            buildNumber = latest.number
          }
        } catch {
          // 最新构建不可查（如无构建历史 404）：保持 queued，下轮再查/再试
        }
      }
      if (!buildNumber) return // 仍未派发/不可裁决：保持 queued
    }
    const info = await client.getBuildStatus(record.jobName, buildNumber)
    const next = mapBuildResult(info.result, info.building)
    const prev = record.status
    if (record.status !== next || (buildNumber && buildNumber !== record.buildNumber)) {
      record.status = next
      record.statusUpdatedAt = this.now().getTime()
      if (buildNumber) record.buildNumber = buildNumber
      this.dirty = true
    }
    // 原始 result 照实存储（UNSTABLE 归 ok 不丢真值；失败自动分析按 rawResult 判断）
    if (info.result && info.result !== record.rawResult) {
      record.rawResult = info.result
      this.dirty = true
    }
    // 在途 → fail 流转瞬间：通知失败自动分析（refreshRecord 只处理在途记录，prev 必为 queued/running）。
    // await 以保证 analysis 状态先于本轮落盘；错误按条捕获，不阻塞其余记录。
    if (next === 'fail' && prev !== 'fail' && this.options.onBuildFailed) {
      try {
        await this.options.onBuildFailed(record)
      } catch (err) {
        this.logger(`[dsh-jenkins-panel] 失败分析回调异常（${record.jobName}#${record.buildNumber ?? '?'}）：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /** 标记失败分析任务已推送（failure-analysis.ts 经 onBuildFailed 回调链调用）；立即走单写链落盘 */
  async markAnalysisPushed(id: string): Promise<boolean> {
    const record = this.records.find((r) => r.id === id)
    if (!record) return false
    record.analysis = 'pushed'
    record.pushedAt = this.now().getTime()
    await this.save()
    return true
  }

  private async sweepAndSave(): Promise<void> {
    if (this.sweep() > 0) await this.save()
  }

  /** 落盘（快照 + 单写链串行化：原子写 = tmp 写入 + fsync + rename） */
  save(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, records: this.records }, null, 2)
    this.writeChain = this.writeChain
      .then(() => this.persist(snapshot))
      .catch((err) => {
        this.logger(`[dsh-jenkins-panel] 注册表写盘失败：${err instanceof Error ? err.message : String(err)}`)
      })
    return this.writeChain
  }

  private async persist(content: string): Promise<void> {
    await mkdir(dirname(this.options.file), { recursive: true })
    const tmp = `${this.options.file}.tmp`
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, this.options.file)
  }
}

/** 构造并加载注册表（接线方：M1-06 build_trigger 写入、M1-09 路由、M2-03 面板消费） */
export async function createTriggerRegistry(options: TriggerRegistryOptions): Promise<TriggerRegistry> {
  const registry = new TriggerRegistry(options)
  await registry.load()
  return registry
}

/** 默认持久化文件路径（接线方按 profile 数据目录计算后调用） */
export function registryFile(profileDataDir: string): string {
  return `${profileDataDir.replace(/[\\/]+$/, '')}/dsh-jenkins-panel/registry.json`
}
