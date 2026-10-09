# 来源核验提示：转述支持语义单叶（产品默认，2026-10-04）

状态：产品默认已改并完成本地验证；**模型行为未经真实对照**，真实资料、留出与发布仍需另行决定。本文件记录改动范围、证据链和限制，不把本地提示契约测试当作模型准确率证据。

## 决定与范围

用户在获知“只改来源核验提示一小段、不加 `described_party` 字段、本地 0 次联网调用”的范围后批准实施。本次只做一件事：把匿名 C4 试点验证过的语义稳定性提示叶并入产品来源核验提示。

- 改动点：`src/notalone/memory_extraction/verification_adapters.py` 的 `SOURCE_VERIFICATION_SYSTEM_PROMPT`，在原“所有项目都吻合才supported……日期字段没有充分支持也应uncertain并标time。”之后插入一段，到“下面是审稿原则示例”之前结束。
- 新增段落原文：

```text
来源支持与直接参与者判断是两项独立判断：某条主张的直接参与者是谁，不决定它是否被
原话支持。report与reported只说明这是明确转述，本身不构成uncertain理由；当候选正文、
subject、语用字段与来源证据都被原话支持时，verdict应为supported且issues=[]，不能仅因
report/reported、第三人转述或候选subject不是直接参与者就判uncertain。只有来源支持不足、
真实歧义或与原话矛盾才用uncertain/unsupported；report/reported标记本身被丢掉或
升级为本人事实，仍属pragmatics问题，仍须uncertain。
```

- 明确不含：试点为人物判断临时加到工具 schema 的 `described_party`/`party_evidence`；schema、`ExtractionFlow`、`PragmaticInterpreter`、采纳门、窄 guard、提示的其他段落均未改。
- 本次改动集共 5 个路径：产品提示 1 个文件（新增 6 行，`+6 -0`，其余字节与改动前逐字一致）、新测试 1 个文件、结果文档 1 个文件、两处上游记录文档的追加说明（任务 Comment 与历史计划页的“后续变更”）。产品代码只有那 6 行。提示文件新 SHA256 `d93ca1d6062842bf33349ec3c340ee37fd126f86a7d62b51e50b09b603cb638f`，新测试文件 SHA256 `ffa18a3386de2fe4641ab509bc0ab4d4234c6e7e782279c9658bc1ea3dbae25e`。
- 与既有句子的分工：原“正文忠实但标签把第三人转述或计划升级成确定本人事实，应uncertain并标pragmatics”和示例“标签却丢失第三人转述，应uncertain/pragmatics”针对的是**标记被丢掉或升级**；新段落只豁免**标记完整保留**的情形。两者不冲突，新段落最后一句也把“标记被丢失或升级”仍归 `pragmatics`。

## 证据链

- 试点来源：`.scratch/memory-core-claim-retention` 的 2026-10-04 直接参与者与语义稳定性两轮，结果见 [直接参与者阶段1结果](memory-party-participants-prompt-pilot-result-20261004.md) 与 [语义稳定性结果](memory-party-semantic-stability-pilot-result-20261004.md)；候选叶文本 SHA256 `8d3026b2af2771bf418d380e664f86a48756d28068eaab58f5a75975fdf9f2b0` 保存在仓库外私有目录。
- 试点结论：匿名 C4 上候选 `described_party=mixed 4/4`、目标证据 4/4、完整 Fact 无新增 `semantic:*` 风险 4/4、`report/reported` 保持 `pending` 4/4、坏 auto 0；同期基线 4 次仍复现旧的 `contact` 方向错误。试点同时确认 `verdict` 才是编译差异的来源，引用标点不是原因。
- 产品侧不变量（本次改动前已存在，[flow.py](../src/notalone/memory_extraction/flow.py) 与 [pragmatics.py](../src/notalone/memory_extraction/pragmatics.py)）：`unsupported` 拒收、`uncertain` 追加 `semantic:{issue}` 并保持待确认、`supported` 不动；转述类候选一律 `pending`，与核验 verdict 无关。因此本改动不会把转述候选升级为自动采纳。

## 本地验证（0 次联网、0 预算）

先写测试再改提示，红绿如实记录。全部命令在 `source /Users/local-user/miniconda3/etc/profile.d/conda.sh && conda activate NotAlone` 之后执行：

