# 08 验收阻碍修复：既有绑定读取前复验私聊范围

日期：2026-10-23。合成验证与真实微信证据分别记录。

## 原因与行为

真实元数据核验中，24 个既有自定义账号会话有 21 个返回唯一 `private`，另 3 个被锁定 CLI 分类为 `official_account`。仅在新增发现时筛选私聊不足以约束旧绑定；不能自行放宽上游分类。

所有历史和增量正文读取统一先执行 `resolve-chat <已绑定稳定身份> --strict-read-only`，只接受唯一、同稳定身份且类型为 `private` 的候选。明确群聊或公众号返回 `cli_chat_not_private`；空、歧义、身份不符或未知类型返回 `cli_scope_unverified`；CLI 异常保留原稳定码。门禁失败不执行 `tail`，保留绑定、资料和检查点，其他绑定继续。

元数据核验最多一秒，与后续正文读取共享现有总预算。范围冲突每五分钟只复验元数据；技术错误指数退避。停读原因在等待期间持续显示，成功复验或撤销后清除；没有历史状态的旧增量绑定也有汇总及当前联系人提示。

范围拒绝把已有覆盖标为不完整，但保留既有 `completed_at` 证明。再次核实私聊后，仅恢复此前确实完成的覆盖并继续增量；普通未完成历史仍须继续分页。无迁移、账本或既有数据重写。

## TDD 与验证

Python 命令统一使用 `PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH"`，模块命令在 `backend/` 执行；集成库为独立 `NOTALONE_TEST_DATABASE_URL=postgresql:///notalone_08_scope_test`。

- 单例红绿：完成后变为非私聊仍然读取；旧增量在退避期间反复查询元数据；未知类型错误归类；缺少 resolve 超时预算；非法预算未提前拒绝；重启后私聊恢复且没有新消息误判历史停滞；其他绑定成功时停读提示消失；无全局流时恢复或撤销仍残留告警。各用例先复现失败，再通过修复。
- `python -m unittest tests.unit.front_sync.test_cli_history_sync tests.unit.front_sync.test_cli_background_sync tests.unit.wechat_cli.test_adapter tests.integration.persistence.test_cli_history_sync tests.integration.persistence.test_cli_pagination_sync tests.integration.server.test_sync_api`：161 tests 通过。
- `python -m unittest discover -s tests/unit/front_sync -t .`：261 tests 通过。
- 桌面 `NOTALONE_TEST_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test tests/sync-scope-view.test.mjs tests/local-history-sync.test.mjs tests/sync-priority-status.test.mjs tests/sync-status-recovery.test.mjs`：24 tests 通过。实际断言红绿证明历史与旧增量停读提示；浏览器缓存缺失不计为红阶段。
- 桌面 `npm run typecheck` 通过；`npm test` 最终 939 通过、1 跳过、0 失败。
- 本票完整 Python 已在上一笔分页修复执行并于 600 秒退出 142，过程中有 F/E、无最终摘要；本修复不宣称全量通过，不重复同一整套等待。

## 审查与边界

Standards 与 Spec 独立审查均无未解决发现，补充的分页测试适配器契约也已复查。`git diff --check` 通过；独立 `notalone_08_scope_test` 已删除并确认不存在。真实总开关保持关闭，由主 Agent 在来源定位冲突的下一笔修复完成后恢复验收。本记录不证明真实全历史已完整。
