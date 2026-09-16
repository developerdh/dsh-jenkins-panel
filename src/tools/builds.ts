/**
 * 构建类工具（HOST-M1-06）：jenkins_build_trigger/status/info/log/history/history_all/retry/cancel/delete/artifacts（10 个）
 *
 * 契约来源：docs/interface-and-data-model.md §3/§4/§7。
 * - build_trigger 顺序（architecture §2.3）：解析名称 → 现拉参数 → 校验/合并 → 触发；
 *   成功后写触发记录注册表（recordTriggered，会话上下文缺失则跳过）；
 *   **不提供 wait 入口（用户要求取消）**：恒不等待、触发即返回 { queueId? }；
 * - build_retry 保留 wait（用户未要求取消）：/rebuild 后轮询 lastBuild 变化至终态，
 *   pollInterval 下限 1s、timeout 上限 30min（可参数覆盖）；
 * - build_log：tail/limit 必带其一（无则拒绝，验收口径），超限追加分页提示。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { getAllBuildHistory } from '../jenkins/all-build-history.js'
import type { BuildResult, ParameterDefinition } from '../jenkins/types.js'
import { asJson, queueIdFromUrl, recordTriggered, resolveJobPath, sleep, textContent, type JenkinsToolsDeps } from './shared.js'

/** 参数合并：默认值（非空）打底 + 模型提供值覆盖（校验/合并口径） */
function mergeParams(
  definitions: ParameterDefinition[],
  provided?: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const def of definitions) {
    const fallback = def.defaultParameterValue?.value
    if (fallback !== undefined && fallback !== null && fallback !== '') {
      merged[def.name] = fallback
    }
  }
  if (provided) {
    for (const [key, value] of Object.entries(provided)) merged[key] = value
  }
  return merged
}

