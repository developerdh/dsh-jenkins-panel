/**
 * Job 类工具（HOST-M1-06）：jenkins_job_list/search/resolve/info/params（5 个）
 *
 * 契约来源：docs/interface-and-data-model.md §3；返回 lossless-JSON；
 * search/resolve 的候选匹配逻辑自 HOST-M1-04 起统一在 `src/jenkins/resolver.ts`（多候选
 * 停下询问，绝不自动选择），本处委托复用（见变更记录）。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { resolveJob, searchJobs } from '../jenkins/resolver.js'
import { asJson, resolveJobPath, textContent, type JenkinsToolsDeps } from './shared.js'

export function defineJobTools(deps: JenkinsToolsDeps): ToolDefinition[] {
  return [
    defineTool({
      name: 'jenkins_job_list',
      description: '列出 Jenkins 任务（支持文件夹/递归/名称过滤）。返回 JobReference[]（name/url/fullName/displayName/color）。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        pattern: { type: 'string', description: '按名称/显示名/完整路径过滤（子串，大小写不敏感）' },
        folder: { type: 'string', description: '文件夹路径（缺省列出根级）' },
        recursive: { type: 'boolean', description: '递归展开全部子级（含文件夹内任务）' },
      },
      output: { schema: { type: 'json', description: 'JobReference[]' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        let jobs = args.recursive
          ? await client.getAllJobsRecursive()
          : args.folder
            ? await client.getFolderChildren(args.folder)
            : await client.listJobs()
        if (args.pattern) {
          const q = args.pattern.toLowerCase()
          jobs = jobs.filter(
            (j) =>
              (j.name ?? '').toLowerCase().includes(q) ||
              (j.displayName ?? '').toLowerCase().includes(q) ||
              (j.fullName ?? '').toLowerCase().includes(q),
          )
        }
        return asJson(jobs)
      },
    }),

    defineTool({
      name: 'jenkins_job_search',
      description: '智能搜索 Jenkins 任务（中文/displayName/模糊；多候选返回 matches 数组，绝不自动选择）。返回 SearchJobsResult。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        query: { type: 'string', description: '搜索词（支持中文/displayName/完整路径）', required: true },
        limit: { type: 'integer', description: '最多返回候选数（默认 20）' },
      },
      output: { schema: { type: 'json', description: 'SearchJobsResult' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        return asJson(await searchJobs(client, args.query, args.limit ?? 20))
      },
    }),

    defineTool({
      name: 'jenkins_job_resolve',
      description: '将Jenkins任务名解析为完整路径（精确优先；多候选返回 candidates 供确认，绝不自动选择）。返回 ResolveJobResult。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        path: { type: 'string', description: '任务名或路径', required: true },
        fuzzy: { type: 'boolean', description: '允许模糊匹配（缺省 true）' },
      },
      output: { schema: { type: 'json', description: 'ResolveJobResult' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        return asJson(await resolveJob(client, args.path, args.fuzzy !== false))
      },
    }),

    defineTool({
      name: 'jenkins_job_info',
      description: '获取Jenkins任务详情（JobInfo：color/buildable/lastBuild/builds 等；jobName 支持模糊解析）。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        jobName: { type: 'string', description: '任务名或路径', required: true },
      },
      output: { schema: { type: 'json', description: 'JobInfo' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        const { fullName } = await resolveJobPath(client, args.jobName)
        return asJson(await client.getJobInfo(fullName))
      },
    }),

    defineTool({
      name: 'jenkins_job_params',
      description: '获取Jenkins任务参数定义（ParameterDefinition[]，每次现拉最新，无持久缓存；jobName 支持模糊解析）。',
      parameters: {
        connection: { type: 'string', description: '连接名（缺省走默认连接）' },
        jobName: { type: 'string', description: '任务名或路径', required: true },
      },
      output: { schema: { type: 'json', description: 'ParameterDefinition[]' }, render: (_args, value) => textContent(value) },
      async execute(args) {
        const client = await deps.getClient(args.connection)
        const { fullName } = await resolveJobPath(client, args.jobName)
        return asJson(await client.getJobParams(fullName))
      },
    }),
  ]
}
