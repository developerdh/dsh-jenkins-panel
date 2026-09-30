/**
 * app.asar 内文件速查（开发期排查工具，不参与构建/测试）
 *
 * 用途：DSH 宿主是打包好的 `app.asar`，排查宿主行为（槽位渲染、模块系统、
 * 缓存策略等）时用它按路径取文件内容或正则片段，无需解包整个 asar。
 *
 * 用法：
 *   node scripts/peek-asar.mjs <asar 内路径> [正则]
 *   node scripts/peek-asar.mjs "dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js" "artifactRevision"
 *   node scripts/peek-asar.mjs "dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js"      # 打印文件开头
 *
 * 默认 asar 路径可用环境变量 DSH_ASAR 覆盖（不同安装位置时）。
 */
import { readFileSync } from 'node:fs'

const ASAR = process.env.DSH_ASAR ?? 'D:\\Programs\\dsh\\resources\\app.asar'
const want = process.argv[2]
const pattern = process.argv[3]

if (!want) {
  console.error('用法：node scripts/peek-asar.mjs <asar 内路径> [正则]')
  process.exit(1)
}

const fd = readFileSync(ASAR)
const headerSize = fd.readUInt32LE(12)
const base = 16 + headerSize
const header = JSON.parse(fd.subarray(16, base).toString('utf8'))

/** 在 asar 头部的文件树里按路径找节点 */
function find(node, path) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      const hit = find(child, path ? `${path}/${name}` : name)
      if (hit) return hit
    }
    return null
  }
  return path === want ? node : null
}

const node = find(header, '')
if (!node || typeof node.offset !== 'string') {
  console.error(`未找到：${want}（asar 内路径以 dsh/node_modules/... 开头）`)
  process.exit(1)
}

const start = base + Number(node.offset)
const text = fd.subarray(start, start + node.size).toString('utf8')

if (!pattern) {
  console.log(text.slice(0, 4000))
} else {
  const re = new RegExp(pattern, 'g')
  let match
  let hits = 0
  while ((match = re.exec(text))) {
    hits++
    console.log(`--- @${match.index}`)
    console.log(text.slice(Math.max(0, match.index - 400), match.index + 700))
  }
  console.log(`\n[hits] ${hits}`)
}
