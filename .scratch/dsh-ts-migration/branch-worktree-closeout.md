# 迁移分支与工作树收尾

2026-10-26，按用户要求逐个核对临时分支，再清理已集成或过时的分支与闲置工作树。不推送、不打包，不改原有三处测试修改或用户资料。起点为 `7dd7403f`。

## 分支核对

25个临时分支全部完成核对：6个为main祖先，15个有等价补丁，另外4个分支的非等价提交按下列证据确认已覆盖或被后续方案替代，未发现需要补入的生产代码。

| 临时分支 | 核对结论 |
| --- | --- |
| `codex/extraction-adoption-service` | 等价补丁已集成 |
| `codex/fix-extraction-invalid-output` | 等价补丁已集成 |
| `codex/fix-layered-time-maintenance` | 等价补丁已集成 |
| `codex/fix-memory-progress-wake-01a16e8e` | 等价补丁已集成 |
| `codex/ocr-worker-prewarm` | 等价补丁已集成 |
| `codex/task07-ui` | 等价补丁已集成 |
| `codex/task08-discussion-continuity` | 等价补丁已集成 |
| `codex/task08-root-integration` | 已在main历史中 |
| `codex/task10-current-main-integration` | 已在main历史中 |
| `codex/task10-integration` | 已在main历史中 |
| `codex/task10-owned-closeout` | 已在main历史中 |
| `codex/task10-root-review` | 已在main历史中 |
| `codex/task10-worker` | 已在main历史中 |
| `codex/task11-memory-adjudication` | 逐提交确认已覆盖 |
| `codex/task12-source-processing-trace` | 等价补丁已集成 |
| `codex/task13-host-integration` | 等价补丁已集成 |
| `codex/task13-l2-scenarios` | 等价补丁已集成 |
| `codex/task13-production-wiring` | 等价补丁已集成 |
| `codex/task16-contact-history-import` | 逐提交确认已覆盖 |
| `codex/task16-history-host-integration` | 等价补丁已集成 |
| `codex/task16-index-verify-worker` | 等价补丁已集成 |
| `codex/task16-python-b-consumer` | 等价补丁已集成，旧桥后续退役 |
| `codex/task16-remote-b-adoption` | 已由单一任务宿主方案替代 |
| `codex/task20-history-gap-recovery` | 逐提交确认已覆盖 |
| `codex/task20-reply-gate` | 等价补丁已集成 |

## 非等价提交的逐项裁决

- `65464802`：生产代码及测试与main的`1f76326d`进行范围限定的range-diff一致；差别只在旧根交接的会话标识处理。当前分层快照仍复验失效记忆依赖，不恢复旧交接。
- `9da642ed`：旧TS记忆B段远程消费原型已由`c826635c`的单一采纳服务、`50306523`的共享任务宿主及`bcc6701c`的完整命题核验覆盖；`48770e9c`已退役Python消费桥和旧运行时选择器。当前A/B回执、来源及取消复验、任务栅栏、模型调用记录仍在，112 SQL与该旧提交原字节一致；不回灌旧桥。
- `11c932d3`：历史单一宿主已在`51cf3690`集成。range-diff中额外差异来自保留当时main新增的imports/taskApi状态字段；当前历史执行方仅TypeScript。
- 分离工作树的`85365fc2`只补充历史测试稳定性边界，没有生产代码。其必要说明在此保留：合成测试通过不代替原生OCR或真实App验收；不恢复旧claimed状态，也不重开用户已取消或暂缓的验收。

## 清理与恢复

- 最终状态：25个临时分支、24个附加工作树全部清理，仅剩本地`main`分支和主工作区。
- 22个普通工作树通过Git管理命令移除。两个托管目录的应用归档请求未落地；用户明确要求直接处理后，先保存Git元数据、依赖链接和恢复信息，再通过Git工作树管理命令移除，最后删除`codex/task20-reply-gate`。没有改写其他会话的所有权信息。
- 普通工作树移除前逐个核对共同Git目录、精确HEAD、未提交修改、忽略项和进程引用；仅清理已核验闲置的完整临时工作树。
- 7份仍有验收用途的非缓存产物已按原字节保留到仓库外私有目录；其他附加文件均为依赖、构建或Python缓存。未跟随依赖链接删除链接目标。
- 清理前已在仓库外创建并验证可恢复的薄Git bundle，保存main以外的分支提交及必要分离HEAD；精确SHA、逐分支结论和恢复材料均有端侧清单。

## 验证与数据影响

共3,959个现有文件及原配置已固定哈希，原有三处修改不纳入提交；生产代码、116份SQL、用户数据库、原始资料、微信资料及其他任务文件未由本次操作改写。

本轮验证仅包括Git祖先、等价补丁、范围限定range-diff、当前合同只读核对、SQL字节比较、文件哈希、引用、恢复档及最终Git状态。未运行产品测试、实际App、模型或微信操作，也未把既有测试改称本轮运行。最后按工程规则执行本地提交和公开历史检查。
