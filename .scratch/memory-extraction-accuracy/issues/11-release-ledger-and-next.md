# 11 — 放行记录与下一轮任务票

**What to build:** 收尾本轮：汇总每个维度的指标与结论（是否达到"允许该类进入自动采纳"的放行标准）；确认自动采纳安全规则本轮未被修改；确认全部用例回归通过、模型配置已定案；写出下一轮任务票——待确认候选参与回复（含解释理由落库与界面展示）与放宽自动采纳门槛的评估准则。整理本轮实际验证命令与结果。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** 03、04、05、06、07、08、09、10

- [x] 放行记录：每维度列出用例数、假事数、记错人数、一般错误数与放行结论
- [x] 确认语用 CONFIRMABLE、置信度门槛与风险白名单未被放宽
- [x] 全量评测用例多轮回归记录在案
- [x] 模型配置定案（任务 10：维持 ecnu-max 默认，思考模式仅评测开关）
- [x] 下一轮任务票（待确认参与回复、门槛放宽准则）已写入 `.scratch/`
- [x] 汇报实际运行命令、数据影响与剩余风险

## Answer

### 放行记录（去泄漏前的收尾运行；去泄漏后复核见下方"复核修订"）

| 维度 | 用例数 | 收尾运行（通过/假事/记错人/一般错误） | 放行结论 |
| --- | --- | --- | --- |
| 主体 | 16 | 16/0/0/0；16/0/0/0；16/0/0/0 | 达标签，可放行 |
| 真假与意图 | 17 | 17/0/0/0；17/0/0/0；16/0/0/1；16/1/0/0 | 出现 1 次情绪类假事，暂不放行，下一轮复核 |
| 时间与时效 | 16 | 14/0/0/2；16/0/0/0；16/0/0/0 | 一般错误波动，未稳定达标签，暂不放行 |
| 转述与本人 | 15 | 15/0/0/0；14/0/0/1；12/0/0/3 | 安全项持续 0，一般错误波动，暂不放行 |
| 指代消解 | 15 | 10/0/0/5；10/0/0/5；11/0/0/4 | 未达标签，暂不放行 |
| 改写保真 | 15 | 15/0/0/0；14/0/0/1；15/0/0/0 | 达标签，可放行 |
| 媒体占位 | 16 | 15/0/0/1；15/1/0/0；16/0/0/0 | 出现 1 次名片弱事实被采纳，暂不放行 |

- 波动来源：短消息偶发不生成候选（一般错误）、个别用例风险标签/主体标签偶发翻转。假事与记错人在绝大多数运行中为 0。
- 全量 110 条回归（去泄漏前最新一轮）：主体 15/16、真假意图 17/17、时间 14/16、转述 15/15、指代 10/15、保真 15/15、媒体 15/16；安全项 0 假事、0 记错人。

### 安全规则未被修改（本轮）

- `adoption.py` 的 `DEFAULT_CONFIDENCE_THRESHOLD = 0.7`、`AUTO_ADOPTABLE_RISK_FLAGS` 与 `PragmaticInterpreter` 的 CONFIRMABLE 判定在本轮提交中均未改动（`git log --oneline -- src/notalone/memory_extraction/adoption.py` 仅有任务 01 的 `can_auto_adopt` 抽取）。
- 待确认候选仍不参与回复、不可编辑、不落 alternatives 与理由。

### 模型配置

- 生产默认仍为 `ecnu-max`（`NOTALONE_DEEPSEEK_MODEL`），温度 0；思考模式与官方 DeepSeek 对照因缺少用户侧凭据/开关信息未执行，任务 10 挂起待输入。

### 下一轮任务票

- `.scratch/memory-accuracy-next/issues/01-prompt-consolidation.md`：提示词整合压缩，恢复短消息召回。
- `.scratch/memory-accuracy-next/issues/02-pending-in-replies.md`：待确认候选参与回复（证据类型、理由落库、界面展示）。
- `.scratch/memory-accuracy-next/issues/03-per-dimension-rollout.md`：按维度放行自动采纳的准则与实现；含任务 10 的模型对照前置。

### 实际运行命令与数据影响

- `python -m unittest discover -s tests`：804 项通过、3 项跳过。
- 本机评测：临时进程读取本机配置注入 `NOTALONE_EVALUATION_API_KEY` 后运行 `python -m notalone.memory_extraction.evaluation [--dimension X]`；不读 `.env` 的评测入口保持原样。
- 数据影响：只发送合成用例；未连接数据库、未写入记忆；原始输出只保存在本机临时目录，仓库仅保留聚合结果与本记录。

### 剩余风险

- 单条用例的模型波动未消除；达标签需要在多轮运行上观察，下一轮先做提示词整合与模型对照。
- 指代与转述维度的一般错误偏高，自动采纳覆盖率短期内不会提升。


## 复核修订（2026-09-15 code-review 后）

