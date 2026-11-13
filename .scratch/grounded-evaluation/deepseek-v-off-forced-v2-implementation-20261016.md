# 单次V探针v2：离线实施记录

Triage: ready-for-agent
State: resolved

依据[已发布v2计划](deepseek-v-off-forced-v2-plan-20261016.md)，仅修改专用runner和测试，修正未来响应失败的安全观测；v1计划、实施、冻结、事件及结果保持原样。实施与验证全部为离线Mock、临时home／合成预算与自有合成子进程，没有真实凭据读取、真实台账或模型请求，不声明独立审查通过。

## 首红

先仅加v2输入／绑定、5类响应处理反例、响应状态、正常响应脱敏与I/O失败负控，再运行新fixture：17项，7失败及10错误（3.038秒）。非法arguments、非object、非有限arguments／正文、HTTP503均复现旧版把响应保存异常归为无响应failure；实际响应标记、v2绑定与结果状态缺失也按预期失败。原SDK成功wire、严格index／PID、fresh claim、预算与deadline用例在本轮保持覆盖。尚未声明修正或审查通过。

## 最小修正

- 专用runner升级为`deepseek-v-off-forced-pilot-v2`；唯一新输入“我刚刚到家。”，仍用给定v4标签编译候选。freeze改绑v2计划／本实施记录，拒绝旧v1版本；原SDK、nullable-proof-v1提示／schema、disabled／none／强制具名工具、cap1及全部时限保持。
- `capture_response`先标记已取得响应。JSON解析、脱敏或规范化普通异常时，只保存实际`status_code`、`body_bytes`、`response_obtained=true`和固定`body_not_saved=response_processing_failed`；超出既有长度上限同样只存受控元数据。随后硬停，不能作为合法工具响应或completed。不保存原始arguments、正文副本、任意异常文本或headers。
- 发布I/O失败仍通过既有`EvaluationBudgetAbort`硬停，不冒称响应保存成功；安全元数据无法生成或保存时同样失败安全。`capture_failure`和result显式使用本轮实际响应捕获状态，真正read timeout仍为false。
- 测试经实际SDK／transport验证捕获前和捕获后普通异常的false／true事件差别，正常响应脱敏、正常／元数据两条I/O失败、503实际状态、一次闭账不退款，及原成功wire／严格整数／claim／deadline全回归。测试阻断真实socket连接和DNS，自有合成进程已回收。

## 验证结果与命令

Conda `NotAlone`中运行；首绿17项通过（3.731秒），加强完整SDK路径后最终17项通过（3.764秒）；最小共享回归2项通过（0.006秒）；两个文件mypy无错误。

```sh
# 仓库根目录
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=backend/src python -B -m unittest discover -s desktop/tests/fixtures -p test_deepseek_v_off_forced_public.py -v
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=backend/src MYPYPATH=backend/src python -B -m mypy --follow-imports=silent desktop/tests/fixtures/deepseek-v-off-forced-public.py desktop/tests/fixtures/test_deepseek_v_off_forced_public.py

# backend/目录
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src python -B -m unittest tests.unit.memory_extraction.test_evaluation_http_budget.EvaluationHttpBudgetTest.test_response_read_failure_is_not_refunded tests.unit.memory_extraction.test_evaluation_provider_contract.EvaluationProviderContractTest.test_invalid_success_tool_structure_never_establishes_identity -v
```

数据仅为新公开合成输入与临时测试记录；本机已审helper继续纳入freeze，仍不承诺干净checkout可运行。结果仅证明离线合同与观测边界，不给旧响应HTTP码、具体arguments错误、供应商原因或模型质量信用。待Root独立两轴审查、最终冻结及实际单次执行；未stage／commit，未修改共享backend、v1材料或他人dirty。

Root收尾：独立Standards硬规则／判断性问题均0、Spec缺失／错实现／越界均0；Spec另独立复跑17项通过。Root最终材料下复跑17项通过（3.131秒），类型检查仍为实施者上述两个文件通过。离线实施完成，真实请求尚未发生；最终源码／本记录／计划将共同冻结，之后实际结论另写结果，不改本记录补签旧质量。
