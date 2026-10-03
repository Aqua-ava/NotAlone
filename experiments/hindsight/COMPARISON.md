# Hindsight 本机中文记忆召回对照

本轮只评价 Hindsight 作为已采纳联系人记忆的候选导航服务。两臂都经过现有 `RetrievalReplyContext.build`、双预算和 `validate_current`；正文、来源、采纳方式、置信度与版本均从本地权威快照读取。没有启用生产向量路径、改写自动采纳、读取真实聊天或验证微信回复质量。

**本次结论：未达到已确认门槛。** 改写覆盖提高、质量组无关注入减少，但 Apple M2/16 GiB 的 CPU 配置下完整预热 P95 为 **1,782.96 ms**，超过用户确认的 1,000 ms 上限。保留当前失败配置和结果，不使用 final 输出调阈值、改模型或缩候选池。生产继续现有路径。

## 实测结果

| 验收或诊断 | A：现有词法 | B：Hindsight + 本地复验 | 结果 |
| --- | ---: | ---: | --- |
| 60 条改写宏 Recall@5 | 1.67% | 15.00% | +13.33 个百分点，达到至少 +10 门槛 |
| 95 条质量组无关注入 | 15/95（15.79%） | 12/95（12.63%） | 不增加；非 gold ID 总数 45→26 |
| 范围/状态/来源/字段/预算/重复违规 | 0 | 0 | 通过；分别审计 131/127 条最终本地记录 |
| 完整 P50 | 16.74 ms | 1,010.30 ms | 全部尝试 |
| 完整 P95 | 28.36 ms | 1,782.96 ms | **不通过**，B 大于 1,000 ms |
| 完整最大值 | 36.43 ms | 2,839.07 ms | 全部尝试 |
| 正式完整尝试 | 103 | 103 | 0 失败/超时，成功分布等于全部分布 |
| 实际 HTTP / 无 token 跳过 | 0 / 本地路径 | 100 / 3 | B 没有失败回退为 A |
| 本人路径与独立预算 | 原有本地路径 | 相同本地 ID、正文与来源 | 正例 Recall@3=1；压力组=0.75 |
| 固定 query 稳定复跑 | 3 query×3 次 | 3 query×3 次 | 最终 ID 顺序一致，分值不要求末位完全相同 |

主改写组正例空结果率由 55/60（91.67%）降到 43/60（71.67%），绝对覆盖仍低。改写有选入 query 的宏 Precision 为 A 40.00%（分母 5）、B 90.20%（分母 17）；不能把不同分母的精确率当作全组成功率。20 条直述宏 Recall 由 A 94.17% 降到 B 87.50%。同主题定向问题的非 gold 注入为 A 3/5、B 5/5，质量组整体改善不表示每一层都改善；逐项误注入 ID 完整保留。

最终改写的可映射外部候选宏覆盖为 96.67%，过评分门后 15.00%，本地复验及最终 Context 仍为 15.00%。本组主要覆盖损失发生在相关性门，不能据此断言换阈值就同时满足准确性。只有 5 个独立 dev 主题、75 条资料的校准不能代表最终 310 条竞争资料；本次保留这个限制，没有反过来用最终查询校准。

100 次实际 HTTP 的服务诊断显示 cross encoder 评分候选数中位 134、P95 149、最大 155；重排组件耗时中位 971 ms、P95 1,726 ms、最大 2,661 ms。它解释了主要等待成本，但不是完整耗时的验收替代。正式返回 3,365 个空映射候选，全部明确记为 `mapping` 拒绝；这也说明服务字段与身份映射需要真实运行核验。

可核对材料：[正式汇总](comparison-v2-r2/result.json)、[逐 query/逐尝试](comparison-v2-r2/formal-attempts.json)、[冻结配置](comparison-v2-r2/frozen-config.json)、[校准全部候选阈值](comparison-v2-r2/calibration.json)、[dev 真实 HTTP/重放计数说明](comparison-v2-r2/calibration-accounting.json)、[候选阶段与组件诊断](comparison-v2-r2/stage-accounting.json)、[预热](comparison-v2-r2/warmup-attempts.json)、[稳定性复跑](comparison-v2-r2/stability-attempts.json)。

## 对 NotAlone 意味着什么

