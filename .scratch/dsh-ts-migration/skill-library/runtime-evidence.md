# 06 运行与删除闭包证据

2026-10-24；仅合成目录、随机隔离PG库与确定性端口。未调用真实模型、未读私人Skill、未操作微信或实际App。官方profile/公开HTTP及App验收由主协调集成后执行，本证据不替代该层。

## 锁版依据

- `@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-scope` 均为 `0.2.1-rc.2`；官方固定提交 `687f282e8625c6b8d11ff58211a90524be2e4317`。
- [官方Skill registry](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill/src/index.ts)：registerProvider控制信号/失效/释放、snapshot/get按scope选层。测试真实加载已安装官方Cordis与registry，业务provider是普通薄适配。
- [官方scope](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/scope/src/index.ts#L137)：createScope创建每轮注册上下文，dispose释放该层；测试按官方 `packages/skill/skill/tests/skill.spec.ts:1109` 的 `scope.ctx.get('skills')` 获取scope服务，不访问框架私有字段。
- 这些是官方真实registry/scope合同测试，不是完整DSH profile运行证据，不以自建Harness替代官方runtime。

## 原业务合同对照

- `backend/src/notalone/reply/adapters/langchain_runtime.py:378`：一次至多一版本，成功资源路径去重；`:485` 正文每页带版本UUID，`:487` 资源整份UTF-8、不按页裁切。
- `:1122` 资源失败仍核对已尝试版本或null，最后成功Skill为null。TS仅受控文件/UTF-8错误且当前资格复验成功时返回原提示；取消、撤资格、未知错误均终止。实际尝试版本与成功使用回执分开，避免将失败读取标作成功。
- `backend/src/notalone/persistence/skill_learning.py:316,323,341`：任务取消、草稿/批次摘要擦除、来源撤销；`skill_review.py:369`：审核正文/指纹/发布失效、版本擦除、同事务广范围回复清理。TS沿相同列更新，05回调必须使用同一client，缺失或失败由外层事务回滚。
- `skill_files.py:437,502`：撤资格事务登记文件队列，提交后擦除；失败发布隐藏快照与无待办暂存入队，合法历史和用户工作目录保留。新增回收同时检查owner和当前content_path，已删除/空定位残留亦排队。

## 已运行

固定Node：`$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`。

- `node --test backend-ts/test/skill-runtime.test.mjs backend-ts/test/skill-runtime-provider.test.mjs`：正文分页及空页回执、全资源、0/1版本、路径拒绝、完整port回执、取消/迟到结果、文件失败/资格撤销差异、官方scope隔离与释放。13项已分别通过。
- `node --test backend-ts/test/skill-cleanup.test.mjs backend-ts/test/skill-runtime*.test.mjs`：合并20/20通过（7项真实隔离PG、13项运行/官方registry）。含跨联系人递归发布撤销、回调缺失/异常全事务回滚、文件队列owner隔离与失败重试。后补合法历史与已删除空定位残留断言，相关单项再次通过。
- `node --test --test-name-pattern='来源删除擦除学习批次' backend-ts/test/skill-cleanup.test.mjs`：新增批次摘要/任务取消/成功步骤保留/其他owner保留1项通过。
- `node backend-ts/node_modules/typescript/bin/tsc --noEmit -p backend-ts/tsconfig.json`：本轮曾通过；最终共享树复验受并行新增 `model-input-budget.ts` 的unknown类型错误影响，未改其他票文件，已报告主协调。

## 当前未完成验证

新增失败发布残留清理测试首次因并行迁移108/宿主107不一致未进入业务；主协调统一更新严格门禁后，已重跑单项和本范围合并20项通过。未绕过门禁。

05真实`deleteSourceReplies`的完整回复/讨论派生清理尚需集成验证；当前递归测试验证的是本模块同事务回调合同及真实PG发布链。更新备份闭包和官方profile/公开HTTP/App仍由主协调执行，不宣称本票完成。
