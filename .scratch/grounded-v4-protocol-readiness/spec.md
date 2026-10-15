# 显式 grounded-v4 离线编译兼容规格

Triage: ready-for-agent
State: resolved

日期：2026-10-16。实施已获主 Agent 授权；本规格不授权真实模型运行、预算、生产切换或质量认证。独立 Standards/Spec 及修订增审已完成，最终两轴均0项；resolved仅表示本离线切片完成。

## 问题与来源

当前已独审完整140来源参考保持140窗、138必需命题、1可选命题、156有限分支、162来源选择。原21和追加119的Gold均不修改。现有 grounded-v3 的封闭 kind 不能表达以下七个必需命题的完整字段组合；固定 `other_unresolved` 也不能分别说明时制与活动阶段未知。

| 命题 | category / speech_act / assertion_status / figurative_type |
| --- | --- |
| R011-P1、R011-P2 | recent_state / plan / asserted / unknown |
| R013-P1、R064-P1、R091-P1 | recent_state / plan / unknown / literal |
| R029-P1 | recent_state / assertion / unknown / literal |
| R057-P2 | recent_state / unknown / unknown / literal |

此外，A15-P2是可选命题，可接受 relationship_note 的 report/unknown 或 assertion/unknown；同一原分句还包含必需的读完命题。当前一分句至多一个候选，且 v3 没有物品所有权未知类别。本次诚实保留该可选覆盖缺口，不扩成一对多编译，不增加必需命题或窗口分母。

来源为 `.scratch/unfinished-work/memory-gold-full140-reference-20261013.json` 的既有已审规则，以及 `backend/src/notalone/memory_extraction/grounded.py`、`grounded_adapter.py` 的实际行为。字段缺口不证明模型会正确选择新标签，离线通过不计质量样本。

## Implementation Decisions

### 显式版本与Seam

公开纯编译 Seam 为 `compile_labels_v4(window, draft)`；独立模型输入合同为 `grounded_schema_v4(window)`、`GROUNDED_V4_PROMPT`；仅显式开发/Mock调用的 runtime 为 `GroundedV4ExtractionRuntime(model=...)`。模型仍只填写程序给定的每个target位置，依赖只能引用原窗口分句，原文、source、日期、解释、理由均由程序装配。

不注册 `EvaluationExtractionMode`，不改生产CLI/Worker/服务的v2选择。`run_ecnu_evaluation(extraction_mode="grounded-v4")` 在最早模式校验拒绝，先于凭据、预算、审核和传输；包含Mock的固定评测入口也拒绝v4。显式开发runtime接受调用方提供的模型以运行精确Mock，它没有真实执行合同或自动选择路径，不能据此宣称full140端到端ready。

### 四个完整封闭kind

| kind | 固定字段组合 | 日期策略 |
| --- | --- | --- |
| figurative_unknown_plan | recent_state / plan / asserted / unknown | 唯一受支持期间；无法解析时双null及原期间阻塞 |
| uncertain_plan | recent_state / plan / unknown / literal | 同上；可能性不变成确定行程 |
| uncertain_state | recent_state / assertion / unknown / literal | 来源观察时刻，终点null |
| stage_unknown_state | recent_state / unknown / unknown / literal | 双null；不因“今天”或时钟推断阶段 |

共享 `KINDS` 不增加新叶；只在v4分支使用扩展表。不开放独立语用字段笛卡尔积。新未知叶不进入旧state完成短答改类逻辑。条件前件与新计划叶的组合不可表达时整窗可见拒绝，不覆盖其固定 assertion_status。未知发生可能性、修辞真伪和指代解释是不同轴；单纯可能性未知不强制生成alternatives。明确玩笑、反讽、夸张仍沿原nonliteral省略。

### 两个受控歧义类别

v4复用原四类，新增 `clock_period` 和 `event_stage`。前者固定说明原句时钟时制未唯一确定，不补24小时制时刻；后者固定说明完成或安排阶段未唯一确定，不选择其一。两类都逐条完整附实际原引句及既有依赖上下文，不写具体时刻、身份、交付或新事实，也不解析极性。

