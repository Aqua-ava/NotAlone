# 票 08 DSH 与讨论连续性核验

日期：2026-10-25

## 结论

- DSH 只承载单次、已核验范围的临时 Agent 运行；用户可见讨论、输入版本、候选版本、显式选择和删除决定只保存在 PostgreSQL。
- 每次生成使用新随机 DSH Session ID，完成、取消或失败后调用公开 `dispose()`；正常重开 App 不恢复旧 DSH Session、JSONL 或内部 checkpoint，而是从业务表重新组装本次上下文。
- 讨论内部 CRUD 不创建 DSH Session，也不调用模型；准备、生成、替换和续答继续由原 Python 会话 authority 编排，TS 只接管讨论业务状态。
- DSH 默认 `sdk-minimal` 自带 JSONL 持久化和自动压缩，会形成产品不需要的第二份长期会话副本，也可能触发过程摘要，因此不直接采用；NotAlone profile 保持临时 Session，业务历史由 PostgreSQL 负责。

## 锁定版本与来源

- 版本：`@deepseek-ai/dsh-root 0.2.1-rc.2`
- commit：`687f282e8625c6b8d11ff58211a90524be2e4317`
- 官方源码快照：`/tmp/notalone-dsh-official-687f282`（目录不含 `.git`；版本读取自 `package.json`，commit 使用本次锁定交付记录）
- `backend-ts/package.json` 固定 `@deepseek-ai/dsh*` 为 `0.2.1-rc.2`，未在运行时安装其他版本。

核验文件及 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `package.json` | `12bb41cd8212021a784b33a20c2b84372189a9505b42081d5e3869e21ff5cffc` |
| `packages/core/agent/README.md` | `652a3283721fb5b52f0671c43d458b04c039d5bfe7e900894cc0f64229b68641` |
| `docs/agent-lifecycle.md` | `3f4a7e406d7e150752680f6b8a1ebc7b823c5c0bab3afca052e64bc7055e32e8` |
| `packages/core/session/README.md` | `f9f43d36c4df64279ca8e1fa1baad1c67cd003c5d79fe26cfe5887057a8ab584` |
| `packages/bundle/sdk-minimal/README.md` | `c88ec05c6198bd975fb795788920a54846f4f9ab51e20ab124c4b89635e528d7` |
| `packages/bundle/sdk-minimal/cordis.patch.yml` | `464ea07c03d3639c2c387fa3a684f5d4001e7ca39f8257b361c604f19487af66` |

## 官方接口核验

- `packages/core/agent/README.md:32,40,47,58,107,117` 明确：`ctx.agents.create()` 创建新的 live Agent 与 Session；公开 `cancel()` 中止当前活动，`whenIdle()` 等待整个 Agent 静止，`handle.dispose()` 停止并排空 loop、注销 Agent、移除 Session、展开作用域。`AgentHandle` disposer 是唯一公开 teardown capability。
- `packages/core/agent/README.md:174-178` 明确：取消默认清空队列；`dispose()` 是完成后清理临时状态的正规入口；跨进程身份和恢复不能依赖进程内 initiator scope。
- `docs/agent-lifecycle.md:6,83,85,89` 明确：`session/event` 是持久回放事实，`agent/*` 是实时协调；未结算的 stream 不是可靠恢复来源；模型端历史应由业务选择，不能把临时 Agent 事件当作长期关系记忆。
- `packages/core/session/README.md:12,28,86,100` 明确：Session 默认只在内存，持久化需要额外 backend；事件日志与派生历史用于可重建请求，不能替代 NotAlone 的业务讨论和删除决定。
- `packages/bundle/sdk-minimal/README.md:12,51,85,97` 与 `cordis.patch.yml:64-68,168-172` 明确：该 profile 默认启用 JSONL Session 持久化和自动 context compaction。直接采用会额外落盘完整 DSH 会话并在超限时自动摘要，违反本票“不自动摘要且不保存长期运行副本”的边界。

## NotAlone 适配

- `backend-ts/src/reply-loop.ts`、`exploration-runtime.ts` 和 `reply-preflight.ts` 每次请求生成新的随机 Session ID，公开使用 `whenIdle()`、取消信号和 `dispose()`，没有 resume 旧 DSH Session。
- `backend-ts/src/assistant-discussion-service.ts` 的会话、输入、版本、选择、携入、中断和删除只操作 `assistant_session*`、`reply_request`、`reply_candidate*` 等 PostgreSQL 记录；不接收 DSH Session ID。
- 业务中断先把对应 turn/request 置失败并写入 `reply_invalidated_key`；迟到结果经 `ReplyStore` 的失效键检查被拒绝。删除讨论还清理请求、候选、学习依赖、可恢复更新备份和 Skill 文件清单，后代携入只保留精确身份并在源删除后显示不可用占位。
- 重开使用已有业务 UUID，构造新的临时 DSH 运行状态。DSH 运行结束即释放作用域和 Session，不读取旧 JSONL/checkpoint，也不把上一轮 Agent 状态自动注入下一轮。

## 实际验证

- `node --test test/assistant-discussion-service.test.mjs test/assistant-discussion-http.test.mjs`
- `node --test test/reply-store.test.mjs`
- `node --test test/main-host-reply-chain.test.mjs`
- `node --test --test-name-pattern='B5-03' test/reply-arbitration-handover.test.mjs`
- 桌面控制器：`assistant-session-catalog`、`assistant-session-projection`、`assistant-session-deletion-guards`
- 公开生成/退出控制：`contact-generation-jobs-http`（15 项通过，包含中断、迟到结果和删除许可）
- `assistant-generation-quit-http` 在 10 分钟上限内未完成，终止后不记为通过；完整退出矩阵仍应由根验收任务复跑。

验证确认：内部讨论入口拒绝公开 token 和无 token；TS→Python→TS 重开保留编辑、显选与删除，模型 HTTP 增量为 0；会话删除后的迟到保存被失效键拒绝；来源清理后原文为 `NULL`，重开只显示删除占位。

## 根端 CUA 验收矩阵

实际 App/微信由根 Agent 独占验收；以下步骤只使用已确认的合成测试联系人和会话，不发送外部消息：

1. 从目标工作树先运行 `cd desktop && npm run dev:status`；无实例才按工程工作流后台启动 `npm run dev`，再查状态并记录自有 PID。
2. 在管理后台打开输入小窗，选择已确认的合成联系人，完成一次候选生成；编辑候选后显式选择一个版本，确认界面显示该版本而非“最近候选”。
3. 通过菜单正常退出并重新启动开发 App；重新进入同一讨论，核对原会话 UUID、输入、候选编辑、显式选择均可见，且没有新的模型调用或自动摘要。
4. 生成期间触发中断或正常退出；重开后核对失败/中断状态可见，重复提交不新增第二个请求，不自动继续运行。
5. 删除该讨论，核对输入入口为空白、不会自动重建旧讨论；等待/触发一次迟到结果，确认不能恢复候选正文。
6. 使用已授权的合成来源触发清理；核对依赖该来源的讨论显示删除占位，独立讨论保持可用，原始正文不可从界面或重读恢复。
7. 结束本轮自有 App，再次运行 `dev:status`；记录 App、监督器、Legacy/DSH/Python、临时目录和数据库的清理结果。

本次尝试记录：`dev:status` 初始为 stopped；后台开发实例成功编译并报告 App ready，管理后台可见，但显示“数据库暂时不可连接”，点击重新检查仍未恢复。按任务边界未继续调试真实 App；已通过父开发监督器正常退出，最终 `dev:status` 为 stopped，未操作微信、未发送消息。真实 App 根端验收仍未完成。
