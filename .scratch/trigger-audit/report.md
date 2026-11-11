# 触发器审计报告（只读调研）

范围：`backend-ts/src` 全部迁移与 schema 定义的最终生效触发器（未发射、未删除的）。逐项清单见同目录 [triggers-appendix.md](triggers-appendix.md)。

## 口径与背景数字的修正

- 背景"121 表 / 141 触发器 / 126 处 RAISE(ABORT)"应来自某个真实库实例（含历史遗留）。本审计以 `backend-ts/src` 注册表建空库实测：**92 表 / 120 触发器（schema v47）/ 97 处 RAISE(ABORT)**。
- 多数"触发器较多的表"实际在每次 INSERT 上只有 0–2 个触发器会执行使命（其余集中在 UPDATE/DELETE 或特定 WHEN 才触发）。

## 分类汇总

| 类 | 数量 | 说明 |
|---|---|---|
| A 应用层已校验（重复） | 20 | 唯一写入口在写前已做同等校验，触发器是第二道 |
| B 可改声明式 | **0** | 需引用 OLD 值（SQLite CHECK 不可表达）、跨行/跨表，或按行状态决策 |
| C 必要（保留） | 75 | 42 条不可变锚（`*_immutable`）＋状态机单向流转＋跨表链一致性 |
| D 派生维护 | 25 | 12 个 management_revision / 6 个 timeline_dirty / 消费与回收机制 7 个 |
| 合计 | 120 | — |

关键事实：A 类里没有一个是"单行 NEW-only 可改 CHECK 的规则"（B=0）；真正能省的规则要么靠删 A，要么考虑改 D，C 均无声明式等价。

## A 类逐项清单（20 个）

| # | 触发器 | 表 | 应用层等价校验位置（文件:行） | 建议动作 |
|---|---|---|---|---|
| 1 | candidate_real_producer | memory_candidate | management/actions.ts:47-49（verifiedExtractionOutput 派生后插值） | 删 |
| 2 | memory_version_decision | memory_version | management/actions.ts:130,196 与 early-return | 删 |
| 3 | auto_noop_execution | memory_decision | adjudication-actions.ts:160-171（同口径执行链） | 删 |
| 4 | decision_candidate_scope | decision_candidate | management/actions.ts:123-126 + 159 | 删 |
| 5 | memory_citation_scope | memory_citation | management/actions.ts:39-42（成对构造）【标注：构造性保证待核实】 | 核实后删 |
| 6 | capture_record_binding | capture_record | history/sqlite/actions.ts:46 + ingest.ts:27,145 | 删 |
| 7 | grant_verification_generation | read_grant | contacts/sqlite/actions.ts:193-198 + clear-actions.ts:258-265 | 删 |
| 8 | grant_revocation_final | read_grant | contacts/sqlite/actions.ts:21-24（三入口均 WHERE revoked_at IS NULL） | 删（如要防静默失败也可留） |
| 9 | media_head_kind | message_media | media/sqlite/actions.ts:21-26（两入口同规则先查） | 删 |
| 10 | skill_default_enabled_update_guard | skill_package | skills/sqlite/storage.ts:207-208（唯一置 1 入口 fail） | 删 |
| 11 | reply_version_call | reply_candidate_version | candidates/versions.ts:42-44 + model-actions.ts:19 | 删 |
| 12 | reply_execution_input_scope | reply_execution_input | model-actions.ts:18-19,40（先 fail 后 insert） | 删 |
| 13 | runtime_context_scope | runtime_context | runtime-actions.ts:97-99（同 scope 等） | 删 |
| 14 | runtime_commit_request | runtime_copy | model-actions.ts:184,206 + requests.ts:32-34 | 删 |
| 15 | adjudication_operation_step | model_operation | adjudication-actions.ts:267（attempt.kind!==purpose fail） | 删 |
| 16 | document_task_basis_fixed | processing_task | documents/stages.ts:181,199 + documents/deletion.ts:180 | 删 |
| 17 | document_basis_producer | document_basis | publication.ts:27-28（同构查询先跑） | 删 |
| 18 | document_producer_scope | memory_document_version | publication.ts:34-40（scope/kind/version 逐项 fail） | 删 |
| 19 | document_publication_scope | document_publication | publication.ts:113-114 + stages.ts:133 | 删 |
| 20 | document_member_scope | publication_member | publication.ts:117 + basis.ts:144（逐成员断言） | 删 |

