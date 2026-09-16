# e2e（面板挂载）

真实浏览器 e2e（FIN-M3-02 阶段 4）。**归用户环境运行**：依赖运行中的 dsh web（默认
`http://127.0.0.1:3080`）且 dsh-jenkins-panel 已安装（`FIN-M3-01` 完成后），本仓库构建/单测/tsc
均不触碰本目录（`tests/**/*.spec.ts` 不被 vitest 收录；`tests/e2e` 已从 tsconfig.json exclude）。

> 0.1.5：面板迁入官方右侧栏后，**better-sidebar 互斥用例（`mutex.spec.ts`）与探针
> （`mutex-verify.mjs`）已删除**——列内多 tab 由官方统一协调，插件不再探测/操作其它插件 DOM，
> 以官方方案为准。面板宽度（含拖拽调宽）同理由官方列几何承担。

## 前置

1. **安装插件**：`FIN-M3-01` 打包发布完成，`dsh plugin add` 安装 dsh-jenkins-panel 到 3080 实例
   （未安装时挂载用例将明确失败）。
2. **依赖**：`@playwright/test` 已在 devDependencies（安装时 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
   跳过浏览器下载；e2e 复用本机已装浏览器）。
3. **浏览器**：本机装有 Edge / Chrome（配置默认 `channel: 'msedge'`，可用
   `PLAYWRIGHT_CHANNEL=chrome` 切换）。

## 运行

```bash
pnpm exec playwright test --config tests/e2e/playwright.config.ts
# 单文件
pnpm exec playwright test --config tests/e2e/playwright.config.ts mount
# 有头模式（便于观察面板开合动画）
HEADLESS=0 pnpm exec playwright test --config tests/e2e/playwright.config.ts mount
```

## 用例清单

| 文件 | 场景 | 验收点 |
|---|---|---|
| `mount.spec.ts` | 面板挂载（安装态） | 宿主/入口挂载、开合 + body 信号、官方列几何（插件不写宽度/`#root`）、窄视口、总览/任务 tab 切换、设置分区存在 |

## 说明

- 面板本体由官方右侧栏 tab body 承载（`sidebar.right.pane.tab`）；开合走 `ctx.sidebarRight`
  （打开 = openTab、关闭 = toggleExpanded），宽度/定位/resize handle 由官方列几何承担。
- 插件不再自绘宽度（`--dsh-jenkins-panel-width` / resize-grip 已移除）、不再写 `#root` 推挤、
  不再探测其它插件 DOM。
