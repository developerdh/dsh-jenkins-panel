/**
 * 队列/工作空间/结构/连接工具（HOST-M1-07 + 连接枚举补充；docs §3 工具契约 + §4 REST 映射）
 *
 * 9 个工具：jenkins_queue_list/cancel、jenkins_workspace_info/cleanup、
 * jenkins_folder_list/view_list/view_jobs、jenkins_connection_test、
 * jenkins_connection_list（连接清单枚举——无 connection 参数，枚举全部已配置连接）；
 * 与 M1-06 的 15 个合计覆盖 PRD §4.2 现有 23 个单连接工具（+ 连接枚举 1 个 = 24 个）。
 *
 * 关键口径：
 * - `workspace_cleanup` **dry-run 默认 true**（doWipeOutWorkspace 破坏性操作，红线）；
 *   `days` 参数接受但暂不生效（对齐 HOST-M1-09 路由变更记录）；
 * - `connection_test` 不落配置、不返回凭据文本（ping 轻量请求，token 不进模型上下文/日志）；
 * - `connection_list` 复用 conn.list 同源数据源（listConnections 绑定：isDefault/hasToken）+ 叠加
 *   registry 端点 url（名称模糊时供模型判别环境；url 非敏感，凭据永不出），供模型先枚举连接名再
 *   选定 connection 参数——补「连接清单」能力缺口；
 * - `folder_list` 复用 getFolderChildren 懒加载单层语义（folder 缺省根；depth 缺省 1）。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { JenkinsClient } from '../jenkins/client.js'
import type { FolderTreeNode } from '../jenkins/types.js'
import { asJson, resolveJobPath, textContent, type JenkinsToolsDeps } from './shared.js'

/** folder_list 递归展开（depth 缺省 1 = 懒加载单层；folder 缺省根） */
async function fetchFolderTree(
  client: JenkinsClient,
  folder: string | undefined,
  depth: number,
  level = 0,
): Promise<FolderTreeNode[]> {
  const children = await client.getFolderChildren(folder)
  if (level + 1 >= depth) return children
  for (const node of children) {
    if (node.type === 'folder') {
      node.children = await fetchFolderTree(client, node.fullName, depth, level + 1)
    }
  }
  return children
}

