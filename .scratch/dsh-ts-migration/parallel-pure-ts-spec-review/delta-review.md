# 4f89 小 delta 的 Spec 追加审查

结论：**approve**。最终冻结为 `4f89bb976dd4086a02b7ae983fee2760d6e4ff64`，未发现由该 delta 新增的 P1／P2。

范围：`git show` 已核对该提交父对象为 ff45；七个路径中仅 `backend-ts/src/extraction-flow.ts` 与 `backend-ts/src/extraction-protocol-contract.ts` 是生产改动。ff45 六块装配及公开 HTTP／事件／桌面消费者没有修改。两份私有源码快照各 260 文件，测试夹具统一取自 4f89；在 base 放入新测试仅用于差分，不冒充该测试原属于 ff45。

新增约束符合来源语义支持／完整来源要求：`extraction-flow.ts:153` 仅在原 legacy direct 核验调用显式启用 `require_complete_evidence`；`:174–180` 将 supported 但未覆盖 `source_message_ids` 的 `requires_all_sources` 主张改为 unsupported／insufficient_evidence，并通过原拒绝路径处理，不增加调用或采纳动作。bounded 分支 `:241` 没有改用该选项。

`extraction-protocol-contract.ts:11–22` 的新参数缺省为空，仅显式启用时增加 legacy-v4 提示及 evidence description；nullable-proof-v3 显式启用会拒绝。六组默认 prompt/schema 深比较一致，隐式默认 mode 也一致。原 parser 与 `source_dependency_mode` 未修改，差分每项均验证仍为 `any`。没有修改 Python 合同、HTTP DTO、数据库迁移、来源身份或物理请求许可。

两个新增回归均通过。把同一文件放入 ff45 时为 1 过／1 预期失败，但首个失败先触发新增提示词断言；本审查没有据此冒充行为复现。独立 `delta-coverage-probe.mjs` 省去该提示断言，直接得到：

| 合成情况 | ff45 接受数 | 4f89 接受数 |
| --- | --- | --- |
| 声明问句与回答，但核验只引回答 | 1 | 0 |
| 明确单源事实 | 1 | 1 |
| 完整双源问答 | 1 | 1 |
| 来源齐全但假核验器误签单源含义 | 1 | 1 |

首例的最终 trace 明确保留 `model_verdict=supported`，程序结果为 unsupported／insufficient_evidence，disposition 为 unsupported_rejected。所有差分只用合成 invoke，物理请求为零。末例说明修复限于来源覆盖，未消除已知语义缺口。

规则源码哈希随两生产文件改变是原 runner 既有行为。沿调用核对 `extraction-batch-service.ts:108–134` 的 pending／unknown 回执检查及 `extraction-task-store-recovery.ts:67–100` 的原目标隔离仍存在，未改成依赖新规则版本来解除旧未知；本次不据静态核对宣称已做新一轮真实恢复验收。

根提供的私有离线回放结论是“原提议 P2 拒、P1／P4 保留、P3 单源含义错仍过”；这里 P1–P4 是提议编号。该材料未由本聊天读取或复跑，不能写成本聊天的真实质量通过证据。没有新实际调用，也不签真实质量、25 或 26。

源码逐项 SHA 见 `delta-fixed-source.json`，结果为 `delta-candidate.tap`、`delta-base.tap`、`delta-compatibility.json`、`delta-coverage.json`；复验和清理见 `delta-commands.md`、`delta-verification.json`。
