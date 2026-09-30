/**
 * 连接设置持久化（CLIENT-M2-07 修复：V5 路径 1 的 dsh-settings wire 在实测中新增不落
 * describe/跨刷新丢失，改走**自建 host 路由 + JSON 文件**（better-sidebar 同款 Path 2，
 * probe V5 建议“无 loopback 限制、更稳”）。
 *
 * ⚠️ 0.2.0 存储归一（插件页配置改造）：JSON 文件降级为**一次性迁移源 + configEditor
 * 不可用时的兜底**。宿主 0.2.0 起提供 ConfigEditor 服务（profile patch 的配置编辑通道，
 * 经 Loader 校验/持久化），插件页配置表单（plugins.bundle.config / plugins.row.config）
 * 绑定的就是插件 Config 条目——Config 成为唯一事实源，本文件的历史职责由
 * `adoptOrMigrateSaved` 一次性收编（见该函数头注）。
 *
 * 文件：`<profile 数据目录>/dsh-jenkins-panel/settings.json`，形状 `{ defaultConnection, connections }`
 * （token 不在此；凭据仍走 dsh credential-ref，V4 方案 A）。
 * - 启动：`adoptOrMigrateSaved` 读取并迁移/合并（Config 归一后文件不再参与运行时合并）；
 * - 保存兜底：`save(registryFile, settings)` 原子写（同目录 `.tmp` + rename，与 registry.ts 同语义；
 *   仅 configEditor 不可用时使用）；
 * - 损坏容错：JSON 解析失败 → 备份 `.corrupt-<ts>` 并返回 null（由接线方回退 Config）。
 */
import { dirname, join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

import type { JenkinsConnectionMeta } from './connection.js'

/** settings.json 文件路径（接线方注入：<profile 数据目录>/dsh-jenkins-panel/settings.json） */
export function settingsFile(dataDir: string): string {
  return join(dataDir, 'dsh-jenkins-panel', 'settings.json')
}

/** 连接设置持久化形状（token 不在此） */
export interface SavedSettings {
  defaultConnection: string
  connections: JenkinsConnectionMeta[]
}

/** 读取 settings.json；不存在/损坏返回 null（调用方回退 Config + 备份损坏文件） */
export async function loadSettings(file: string, logger?: (m: string) => void): Promise<SavedSettings | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    // ENOENT = 尚无持久化设置 → 回退 Config
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    logger?.(`设置文件读取失败：${file} ${String(err)}`)
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SavedSettings>
    return {
      defaultConnection: typeof parsed.defaultConnection === 'string' ? parsed.defaultConnection : '',
      connections: Array.isArray(parsed.connections) ? parsed.connections : [],
    }
  } catch {
    const corrupt = `${file}.corrupt-${Date.now()}`
    try {
      await rename(file, corrupt)
      logger?.(`设置文件损坏，已备份至 ${corrupt} 并重置`)
    } catch {
      logger?.(`设置文件损坏且备份失败：${file}`)
    }
    return null
  }
}

/** 原子写 settings.json（.tmp + rename；不依赖存储 hub 接线） */
export async function saveSettings(file: string, settings: SavedSettings, logger?: (m: string) => void): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8')
  await rename(tmp, file)
  logger?.(`设置已保存：${file}（${settings.connections.length} 个连接）`)
}

/** 归档已迁移的 settings.json（固定改名 `.migrated`；Node rename 在 Windows 上覆盖同名） */
export async function archiveSettings(file: string, logger?: (m: string) => void): Promise<void> {
  const archived = `${file}.migrated`
  await rename(file, archived)
  logger?.(`旧设置文件已归档：${archived}`)
}

/**
 * 宿主 ConfigEditor 最小结构面（@deepseek-ai/dsh-config-editor 的必要子集；类型面不装）。
 * `edit` = 校验→持久化到 profile patch→Loader reconcile（普通字段会触发插件重载）。
 */
export interface ConfigEditorFace {
  entries(): Array<{ options: { name: string } }>
  edit(entry: unknown, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>
}

/** 迁移结果：生效设置 + 是否已完成「文件 → Config」收编 */
export interface AdoptResult {
  settings: SavedSettings
  /** true = settings.json 已写入 Config 并归档；false = 降级为文件优先内存合并（下次保存重试） */
  migrated: boolean
}

/** 把连接设置写入本插件 Config 条目（仅覆盖 defaultConnection/connections，保留 current 其余字段）；无条目时抛错 */
export async function writeConnectionsToConfig(
  editor: ConfigEditorFace,
  packageName: string,
  next: SavedSettings,
): Promise<void> {
  const entry = editor.entries().find((e) => e.options.name === packageName)
  if (!entry) throw new Error('未在 profile patch 中定位到本插件条目')
  await editor.edit(entry, (current) => ({
    ...current,
    defaultConnection: next.defaultConnection,
    connections: next.connections,
  }))
}

/**
 * 启动期设置收编（0.2.0 存储归一，幂等）：
 * - 无文件（或损坏）→ 生效值 = Config，直接返回；
 * - 有文件 + configEditor 可用 → 把文件值写入本插件 Config 条目（edit 仅覆盖
 *   defaultConnection/connections，保留 current 里其余手改字段），成功后归档文件；
 *   写入会触发 Loader reconcile（插件重载），文件已归档故再次 apply 不再进入本分支；
 * - 有文件 + configEditor 不可用/写入失败 → 降级：文件优先内存合并（0.1.x 行为），
 *   下次保存时重试收编。
 */
export async function adoptOrMigrateSaved(options: {
  file: string
  config: { defaultConnection: string; connections: JenkinsConnectionMeta[] }
  /** 宿主 ConfigEditor（宽松读取；undefined = 服务不存在，直接降级） */
  editor: ConfigEditorFace | undefined
  /** 本插件包名（用于在 entries() 里定位自己的 profile patch 条目） */
  ownPackageName: string
  logger?: (m: string) => void
}): Promise<AdoptResult> {
  const { file, config, editor, ownPackageName, logger } = options
  const saved = await loadSettings(file, logger)
  if (!saved) {
    return { settings: { defaultConnection: config.defaultConnection, connections: config.connections }, migrated: false }
  }
  if (!editor) {
    logger?.('configEditor 服务不可用：settings.json 保持文件优先合并（保存时将重试收编）')
    return { settings: saved, migrated: false }
  }
  try {
    await writeConnectionsToConfig(editor, ownPackageName, saved)
  } catch (err) {
    logger?.(`settings.json 收编失败（${err instanceof Error ? err.message : String(err)}）：保持文件优先合并，保存时将重试`)
    return { settings: saved, migrated: false }
  }
  await archiveSettings(file, logger)
  logger?.(`settings.json 已收编进插件配置（profile patch）：${saved.connections.length} 个连接`)
  return { settings: saved, migrated: true }
}
