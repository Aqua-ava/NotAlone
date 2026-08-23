# 04 — 写入裁决：同事件演变与版本化失效

**What to build:** 借鉴 Mem0 的写入决策：候选入库前在同范围+同受控主题+同主体+同分类内检索相似已有记忆，新候选与相似旧记忆交模型裁决四动作——ADD（新增）/ UPDATE（同事件演变：旧记忆标记失效并保留版本历史，新记忆入库）/ NOOP（重复跳过）/ KEEP（不同事件并存）；失效与写入由确定性代码执行；裁决的外部调用落台账。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** 03（落库层与水位）

- [x] 相似检索：同 owner（级）范围 + 同主题 + 同主体 + 同分类内的关键词相似匹配
- [x] 裁决模型调用：新候选 + 相似旧记忆 → 四动作之一，结构化输出沿用强化配方
- [x] UPDATE 执行：旧记忆标记失效（保留可查历史），新记忆入库；失效记忆不再进入检索
- [x] NOOP/KEEP/ADD 各自落库行为正确，重复抑制复用 NOOP
- [x] 裁决调用三态落台账（成功/运行失败/校验拒绝）
- [x] fake model 单测覆盖四动作；集成测试验证 UPDATE 后检索只返回当前版本

## Comments

## Comments（实现记录）

- 2026-08-23 完成。`adjudication.py` 定义四动作、SimilarMemory 与字符 bigram Jaccard 相似度（默认阈值 0.2，经"减肥→增肌"演变用例校准）；`adjudication_adapters.py` 提供 LangChain 结构化裁决（prompt 四动作定义 + 强化 schema）。
- `MemoryAdoption` 接入裁决：同池+同主题+同分类内相似命中才调模型（省调用）；UPDATE 前校验 replaced_memory_id 必须在相似集合内（模型编造 ID 降级为 ADD 并按校验拒绝落台账）；旧记忆经 invalidate 版本化失效（联系人级与 owner 级各自失效路径），检索只返回当前版本；NOOP 计入重复跳过；裁决失败传播并按运行失败落台账。
- 顺带补齐 `OwnerMemoryPort.invalidate` 与 PostgreSQL 实现。
- 集成测试 7 例：UPDATE 替换、NOOP 跳过、KEEP 并存、编造 ID 降级、失败传播、不相似免调用、owner 级 UPDATE；全量 231 例通过。台账三态记录逻辑与 03 同模式实现（成功/运行失败/校验拒绝），未逐态写显式断言，留待 06 冒烟一并观察。
