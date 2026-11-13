# 单次V关闭思考／强制具名探针：离线实现记录

Triage: ready-for-agent
State: resolved

依据[已发布计划](deepseek-v-off-forced-pilot-plan-20261016.md)，本片仅实现独立fixture与精确Mock测试。没有真实模型请求、真实凭据读取或真实评测预算；未修改既有后端／完整140合同。以下是离线实施记录，不声明独立审查通过，不表示可以启动真实调用。

## 实施范围

- 新增 `desktop/tests/fixtures/deepseek-v-off-forced-public.py`：固定 `deepseek-v-off-forced-pilot-v1`，仅编译给定v4标签的“我刚到家。”候选，实际SDK调用现有nullable-proof-v1 V适配器。请求体逐项核对官方端点、`deepseek-flash`、disabled／none、唯一原schema及强制`SourceVerificationOutput`；不启用strict或beta，不调用E。
- 新增 `desktop/tests/fixtures/test_deepseek_v_off_forced_public.py`：精确 `httpx.MockTransport`、临时home／合成预算、禁止socket连接与DNS；进程测试只启动本测试创建的合成子组，验证leader退出后仍回收同组后代，并保留独立哨兵组。
- 独立 `pilot-event-*`、manifest、result和finish格式保留 `quality_certified=false` 与 `automatic_successor=false`。请求／响应经既有脱敏规则，只记录正文和受控状态，不保存headers或异常消息。缺工具、错名、多工具、参数错误、错model、HTTP500及无响应read timeout均只消耗一次并闭账；不从content补解析。
- prepare不读home／registry／key；成功领取并复核零请求台账后才到唯一凭据loader。固定输入、来源、候选、原prompt／schema、完整wire、实际源码闭包、安装版本、计划／本记录及授权SHA共同绑定。源码闭包包含实际使用的两个本机已审helper与相关包源码超集；漂移在请求前拒绝。
- 共用预算、owned进程组和deadline基类；cap1，HTTP read30秒，call60秒，work70秒，outer80秒。prepare、validate、worker、launch共享原绝对窗口；外层为自有组收尾预留3秒。完成立即闭账；闭账证明缺失或不符时保留close_unknown，不创建后继。

当前依赖被忽略的本机 `desktop/artifacts/grounded-public21-prepare-20261015/` 下两个helper，仅复用文件函数、安装版本列表和领取后的凭据入口；实际文件均入freeze。此片不承诺干净checkout可运行，不修改或泛化旧helper。

## 红绿与验证

首红为一个SDK wire测试：新runner尚不存在，出现 `FileNotFoundError`；加入最薄固定实现后同一测试通过。扩展闭账／否定用例后，第二轮红发现manifest缺授权SHA与第二次launch未在spawn前拒绝；补齐绑定与一次性启动检查后转绿。

2026-10-16，在Conda `NotAlone`、`NOTALONE_DISABLE_DOTENV=1` 下完成：

```sh
# 仓库根目录；10项通过
PYTHONPATH=backend/src python -B -m unittest discover -s desktop/tests/fixtures -p test_deepseek_v_off_forced_public.py -v

# 仓库根目录；两个新文件无类型错误
PYTHONPATH=backend/src MYPYPATH=backend/src python -B -m mypy --follow-imports=silent desktop/tests/fixtures/deepseek-v-off-forced-public.py desktop/tests/fixtures/test_deepseek_v_off_forced_public.py

# backend/目录；36项通过
PYTHONPATH=src python -B -m unittest tests.unit.memory_extraction.test_evaluation_http_budget tests.unit.memory_extraction.test_evaluation_provider_contract tests.unit.memory_extraction.test_evaluation_main16_deadline -v
```

10项新测试覆盖实际SDK wire／fresh claim后唯一loader、prepare零home读取、授权与freeze／源码集合／版本／wire／窗口漂移在领取前拒绝、cap1第二次请求拒绝、工具与timeout故障一次闭账、领取后漂移闭账零请求、60／70秒退场的closed或close_unknown、原80秒窗口与重复launch、仅自有组及后代回收。HTTP500与read timeout均实际经SDK Mock验证一次发送，未发生重试。共享36项回归覆盖既有预算、provider和main16 deadline守卫；没有重跑完整大包。

这些结果仅证明离线合同与控制，不能证明官方服务实际可用、延迟、V质量、旧unknown结果或任何自动采纳资格。真实执行留给Root在独立两轴审查、最终冻结与复核后另行开展；本实施者未stage或commit，原有他人改动保留。

## 初审修正：整数类型边界

独立初审提出两个P2：正常result与deadline fallback的worker PID只比较Python相等，导致等值浮点PID可被当作闭账证明；响应choice index只比较零，导致 `False` 与 `0.0` 可通过。Standards与Spec的PID发现指向同一个缺口，按一个问题处理；本记录不声明复审通过。

先仅增加两项测试，再运行上列fixture命令，真实红为 `Ran 12 tests in 2.239s; FAILED (failures=4)`：result／deadline的浮点PID各误报closed一次，choice index的bool／float各误报completed一次。PID测试同时保留实际整数正控，并覆盖bool和错PID负控，全部只使用自有合成子进程及临时文件。修正与绿灯结果将在完成后追加。

修正仅在新runner中为两条worker PID读取与choice index读取加入 `type(value) is int`；同片的created、request_limit与reserved_requests已有严格整数检查。仍以同一命令验证，12项通过（2.321秒），两个新文件mypy再次无错误。原36项共享回归在本片初审前已通过，共享源码未改；本轮另外复验既有provider非法成功响应守卫。修正没有改变模型策略、schema、旧结果或其他入口，尚待独立复审。

文档补齐后的fixture复跑仍为12项通过（2.322秒）。本轮最小相关命令在 `backend/` 执行：`NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src python -B -m unittest tests.unit.memory_extraction.test_evaluation_provider_contract.EvaluationProviderContractTest.test_invalid_success_tool_structure_never_establishes_identity -v`，1项通过（0.003秒）。所有本轮命令均在Conda `NotAlone` 中执行。

Root独立审查完成：Standards初审1项P2、Spec初审2项P2（PID为同一缺口），修正后两轴窄增审剩余均0，判断性问题0。Root另已独立复跑修正前10项和两个文件mypy；修正后12项及最小provider1项由实施者实跑，真红／绿见上文。不累加成独立质量样本。最终准备将冻结这两份文档及实际runner／helper／安装版本；当前仍没有本探针真实请求，真实运行另作结果记录。
