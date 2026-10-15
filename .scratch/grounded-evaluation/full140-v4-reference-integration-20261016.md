# 完整140 v4／来源保真v2参考协议装配（2026-10-16）

本记录对应[完整140规格](full140-v4-source-v2-readiness-20261016.md)，承接[原待审切片](reference-source-fidelity-v2-spec-20261016.md)。只合成离线，不启动真实预算、模型、凭据、PG、GUI或安装，不提交。

## 已有事实与范围

Root已完成两轴独审：`grounded_eval_standards`核9文件／绑定／不变性0项；`grounded_eval_spec`独立核实际source、contact sender／target 0、D2第87行及A05语义0项。本次语义范围只有A05及直接规则、140装配和不变性，其余139／R105延续旧独审；非新盲标、现实认证、模型质量或维度放行。

待审切片原件、pending状态与摘要保存在提交`9d44e5fb`及原spec历史。新材料如实更新已审元数据，固定绑定只接受当前已审对象；待审或伪造passed材料不能靠自重算摘要获准。旧v1默认行为及原件、全部输入／窗口／命题／分母／来源选择和旧成绩不变。

## 已约定Seam

- 两个reference validator显式`reference_version`封闭选择，默认`legacy-v1`；新固定v2返回`review_pending=false`、`execution_ready=true`、`quality_certified=false`。
- `EvaluationExtractionMode.GROUNDED_V4`连接实际v4 prompt／schema／runtime；生产factory不变。
- `EvaluationRecordStore`只接受新固定计划／版本字段精确配对，完整140逐窗合同；旧省略字段仍为legacy。
- `PhasedEvaluationAudit.reference_version`只允许source-v2与grounded-v4、full140、nullable及E／V omitted组合；离线bundle必须与冻结版本一致。generic offline不开放v4。

本Agent拥有四份v2材料、reference／extraction／records／offline／phased及对应测试；fixed entry／deadline／owned runner由并行worker负责。本记录不代替Root的最终冻结或启动授权绑定。

## 验证记录

本切片实现完成，待Root与并行固定入口合并核对及两轴独审；本轮没有真实模型质量成绩，没有启动真实预算。

独立初审实际为Standards硬合同1项（判断性问题0）、Spec错实现1项（缺失／越界0），均指同一P2：新records只用Python相等比较plan，`False/0.0`能冒充0、`True/1.0`能冒充1，即使调用者重算plan及config摘要仍可注册。Root在新v4注册内补逐项严格整数类型，不改变旧legacy行为，并补四种实际构造器负控及“拒绝前不写manifest”断言。records组23项先红、4个子例实际失败；修复后相关六模块**111/111**，10.214秒通过，日志`desktop/artifacts/full140-v4-root-record-position-{red,green}-20261016.log`。原495／110是修复前历史范围，不改写为当时已覆盖本问题；本次回归与之重叠，不累加唯一测试数。两轴增量复核待返回，完整入口集成仍由Root另行验证。

随后实际增审：Standards原1项→剩余0、判断性问题0；Spec原1项→剩余0、无新问题，Spec审查者另行单跑新增四种负控通过。Root对records源码mypy通过，日志`desktop/artifacts/full140-v4-root-record-position-types-20261016.log`。本装配切片至此完成两轴审查；整体真实运行仍须固定控制切片、最终合同、冻结和唯一启动分别完成，不以材料资格或本切片通过代替真实模型质量。

TDD实际反馈：参考资格正控先因仍返回pending而失败，pending／伪造passed负控同时暴露旧固定pending仍被接受；更新实际审核元数据、固定摘要及状态门后20项通过。v4选择先因枚举缺失、generic offline拒码不符而失败，再通过；records新注册先因缺property／v4冻结拒绝失败，再通过；phased先因缺reference_version关键字失败，随后完整路径检查又发现具名工具参数只识别旧v2／v3，扩入v4后28项通过。离线Mock首个反馈是夹具误用不存在的kind=none，修为既有not_memory后确认版本bundle、编译记录、raw／final保存、单次E与零V、unknown停后139未跑、关闭和capability过期；此合成夹具只验证传输和记录，未认证A01语义或覆盖。

