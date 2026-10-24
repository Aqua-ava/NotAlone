# 根迁移持续目标

用户已把以下约束写入系统目标：无依赖任务必须创建全新、用户可见的 Codex 会话，不是 sub-agent；会话直接通信，主会话统一集成并独占 App／微信验收。验收联系人使用 `ran`；不得发送未明确指定的外部消息。

当前 HEAD 为 `d5cd0e67`：

- `c9fae483`：无冲突合入票13 `31b0980f`，唯一 TS Worker 接管 `organize_memory`；
  Python 只保留管理/维护入队，不再执行 L2 模型。根组合测试 TS 47/47、Python 49/49。
- `21564070`：合入票16 `f90545aa`，TS 历史导入、任务控制与唯一提取 Worker。
- `15b134a4`、`8771ba6a`、`d5cd0e67`：分别记录票16主树回归、index/verify
  后续切片和票13主树所有权回归。
- `f9381923`：并入票 21 的 ANECompilerService／Background Inference entitlement 只读诊断。
- `0be99df7`：修复 Python 共享宿主 A 成功后未先结算、导致 B 预约立即 `ModelWorkStopped`；相关 104 项测试通过。
- `50306523`：接入 TS 提取 B 段共享宿主。
- 修复后的真实 trace `7f7b8ac8-f022-4d7c-bbe1-2c7756bdac3b` 已成功执行 A／V／裁决／关系核验，共 5 次物理调用，5 个 ledger、5 个 receipt，全部 committed；这只证明共享账务顺序，不等同 `ran` 验收完成。

用户可见会话（均非 sub-agent）：

- 票 13 用户会话：源码已交付并集成，idle；保持
  claimed，等待根实际 App 验收。
- 票 16 用户会话：提取 Worker 已集成，idle；保持
  claimed，等待 `index|verify` 和根实际 App 验收。
- “16 索引与验证 Worker”新用户会话：
  active；补确定性 `index|verify`，不得用 sub-agent 代替。
- “修复记忆自然过期未入队”新用户会话：
  active；修票13完整管理套件已复现的独立维护缺陷。
- 票 21：用户会话已交只读诊断；票保持 claimed。accurate、0.90、2500ms 不降低。

当前开发 App 用 `npm run dev` 运行，主 PID 曾为 `87701`；环境为 reply/history TypeScript，extraction 仍走 Python Worker。数据库 `notalone_dev`，owner `6b0faa77-8bcf-4a14-a627-7629265624da`。

`ran` contact 为 `aaf9796e-1c92-4608-b9be-dc06a48df194`，任务为 `4db4510b-a7e8-450b-b8b8-cc0b3b71751e`，78 条；App“继续处理”已成功把任务按原身份排入开发 TaskHost，但全局单 Worker 正处理较早存量任务，当前仍 queued。不得通过删除其他用户任务来插队。

下一步：

1. 等 `index|verify` 与维护缺陷两个新会话提交；根逐个审查、无冲突集成、重跑组合测试。
2. 用实际开发 App 处理 `ran`，核验记忆、来源、candidate／confirmed links、水位与 UI 查看／修正／删除；不发送消息。
3. 13、16、21 实际证据闭合后关闭对应票；再按依赖创建 14、15、17、22、24、25、26 的新可见会话。
4. 最终做切换／回退、模型质量与桌面矩阵，再删除 Python／LangChain 入口；不 push、不打包、不建 PR。
