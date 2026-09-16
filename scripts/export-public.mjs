#!/usr/bin/env node
/**
 * 公开仓库导出脚本（孤儿快照链）
 *
 * 用途：把当前 HEAD 导出为一份「剔除 docs/ 的孤儿提交」挂到本地 public 分支链上，
 * 推送到 GitHub 公开仓库。cnb 私有仓保持完整历史与 docs 跟踪，零改动。
 *
 * 原理：
 *   1. 用临时 index 读入 HEAD 的树，剔除 docs/ 后 write-tree；
 *   2. commit-tree 生成新提交，父提交 = 上一次导出提交（refs/heads/public，无则为首例）；
 *   3. update-ref 前移 public，再 push 到 github 远端（public:main，恒为 fast-forward）。
 *
 * 安全属性：
 *   - 与内部历史零血缘：GitHub 上翻不到 docs/ 的任何版本；
 *   - 导出前校验快照树不含 docs/（含即中止）；
 *   - 工作区有未提交变更时警告（导出对象是 HEAD 提交，不是工作区）。
 *
 * 用法：
 *   node scripts/export-public.mjs                # 导出并前移本地 public 分支
 *   node scripts/export-public.mjs --push         # 导出后推送 github 远端（public:main）
 *   node scripts/export-public.mjs --remote gh    # 指定远端名（默认 github）
 *
 * 首次使用前：git remote add github <你的GitHub仓库地址>
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/* ── 参数 ──────────────────────────────────────────────────────────── */
const args = process.argv.slice(2)
const argOf = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const hasFlag = (flag) => args.includes(flag)
const REMOTE = argOf('--remote') ?? 'github'
const LOCAL_BRANCH = 'public'
const TARGET_REF = 'main'
const EXCLUDE_PATHS = ['docs'] // 公开仓排除的顶层路径（历史遗留敏感面）

/* ── git 助手 ──────────────────────────────────────────────────────── */
function git(gitArgs, options = {}) {
  const result = spawnSync('git', gitArgs, {
    encoding: 'utf8',
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`git ${gitArgs.join(' ')} 失败（exit ${result.status}）：${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

const headShort = git(['rev-parse', '--short', 'HEAD'])

/* 工作区未提交变更 → 提醒（不中止：导出的是 HEAD，不是工作区） */
const dirty = git(['status', '--porcelain'])
if (dirty) {
  console.warn('[export-public] ⚠ 工作区有未提交变更，本次导出的是 HEAD 提交（建议先提交再导出）：')
  for (const line of dirty.split('\n').slice(0, 10)) console.warn(`  ${line}`)
}

/* ── 临时 index：HEAD 树剔除 docs/ ─────────────────────────────────── */
const indexFile = join(mkdtempSync(join(tmpdir(), 'dsh-jenkins-export-')), 'index')
const envWithIndex = { ...process.env, GIT_INDEX_FILE: indexFile }
try {
  git(['read-tree', 'HEAD'], { env: envWithIndex })
  for (const path of EXCLUDE_PATHS) {
    const exists = git(['ls-tree', '--name-only', 'HEAD', '--', path], { env: envWithIndex })
    if (exists) git(['rm', '-r', '--cached', '-q', path], { env: envWithIndex })
  }
  const tree = git(['write-tree'], { env: envWithIndex })

  /* 安全闸：快照树不得含排除路径 */
  const topLevel = git(['ls-tree', '--name-only', tree]).split('\n')
  const leaked = topLevel.filter((name) => EXCLUDE_PATHS.includes(name))
  if (leaked.length > 0) {
    throw new Error(`快照树仍包含排除路径：${leaked.join('、')}（中止，未生成提交）`)
  }

  /* ── 孤儿链：父提交 = 上一次导出提交 ───────────────────────────── */
  const parent = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${LOCAL_BRANCH}`], {
    encoding: 'utf8',
  })
  const parentRef = parent.status === 0 ? parent.stdout.trim() : undefined
  // 公开提交信息不携带内部提交 subject（避免内部命名随发布外泄）；
  // 短哈希在公开仓中无对应对象、无信息量，仅作内部对照。
  const stamp = new Date().toISOString().slice(0, 10)
  const commitArgs = ['commit-tree', tree, '-m', `chore(public): snapshot of internal ${headShort} at ${stamp}`]
  if (parentRef) commitArgs.push('-p', parentRef)
  const commit = git(commitArgs, { env: envWithIndex })
  git(['update-ref', `refs/heads/${LOCAL_BRANCH}`, commit])

  console.log(`[export-public] ✓ ${headShort} → public 快照 ${commit.slice(0, 10)}（父：${parentRef ? parentRef.slice(0, 10) : '无，首例'}）`)
  console.log(`[export-public] ✓ 快照顶层：${topLevel.join(' ')}`)

  /* ── 推送 ──────────────────────────────────────────────────────── */
  if (hasFlag('--push')) {
    git(['push', REMOTE, `${LOCAL_BRANCH}:${TARGET_REF}`])
    console.log(`[export-public] ✓ 已推送 ${LOCAL_BRANCH} → ${REMOTE}/${TARGET_REF}`)
  } else {
    console.log(`[export-public] 未推送。确认后执行：git push ${REMOTE} ${LOCAL_BRANCH}:${TARGET_REF}`)
  }
} finally {
  rmSync(indexFile, { force: true })
}
