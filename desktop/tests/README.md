# 桌面测试分类

`inventory.json` 登记 `.test.mjs`、`.test.ts` 和 `.spec.ts`。`pnpm run test:inventory` 只核对文件与分类，不导入或运行测试；新增、删除、改名及重复登记都会失败。改变用例内容时仍须核对递归夹具和环境分支，不能只凭文件名判断安全范围。

在 `desktop/` 运行命令，实际脚本以 [package.json](../package.json) 为准：

| 分类 | 执行边界 | 入口 |
| --- | --- | --- |
| `safe-node` | Node 内存、SSR、合成文件、回环 HTTP 或合成子进程；部分 macOS 用例编译和签名仓库探针或空程序，不执行探针、不启动 App、不构建产品包。 | `pnpm test` 先类型与登记检查，再运行该明确列表。 |
| `headless` | 无头 Chromium 与 React，使用各用例的合成夹具；不等同于真实 Electron、权限或渠道验收。 | 按登记指定文件，先核对浏览器及夹具；刷新相关窄组可用 `pnpm run test:polling`。 |
| `isolated-http` | 生产 HTTP 边界或文件显式要求的外部证据。 | 核对实际文件和合成数据准备后执行，不对目录无差别 glob。 |
| `native` | 原生进程、真实微信工具或权限现场，按用例实际能力区分。 | `pnpm run test:native` 运行 Swift 合成套件及 CLI 入口回归；真实观察另按[桌面验收](../README.md#桌面验收与自动化测试)。 |
| `app` | Electron 或历史打包前置；登记不证明用例兼容当前开发路径。 | 实际 App 仅使用 `pnpm run dev` 并先 `dev:status`；逐项核对夹具，发布类仍受门禁阻止。 |
| `historical` | 固定旧实现或兼容历史入口。 | 先查[历史测试说明](../../backend-ts/test/HISTORICAL.md)，不从当前树恢复 Python／PG 后台。 |

[默认 runner](../scripts/test-safe.mjs)只传递核准的 `safe-node` 文件；需要编译的 TypeScript 测试使用本轮临时目录并清理。`test:polling` 是窄回归，不代表全部页面覆盖。

[test:pages](../scripts/test-pages.mjs)当前仅保留 `--status`、合成租约探针和旧页面指引，旧 `--case` 组合不会在当前树执行。当前页面测试按 inventory 运行；产品历史候选功能的测试名称不等于退役后台测试。

记忆页面回归由 `memory-processing-entry`、`memory-page-fixed-processing` 与 `sqlite-memory-management-view` 覆盖连接核验、资料展示、编辑与范围失效；旧 `LegacyMemoryPage` 专用夹具随入口删除，主进程控制器和事件用例仍保留。旧条件编辑及全局本人页面不计作当前 SQLite 功能覆盖。

[test:app](../scripts/test-app.mjs)保留明确范围、期限、启动数和互斥参数，`pnpm run test:app:status` 只读占用。自动化参数不要求用户额外预约，也不授权打包或执行与热更新约束不兼容的旧夹具。未知残留须先核对归属，不能删除锁或终止未知进程继续。

记录分别说明静态／合成验证、无头页面、Computer Use、真实原生／微信及模型质量覆盖。任何默认测试通过都不能代签完整桌面业务闭环；本文件是入口说明，不是本轮测试成绩。

## 旧助手协议退役后的覆盖

旧 `/replies/prepare`、`turns/inputs`、候选 `/versions` 分页及独立方向探索没有当前 SQLite 生产者，其专属桌面套件与模拟夹具已退役。历史实现通过固定 Git 树回看，不在当前树重建后端或向正式读取器注入旧协议。保留的业务要求对应下列现行入口；文件存在不代表本轮已执行或真实渠道已验收。

| 保留要求 | 当前测试入口 |
| --- | --- |
| 只读目录与历史，不隐式创建、继续或生成；明确继续后切换当前讨论 | `assistant-session-catalog`、`assistant-session-recovery`、`sqlite-first-session-regression`、`sqlite-discussion-panel`、`sqlite-candidate-history-read` |
| 回看乱序、连接换代、联系人切换与来源撤下后，迟到正文不能复活 | `assistant-session-projection`、`contact-restore-coalescing`、`manual-confirm-session-recovery`、`sqlite-discussion-session`、`sqlite-discussion-source-lifecycle` |
| 删除须核实操作终态，404 不冒充完成；失败可重试，旧连接不能确认新范围 | `assistant-session-deletion-guards`；后台 `sqlite-discussion-deletion` |
| 候选完整消息版本、手工编辑、明确选择、回看与显式携入 | `sqlite-reply-candidate-bridge`、`sqlite-reply-candidates`、`sqlite-candidate-history-read`；后台 `sqlite-reply-candidates` |
| 来源失效同时撤下候选、依据、选稿、草稿与实际 Skill；迟到读取不能恢复 | `sqlite-reply-candidates`、`sqlite-discussion-source-lifecycle`；后台 `sqlite-reply-candidates`、`sqlite-reply-candidate-input-regressions` |
| 独立想法在准备、读取失败、新开与合法范围往返时保留；删除及范围失效清除旧副本 | `sqlite-first-session-regression`、`workspace-local-draft-transition`、`workspace-draft-sqlite-handoff`、`desktop-state-optimization` |
| 编辑独立想法不随累计讨论重传正文；IPC 断档只发一次权威补读 | `reply-input-stream`（10／100／1000 条 SQLite 发言） |
| 历史设置与要求保持原实际输入，不用当前资料补造历史证明 | 后台 `sqlite-reply-input-materials`；桌面 `sqlite-reply-candidates`、`memory-current-status` |
| 长期概览保留推断分类、依据、局限与真实底层版本，不升级为稳定事实 | `sqlite-profile-inference`；后台 `l3-profile-workspace`、`sqlite-memory-documents-reply` |
| 通用 JSON 与真实 HTTP 无损往返大整数，IPC 克隆保留数字类型 | `backend-json-integers` |
| 历史聊天保留引用作者、类型、精确顺序与未知时间；删除或失败撤下正文 | `contact-history-quotes`、`sqlite-history-messages`、`contact-history-controller` |
| 取消实际模型请求须排空；重启恢复保留发送及成本未知事实，迟到提交拒收 | 后台 `sqlite-discussion-generation`、`sqlite-discussion-recovery`、`sqlite-discussion-unknown-abandon`；桌面 `sqlite-discussion-bridge`、`sqlite-reply-candidate-bridge` |

表中的后台文件位于 `backend-ts/test/`，其余位于本目录，均省略 `.test.mjs`。旧任务管理器的准备回执、停止原因及退出身份并非 SQLite 的运行协议；其旧单元断言不作为当前退出或配置重载的验收证据。当前读取的响应字节限制、认证、取消和代次校验继续由 `sqlite-discussion-read` 与正式桥测试覆盖。
