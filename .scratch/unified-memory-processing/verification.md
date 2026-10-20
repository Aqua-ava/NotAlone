# 验收记录

## 自动验证

- `cd desktop && npm run typecheck`：通过。
- `cd desktop && node --test tests/memory-processing/*.test.mjs`：20 项通过。
- 先记录失败回归，再修复：排队掩盖失败、空任务残留错误误报完成、来源不可用与执行中混合提示。
- `cd backend && PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" python -m unittest tests.integration.server.test_observation_auto_flow.ObservationAutoFlowTest.test_replayed_batch_does_not_reset_completed_task -v`：通过。
- 同类另外三例 `test_running_duplicate_events_do_not_add_an_execution_round`、`test_failed_task_only_requeues_on_new_batch_and_keeps_retry_budget`、`test_observation_does_not_run_an_older_import_task`：通过。
- `cd desktop && perl -e 'alarm 600; exec @ARGV' -- npm test`：212/213 通过。
- 唯一失败 `tests/headless/command.test.mjs` 的“页面入口公开状态明确不启动 Electron”：既有页面测试租约返回 `needs-owner-verification`，用例预期 `absent`；单例复跑同样失败。未修改或清理其他任务租约。

## 实际 App

- 通过 `npm run dev:status` 核验并复用开发实例及监督器，没有启动第二份或打包版。
- Computer Use 点击记忆页：主栏显示“记忆处理需要继续”、保存进度说明、“继续处理”和“查看详情”。
- 展开详情核对同步资料及历史导入各自真实进度；再收起，主栏无任务列表。
- 未对真实资料点击继续处理；批量恢复及部分失败行为使用合成 HTTP/生产桥接验证。
- 只读排队任务元数据，确认是旧同步资料尚未完成提取；没有发现无资料却虚构任务的证据，未修改后台排队策略。
- 未读取或输出聊天正文，未修改真实资料、同步授权或发送外部消息。未对微信渠道重新认证端到端能力。
- 无新增常驻服务或浏览器工作页；合成测试浏览器由夹具关闭，最终标签页清单保持原有页面。

## 审查

- Standards：已解决读取截断误判，复审无剩余阻塞。
- Spec：已解决来源不可用、空列表及混合运行状态提示，复审无剩余阻塞。
- 保留工作区既有其他改动，只提交本次状态栏、回归与规格记录。