A 类所有规则都是"跨表存在性＋状态匹配"（要引用 OLD 或查其他表），SQLite CHECK 无法表达，因此这类重复既改不成声明式约束，也无法合并成某条更简单的 CHECK，只能删除。

## D 类汇总（25 个，不建议以迁移方式重写）

20 个 `management_*`/`timeline_*` 维护 owner/contact.management_revision 与 memory.management_timeline_dirty，另有 document_publication_identity 镜像与 2 个 auto_noop 消费/回写触发器。它们的规则值是"分页/时间线失效机制的一条实现路径"——若不先替代失效机制（如改 action 层折叠、按 owner/contact 批量打点），迁移删除即破坏分页游标正确性。合并 D 属功能重构，不是"减负"。

## 实测

### 批量插入基准（空库副本，事务内批量 10k 行，3 轮中位数）

- 全触发器 A：memory_candidate 344 ms、memory_decision 251 ms、execution_event 33 ms
- 整组撤该表插入通路触发器 B：56 / 46 / 23
- **差值：candidate -288 ms（≈29 µs/行，84%），decision -207 ms（≈21 µs/行，83%），execution_event -12 ms（≈35%）**
- A 类单删（只删 1 个）：candidate_real_producer -19 ms（5.6%）；auto_noop_execution ≈0；其余单删在噪声内
- **未见线性加和**：单删合计约 -70 ms，但三条一起删 = -288 ms。单触发器层面的归因因此只能作参考；"整组撤掉"的差值以配对方式测得、跨轮稳定，但线性加和被打破的机理未定位，本报告不为此给假设性结论。本地无并行负载，绝对值仅供参考。

### 真实路径 `history.acceptPage`（夹具，1000 条/页，3 轮中位）

- 全触发器：88–104 ms（中位 91）
- 只撤 capture_record 域触发器（A 类相关）：86 ms（仅省 ~5–6%）
- 全部撤 120 个：60 ms
- **触发器合计占该动作 ≈30%（28–30 ms/1000 条页），但其中"可归因到单触发器"的 ≤6%；其余是触发器群体的总量效应**

## 结论与建议

差值不小（A/B 两路实测触发器开销相当于该路径写动作时间的 30–85%），值得做触发器精简迁移。但按"值不值得"分批衡量：

1. **第一批（低风险）：删 18 条 A 类**（20 条中 memory_citation_scope 暂不动、grant_revocation_final 留观察）。若 D 类 3 条 identity 镜像/级联清理已有替代清理机制，可一并并入本批；否则不动 D。A 类在 INSERT 路径实测贡献小（capture_record_binding ≤6%、candidate_real_producer ≈5.6%），但收益零行为风险。配套动作：memory_citation_scope 先在唯一写入口补显式断言（当前是 required/citation 成对构造的隐式保证），方可进入本批。
2. **第二批（中风险）：D 类的写入路径精简键**。不删触发器，改为在同一事务同一目标行的重复写写合并为一次（如多个事件同一 contact 的 revision 保留每次 +1 但批量改为收尾一次）。D 类本质是「分页/时间线失效机制」，须先有替代机制与其对齐，属功能重构。
3. **第三批：C 类不动**。75 条 C（42 条不可变锚＋状态机＋跨表链）没有声明式等价，是防后台写、原始 SQL 与未来新写入口绕过的最后防线；实测其在 acceptPage 上单域贡献 ≤3ms，不动为佳。

**结论：值得做，但别指望一步到位。** 历史入库路径 30%、记忆决策/候选批量写入 83–84% 的触发器成本是实测差值；第一批删 18 条 A 预期关闭其中 5–7%（集中在校验写路径），剩余差距主要来自 D（management_revision/timeline_dirty 每行必写）与 C/D 组合程序组成本，需要第二批 D 的写路径合并重构才能闭合；C 类（75/120）本身无等价替代，不属精简对象。

## 验证记录与限制

- 附录脚本与基准脚本保存在本地 /tmp（未进仓库），输出 JSON 在 `/tmp/ta-out/`（trigger-summary、key-table-ddl、bench-bulk、bench-realpath）。
- 实测环境：M 系列 MacBook，空库，事务级同步批处理，无并发干扰；数值用于同路径相对比较。
- 已知缺口：(1) A 类单删与整组差值非线性，机理未完全定位，只报告配对实测的整组差值；(2) `memory_citation_scope` 的成对构造关系尚未独立代码复核。