命令均先激活Conda `NotAlone`，设置`NOTALONE_DISABLE_DOTENV=1`并使用`python -B`；指定模块的工作目录是`backend/`：

```sh
python -B -m unittest tests.unit.memory_extraction.test_evaluation_reference tests.unit.memory_extraction.test_evaluation_records tests.unit.memory_extraction.test_evaluation_phased_audit tests.unit.memory_extraction.test_evaluation_extraction tests.unit.memory_extraction.test_evaluation_review tests.integration.memory_extraction.test_evaluation_offline -v
python -B -m unittest discover -s tests/unit/memory_extraction -t . -v
python -B -m mypy src/notalone/memory_extraction/evaluation_reference.py src/notalone/memory_extraction/evaluation_extraction.py src/notalone/memory_extraction/evaluation_records.py src/notalone/memory_extraction/evaluation_offline.py src/notalone/memory_extraction/evaluation_phased_audit.py
```

- 当前材料最后澄清历史pending段落、同步所有摘要后，相关组 **110/110**，7.419秒；日志`desktop/artifacts/full140-v4-reference-related-final-20261016.log`。其中reference20、records22、phased28、extraction2、review20及offline18；此前同组110通过不重复累计。
- 完整memory_extraction unit **495/495**，6.922秒；日志`desktop/artifacts/full140-v4-reference-all-unit-20261016.log`。包括并行worker当时已落地的deadline测试及Root更新的两个旧合同断言；最后的文档历史限定与固定摘要再由上述110核过。unit92与相关组合重叠，当前唯一测试数 **513**（495＋offline18），不与旧任务的576、86或真实窗口相加。
- 修改的5个源码mypy通过，日志`desktop/artifacts/full140-v4-reference-types-20261016.log`。`git diff --check`通过；四个相关Markdown的179个本地链接可达，无本机身份绝对路径。
- 对提交`9d44e5fb`逐值比对：两JSON全部windows／e_fields／v_fields／common_rules不变；full140全部source manifest／旧oracle／mapping／rule_scopes不变。四份v1字节固定负控继续通过，A05以外139／R105未改，138必需＋A15可选1／156分支／162来源选择不变。

所有修改仅本次16文件：四份v2参考／中文材料、五个源码、五个对应测试（含新增extraction unit）、原spec追加后继记录与本记录。`evaluation_review.py`、生产factory、grounded编译器、评分器、默认空表、采纳、旧Gold／原source／旧成绩／旧冻结／原票和初始dirty未由本Agent修改；并行fixed entry／owned／deadline／fixture另由对应worker负责，本记录不替其最终集成验收。

## 当前固定材料摘要

| 材料 | JSON规范SHA | JSON字节SHA | 中文字节SHA |
| --- | --- | --- | --- |
| public21 v2 | `823d680bfa9e4c62024e570de0dddd2eb06e27d6fe05ba757e88e6dfb08f2635` | `6ec7ee70a47b94d0cdf667be6478b8fe7cbe33e91bc3d4ec5e49ee340914f738` | `99efaae24d8d4175a2006ae8442e8ea8635728c3eef3d9c9bc8357d382683977` |
| full140 v2 | `e0edd5d6badafc23e63bd85375a21e126c962d4b0758bbf721786d58fa254040` | `01689754c0e650e26d98c7d714f244eefb3a5f75c1e1dc12bd74073d5e2b2745` | `df79166517ed9196d8f9011aeb59b2b496b5ce233a45df85a98ae1029a4e5560` |

公开JSON仍为原9顶层键；版本／路径／独审记录／待审历史在provenance，不新增任意path能力。新显式版本拒绝旧pending历史材料，不能靠改status、reviewer或重算对象SHA冒充当前已审绑定。无版本字段旧记录／旧审核bundle仍为legacy；新版本只供固定完整140 v4协议，不开放generic offline v4。新固定参考资格不是prompt／代码最终冻结、实际模型表现、typed proof可用、维度批准、自动采纳或生产启用。后续实际执行及独立raw／full审核由Root在完成合并和冻结后协调。
