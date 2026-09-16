/**
 * 会话 → 工作区解析（P0-a：不依赖内存会话）
 *
 * 用户报障：重启后打开面板，总览「当前工作区」过滤看似失效。根因是解析只走
 * `ctx.sessions.get(sessionId).cwd` → `workspaceRegistry.resolveByPath(cwd)`，而
 * `ctx.sessions` 只认**本进程已加载**的会话；进程刚启动（或面板早于会话加载完成）时
 * 解析恒为 `undefined`，host 随后把「按工作区过滤」静默降级为「不过滤」（旧行为见
 * routes.ts 的 V7 放宽注释），于是 chip 显示「当前工作区」却列出全部工作区的记录。
 *
 * 本模块把解析做成两级，**都只用同一个 `ctx.workspaceRegistry` 的公开 API**：
 * ① 路径归属（既有口径，保持与写记录时一致）：会话 cwd → `resolveByPath(cwd)`；
 * ② 会话索引兜底（新增）：`list()` 中某 workspace 的 `sessionIds` 含该会话 id。
 *    `sessionIds` 是「启动时由 `SessionPersistence.list()` 的会话头（id/cwd/createdAt）
 *    建出的同步投影」（见 @deepseek-ai/dsh-workspace 类型声明），因此**不需要会话在
 *    本进程内存里**——正是重启后的场景；其成员判定同样要求会话头 cwd 的规范路径等于
 *    workspace 路径，与 ① 同等严格，不引入语义漂移。
 *
 * 两级全部 fail-soft：任何一侧抛错都退化为 `undefined`（不阻塞总览取数），
 * 而**如何呈现"没解析到"由调用方决定**——本模块绝不偷偷放宽过滤语义。
 */

/** workspaceRegistry 的最小消费面（只取本模块用到的两个公开方法；便于单测注入） */
export interface WorkspaceRegistryLike {
  /** 规范化路径 → 所属 workspace（不存在/未归属返回 undefined） */
  resolveByPath(path: string): Promise<{ id: string } | undefined>
  /** 同步全量投影（含每个 workspace 的 sessionIds 会话头索引） */
  list?(): Array<{ id: string; sessionIds?: readonly string[] }>
}

/** 解析依赖（接线方注入；缺省即"未接线"，一律返回 undefined） */
export interface WorkspaceResolutionLookups {
  /** 会话 id → 会话工作目录（通常封装 ctx.sessions；未加载的会话返回 undefined） */
  getSessionCwd: (sessionId: string) => Promise<string | undefined>
  /** 工作区注册表（缺省/未接线 → 只可能返回 undefined） */
  workspaceRegistry?: WorkspaceRegistryLike
}

/**
 * 解析会话所属工作区 id。
 * @param sessionId 会话 id（空白视为未提供）
 * @param lookups 解析来源（会话 cwd + 工作区注册表）
 * @returns 工作区 id；两级都无法解析时 `undefined`（调用方须如实呈现，不得当作"已过滤"）
 */
export async function resolveWorkspaceIdOfSession(
  sessionId: string,
  lookups: WorkspaceResolutionLookups,
): Promise<string | undefined> {
  const id = sessionId?.trim()
  if (!id) return undefined
  const registry = lookups.workspaceRegistry

  // ① 路径归属（既有口径）：实时会话的 cwd → 其所属 workspace
  try {
    const cwd = await lookups.getSessionCwd(id)
    if (cwd) {
      const workspace = await registry?.resolveByPath(cwd)
      if (workspace?.id) return workspace.id
    }
  } catch {
    // 落到 ②：会话服务未接线/异常不应让总览取数失败
  }

  // ② 会话索引兜底：sessionIds 来自持久会话头投影，不依赖会话在本进程内存中
  try {
    for (const workspace of registry?.list?.() ?? []) {
      if (workspace.sessionIds?.includes(id)) return workspace.id
    }
  } catch {
    // 解析失败 → undefined（由调用方如实呈现）
  }
  return undefined
}
