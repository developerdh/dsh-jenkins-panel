/**
 * 旧数据目录一次性迁移（包名 dsh-jenkins → dsh-jenkins-panel 改名配套）
 *
 * 背景：npm 上 `dsh-jenkins` 已被他人占用（jsoncodee 的 Jenkins CLI 插件），包名更改为
 * `dsh-jenkins-panel`；插件全部持久化状态（settings.json 连接设置 + registry.json 触发记录）
 * 原先落在 `$DSH_HOME/dsh-jenkins/`，目录名随包名一并对齐，否则改名后首次启动视为全新安装，
 * 用户本机触发记录与连接设置"丢失"。
 *
 * 策略（fail-open）：apply() 启动时、任何读盘之前调用——
 * - 旧目录存在且新目录不存在 → 整目录 rename（同盘原子），返回 true；
 * - 新目录已存在 → 不动（已迁移/新装，旧目录留作备份不自动删）；
 * - 旧目录不存在 → no-op；
 * - 任何 I/O 错误 → 记日志返回 false，流程继续（等效全新安装，不阻塞插件加载）。
 */
import { rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 旧包名对应的数据目录名（迁移源头，固定不改——历史事实） */
export const LEGACY_DATA_DIR_NAME = 'dsh-jenkins'

/** 当前包名对应的数据目录名（与 registryFile/settingsFile 的子目录一致） */
export const DATA_DIR_NAME = 'dsh-jenkins-panel'

export interface LegacyMigrationLogger {
  (message: string): void
}

/**
 * 把 `<dataDir>/dsh-jenkins` 迁移为 `<dataDir>/dsh-jenkins-panel`（如需要）。
 * @returns 是否实际发生了迁移
 */
export async function migrateLegacyDataDir(dataDir: string, logger?: LegacyMigrationLogger): Promise<boolean> {
  const from = join(dataDir, LEGACY_DATA_DIR_NAME)
  const to = join(dataDir, DATA_DIR_NAME)
  try {
    const fromStat = await stat(from).catch(() => undefined)
    if (!fromStat?.isDirectory()) return false
    const toStat = await stat(to).catch(() => undefined)
    if (toStat?.isDirectory()) return false
    await rename(from, to)
    logger?.(`[dsh-jenkins-panel] 已迁移旧数据目录：${from} → ${to}`)
    return true
  } catch (err) {
    logger?.(
      `[dsh-jenkins-panel] 旧数据目录迁移失败（按全新安装继续）：${err instanceof Error ? err.message : String(err)}`,
    )
    return false
  }
}