本次证明在这组中文合成资料中，语义候选能够覆盖词法漏掉的资料；独立相关性门与本地权威复验可以在固定预算内降低整体误注入。不过当前本机完整时延不达标、改写最终覆盖仍只有 15%，不能据此批准接入当前 Hindsight CPU 配置或承诺真实回复质量。

可以直接学习的方法是：召回阶段与采纳置信度分开；按本地 ID 聚合 chunk；外部只做候选导航，正文、来源、版本与删除仍由本地权威复验；参数只在独立 dev 校准；最终组同时验覆盖、误注入、失败分母和完整等待时间。Hindsight 的实体/时间图、提取、observations、mental models 与 reflect 本轮没有验证，不能把这些能力列为已证明收益。更轻的重排、候选预算或词法融合只属于后续另立实验的假设，本轮没有继续实现。

## 数据、参数与完整尝试

使用已冻结 `hindsight-synthetic-v2`：397 条合成快照、133 条 query；其中 dev 是另外 5 个主题、75 条资料、30 条 query，最终是 20 个主题各 3 种改写，共 60 条主收益正例。最终质量组为 60 改写、20 直述、10 寒暄和 5 同主题定向问题，共 95 条。dev bank 较小，表达之间也存在主题相关性，结果不能当作真实用户分布或 60 个独立场景的估计。完整标注见 [DATASET.md](DATASET.md) 和 [冻结 gold](v2/gold.json)。

最终主 bank 本地共有 314 条资料，其中当前可检索的 310 条建立外部索引；另 4 条删除/失效/时间不在窗口的资料保持本地不可用，没有复制到正式静态索引。因此静态组的零状态违规不能单独证明陈旧外部索引处理；该能力由真实生命周期与竞态验证另行证明。另有两个隔离 bank 共 4 条同文异 ID 资料。4 条本人资料只走本地路径。

只校准 `tau_B`。先以真实 HTTP 抓取 dev 候选和实际归一化 `scores.reranker`，然后只重放该 dev 候选、继续通过真实 Context 选入与复验，搜索全部正分值和 1.0。本次共有 1,744 个候选阈值，冻结 `tau_B=0.024230102630622113`。先要求无关注入不高于 dev A，再依次选择改写宏 Recall 最高、误注入 query 最少、有选入 query 宏 Precision 最高、阈值最高的配置。1.0 仍会接受恰好 1 分，不是人为制造的全拒绝门；dev 重放耗时不作为服务时延。

dev 的 `captured_http_attempts` 是实际 HTTP 抓取；`selected_attempts` 只重放这些响应，其历史字段 `http_attempts` 表示 RecallClient 边界调用数，实际 HTTP 为零。正式 final 由真实 HTTP 客户端执行，该字段对应实际请求。独立计数说明已明确 execution_mode，避免把 dev 重放当作真实请求或时延证据。

阈值、模型、数据摘要、候选规则、源码摘要与运行计划在最终组之前冻结。最终每 query 每臂 1 次，共 103 次/臂；第偶数下标 query 按 A→B、奇数按 B→A。各 final 分组第一条先各臂预热 1 次。正式计时包含真实 HTTP、embedding、混合检索、重排、映射/去重、本地复验、Context 选取及 `validate_current`；不含模型加载、建索引、生成或计时后额外逐 ID 审计。另有事先声明的 3 个 query 各臂各 3 次稳定复跑，不并入正式质量或 P95。

P50/P95 使用排序后第 `ceil(p*N)` 个值，全部尝试保留；成功分布和失败/超时另列。Macro Recall 对有 gold 的 query 平均；Precision 对选入非空的 query 平均，并报告其分母。无关注入率分母始终是对应冻结组的全部 query；同文异 ID 不合并，多个 chunk 回到同一本地 ID 后只计一次。

## 保留的接入失败与修复

[首轮 comparison-v2](comparison-v2/result.json) 在独立 dev 阶段有 19/30 次失败、11 次成功，其中 27 次实际 HTTP、3 次无 token 跳过。没有选定阈值，也没有运行 final。原因是 HTTP 客户端把任何 `metadata=null` 候选提升为整次失败；实际响应的正常身份候选与空映射候选可以同时存在，评分日志仍完整。完整逐次失败、实际原响应、修复前参与源码摘要和精确清理证据均保留，没有从分母抽走这些请求。

