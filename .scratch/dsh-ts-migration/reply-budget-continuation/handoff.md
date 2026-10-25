# 回复96账本续期 ACK 交接

State: resolved
Triage: ready-for-agent

本窄任务已完成并冻结；原 ticket25／26 状态由主协调管理，本会话未改动。
仅修改 `../ticket25-final-run/bridge.py`，新增本目录定向测试及脱敏证据。
公开依据：`backend/src/notalone/problem_budget.py:48-117` 的续期、预留与 snapshot；未修改该模块。
根因：原 ACK 无条件拒绝非空 continuations，并仍应用原期限与两轮无改善门禁。
修复：只读核验授权历史结构，按最新授权期限、已有轮次基线和新增轮次额度判断。
要求唯一活动轮属于最新授权之后；已结案、不存在、旧轮复活、越额及损坏结构均拒绝。
ACK 返回有效续期期限；原账本 deadline、streak、unknown 历史和 max_calls 均保持。
`check`／`reserve`／`reserve_request` 继续使用原 ProblemBudget 门禁与预留接口；其响应期限合同保持。
used==max_calls 允许合法活动轮 ACK；check／reserve 仍拒绝；used>max_calls 拒绝。
测试同时核对完整 snapshot 与 SQLite 字节，证明成功／失败 ACK 不扣费、不退款、不续期、不增加上限。

Python 使用工程规定的 Conda NotAlone；以下命令均已执行：
`python -B .scratch/dsh-ts-migration/reply-budget-continuation/test_bridge.py ReplyBudgetContinuationTests.test_authorized_continuation_ack_before_and_after_last_reservation -v`：原桥 RED、修复后 GREEN。
相同最终测试源码对仓库外原桥副本回放：1 个预期 RED，明确为 budget_ack_rejected。
`python -B .scratch/dsh-ts-migration/reply-budget-continuation/test_bridge.py -v`：15/15 通过。
在 `backend/` 执行 `python -B -m unittest tests.unit.experiments.test_problem_budget -v`：10/10 通过。
`git diff --check -- .scratch/dsh-ts-migration/ticket25-final-run/bridge.py` 与 Python AST 校验通过。
全部命令、输入／日志哈希、拒绝边界及清理结果见 `evidence.json`；精确文件摘要见 `manifest.sha256`。

夹具仅在自有仓库外 0700 目录／0600 SQLite 中生成，全部自动清理，剩余夹具目录 0。
仓库外保留 0600 原日志与原桥副本供端侧核验；公开证据仅含摘要和哈希，无私有路径或原日志。
未读取真实账本、凭据、原始资料或冻结评测；未发真实请求；未启动 App／微信；未生成缓存。
未 add／commit／push／PR，未派子 Agent；用户三个桌面测试文件及其他协作者改动均未编辑。
主协调下一步：小增量独立复核，再按原身份／账本核验正式发送前后 ACK，统一提交并继续回复96。
本任务仅证明合成桥接合同，不代表回复96、实际 App、微信或真实质量验收通过。
