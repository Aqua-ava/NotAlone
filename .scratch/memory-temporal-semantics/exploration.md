# 实现入口与差距核查

2026-10-20，只读代码核查；未运行产品测试或模型，未修改业务资料。源码行号仅供定位，以实施时版本为准。

## 后端入口

- `backend/src/notalone/memory/timing.py:26`：来源／保存时间及四态，严格旧合同兼容；`:108` 仅按直接消息求来源范围。
- `backend/src/notalone/persistence/memory_timing.py:63`：读取时派生当前状态，需保留同范围活动来源过滤。
- `backend/src/notalone/memory/current_status.py:115`：偏好／禁忌默认稳定，时态词降级；没有结构化条件状态。
- `backend/src/notalone/memory/events.py:44`：严格 v1 事件合同，datetime 无年／月精度；阶段和时段分别核验，事件 identity 同时受影响。
- `backend/src/notalone/memory_extraction/direct_adapter.py:22`：正式直接提取；`:34` 已要求无期限偏好双空，复用旧 schema 仍需检查冲突。
- `backend/src/notalone/memory_extraction/adapters.py:405`：每条消息提供独立 occurred_at；`:273` 附近有效期 schema 含旧默认期限要求。
- `backend/src/notalone/memory_extraction/verification_adapters.py:55`：已有来源时区规则；`:61` 仍含瞬时当天到期口径。
- `adjudication.py` 中 SimilarMemory／AdjudicationRuntime 目前主要为 ID、正文、主题；`adjudication_adapters.py` 单条／批量输入没有完整新旧来源时间，实施前用 `rg --files backend/src/notalone | rg adjudication` 定位。
- 自动采纳／合并已保护人工版本、核验事件及来源；在原子写入前追加有据时间关系校验，不能只改 prompt。
- `backend/src/notalone/reply/context.py:176` 的 ContextEvidence 缺 event；`:1490` 的记忆证据只传 timing／valid_at／invalid_at。`:585` 已有有界原话窗口补查，可复用。

## 桌面入口

- `desktop/src/shared/memory-bridge.ts:7`：MemoryTiming／MemoryEvent；`:116` 分层引用只含 timing，缺事件／有效期。
- `desktop/src/main/memory/read.ts:84`、`layered-read.ts:43`：L1、L2/L3 读取。
- `desktop/src/main/reply/evidence-read.ts:20`、`layered-evidence-read.ts:69`：生成依据及分层冻结／工具回执。
- `desktop/src/renderer/MemoryPage.tsx:273`、`OwnerLayeredMemoryPanel.tsx:123`、`MemoryTemporalStatus.tsx:3`：重复四态标签；本人详情还缺事件展示。
- `desktop/src/renderer/LayeredMemoryPanel.tsx`、`ReplyEvidence.tsx`：分层引用与生成依据须同步精度／阶段／条件。

## 现有验证先例

- `backend/tests/integration/server/test_memory_current_status.py`：当期范围、来源不足、旧快照、实际生成依据。
- `backend/tests/integration/server/test_historical_reply_basis.py`：时钟变化不改历史快照、迟到生成复验。
- `backend/tests/integration/server/test_memory_event_updates.py`：版本更新、撤销、删除、人工保护、计划到期。
- `backend/tests/integration/server/test_memory_retirement_generation.py`：错误／变化／未知生成资格。
- `backend/tests/integration/server/test_relationship_overview_events.py`：概览事件。
- `desktop/tests/memory-current-status.test.mjs`、`memory-event-updates.test.mjs`、`recovered-evidence.test.mjs`：生产读取／控制器合同。
- `desktop/tests/headless/memory-current-status.ts`：隔离合成数据库与真实后台的卡片／回复／来源删除页面验收。
- 页面用例组已有 `memory-current-status`、`memory-event-updates`、`historical-reply-basis`、`layered-reply`；先跑最小单例及类型检查。

## 规格与边界

- `architecture/current/domain-data.md:143-167` 的默认起止与后文来源时间语义需要收敛。
- ADR-048、ADR-069、ADR-070、ADR-071：保留历史当前区分、直接提取、旧资料升级边界、错误／变化分开。
- `.scratch/memory-time-context/spec.md` 已记录早期生产水位对缺日期／乱序消息的限制；04 必须核对现行实现，不能假定新导入自然得到处理。
- `research/tencentdb-agent-memory-time-semantics.md`：腾讯仅作设计参考；`research/temporal-memory-methods-20261002.md:101` 记录早期试验未达切换条件。
- 本次 `npm run dev:status` 返回现有开发实例。实际实施和验收必须重新核对并复用，不以本记录证明后续实例状态或功能可用。
