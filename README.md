# dsh-jenkins-panel

Jenkins CI/CD integration plugin for [DeepSeek Harness](https://www.deepseek.com) (dsh)：让 dsh 里的 AI 直接触发、跟踪、排查 Jenkins 构建，并提供一个官方右侧栏可视化面板。

> Jenkins CI/CD integration plugin for DeepSeek Harness (dsh): AI-invocable `jenkins_*` tools, an official right-sidebar panel, connection & token settings card, and automatic build-failure analysis pushed back into the triggering session.

## 功能

- **AI 工具（host 半）**：22 个 `jenkins_*` 工具对模型可见——构建触发/状态/日志/历史/产物、任务搜索与智能解析（多候选停下询问）、队列/工作空间/连接测试等；触发成功自动写入触发记录注册表（持久化，跨重启保留）。
- **右侧栏面板（client 半）**：接入 dsh 官方右侧栏，含总览（对话触发的构建记录 + 状态过滤实时刷新）、任务（多连接切换 + 多层级折叠树 + 搜索）、构建详情（日志 tail/分段/自动跟随、产物下载、工作空间清理）。
- **失败自动分析**：对话触发的构建失败（FAILURE）后，自动向触发会话回推一条分析任务书，由会话内 AI 只读排查日志并输出结构化失败总结（结论 / 关键报错 / 可能原因 / 修复建议）。可在配置中关闭。
- **连接与凭据**：多 Jenkins 连接管理走 dsh 官方设置页分区；每连接 Token 存 dsh 凭据服务（credential-ref），明文不落配置。

## 安装

前置：dsh 0.1.5+（web profile）。

```sh
# npm 发布版（推荐，构建产物随包分发）
dsh plugin --profile <name> add dsh-jenkins-panel@<version>
```

也可以直接从 GitHub 安装（仓库内 `prepare` 脚本会在安装时自动构建）：

```sh
npm install github:developerdh/dsh-jenkins-panel
```

安装后在 dsh 设置页「Jenkins 连接」分区配置连接（URL/用户名/超时）与每连接 Token，重载页面即可在右侧栏与顶部栏入口看到面板。

## 配置速览

| 配置段 | 默认值 | 说明 |
|---|---|---|
| `defaultConnection` | `default` | 缺省连接名 |
| `connections` | `[]` | 连接清单（name/url/username/timeout；name 参与凭据 ref 派生，需唯一） |
| `registry.maxPerSession` | `200` | 每会话保留的触发记录条数 |
| `registry.ttlDays` | `30` | 触发记录保留天数 |
| `registry.pollIntervalMs` | `15000` | 在途构建状态轮询间隔 |
| `analysis.enabled` | `true` | 构建失败自动分析总开关（含常驻轮询） |
| `analysis.tailLines` | `100` | 分析任务书建议的首拉日志行数 |

## 本地开发

```sh
pnpm install
pnpm build      # host 半（tsup）+ client 半（esbuild → ModuleLoader 协议产物）
pnpm test       # vitest 单测
pnpm lint       # eslint
pnpm typecheck  # tsc 双 tsconfig
```

挂载调试：`cordis.patch.yml` 向 profile 组合插入本插件（`dsh web --patch ./cordis.patch.yml`）。

## License

[MIT](./LICENSE)