模型仍负责按来源选全适用类别。程序不按数字、关键词、用例或Gold补码。六类非互斥多选，不能重复、未知、漏字段或与unresolved矛盾；前缀和未知第三人合并仍取实际成员并集。最多七条说明，单条沿原8400 Unicode字符上界；超限整窗失败，不截断引句或否定。

### 仅v4的完整下月期间

完整整词 `下个月`、`下月` 可映射到来源本地日历的下月1日00:00（含）至再下一月1日00:00（不含）。保留来源tzinfo及相应月界偏移，使用日历换月而非固定30天；跨年、闰年不特殊猜测。固定偏移来源不凭空增加地理时区。

月词必须带相对/数量前缀或时段后缀；地名或活动名中的裸“月”字不启动月份分支，也不算第二个月期间。有限词法扫描完整引句：除月词，还识别原日周词、相对年份、数量期间与既有前后限定；数量包括阿拉伯/中文数及半、几、数、若干，月份后缀包括初、中、旬、底、末及既有前后限定。月词、数量期间和其他已识别时间词在谓词正文尾部也参与唯一期间检查，不能隐藏第二个期间。完整引句只有一个时间词且完整为 `下个月`/`下月` 时，还必须符合有限前后形状：前置只接受可选我/你/他/她/它及相应复数、最多两个计划/可能/打算/准备/想/要/将/会助词、可选在/于；后置接受同样的可选主语与最多两个助词、可选一起，接去/来/参加/办理/出发及最多256字符单分句正文和尾标点。原否定检查仍生效。

这是一套正向封闭计划形状，不用无限追加修饰黑名单判定短语已经结束。“头几天/刚开始”等月内局部形状，以及“从现在到下个月”等跨月范围不匹配，直接双null并保留 `grounded:unresolved_period`，不回退到日周子串。月初、月底、旬、具体日/周、多个期间、否定、取消和更正仍降级。未支持的具名主语、其他谓词、长正文或其他句式也保持UNKNOWN并保留完整原句；不按用例、地名或Gold放行。该有限词法支持不认证通用中文时间语义。

没有月份时间词且没有额外已识别数量期间/限定时继续复用旧日周计算，包括正文含非时间“月”字的情形；例如“下周……待半天”仍保持UNKNOWN，不用较短的下周掩盖附加期间。未知来源时间、日期溢出、具名时区中不存在或重复的月界仍降级；无时区来源在原领域模型入口拒绝。旧v2/v3的 `_period` 原样保留，不扩大旧协议时间语法。日期仍是检索期间，不是事件真实开始、结束或交付时间。

### 已发生correction与原安全合同

历史更正已有 `correction → relationship_note/correction/asserted/literal`，双null。本次不新增更正解析器；给定标签沿原依赖合并保留完整更正内容。R024必须包含target及给北京去向的context，R083原定下周和改后下个月均保留；不能把被更正的未来时间写为更正动作有效期。

原E14、联系人/source隔离、删除路径、最低置信度、sensitivity传播、风险白名单、0.7门槛、typed source proof、V只降不升与默认空放行表不变。编译器不产生来源语义证明或放行依据。

## Testing Decisions

测试通过上述纯编译Seam和实际SDK+精确 `httpx.MockTransport` 的wire进行，不测试私有日期函数，不把给定标签当成真实模型分类收益。