export function defineBuildTools(deps: JenkinsToolsDeps): ToolDefinition[] {
  return [
    defineTool({
      name: 'jenkins_build_trigger',
      description:
        '触发Jenkins任务构建。内部顺序：解析名称 → 现拉参数 → 校验/合并 → 触发；成功后写入触发记录。**恒不等待**，立即返回 { queueId? }（用户要求取消 wait 入口，避免触发被阻塞）；构建状态后续可用 jenkins_build_status 查询。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        jobName: { type: 'string', description: '任务名或路径（多候选时停下询问）', required: true },
        parameters: { type: 'object', additionalProperties: true, description: '构建参数（覆盖默认值；缺省用任务默认参数）' },
        delay: { type: 'integer', description: '延迟触发（秒）' },
      },
      output: { schema: { type: 'json', description: '{ queueId? }' }, render: (_args, value) => textContent(value) },
      async execute(args, exec) {
        const client = await deps.getClient(args.connection)
        const { fullName, displayName } = await resolveJobPath(client, args.jobName)
        const definitions = await client.getJobParams(fullName)
        const merged = mergeParams(definitions, args.parameters)
        if (args.delay && args.delay > 0) await sleep(args.delay * 1000)
        const { queueUrl } = await client.triggerBuild(fullName, merged)
        const queueId = queueIdFromUrl(queueUrl)
        // 用户要求：取消 wait——恒不等待，触发即返回（buildNumber/status 不再输出）
        await recordTriggered(deps, exec, {
          connection: args.connection ?? deps.registry.defaultConnection,
          jobName: fullName,
          displayName: displayName ?? fullName,
          queueId,
          params: merged,
        })
        return asJson({ queueId })
      },
    }),

    defineTool({
      name: 'jenkins_build_status',
      description: '获取Jenkins构建状态（BuildInfo；buildNumber 缺省为最新构建）。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        jobName: { type: 'string', description: '任务名或路径', required: true },
        buildNumber: { type: 'integer', description: '构建号（缺省最新）' },
      },
      output: { schema: { type: 'json', description: 'BuildInfo' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        const { fullName } = await resolveJobPath(client, args.jobName)
        return asJson(await client.getBuildStatus(fullName, args.buildNumber))
      },
    }),

    defineTool({
      name: 'jenkins_build_info',
      description: '获取Jenkins构建详情（BuildInfo 全量原始 JSON：含参数 actions/产物 artifacts/变更集 changeSet，以 Jenkins 返回为准）。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        jobName: { type: 'string', description: '任务名或路径', required: true },
        buildNumber: { type: 'integer', description: '构建号（缺省最新）' },
      },
      output: { schema: { type: 'json', description: 'BuildInfo（含原始扩展字段）' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        const { fullName } = await resolveJobPath(client, args.jobName)
        return asJson(await client.getBuildInfo(fullName, args.buildNumber))
      },
    }),

    defineTool({
      name: 'jenkins_build_log',
      description:
        '获取Jenkins构建日志（LogOutput：jobName/buildNumber/log/totalLines）。必须指定 tail 或 limit 之一（防止全量拉取）；超限时提示用 startLine/limit 分页。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        jobName: { type: 'string', description: '任务名或路径', required: true },
        buildNumber: { type: 'integer', description: '构建号（缺省最新）' },
        startLine: { type: 'integer', description: '起始行号（0-based）' },
        limit: { type: 'integer', description: '从起始行向后取多少行' },
        tail: { type: 'integer', description: '取末尾 N 行（与 startLine/limit 互斥）' },
      },
      output: { schema: { type: 'json', description: 'LogOutput' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        if (args.limit == null && args.tail == null) {
          throw new Error('build_log 必须指定 tail 或 limit 之一（防止全量拉取日志；可用 startLine/limit 分页）')
        }
        const client = await deps.getClient(args.connection)
        const { fullName } = await resolveJobPath(client, args.jobName)
        const out = await client.getBuildLog(fullName, args.buildNumber, {
          startLine: args.startLine,
          limit: args.limit,
          tail: args.tail,
        })
        const shown = out.log.split('\n').length
        if (out.totalLines > shown) {
          out.log += `\n…（日志共 ${out.totalLines} 行，已显示 ${shown} 行；可用 startLine/limit 分页查看更多）`
        }
        return asJson(out)
      },
    }),

    defineTool({
      name: 'jenkins_build_history',
      description: '获取Jenkins构建历史（BuildHistory：builds 摘要列表 + totalCount；支持状态过滤/数量限制）。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        jobName: { type: 'string', description: '任务名或路径', required: true },
        limit: { type: 'integer', description: '最多返回条数（默认 20）' },
        status: { type: 'string', enum: ['SUCCESS', 'FAILURE', 'UNSTABLE', 'ABORTED', 'NOT_BUILT', 'IN_PROGRESS'], description: '按构建结果过滤' },
      },
      output: { schema: { type: 'json', description: 'BuildHistory' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        const { fullName } = await resolveJobPath(client, args.jobName)
        return asJson(await client.getBuildHistory(fullName, { limit: args.limit ?? 20, status: args.status as BuildResult | undefined }))
      },
    }),

    defineTool({
      name: 'jenkins_build_history_all',
      description:
        '分页获取当前 connection 下全部 Job 的历史构建摘要。跨 Job 按构建时间倒序归并；仅支持页码分页，不做结果/时间/时长过滤。单个 Job 的扫描窗口受 perJobLimit 限制，返回 scan.truncated 表示可能存在更早记录。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        page: { type: 'integer', description: '页码，从 1 开始（默认 1）' },
        pageSize: { type: 'integer', description: '每页返回条数（默认 100，最大 500）' },
        perJobLimit: { type: 'integer', description: '单 Job 最大扫描窗口（默认 500，最大 1000）' },
      },
      output: { schema: { type: 'json', description: 'AllBuildHistoryResult' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const connection = args.connection?.trim() || deps.registry.defaultConnection
        const client = await deps.getClient(connection)
        return asJson(
          await getAllBuildHistory(client, connection, {
            page: args.page,
            pageSize: args.pageSize,
            perJobLimit: args.perJobLimit,
          }),
        )
      },
    }),

    defineTool({
      name: 'jenkins_build_retry',
      description:
        '重试Jenkins构建（复用上次构建参数，POST /rebuild；成功后写触发记录）。**恒不等待**，立即返回 { queueId? }（与 trigger 一致，wait 入口已取消）；构建状态后续可用 jenkins_build_status 查询。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        jobName: { type: 'string', description: '任务名或路径', required: true },
      },
      output: { schema: { type: 'json', description: '{ queueId? }' }, render: (_args, value) => textContent(value) },
      async execute(args, exec) {
        const client = await deps.getClient(args.connection)
        const { fullName, displayName } = await resolveJobPath(client, args.jobName)
        const { queueUrl } = await client.retryBuild(fullName)
        const queueId = queueIdFromUrl(queueUrl)
        // 用户要求：retry 同 trigger 取消 wait——恒不等待，重试即返回（buildNumber/status 不再输出）
        await recordTriggered(deps, exec, {
          connection: args.connection ?? deps.registry.defaultConnection,
          jobName: fullName,
          displayName: displayName ?? fullName,
          queueId,
          params: {},
        })
        return asJson({ queueId })
      },
    }),

    defineTool({
      name: 'jenkins_build_cancel',
      description: '停止（取消）正在运行的Jenkins构建任务。返回操作结果。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        jobName: { type: 'string', description: '任务名或路径', required: true },
        buildNumber: { type: 'integer', description: '构建号', required: true },
      },
      output: { schema: { type: 'json', description: '{ ok, message }' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        const { fullName } = await resolveJobPath(client, args.jobName)
        await client.cancelBuild(fullName, args.buildNumber)
        return asJson({ ok: true, message: `已请求停止 ${fullName} #${args.buildNumber}` })
      },
    }),

    defineTool({
      name: 'jenkins_build_delete',
      description: '删除Jenkins构建记录。返回操作结果。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        jobName: { type: 'string', description: '任务名或路径', required: true },
        buildNumber: { type: 'integer', description: '构建号', required: true },
      },
      output: { schema: { type: 'json', description: '{ ok, message }' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        const { fullName } = await resolveJobPath(client, args.jobName)
        await client.deleteBuild(fullName, args.buildNumber)
        return asJson({ ok: true, message: `已删除构建 ${fullName} #${args.buildNumber}` })
      },
    }),

    defineTool({
      name: 'jenkins_build_artifacts',
      description: '获取Jenkins构建产物列表（Artifact[]：displayPath/fileName/relativePath）。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        jobName: { type: 'string', description: '任务名或路径', required: true },
        buildNumber: { type: 'integer', description: '构建号（缺省最新）' },
      },
      output: { schema: { type: 'json', description: 'Artifact[]' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        const { fullName } = await resolveJobPath(client, args.jobName)
        return asJson(await client.getBuildArtifacts(fullName, args.buildNumber))
      },
    }),
  ]
}