固定 Hindsight 版本的 graph 扩展路径可能不带 metadata，HTTP 契约允许 `dict[str,str] | None`。现仅将 null 表示为空映射，交给适配器逐候选记 `mapping` 拒绝，保留有效候选；不从 document ID 猜测本地 ID。非 dict、非字符串映射或缺失/非有限分数仍是协议失败。这是接口适配修复，不改变模型、候选预算、gold 或评分方向。

修复后混合正常/null HTTP 接缝和真实 Context 正例通过；[独立 smoke](comparison-v2-r2-preflight/smoke-result.json) 通过、[生命周期复验](comparison-v2-r2-preflight/lifecycle-result.json) 的 27 个实际检查点全部通过。新 smoke bank 与首轮失败的四个 bank 均按明确身份清理。正式运行保存为 [comparison-v2-r2](comparison-v2-r2/run-plan.json)，保留首轮失败。

源码证据：固定 SHA `f7dd3f4fd7420f7beec60c32c965e5e5cf7be066` 的 [HTTP metadata 定义](https://github.com/vectorize-io/hindsight/blob/f7dd3f4fd7420f7beec60c32c965e5e5cf7be066/hindsight-api-slim/hindsight_api/engine/response_models.py#L390)允许 null；[通用列投影](https://github.com/vectorize-io/hindsight/blob/f7dd3f4fd7420f7beec60c32c965e5e5cf7be066/hindsight-api-slim/hindsight_api/engine/db/ops.py#L45)没有 metadata，[graph link 扩展](https://github.com/vectorize-io/hindsight/blob/f7dd3f4fd7420f7beec60c32c965e5e5cf7be066/hindsight-api-slim/hindsight_api/engine/memories/pg/link_expansion.py#L270)可能走该投影，[from_db_row](https://github.com/vectorize-io/hindsight/blob/f7dd3f4fd7420f7beec60c32c965e5e5cf7be066/hindsight-api-slim/hindsight_api/engine/search/types.py#L124)对缺字段使用 `None`。这说明该路径存在，不证明每一个实际空映射候选都经由同一路径，也不表示 retain 丢失 metadata。正式报告单独统计空映射候选与覆盖损失。

## 生命周期与证据范围

27 个真实检查点区分了本地拒绝和外部清除：同来源/多来源支持、metadata-only revision 更新、正文更新、幂等重试、公开 `correct` 创建新 UUID、最后来源/整条删除、重建、联系人 bank 清除，以及当前实例和同持久库重启后的不可检索。documents/chunks API、活动 SQL、embedding 列、archive、旧 unit ID 和作用域索引分别核对；其他 owner/contact 的控制正例仍能召回。字段、来源和时间竞争由确定性边界替身验证，不能冒充真实服务收益。

多来源更新使用明确声明的合成权威快照，不证明生产来源删除任务已接入 Hindsight。活动行、索引和可检索副本清除不证明 MVCC、WAL、死索引元组、备份、进程暂存或存储介质的物理擦除。详见 [生命周期报告](lifecycle.md) 及修复后复验原始数据。

## 固定环境与成本口径

源码与 `hindsight-api-slim 0.10.2` 固定，实际服务是独立 Python 3.11 venv + pg0 PostgreSQL 18.1，API `127.0.0.1:18888`、数据库 `127.0.0.1:18543`。产品代码仍用 Conda NotAlone Python 3.12。两个模型为 BAAI/bge-small-zh-v1.5（SHA `7999e1d3359715c523056ef9478215996d62a620`，512 维）和 cross-encoder/mmarco-mMiniLMv2-L12-H384-v1（SHA `1427fd652930e4ba29e8149678df786c240d8825`）。CPU/local/offline，`OMP_NUM_THREADS=2`，LLM none、chunks、禁止自动归纳、world-only，没有云端推理或模型自动降级。实际版本与配置随冻结文件保存。

另外用全新空缓存真实下载同 SHA 的公开模型，首轮 bge 为 7,447.91 ms/96,407,485 bytes，mmarco 为 20,067.73 ms/492,761,724 bytes，合计 27,515.64 ms/589,169,209 bytes。结束后额外下载缓存全部清除，正式模型文件配置 SHA-256 一致；第二次新缓存重复单列保存，没有覆盖首轮。该成本依赖当时网络，不能把两轮当可靠分布。最初依赖安装耗时没有完整记录，没有把现有 venv/uv 缓存称首次安装。

此前模型文件已缓存的进程停止/重启至 health 为 9,981.34 ms；这是进程冷启动，未清除 OS 文件缓存，与首次模型下载和安装不同。修复后复验也保存其独立重启值。实际完整召回 P95 与这类启动成本分开报告。

正式 runner 每秒读取 API 的 ps CPU/RSS，报告抽样最大值；该值不是精确的整个进程内存峰值。runner 自身另报告 OS 记录的峰值和用户/系统 CPU 时间。数据库子进程和系统总内存没有合计。磁盘列出独立 database/models/venv 目录，SQL 删除不代表目录恢复到初始大小。

本机实际为 macOS 15.7.5、Apple M2、8 个逻辑 CPU、16 GiB；产品 Python 3.12.13。API 最大抽样 RSS 939,120 KiB（约 917 MiB）、ps CPU 240.6%（多核进程口径）；runner OS 峰值 334,594,048 bytes（约 319 MiB），用户/系统 CPU 231.37/2.54 秒，包含全部 dev 阈值穷举和 final。独立目录 database/models/venv 分别 69,388/591,612/1,789,200 KiB。主 bank 310 条建索引为 5,665.67 ms，dev 75 条为 1,193.07 ms，两隔离 bank 各 2 条为 146.35/142.95 ms。更新/删除小量成本另见生命周期报告；不把初建大集成本和单文档更新混在一起。原始证据见 [资源抽样](comparison-v2-r2/resources.json)、[索引逐批成本](comparison-v2-r2/index-events.json)、[新缓存公开下载](comparison-v2-r2/download-cost-evidence.json)。

## 运行、验证与清理

模型准备/启动方法见 [runtime.md](runtime.md)。下列复跑使用当前已复验的源码和已缓存模型；产物目录须是新目录，目标四个冻结 bank 若已占用会拒绝，不静默清空其他运行。

```sh
source /Users/local-user/miniconda3/etc/profile.d/conda.sh
conda activate NotAlone
PYTHONPATH=src python -m notalone.experiments.hindsight_runtime start
curl --fail http://127.0.0.1:18888/health
PYTHONPATH=src python -m notalone.experiments.hindsight_comparison run --output experiments/hindsight/reproduction-20261004 --preflight experiments/hindsight/comparison-v2-r2-preflight --cost-evidence experiments/hindsight/comparison-v2-r2/download-cost-evidence.json
PYTHONPATH=src python -m notalone.experiments.hindsight_comparison cleanup --output experiments/hindsight/reproduction-20261004
PYTHONPATH=src python -m unittest discover -s tests/unit/experiments -v
PYTHONPATH=src python -m unittest tests.unit.retrieval.test_recall_evaluation tests.unit.retrieval.test_lexical tests.unit.reply.test_context_retrieval -v
PYTHONPATH=src python -m mypy src/notalone/experiments --follow-imports=silent
```

实际首次失败命令为 `... hindsight_comparison run --output experiments/hindsight/comparison-v2 --cost-evidence /tmp/notalone-hindsight-cost-evidence.json`，该版本先运行 dev 后拒绝接受阈值。修复与重新复验之后使用 `--output experiments/hindsight/comparison-v2-r2 --preflight experiments/hindsight/comparison-v2-r2-preflight`；没有覆盖原数据。

公开下载复现脚本 [download_cost.py](download_cost.py) 使用固定独立 runtime 的 Python 3.11 venv，命令为 `/tmp/notalone-hindsight-runtime-f7dd3f4/venv/bin/python experiments/hindsight/download_cost.py`；输出 `/tmp/notalone-hindsight-cost-evidence.json`，只处理本脚本创建的额外空缓存并在结束后清理。公开下载不携带 query、资料或 token。不要与正式性能测量同时运行。

实际通过 36 个完整实验测试、66 个原有词法/召回/Context 回归，13 个实验源码模块 mypy 和 `git diff --check` 通过。最小 red→green 验证 dev 门的真实 Context 结果、超时保留分母、nullable metadata 不猜身份；分位数测试包含 6 个 1,500 ms 失败，不能以成功快样本替代全部 P95。

清理只读取本轮 owned manifest，核对四个精确 bank 和当前 internal_id 未被另一轮替换；首轮和正式轮均已验证删除后各活动表计数及作用域索引归零，见 [正式清理证据](comparison-v2-r2/cleanup.json)。原始证据保留在 Git，API/pg0 和独立 runtime 最终停止与清理由主 Agent 收尾。Standards/Spec 两轴与全仓回归由主 Agent 统一执行；本文不提前声明已通过。