- 四叶精确字段、观察时刻或双null、原程度与引句；confidence=1仍待确认。
- 完整月界的正负偏移、跨年、闰/非闰二月及跨DST；未知/无时区、溢出、不存在/重复月界失败安全。
- 月初、月底、旬、具体日周、多个期间、否定、取消、更正及失败长短语不短串回退。
- 时制与阶段两类分别解释，绑定实际引句；前缀合并传播来源、敏感性、最低置信度和类别并集；七条/8400字符有界且不截断否定。
- R024/R083完整历史更正与双null；不对Gold作模型或评分保证。
- 自由正文/日期/独立语用字段、未知kind/code、重复code、unresolved矛盾、错误工具名或缺位置整窗拒绝，无修复调用。
- 变更前 `56051719` 独立取得的v2/v3提示SHA、完整140动态schema集合SHA及140组给定标签完整E14 SHA固定为兼容基线；旧协议拒绝新标签并继续保持月份未知。
- 真实评测入口在官方/ECNU、reference21/full140、真实或Mock传输选择下均最早拒绝v4，不读凭据、建预算、调用审核或传输。

### 实际离线记录

Conda `NotAlone`，工作树 `backend/` cwd，所有命令显式 `NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src python -B`。已核 `grounded.__file__` 来自本工作树的 `backend/src/notalone/memory_extraction/grounded.py`，不依赖主checkout的editable路径，没有修改全局安装。

首红：新增 `test_closed_unknown_kinds_keep_independent_pragmatic_and_time_fields` 因缺 `compile_labels_v4` 失败；实现后通过。月份正例初次10个子例均为null而失败；最长短语/混合期间和非唯一月界负例初次18失败（另一个无时区来源已由原模型拒绝，测试调整为核该既有入口）；补“附近/早些时候/的前几天/的最后几天”又先记录4项失败，再扩受控最长短语并转绿。两码首红被旧四类合同拒绝；SDK首红因缺独立v4 runtime失败；逐个切片后转绿。

最小相关组：新纯编译及runtime、旧v2/v3 runtime共28测试通过。类型检查：

```sh
python -B -m mypy --follow-imports=silent \
  src/notalone/memory_extraction/grounded.py \
  src/notalone/memory_extraction/grounded_adapter.py \
  tests/unit/memory_extraction/test_grounded_v4.py \
  tests/unit/memory_extraction/test_grounded_v4_runtime.py
```

初版结果为 `Success: no issues found in 4 source files`；完整相关组575项通过（25.479秒），包含当时15项新增测试。两轴P2修订后的增量验证另记下文，不将该初版结果冒称修订后全量结果。完整命令的Python部分如下，前缀同上；先清空环境防止回归读取真实凭据或数据库配置。未导入真实模型/PG冒烟测试模块。

```sh
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src python -B - <<'PY'
import os, pathlib, unittest
os.environ.clear()
os.environ['NOTALONE_DISABLE_DOTENV']='1'
import notalone.memory_extraction.grounded as grounded
repo=pathlib.Path.cwd().parent
assert pathlib.Path(grounded.__file__).is_relative_to(repo)
print('module_origin_verified',pathlib.Path(grounded.__file__).relative_to(repo),flush=True)
loader=unittest.TestLoader()
suite=loader.discover('tests/unit/memory_extraction',top_level_dir='.')
suite.addTests(loader.loadTestsFromNames([
 'tests.integration.memory_extraction.test_evaluation_ecnu',
 'tests.integration.memory_extraction.test_evaluation_offline',
 'tests.integration.memory_extraction.test_evaluation_sdk_budget',
 'tests.integration.memory_extraction.test_evaluation_wire_contract',
]))
result=unittest.TextTestRunner(verbosity=1).run(suite)
raise SystemExit(not result.wasSuccessful())
PY
```

独立审查初轮两轴各发现1项同源月份修饰问题；第一轮修订后Standards为0，Spec继续发现尾部额外期间遗漏。第二轮修订后，原两轴分别复核增量，最终均0项；全部旧v2/v3兼容与本规格受限范围保持。具体失败及修后验证见下方记录，不用最终0项覆盖初审发现。

### 两轴P2后的增量修订

两轴初审各指出同一项月份期间P2。公开纯编译Seam先复现三条部分月/跨月范围被填为整月，以及月亮湾使整周、整月错误降级，共5个子例全部失败。随后将月份判定替换为上述月时间词候选及完整前后正向形状，移除初版不断扩充的月修饰黑名单，5个子例转绿。

