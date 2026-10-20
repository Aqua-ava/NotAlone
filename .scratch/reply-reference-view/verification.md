# 本次参考验证记录

- 实现范围：候选组下方唯一只读入口；默认收起、分类数量、材料原文和来源；不新增调整或模型调用。
- 数据影响：表达样本原文冻结在现有 reply_request.context_snapshot；旧快照保持未知；依附既有来源／样本删除链。
- TDD：SSR唯一入口断言先失败后通过；HTTP冻结字段先失败后通过；桥接冻结原文断言先失败后通过。
- 后端相关 HTTP：style_reference_api、style_samples、reply_evidence_api，共25项通过。
- 桥接和真实DOM：recovered-evidence.test.mjs 6项通过（系统Chrome，公开Main/preload合成夹具）。
- SSR：unified-workspace-view.test.mjs 5项通过；TypeScript通过。
- 开发App：复用 npm run dev 实例，通过Computer Use选取已有合成验收联系人，读取其历史候选，验证唯一入口、初始收起、展开、来源及再次收起；未生成、复制或发送消息。
- 浏览器：未创建工作标签；用户已有标签保留。页面测试自有无头Chrome由测试清理。
- Standards：未发现阻断规范问题；部分失败方法回执应显示名称的建议已落实。
- Spec：未发现范围缺失；目录文案误称其余均未读取已修正。
- 全桌面 npm test：213项中212通过；唯一headless command状态断言与同时运行页面租约冲突，租约清理后单独复验command.test.mjs，11项全通过。
- 扩展页面：reply-evidence 9子场景、layered-reply、conversation-strategy-entry通过；overview、historical、memory-current-status未通过；后两者分别在新入口前历史提示、生成前记忆状态文案处失败。
- overview页面历史过期资料断言失败：捕获快照不含该资料，HEAD旧面板渲染同样缺失；不修改召回。
- 后端全量：600秒有界运行遇大量失败，正在停止并最小复现，未认证全量通过；原persistence模块start失败已用HEAD原实现单例复现。
- 保留用户已有drawio删除与name-matching-foreground-http.test.mjs；不推送、不打包。

- 本地提交：c4b8fae4；未推送。
- 未运行：迁移选择器后的source-deletion-page-scenarios及manual-first-release发布场景，未打包。

### 后端全量停止与最小归因补记

- 仅运行一次：`perl -e 'alarm 600; exec @ARGV' -- $HOME/miniconda3/envs/NotAlone/bin/python -m unittest discover -s backend/tests -t backend -v`，日志 `/tmp/notalone-reference-backend-full.log`。大量失败后按协调要求发送 SIGINT，未等待 alarm；未完成全量、没有最终 unittest 汇总，不能宣称通过。
- 中断前逐行已观察到至少 521 个 ok、30 个 FAIL、200 个 ERROR、25 个 test 行 skipped；部分用例自身打印多行，因此这不是完整总计。
- 最小复现：`tests.integration.front_sync.test_front_sync_end_to_end.FrontSyncEndToEndTest.test_cli_failure_and_probe_failure_fail_closed` 在第 796 行期望 ACTIVE，实际 FAILED；将本次三个后端改动模块的固定基线 `dacf658be8da564293f91633aeaa068fd9555c7b` 源码载入后复跑，同处同错。证据 `/tmp/notalone-reference-full-minimal.log`、`/tmp/notalone-reference-full-head-minimal.log`。此前 persistence start 单例也已证实基线同错；其余全量失败没有逐项归因，不统称基线。
- 本任务相关三个 HTTP 模块仍是 25 项通过，独立于以上未完成全量，日志 `/tmp/notalone-reference-backend-http-tests.log`。
- 全量 Python PID 7192 已退出，无本轮全量进程存活。SIGINT 落在 `server.shutdown()` 清理阶段，最后一组 class cleanup 是否执行未确认。只读数据库目录发现 14 个 `notalone_core_flow_*_test` 测试库；本次全量未产生数据库归属记录，无法可靠区分历史残留与并行页面测试，故未删除未知归属测试库。未读取私人库或正文，未修改产品代码。
