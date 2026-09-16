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
 *   node scripts/export-public.mjs                          # 导出 HEAD 并前移本地 public 分支
 *   node scripts/export-public.mjs --push                   # 导出后推送 github 远端（public:main + 版本 tag）
 *   node scripts/export-public.mjs --remote gh              # 指定远端名（默认 github）
 *   node scripts/export-public.mjs -m "feat: ..."           # 策划公开提交信息（首个 -m 为主题，其余为正文段落）
 *   node scripts/export-public.mjs -n "版本说明..."          # 策划 Release 说明（写入附注 tag，Actions 组装进 Release 正文）
 *   node scripts/export-public.mjs <内部提交>               # 导出指定内部提交（重建快照链用）
 *
 * 提交信息口径：面向公众的人工策划文案（推荐），不携带内部提交 subject / 任务编号；
 * 缺省为中性 release 风格。正文固定追加 `Snapshot-Of-Internal: <内部短哈希>` trailer——
 * 公开仓中该对象不存在、无信息量，仅供维护者对照内部状态。
 *
 * 首次使用前：git remote add github <你的GitHub仓库地址>
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/* ── 参数 ──────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2)
const messages = [] // -m/--message 收集：首个为主题，其余为正文段落
const notes = [] // -n/--notes 收集：版本 tag 附带的 Release 说明（首个为主题，其余为段落）
let REMOTE = 'github'
let target // 位置参数：要导出的内部提交（缺省 HEAD）
let doPush = false
let tagEnabled = true
let releaseTag
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--remote') REMOTE = argv[++i]
  else if (a === '-m' || a === '--message') messages.push(argv[++i])
  else if (a === '-n' || a === '--notes') notes.push(argv[++i])
  else if (a === '--push') doPush = true
  else if (a === '--no-tag') tagEnabled = false
  else if (a.startsWith('-')) throw new Error(`未知参数：${a}`)
  else target = a
}
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

const targetRef = target ?? 'HEAD'
const headShort = git(['rev-parse', '--short', targetRef])

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
  git(['read-tree', targetRef], { env: envWithIndex })
  for (const path of EXCLUDE_PATHS) {
    const exists = git(['ls-tree', '--name-only', targetRef, '--', path], { env: envWithIndex })
    // -f：临时 index 与 HEAD 的缓存内容必然不同（导出目标≠HEAD 时），git 的防丢数据检查在此是误报；
    // 索引是一次性临时文件，--cached 移除不损失任何对象。
    if (exists) git(['rm', '-r', '--cached', '-f', '-q', path], { env: envWithIndex })
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
  // 公开提交信息 = 人工策划（-m，首个为主题其余为正文），缺省中性 release 风格；
  // 不携带内部提交 subject / 任务编号。正文固定保留内部短哈希 trailer 供维护者对照。
  const stamp = new Date().toISOString().slice(0, 10)
  const subject = messages[0] ?? `chore(release): snapshot ${stamp}`
  const body = [...messages.slice(1), `Snapshot-Of-Internal: ${headShort}`]
  const commitArgs = ['commit-tree', tree, '-m', subject]
  for (const paragraph of body) commitArgs.push('-m', paragraph)
  if (parentRef) commitArgs.push('-p', parentRef)
  const commit = git(commitArgs, { env: envWithIndex })
  git(['update-ref', `refs/heads/${LOCAL_BRANCH}`, commit])

  console.log(`[export-public] ✓ ${headShort} → public 快照 ${commit.slice(0, 10)}（父：${parentRef ? parentRef.slice(0, 10) : '无，首例'}）`)
  console.log(`[export-public] ✓ 快照顶层：${topLevel.join(' ')}`)

  /* ── 版本 tag：给快照打 v<package.json version>，触发 GitHub Actions 构建 Release ──
   * 同版本重复导出：tag 已指向本快照 → 跳过；指向别的快照 → 警告不动（发新版请升版本号）。
   * --no-tag：重建快照链时使用，避免中间快照被误打 tag。 */
  if (tagEnabled) {
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version
    releaseTag = `v${version}`
    const tag = releaseTag
    const existing = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { encoding: 'utf8' })
    if (existing.status !== 0) {
      // 附注 tag：tag message 即 Release 说明（-n 策划；缺省一行），Actions 据此组装 Release 正文
      const tagSubject = notes[0] ?? `Release ${tag}`
      const tagArgs = ['tag', '-a', tag, commit, '-m', tagSubject]
      for (const paragraph of notes.slice(1)) tagArgs.push('-m', paragraph)
      git(tagArgs)
      console.log(`[export-public] ✓ 已打 tag ${tag} → ${commit.slice(0, 10)}（push 后触发 Actions 构建 Release）`)
    } else if (existing.stdout.trim() !== commit) {
      console.warn(`[export-public] ⚠ tag ${tag} 已指向另一快照（${existing.stdout.trim().slice(0, 10)}），未移动；发布新版本请升 package.json version`)
    } else {
      console.log(`[export-public] tag ${tag} 已在本快照，跳过`)
    }
  }

  /* ── 推送 ──────────────────────────────────────────────────────── */
  if (doPush) {
    git(['push', REMOTE, `${LOCAL_BRANCH}:${TARGET_REF}`])
    if (releaseTag) git(['push', REMOTE, `refs/tags/${releaseTag}`]) // 已是最新时 up-to-date 无害；pre-push 钩子会校验 tag 指向 docs-free 快照
    console.log(`[export-public] ✓ 已推送 ${LOCAL_BRANCH} → ${REMOTE}/${TARGET_REF}${releaseTag ? ` 及 tag ${releaseTag}` : ''}`)
  } else {
    console.log(`[export-public] 未推送。确认后执行：git push ${REMOTE} ${LOCAL_BRANCH}:${TARGET_REF}${releaseTag ? ` 与 git push ${REMOTE} refs/tags/${releaseTag}` : ''}`)
  }
} finally {
  rmSync(indexFile, { force: true })
}