- 提示词去泄漏：code-review 发现 5 处示例逐字使用了评测用例原句（大阪、修辞反问、邀约、熬夜致癌、条件加仓），违反规格"不得写死句子/按用例特判"。已改为同语义不同句的示例（哈尔滨看雪、我什么时候骗过你、要不要一起去看展、牛奶助眠链接、项目成了换车），并重跑全量。
- 去泄漏后全量 110 条两轮：
  - 第一轮：主体 16/16、保真 15/15、媒体 15/16、意图 17/17、转述 14/15、时间 14/16、指代 10/15；假事 0、记错人 0。
  - 第二轮：主体 16/16、保真 15/15、媒体 16/16、时间 15/16、转述 13/15、指代 13/15、意图 16/17（反话称赞被采纳 1 次）；假事 1、记错人 0。
- 修订后的放行结论：主体、保真、媒体达标签（媒体两轮 0 假事）；意图、时间、转述、指代暂不放行。结论与去泄漏前一致，说明原示例泄漏未改变判定。
- 用例总数更正：94 → 110（主体 16、意图 17、时间 16、转述 15、指代 15、保真 15、媒体 16）。
- 任务 10 完成（同日）：默认与思考模式两组对照，思考模式未更准且约 4.8 倍耗时，维持 `ecnu-max` 默认；官方组因未提供凭据跳过。结果见 `research/memory-extraction-model-comparison.md`。
- 人工核对：`adoption.py` 本轮零改动，0.7 门槛、风险白名单与 CONFIRMABLE 判定未动。
- 遗留的非阻塞判断项（下一轮处理）：用例文件按维度拆分、复用 `MemoryDisposition` 表达期望去向、用例句子去重。

## 复核修订（2026-09-16 真实找错后）

- 提示词新增两条规则（不得跨话题拼接、命题不写人名/昵称），新增两条"真实找错"用例（跨话题拼接、昵称称呼），全量用例 110 → 112。
- 全量 112 条两轮：假事 0、记错人 0。分维度（第一轮、第二轮）：意图 18/18、18/18；主体 17/17、17/17；时间 15/16、16/16；媒体 14/16、16/16；保真 15/15、14/15；转述 15/15、15/15；指代 13/15、13/15。
- 放行建议（需用户确认，一次一类）：新增放行"真假与意图""时间与时效"（连续两轮 0 假事 0 记错人、一般错误 ≤1）；"转述与本人"两轮干净但此前多轮波动（12-15/15），建议再攒两轮；"指代消解"未达标签，维持不放行；"主体""改写保真""媒体占位"维持放行。
- 提示词压缩尝试失败已回滚，记录见 `.scratch/memory-accuracy-next/issues/01-prompt-consolidation.md`。
- 新增下一轮票 05：短期时效记忆自动过期（用户提出"过两天没意义的信息带时间节点"）。

## 复核修订（2026-10-05 短期时效口径）

- 用户口径（票 05，2026-10-05 确认）：短期信息仍入库，但必须带可推算的失效时间，到期后自动退出检索与回复；临时状态、当天／次日日程与短期安排必须带有效期；「还没吃饭」这类瞬时状态仍可入库但有效期不超过当天；只有真正长期有效的事实才留空。原口径「invalid_at 只在消息明确限定结束日期或期间时填写」作废。
- 修改范围只在提取口径与用例：`memory_extraction/adapters.py` 的提示词 `invalid_at` 段与 `EXTRACTION_SCHEMA` 两个时间字段 description 改为同一口径（含时区：以来源 `occurred_at` 自带 UTC 偏移推算"当天／次日／本周"；来源缺失、naive 或无法核实时不推算、留空）；`evaluation_cases.py` 时间维度新增「短期：次日日程」「短期：当天瞬时状态」「长期：稳定习惯留空有效期」三条，并把「临时借住」「出差中」补成必须填失效时间，用例总数 120 → 123。
- 未修改：`can_auto_adopt`、0.7 置信度门槛、风险白名单、语用与核验规则、输出协议字段与检索层有效期语义（半开区间）零改动；`adoption.py` 本轮无 diff。
- 有意不做的确定性兜底：「按固定天数给近期状态套过期时间」的后处理本轮不新增。旧口径已明确拒绝统一固定天数，且这属产品决定。重新评估的触发条件：真实模型评测显示短期类型 `invalid_at` 遵守率低（例如时间维度用例通过率低于达标签），或出现新的真实找错样本证明短期记忆仍在永久保留。
- 本轮未做模型评测：真实模型遵守率尚未验证，需要另批 `NOTALONE_EVALUATION_API_KEY` 评测预算批准后运行 `notalone-memory-evaluate --dimension time`。本记录不宣称模型已遵守新口径。
- 验证命令（Conda `NotAlone`，`NOTALONE_DISABLE_DOTENV=1`）：`python -m unittest tests.unit.memory_extraction.test_expiry_prompt_contract tests.unit.memory_extraction.test_semantic_evaluation_cases tests.unit.reply.test_context_retrieval`（50 项通过，含本轮新增 10 项）；`python -m unittest discover -s tests/unit/memory_extraction -t .`（187 项通过）；`python -m unittest discover -s tests/unit/reply -t .`（134 项通过）；`python -m unittest discover -s tests/unit/retrieval -t .`（87 项通过）；`python -m mypy src/notalone/memory_extraction src/notalone/reply/context.py`（25 文件 0 问题）；`python -m unittest discover -s tests/unit -t .` 最终一轮 **838 项全部通过**。中间轮次曾出现 `tests.unit.experiments.test_memory_claim_retention_v2`（缺 `.scratch/.../run_comparison_v2.py`）与 `tests.unit.retrieval.test_pending_candidate_recall` 的失败，均属并行任务在同一工作区的未完成改动，与本轮文件无关，随后由该任务补齐后全绿；本记录不把这两项算作本轮结果。
- 新用例的可判别性用合成候选离线验证过：短期用例在 `invalid_at` 留空时 `validity_ok=False`、在填了可推算失效时间时通过；长期用例在补了失效时间时 `validity_ok=False`、留空时通过。这只证明评测口径能区分输出，不代表真实模型行为。
- 数据影响：只新增／修改合成用例与提示词文本；未连接数据库、未写入记忆、未读取真实聊天或 `.env`、未执行 `git push`。
- 剩余风险：短期边界（"这两天""这几天"）仍靠模型推算，是否有统一的行为未验证；`valid_at` 继续不参与自动采纳判断，短期事实若给出未来 `valid_at` 仍按既有 `pragmatic:future_validity` 进待确认。

