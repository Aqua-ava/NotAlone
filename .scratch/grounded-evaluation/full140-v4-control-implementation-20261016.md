# 完整140窗v4固定控制的实施记录

Triage: ready-for-agent
State: resolved

范围按 [主规格](full140-v4-source-v2-readiness-20261016.md)。本记录只描述实际控制实现与离线证据，不授权真实运行；参考/Gold、协议枚举和记录/审核装配由同伴负责，不在此改写其审核状态。

固定完整140原输入，138必需及1可选；执行位置为range140，Gold位置独立沿full_case_reference_positions映射。新版本只允许 `full140-grounded-v4-source-v2` + `source-fidelity-v2` + grounded-v4 + nullable-proof-v1 + 官方DeepSeek flash/max + 280次 + HTTPX300秒/零重试 + E/V omitted。调用与审核各600秒、工作86380秒、外层86400秒，同一绝对窗口完成即退，不保证93小时20分最坏情形可在24小时内全完。

runner复用既有ignored helper的纯文件函数、一次显式凭据适配及独立raw/full审核桥；实际两helper与动态源码、规范、四份新版参考、140实际E合同和V合同及SDK版本纳入freeze。本机fixture依赖这些端侧已审文件，不承诺clean checkout portable。prepare禁真实home/key/registry；只有成功领取且再验fresh claim后一次读取显式凭据。

凭据读取前及每次模型请求前复核源码冻结；raw／full审核桥核私有目录、回执绑定与时间，没有在每次审核回调前另作源码复核。只回收start_new_session创建并记录的自有组，先关闭预算并fsync收据再退出，关闭失败unknown。fallback日志越过支持边界时整批unknown，不能静默截断前2048条后把已开始末窗称为unrun。不自动后继，不退款或重试远端未知。

新profile支持完整读取至16384条六位编号事件；旧profile仍保留2048条支持上界，越界同样整批unknown。两者均不再截断后继续推断unrun。正常result中的预算收据没有独立PID签名，依赖同run私有输出目录及本轮自有spawn来源；只有带`worker_pid`的deadline收据会进一步核对本轮worker的精确整数PID。二者都要求run、closed、精确整数cap及已预约次数合法；这不是通用的对抗性收据认证。

实际闭包还包含[参考与协议装配记录](full140-v4-reference-integration-20261016.md)，与四份已审新参考分开冻结；既有21/remaining8/pilot/main16原闭账文件不改。执行入口的新旧混版在budget、credential、audit及transport之前报`evaluation_full140_v4_fixed_plan_required`，没有把原main16成绩并入新完整140。

## TDD与验证记录

已实际记录：专属deadline模块缺失首红1项error，最小实现后1项通过；旧计划混source-v2在缺reference_version参数时首红1项error，最早版本守卫实现后1项通过；第2049条才开始的末窗原fallback误标unrun首红1项failure，移除静默截断、超限整批unknown后1项通过。新增收据负控还捕获浮点PID被宽松相等接受及非对象收据触发异常，修正为精确类型/损坏收据unknown；返回freeze曾与模块FIXED共用可变dict、授权数值1曾与True宽松相等，分别用副本及`is True`修正。原始首红输出未另存日志，不为报告重跑。

控制层及旧入口相关组实际通过103项（23.911秒）。cwd为`backend/`，先激活Conda `NotAlone`，命令为：

```sh
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src python -B -m unittest \
  tests.unit.memory_extraction.test_evaluation_full140_v4_deadline \
  tests.unit.memory_extraction.test_evaluation_owned_process \
  tests.unit.memory_extraction.test_evaluation_main16_deadline \
  tests.unit.memory_extraction.test_evaluation_ambiguity2_deadline \
  tests.unit.memory_extraction.test_evaluation_remaining8_deadline \
  tests.integration.memory_extraction.test_evaluation_ecnu
```

同cwd、同环境的类型检查实际通过8个文件：

```sh
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src python -B -m mypy --follow-imports=silent \
  src/notalone/memory_extraction/evaluation_ecnu.py \
  src/notalone/memory_extraction/evaluation_owned_process.py \
  src/notalone/memory_extraction/evaluation_full140_v4_deadline.py \
  tests/integration/memory_extraction/test_evaluation_ecnu.py \
  tests/unit/memory_extraction/test_evaluation_owned_process.py \
  tests/unit/memory_extraction/test_evaluation_full140_v4_deadline.py \
  ../desktop/tests/fixtures/full140-v4-public.py \
  ../desktop/tests/fixtures/test_full140_v4_public.py
```

类型检查同时补全既有ECNU测试的三个空列表标注，并将应不可触达的凭据/审核/传输lambda改为`NoReturn`断言，保留原先的调用计数保护。另一个失败仅是新测试临时路径含系统别名、未满足专属收据的规范化路径要求，修正该测试的`.resolve()`后上述103项通过。

最终固定runner兼容组在仓库根目录、Conda `NotAlone`实际通过29项（47.838秒），覆盖新full140与旧main16、ambiguity2、remaining8：

```sh
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=backend/src python -B -m unittest discover \
  -s desktop/tests/fixtures -p 'test_*public*.py'
```

其中完整140实际SDK Mock沿原输入顺序140次E、两窗空E免V、138次V，共278次预约，逐窗raw/full审核、末窗完成且cap280预算closed。另核实际动态v4提示在E后改变时，V及后续窗前立即停、只占1次预约；普通正文缺工具、远端未知及审核safety/unknown均如实停批。Mock只使用预置合成标签和审核，不认证模型分类、语义收益、15例质量门或真实供应商可用。上述输出未另存端侧日志，执行命令与统计在此保存；独审由主Agent统一组织，本记录不提前标通过。

数据影响：只读取公开合成输入、新版Gold及实际源码；预算仅在临时home创建并由测试清理，自有进程组均由测试回收。未创建真实预算、读取真实凭据、启动模型、PG或桌面；没有修改真实聊天、产品默认、采纳门、评分器或原闭账结果。真实运行仍需主Agent独立冻结当前完整闭包、绑定授权并实际审核，不自动启动后继。

## Root整合验证与独审

Root另在主树实际运行完整memory_extraction unit **500/500**（12.982秒）及ECNU／offline／SDK预算／wire集成 **112/112**（22.385秒），日志分别为`desktop/artifacts/full140-v4-root-integrated-{unit,integration}-20261016.log`。命令均同Conda、禁dotenv及`backend/`：`python -B -m unittest discover -s tests/unit/memory_extraction -t . -v`；`python -B -m unittest tests.integration.memory_extraction.test_evaluation_ecnu tests.integration.memory_extraction.test_evaluation_offline tests.integration.memory_extraction.test_evaluation_sdk_budget tests.integration.memory_extraction.test_evaluation_wire_contract -v`。这些与前述103及A切片测试重叠，不反复累加；29项runner是独立夹具组，不属于模型质量。

独立初审Standards硬规则1项／判断性问题0，Spec错项1／缺失及越界0，均为本记录曾过述“每次模型／审核调用先核冻结”。实际源码只在凭据读取和模型请求前复核；Root已据实收窄上述描述，不扩大运行时合同、不改审核或已过测试代码。两轴增量复核待返回。

## Answer

实际增审Standards原1项→剩余0、判断性问题0；Spec原1项→剩余0、无新错项。固定控制切片及Root整合检查完成；resolved只表示准备完成，真实运行仍需新冻结和唯一启动，当前没有真实模型成绩或自动后继。
