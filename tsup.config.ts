import { defineConfig } from 'tsup'

/**
 * dsh-jenkins-panel host 半构建（FIN-M3-01 阶段 1 调整）
 *
 * 原双入口（tsup 直出 host ESM + client ESM）在真实 dsh web 加载时发现：
 * client 半必须以 `window.__ModuleLoader__.load({ id, factory })` 格式交付
 * （dsh client-modules 协议；直出 ESM 被拒——"loaded without registering via
 * __ModuleLoader__.load"）。因此 client 半改由 `scripts/build-client.mjs`
 * （esbuild CJS + 工厂包裹 + CSS 运行时注入）产出；本配置只负责 host 半。
 *
 * host：src/index.ts → lib/index.js（Node ESM；cordis/schemastery/axios 保持 external，
 * 运行时从 profile 的 node_modules 解析——axios 已入 dependencies 自包含）。
 * 命名隔离口径（docs/architecture.md §1/§7）：产物为独立双入口，不含 better-sidebar 任何代码。
 */
const peerExternal = [
  'react',
  'react-dom',
  'axios',
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-client-ui-slots',
]

export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  external: peerExternal,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
})
