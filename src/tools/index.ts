/**
 * jenkins_* 工具注册汇总（HOST-M1-06 + M1-07）
 *
 * `registerJenkinsTools(ctx, deps)`（architecture §2.1 调用形态）：
 * 用 @deepseek-ai/dsh-tools 的 defineTool 注册全部 24 个工具
 * （job 5 + build 10 + ops 9：队列/工作空间/结构/连接测试/连接清单），
 * 工具名前缀统一 `jenkins_*`（与 better-sidebar `sidebar_*` 命名隔离）。
 * deps 由接线方（apply/HOST-M1-05）组装：registry（连接注册表 M1-03）、
 * getClient（clientFor 绑定）、listConnections（连接清单，jenkins_connection_list 用）、
 * triggerRegistry（触发记录 M1-08）、sessionIdOf（可选）。
 */
import type { Context } from '@deepseek-ai/cordis'

import { defineBuildTools } from './builds.js'
import { defineJobTools } from './jobs.js'
import { defineOpsTools } from './ops.js'
import { type JenkinsToolsDeps } from './shared.js'

export type { JenkinsToolsDeps }

/**
 * 注册全部 jenkins_* 工具（job 5 + build 10 + ops 9）。
 *
 * ⚠️ 生命周期（0.2.0 实测勘误）：`ctx.tools.register` 返回的 disposer 是工具唯一的注销
 * 通道（同层重复注册直接失败），不能依赖「随 fiber 卸载自动清理」——插件重载/重装时
 * 残留工具会让下次激活撞重复。故全部注册收进一个 `ctx.effect`：collect 全部 disposer、
 * 卸载时逆序注销（与 routes.ts 的修法同款）。
 */
export function registerJenkinsTools(ctx: Context, deps: JenkinsToolsDeps): void {
  ctx.effect(() => {
    const disposers = [...defineJobTools(deps), ...defineBuildTools(deps), ...defineOpsTools(deps)].map((tool) =>
      ctx.tools.register(tool),
    )
    return () => {
      for (const dispose of [...disposers].reverse()) dispose()
    }
  }, 'dsh-jenkins-panel: jenkins_* tools')
}