另保留范围外头尾几天、跨月范围和未支持主语/谓词为UNKNOWN的同类控制；月光路、月饼展等正文不按名称放行。新增给定标签对照已审Gold的R009、R013、R064、R081、R096、R097、R101、R118八个月份分支，逐一核subject、category、speech_act、assertion_status、figurative_type、日期和source均可表达；这不提供模型分类、正文评分或真实质量信用，Gold未改。

实际最小及受影响回归命令（相同Conda/cwd/env）：

```sh
python -B -m unittest \
  tests.unit.memory_extraction.test_grounded_v4 \
  tests.unit.memory_extraction.test_grounded_v4_runtime \
  tests.unit.memory_extraction.test_grounded_v3 \
  tests.unit.memory_extraction.test_grounded_v3_runtime \
  tests.unit.memory_extraction.test_grounded_extraction \
  tests.unit.memory_extraction.test_grounded_runtime
```

实际66项通过（0.612秒），包含新增的三项测试方法；旧v2/v3双提示、140个动态schema集合及140组给定标签完整E14基线仍通过。修订后同一4文件mypy命令通过（`Success: no issues found in 4 source files`），`git diff --check`通过；未重跑无新增影响的评测集成范围。随后原两轴增审仍发现下述尾部期间问题，未按此中间结果宣布完成。

### 整引句时间词法的第二轮增量修订

原P2关闭后，Spec增审指出后置正文仍可能藏有“月底”或“半个月”。同一公开编译测试新增六个尾部时间控制，首红为5项子例失败：“月底才回来”“待半个月”“月初再转车”“待几个月”“待半天”仍填整月；“待几周”原本已阻塞。未保存首红原始日志，结果来自当次命令输出；没有为补报告重复运行首红。

随后用上述统一有限时间词法扫描整条引句，替换先剥月份再搜残余正文的两段检查；带相对/数量前缀或时段后缀的月词，以及数量期间在任意位置都参加检查。数量期间只能阻塞，不据此生成新日期。追加“下周……待半天”和“半个周末”的短串回退控制，扩展后的同一测试方法通过（1项，0.003秒）。这仍是有限词法及封闭计划形状，不证明能识别任意中文暗示、复合数量或语义限定，也不按具体地点、用例或Gold放行。

实际以同一Conda、工作树backend cwd与 `NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src python -B` 前缀，通过内联 `unittest.defaultTestLoader.loadTestsFromNames` 加载上列六个完整模块；载入前清空进程环境并仅保留禁dotenv标记，且再次核实 `grounded.__file__` 属于本工作树。66项通过（0.646秒），其中八个月份Gold给定标签及v2/v3独立提示/schema/完整E14基线仍通过。同一4文件mypy通过（`Success: no issues found in 4 source files`）。未重跑无新增影响的575项初版范围；随后原两轴增量复核均0项。A05 Gold未修改。

## 数据影响与Out of Scope

只读取公开合成用例并使用Mock SDK响应；无真实聊天、模型、凭据、PG、GUI、依赖安装或真实运行预算。既有评测回归仅使用临时合成账本，不领取真实模型调用额度。主工作树当前main16冻结79依赖、原Gold、旧封存、旧运行/预算及原固定守卫均不修改。

不增加full140 runner/profile或执行期限，不接入v4真实评测，不扩大optional为required，不改评分，不恢复模型自由正文/日期/理由/替代解释，不做A15同分句多候选，不自动切生产或宣布达到ADR-027的至少15窗质量门。真实收益、完整140集成和后续有限冻结/预算均未验证。

## Answer

四类封闭未知类型、两类受控说明、有限完整下月计算及显式开发/Mock runtime已完成；初版完整相关575项、最终受影响66项、4文件类型检查及双轴增审结果分别保留。新协议未注册真实入口，生产默认v2、原门槛与typed依据不变。已知A05产权参考冲突另由新版参考切片处理，本切片不认证该旧参考或其质量；A15可选缺口也保持。
