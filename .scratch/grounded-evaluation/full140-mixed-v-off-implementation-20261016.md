# 完整140固定分阶段合同：离线实施记录

Triage: ready-for-agent
State: resolved

依据[已发布计划](full140-mixed-v-off-plan-20261016.md)，实施范围限专用评测入口与直接测试。仅运行精确Mock、临时home和自有合成进程；不读取真实凭据、不创建真实预算、不启动真实模型或批次。不声明独立审查或质量通过。

## 固定身份与实施

执行计划`full140-grounded-v4-source-v2-v-off-forced`，provider／阶段版本`deepseek-phase-split-v1`，mode`deepseek_bounded_full140_v4_source_v2_v_off_forced`，stage`full140-v4-source-v2-v-off-forced`，owned kind`full140-v4-v-off-forced`。策略函数每次返回新的唯一固定值；E enabled／max／omitted，V disabled／none／forced。两个内部SDK模型共用领取后的一次凭据、同一transport和预算；原adapter、动态schema及提示不改。

六个后端模块贯通上述身份：ecnu准入与invocation_scope，provider完整wire，offline按purpose分发，records严格登记与安全响应，phased审核bundle和owned领取／收尾。原完整140仅保留旧配对；新字段不得借旧身份使用。旧夹具共用流程只接收旧／新两个内部固定变体，新薄入口不复制评测流程。ADR-059仅补离线封闭准入。

新源码闭包沿旧完整集合另加新薄入口、计划、本记录及ADR；prepare／validate核来源参考、140输入映射、动态合同和安装版本；真实请求前沿provider复核源码、截止及完整wire。不宣称每个RAW／FULL桥回调都重新校验源码。本机已审helper仍是实际依赖，不承诺干净checkout可运行。Gold、来源可信元数据、生产与typed门未改。

仅新profile按内建int及范围核请求序号，并按sequence标记进入响应捕获。解析／脱敏／完整规范化／摘要先于I/O预验；失败沿现有digest-only元数据，保存真实HTTP状态、长度／hash、固定失败码和`response_obtained=true`后硬停。I/O失败不补写同一终态；旧profile原路径保留。新模型响应index、owned PID／计数均严格整数。

## 真实红绿与当前验证

首条SDK垂直测试为新薄入口缺失的真实红（1项error），贯通固定门后转绿：首窗E→V两次实际SDK Mock请求、领取后一次loader，独立合成审核unknown即闭账（1项，1.459秒）。新增records测试初次借用旧测试helper时误用了synthetic endpoint，已修正测试夹具；随后真实红只剩True／1.0／0／281序号四个负控（5项，4失败，0.483秒），补仅新profile的int／范围门后转绿。新合同／records／准入共7项通过。

必要共享与集成组87项通过（17.442秒）；新增owned正常／deadline PID与计数、3001／16385事件恢复边界、phased混版4项通过（4.024秒）；10文件mypy无错误。首次完整140 Mock因实施者在运行中补写冻结闭包文件而触发source drift硬停，不能算全量通过；同组其他4项新fixture负控已通过。最后稳定源码的末窗复跑与旧runner回归待下方追加。

命令均先激活Conda `NotAlone`，设置`NOTALONE_DISABLE_DOTENV=1`：

```sh
# 仓库根目录：新fixture，末窗单项使用此模块的完整测试名
PYTHONPATH=backend/src python -B -m unittest discover -s desktop/tests/fixtures -p test_full140_mixed_v_off_public.py -v
# 旧runner回归
PYTHONPATH=backend/src python -B -m unittest discover -s desktop/tests/fixtures -p test_full140_v4_public.py -v
# backend/：87项直接相关组
PYTHONPATH=src python -B -m unittest tests.unit.memory_extraction.test_evaluation_mixed_contract tests.unit.memory_extraction.test_evaluation_provider_contract tests.unit.memory_extraction.test_evaluation_records tests.unit.memory_extraction.test_evaluation_phased_audit tests.unit.memory_extraction.test_evaluation_owned_process tests.integration.memory_extraction.test_evaluation_ecnu.EvaluationECNUTest.test_full140_v4_rejects_every_changed_fixed_scope_or_type_before_claim tests.integration.memory_extraction.test_evaluation_ecnu.EvaluationECNUTest.test_official_reference21_uses_fixed42_and_max_without_tool_choice tests.integration.memory_extraction.test_evaluation_ecnu.EvaluationECNUTest.test_main16_fixed_official_v3_plan_keeps_all_original_main_windows_and_32_cap tests.integration.memory_extraction.test_evaluation_offline.EvaluationOfflineTest.test_nonempty_extraction_runs_verification_and_keeps_raw_and_original_score tests.integration.memory_extraction.test_evaluation_offline.EvaluationOfflineTest.test_registered_full140_v4_bundle_and_persist_use_frozen_reference_version -v
```