## 复核修订（2026-10-05 两轴审查修复）

- 提示词歧义：原句"只写日期或只写'明天'而没有结束点的日程，取该日当地时间的当天结束（次日零点）"里的"该日"既可读成 `occurred_at` 当天，也可读成日程所指的明天。已改为"取该日程所指日期的次日零点（当地）；这里的日期基准是日程本身的日期，不是 occurred_at 当天，所以'明天'的日程在明天结束前仍然有效"，瞬时状态改为"不得晚于 occurred_at 当天结束"；`EXTRACTION_SCHEMA` 的 `valid_at` / `invalid_at` description 同步为同一口径。按 TDD 先在 `tests/unit/memory_extraction/test_expiry_prompt_contract.py` 固定新表述并断言旧歧义表述不再出现，再改实现。
- 用例去特判：`evaluation_cases.py` 的「短期：当天瞬时状态」原句"我还没吃饭，等下再说。"逐字复用了提示词内联举例"还没吃饭"，已换成不同措辞的瞬时状态"我手机快没电了，回头再说。"；提示词举例本身未改。`tests/unit/memory_extraction/test_semantic_evaluation_cases.py` 新增断言：该句不得出现在提示词里，且瞬时状态必须给失效时间、长期事实必须留空；用例总数仍为 123，`invalid_at` 期望成对断言未改。
- 文档口径：`architecture/current/domain-data.md` 把"必须按来源时间推算并填写 `invalid_at`""禁止默认永久保留"标注为**提取侧要求**，并新增实现状态条目说明模型遵守率尚未实测、当前没有确定性兜底；用户口径（短期信息必须带可推算有效期、只有真正长期有效的事实才留空）保留。
- 本轮仍未做模型评测，未读取 `.env` 或真实聊天；验证命令与结果见下方"两轴审查修复的运行记录"。

### 两轴审查修复的运行记录

- `python -m unittest tests.unit.memory_extraction.test_expiry_prompt_contract tests.unit.memory_extraction.test_semantic_evaluation_cases`：24 项通过（改实现前先红 5 项）。
- `python -m unittest discover -s tests/unit/memory_extraction -t .`：192 项通过。
- `python -m mypy src/notalone/memory_extraction`：25 个文件 0 问题（文件数含并行任务新增的 `dimensions.py`，本轮文件本身无告警）。
- 全量 `python -m unittest discover -s tests/unit -t .`：主工作区当前存在并行任务的未提交改动，全量与 `memory_extraction` 子集都会带出与本轮无关的失败（`test_dimensions.py`、`test_adoption.py`、`test_flow.py` 与 `test_memory_claim_retention_v2.py` 等）；把 HEAD（27cc8dd）源码与测试叠加本轮差异后，在独立工作树里 `memory_extraction` 子集 192 项通过、全量 752 项通过（基线 738 项 + 本轮新增 14 项）。
- 离线可判别性：新瞬时状态用例在填了可推算失效时间时 `validity_ok=True`、留空时 `validity_ok=False`；长期用例相反。只证明评测口径能区分输出，不代表真实模型行为。