export function defineOpsTools(deps: JenkinsToolsDeps): ToolDefinition[] {
  return [
    defineTool({
      name: 'jenkins_queue_list',
      description: '列出当前排队中的Jenkins构建项（QueueItem[]：id/task/why/stuck/blocked/buildable 等）。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
      },
      output: { schema: { type: 'json', description: 'QueueItem[]' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        return asJson(await client.listQueue())
      },
    }),

    defineTool({
      name: 'jenkins_queue_cancel',
      description: '取消排队中的Jenkins构建项。返回操作结果。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        queueId: { type: 'integer', description: '排队项 ID（queue.list 的 id）', required: true },
      },
      output: { schema: { type: 'json', description: '{ ok, message }' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        await client.cancelQueueItem(args.queueId)
        return asJson({ ok: true, message: `已取消排队项 #${args.queueId}` })
      },
    }),

    defineTool({
      name: 'jenkins_workspace_info',
      description: '获取Jenkins任务工作空间信息（WorkspaceInfo：路径/最后构建/可构建；404=从未构建则无路径）。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        jobName: { type: 'string', description: '任务名或路径', required: true },
      },
      output: { schema: { type: 'json', description: 'WorkspaceInfo' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        const { fullName } = await resolveJobPath(client, args.jobName)
        return asJson(await client.getWorkspaceInfo(fullName))
      },
    }),

    defineTool({
      name: 'jenkins_workspace_cleanup',
      description: '清空Jenkins任务工作空间（**dry-run 默认 true 只预览**，确认后 dryRun=false 执行；days 参数暂不生效，见变更记录）。返回预览/结果。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        jobName: { type: 'string', description: '任务名或路径', required: true },
        days: { type: 'integer', description: '仅清理 N 天未运行的工作空间（暂不生效）' },
        dryRun: { type: 'boolean', description: '仅预览不执行（默认 true）' },
      },
      output: { schema: { type: 'json', description: '{ dryRun, info? } 或 { dryRun, ok, message }' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        const { fullName } = await resolveJobPath(client, args.jobName)
        if (args.dryRun !== false) {
          // dry-run：只读预览（不调 wipeWorkspace）
          return asJson({ dryRun: true, info: await client.getWorkspaceInfo(fullName) })
        }
        await client.wipeWorkspace(fullName)
        return asJson({ dryRun: false, ok: true, message: `已清空工作空间 ${fullName}` })
      },
    }),

    defineTool({
      name: 'jenkins_folder_list',
      description: '列出Jenkins文件夹/任务（folder 缺省根；depth 缺省 1 = 懒加载单层；folder 节点带 children）。返回 FolderTreeNode[]。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        folder: { type: 'string', description: '文件夹路径（缺省根级）' },
        depth: { type: 'integer', description: '递归深度（缺省 1 = 单层）' },
      },
      output: { schema: { type: 'json', description: 'FolderTreeNode[]' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        const depth = typeof args.depth === 'number' && args.depth >= 1 ? Math.floor(args.depth) : 1
        const tree = await fetchFolderTree(client, args.folder as string | undefined, depth)
        return asJson(tree)
      },
    }),

    defineTool({
      name: 'jenkins_view_list',
      description: '列出 Jenkins 视图（ViewInfo[]：name/url/description，含各视图 jobs）。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
      },
      output: { schema: { type: 'json', description: 'ViewInfo[]' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        return asJson(await client.listViews())
      },
    }),

    defineTool({
      name: 'jenkins_view_jobs',
      description: '取指定视图内的Jenkins任务列表（JobReference[]）。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        viewName: { type: 'string', description: '视图名', required: true },
      },
      output: { schema: { type: 'json', description: 'JobReference[]' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        return asJson(await client.getViewJobs(args.viewName))
      },
    }),

    defineTool({
      name: 'jenkins_connection_list',
      description:
        '列出当前已配置的全部 Jenkins 连接（name/url/isDefault/hasToken；url 为端点地址，名称模糊时可用它判别是哪个环境；不含任何凭据）。**无 connection 参数**——它枚举全部连接、不属于单连接作用域；返回的 name 可直接作为其它 jenkins_* 工具的 connection 参数（缺省走默认连接）。',
      parameters: {},
      output: { schema: { type: 'json', description: 'ConnectionSummary[]（含 url）' }, render: (_args, value) => textContent(value) },
      async execute() {
        if (!deps.listConnections) {
          throw new Error('jenkins_connection_list 未接线（需注入 listConnections 数据源）')
        }
        const summaries = await deps.listConnections()
        const byName = new Map(summaries.map((s) => [s.name, s]))
        // url 来自连接端点配置（registry.connections 实时元数据，非敏感）；isDefault/hasToken 来自 conn.list 同源绑定
        return asJson(
          deps.registry.connections.map((conn) => {
            const summary = byName.get(conn.name)
            return {
              name: conn.name,
              url: conn.url,
              isDefault: summary?.isDefault ?? conn.name === deps.registry.defaultConnection,
              hasToken: summary?.hasToken ?? false,
            }
          }),
        )
      },
    }),

    defineTool({
      name: 'jenkins_connection_test',
      description: '测试 Jenkins 连接（轻量 API 请求，返回延迟；不落配置、不泄漏凭据文本）。返回 { ok, message, latencyMs? }。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
      },
      output: { schema: { type: 'json', description: '{ ok, message, latencyMs? }' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        try {
          const client = await deps.getClient(args.connection)
          const result = await client.ping()
          return asJson({ ok: true, message: `连接正常（${result.latencyMs}ms）`, latencyMs: result.latencyMs })
        } catch (err) {
          return asJson({ ok: false, message: err instanceof Error ? err.message : String(err) })
        }
      },
    }),
  ]
}