87项组执行后新增的4项owned／phased用例已单独运行，没有重跑整个组。剩余风险限未做真实调用与独立审查；本片所有成绩均为合成控制，不认证140语义、typed、来源可信链或放行。未stage／commit，他人dirty保留；真实freeze与唯一启动留Root。

## 最终稳定复跑

稳定所有实现文件后，新完整末窗单项通过（40.855秒）：140E、138V、278次实际SDK Mock请求，完整140位置及Gold映射不变，末窗139到达、RAW／FULL均按序、cap280闭账；合成输入中两个空窗不调用V，此请求数不代表139个Gold事实对应139个V窗。旧完整140 runner的9项回归通过（42.970秒），验证旧E／V仍均max／omitted。新fixture的另外4项控制已在前一组通过；完整一项仅因前述实施者误改闭包而单独复跑。复跑之后只校正说明文字，未改变控制行为。

```sh
# 仓库根目录：最终完整末窗单项
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=backend/src:desktop/tests/fixtures python -B -m unittest test_full140_mixed_v_off_public.Full140MixedPublicTest.test_full_mock_reaches_last_window_with_actual_v_count_and_fixed_closed280 -v
# backend/目录：87项后新增的4个边界
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src python -B -m unittest tests.unit.memory_extraction.test_evaluation_owned_process.OwnedPublicProcessTest.test_mixed_normal_and_deadline_receipts_require_integer_pid_and_counts tests.unit.memory_extraction.test_evaluation_owned_process.OwnedPublicProcessTest.test_mixed_fallback_keeps_16384_limit_and_last_window_mapping tests.unit.memory_extraction.test_evaluation_phased_audit.EvaluationPhasedAuditTest.test_mixed_phased_identity_and_policy_are_checked_before_raw_access tests.unit.memory_extraction.test_evaluation_phased_audit.EvaluationPhasedAuditTest.test_old_phased_identity_cannot_accept_mixed_policy -v
# 仓库根目录：类型检查
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=backend/src MYPYPATH=backend/src python -B -m mypy --follow-imports=silent backend/src/notalone/memory_extraction/evaluation_provider_contract.py backend/src/notalone/memory_extraction/evaluation_offline.py backend/src/notalone/memory_extraction/evaluation_ecnu.py backend/src/notalone/memory_extraction/evaluation_records.py backend/src/notalone/memory_extraction/evaluation_phased_audit.py backend/src/notalone/memory_extraction/evaluation_owned_process.py desktop/tests/fixtures/full140-v4-public.py desktop/tests/fixtures/full140-mixed-v-off-public.py desktop/tests/fixtures/test_full140_mixed_v_off_public.py backend/tests/unit/memory_extraction/test_evaluation_mixed_contract.py
```

实现者停止编辑，等待Root集成复验与独立两轴；没有新的真实场或自动后继。

## Root离线收尾

Root在实现稳定后分别运行全部`test_evaluation*.py`：评测单元193项通过（17.354秒），评测集成112项通过（23.553秒），两进程exit0已取回。命令在仓库根目录、Conda NotAlone、禁dotenv下为`PYTHONPATH=backend/src python -B -m unittest discover -s backend/tests/unit/memory_extraction -t backend -p 'test_evaluation*.py' -v`，集成将路径替换为`backend/tests/integration/memory_extraction`。没有重复完整Mock或不相关记忆／桌面包。

以`4b748809`为固定基点的15文件独立Standards初审硬规则／判断性问题均0，Spec初审缺失／错实现／越界均0；Spec另做最小10项离线验证。Root仅随后收窄ADR的时间表述与失败记录描述，不改变实现或合同。上述各组分开记录，不相加成质量样本。

旧A13的独立只读复查表明：同旧标签／V的纯内存重放在v4仍可得到auto／pending混合与bad_auto；这不是本新合同必然触发，也未发现须在本次放宽的确定性程序缺陷。现有pending正控及错误auto安全负控已在Root193项内运行，整组去向安全规则保持；新场若触发仍须停止，不改Gold、去向或删候选救分。该诊断没有新真实调用，不计本场成绩。

离线实施已完成；所有最终文档进入新freeze。当前仍没有本场真实台账或模型请求，Root在最终纯prepare及本地提交扫描后另行核查、绑定现有授权并唯一启动；本记录不预签真实质量、typed或放行。

最终文档落盘后的纯prepare／旧新跨版拒绝单项通过（0.562秒）；仍为临时home／禁真实凭据与网络的离线验证。
