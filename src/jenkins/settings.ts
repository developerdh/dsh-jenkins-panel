/**
 * 连接设置持久化（CLIENT-M2-07 修复：V5 路径 1 的 dsh-settings wire 在实测中新增不落
 * describe/跨刷新丢失，改走**自建 host 路由 + JSON 文件**（better-sidebar 同款 Path 2，
 * probe V5 建议“无 loopback 限制、更稳”）。
 *
 * 文件：`<profile 数据目录>/dsh-jenkins-panel/settings.json`，形状 `{ defaultConnection, connections }`
 * （token 不在此；凭据仍走 dsh credential-ref，V4 方案 A）。
 * - 启动：`load(registryFile)` 读取并**合并**插件 Config（文件优先，提供跨重启持久化）；
 * - 保存：`save(registryFile, settings)` 原子写（同目录 `.tmp` + rename，与 registry.ts 同语义）；
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