```bash
# 单文件：改动前红（2 项失败、3 项通过），改动后 5 项全过
PYTHONPATH=src:. python -m unittest tests.unit.memory_extraction.test_verification_prompt_contract -v

# 记忆提取子集：175 项通过
PYTHONPATH=src:. python -m unittest discover -s tests/unit/memory_extraction -t .

# 全量：必须带 -t .（不加时 tests/unit/experiments 会被当顶层包，
# 触发与本改动无关的既有 experiments.pgvector 导入错误）
NOTALONE_DISABLE_DOTENV=1 PYTHON_DOTENV_DISABLED=1 PYTHONPATH=src \
  python -m unittest discover -s tests/unit -t .        # 720 项通过

PYTHONPATH=src python -m mypy src/notalone/memory_extraction --follow-imports=silent
PYTHONPATH=src:. python -m mypy tests/unit/memory_extraction/test_verification_prompt_contract.py \
  --ignore-missing-imports                              # 通过
git diff --check                                        # 通过
```

- 红：改动前两条提示契约测试失败——`test_prompt_states_report_is_not_alone_a_reason_for_uncertain`（提示中不存在“不能仅因”）与 `test_prompt_keeps_label_loss_as_uncertain`（不存在“仍须”）；另 3 条流程测试当时已通过（它们只经过确定性假 runtime 与内存 oracle，不读提示），说明 fail-closed 行为不依赖本次提示。两轴审查各自独立复现了同一红绿结果。
- 绿：改提示后 5 项全过；其中 `test_supported_report_keeps_fact_without_semantic_risk` 断言 `supported` 不产生 `semantic:*` 风险、且该候选仍为 `pending`（`report`、`reported`）；`test_uncertain_verdict_still_adds_semantic_pragmatics` 与 `test_unsupported_verdict_still_rejects` 守住降级与拒收。
- 回归：记忆提取子集 175 项、全量 720 项通过。`mypy src/notalone/memory_extraction` 24 个源文件仅剩 `command.py:504` 一处与本次无关的既有错误（已用 `git stash` 前后对比确认改动前同样存在）。全量 `unittest discover -s tests/unit`（不加 `-t .`）会因既有顶层包冲突报 1 个导入错误，与本次改动无关；这是仓库既有状态，不是本次引入。

## 限制

- 提示文本无法在离线环境证明模型行为：本地证据只说明提示已明确该语义、产品在三种 verdict 下的后处理未变。产品提示此前没有“完全被支持的 report/reported 不得判 uncertain”的明确表述，本次补齐属于降低歧义，不等于模型一定照此返回。
- 试点的 `mixed 4/4` 与 `supported 4/4` 来自带 `described_party` 的人物变体提示与固定匿名 C4 窗口；产品提示没有该字段，两者不是同一提示的对照，不能把试点数字直接算作产品提示的成绩。
- 文本差异如实披露：试点候选叶末尾还有一句“语用状态仍由候选已有字段和后续 `PragmaticInterpreter` 处理”，产品版未收录该句，因为产品流水线里这一步本来就由 `PragmaticInterpreter` 承担（[pragmatics.py](../src/notalone/memory_extraction/pragmatics.py)），无需在提示里复述；其余句子含义与候选叶一致。这样产品版比试点版短一句，4/4 的可迁移性因此未经实测。
- 提示断言的脆弱面：两条契约测试用“不能仅因”“仍须”等句式作为标记，若日后同义改写提示会误红；判别力主要来自流程测试的 `semantic:*` 为空与 `pending` 断言。
- 试点捕获的模型响应属于人物变体提示，未用于重放本产品提示，以免得出误导结论。
- 未读取真实聊天、actual/held 留出、凭据；未写业务记忆、水位或历史资料；未改其他字段、schema、Flow、默认采纳与远端 Git。

## 下一步

1. 真实模型匿名对照仍是必需项：沿用既有模式（固定匿名窗口、逐步开门、只观测 `verdict`/风险与 `report/reported` 保持 `pending`、坏 auto 与误拒分别统计），需要用户另批预算。
2. 若对照通过，再由用户决定是否调整人物等相邻字段或进入发布评估；未通过则保留首返回、关闭余量并回到现有 fail-closed 路径。
