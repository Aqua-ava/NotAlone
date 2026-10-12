# 全140窗受限入口与参考装配提案（2026-10-13）

本文件保留全140入口的设计，并记录Root授权后的最小工具实现，不是调用授权、119参考装配完成或质量证明。产品提示叶已提交 `4c939d965c1d9f3cf3c8c3229914b3ea8edf1f67`；最新单V已真实闭账，当前HTTP43次、九个stage均closed。145次已关闭未用额度与12次永久退役额度不可借用，全量280尚未注册。Root另批准准备一笔新独立42次的完整当前21窗观察，分配总上限将为522；它不挪用全140配额，尚无新registry或HTTP。没有第四基线或自动后继。

## 核查结果

公开集合为 `evaluation_cases.CASES` 123窗加 `semantic_evaluation_cases.SEMANTIC_CASES` 17窗，原顺序共140且名称唯一。现有实际受控入口只接受固定21窗或其中最多四窗；`_run_evaluation_batch` 已支持给定的固定cases/window/plan、持久预算、raw封存后full审核与安全停止，可以复用。`run_offline_evaluation` 只接受精确Mock；普通 `evaluation.main` 的全140入口没有本目标所需持久预算／Phased审核，因此不用于真实调用。

原Gold21文件字节SHA为 `5ab68ad8fbb48348231b27ae600ca011e47bf7fc2c1aa2f4e5b417bfa392d5a6`，规范对象SHA为 `5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32`。21窗覆盖全部reference19与两个核心命题窗，28必需／1可选命题和A14唯一人类纳入决定不变。其余119窗按原源码维度为subject20、truth_intent20、paraphrase20、time24、reported16、media16、quantity1、condition2；其中27带旧严格命题约束、92只有较弱旧oracle，不能称为119份完整Gold。

Root和mac_provenance已分别纯读取核对公开序号／输入摘要；mac的对齐结果位于私有 `notalone-full140-projection-20261013-4zlbqm5j/`。其中 `alignment140.json`、`uncovered119.json`、`collection-validation.json` 不含本轮模型输出；21名称／窗口规范摘要／target均零差异。后续原顺序与映射以独审的 `runtime140-metadata-v2.json` 为准，早期按Gold顺序的目录不能当实际执行顺序。

## 最小Interface

只提议修改三个现有Module，不开放任意cases、外部validator回调或新的Harness：

- `evaluation_ecnu.py` 的现有 `run_ecnu_evaluation` 增加一个窄 `case_set`，默认 `reference21`，唯一另一值为 `full140`。默认21与显式最多4诊断的原config、cap与行为保持；full只取源码中的全部固定140，拒绝任意subset或调用方cases，强制300秒／0重试／cap280。
- `evaluation_reference.py` 增加固定全量参考校验。新的140参考保留原Gold21对象作逐字相同前缀，119仅追加至21..139；原21文件、中文判据和有适用范围的common_rules均固定并仍核验。新增119来自公开源码和现行领域规则，不能从模型响应生成。
- `evaluation_phased_audit.py` 增加同一个窄参考类型，默认仍21；full保持精确 `PhasedEvaluationAudit` 类型、readonly tuple映射、原始E先审核并持久封存，再揭V／最终路径。运行位置按原 `(*CASES, *SEMANTIC_CASES)`，映射到前缀21＋追加119的参考位置，不重写旧21的position或答案。选定case后只给其适用的原21或扩展119判据，不能把原literal／风险／21与28/1分母说明机械应用新例。

真实入口在 `EvaluationBudget.create`、claim及credential前，核集合枚举、固定140名称与输入／target、参考文件路径与摘要、完整字段、parent21及唯一A14人类范围、审核类型与映射、规则适用范围、全部来源冻结。full的config可沿已有 `selected_case_positions` 保存local→参考映射，不新增任意数据注入键；mode/stage与固定公开cases摘要区分full。实际调用仍走原SDK及两个持久计数HTTP transport，单模型ECNU、thinking、工具格式和原质量门保持。

原Gold21的common_rules含本批全部literal、A/B专属分类／风险／备选条件和21窗／28必需＋1可选范围；它们不是140通用判据。最小实现可在新参考的provenance中绑定原21完整对象和扩展规则，两者各有独审摘要；Phased按已冻结reference_position选择适用的参考投影，并让同一投影的规范摘要同时绑定raw和full，保持封存不可改。原21case仍使用原完整21对象／rules，不被新规则覆盖；扩展case使用包含其固定window与119规则的机械投影。整个140容器及各投影范围另固定，不能把容器摘要与实际case参考摘要混称。这项装配只在现有reference／phased内部，纯评分器无新可插入回调。

## 119参考协议

每个新窗口先保留原全局位置、名称、源码行、消息／target／日期、inputSHA及旧oracle原值，再逐项装配现有E14／V4、命题、允许来源、人物归属、两日期、风险、未知备选、解释理由、理想去向及禁止含义。严格oracle的显式空与弱oracle的无约束必须分开；case级存在性布尔只约束整体结果，不能自动填每条字段。旧pattern只作公开判据之一，不能冒充完整语义Gold。

正文支持且有边界的未知可为safe并pending；错误确定指代、无据角色／场景、actual-auto带非空alternatives以及明确错误destination仍沿原safe-only与bad_auto门停止。reported、媒体及其他尚无typed依据的维度不因此自动放行；理想三门benchmark与生产默认空放行表分别报告。

存在文本／旧oracle／现行规则冲突或完整字段无法有据确定时，列出精确未决项，先独立审核而不制造答案、删除难例、增加有利optional或降低门槛。原140 legacy none为29；原Gold21含A14明确纳入复核，故在119独审仍维持其原28个none草稿的条件下，merged语义参考才为none30。两种分母分层保留，不把草稿30写成原旧答案或已冻结。新参考须以source-only记录来源、非盲装配、Agent审核及quality=false，不能扩大A14的人类确认事实；原sealed、旧full0和全部未运行不回填。Root批准协议、119参考完整装配和两轴通过后才能冻结全量Gold／预算／时窗。

## 有意义的最小验证

先对现有公开Interface做负控，再最小实现：非法枚举／bool／full与subset冲突；139或141窗、重复／错位名称、错输入／target；旧21前缀或A14人类范围改变；119缺命题或14/4字段、日期槽混淆、未决来源；parent文件／annotation摘要错；原21／扩展规则适用范围混用、raw/full投影摘要错；伪audit类型或readonly映射错位。全部须在budget及credential前拒绝。正控证明原21和最多4诊断配置原样、全140固定280及300/0、raw封存→full、空E不发送V、普通错误继续、安全／未知／记录失败停止、闭账无法复开。

只扩展 `test_evaluation_reference.py`、`test_evaluation_phased_audit.py` 及 `test_evaluation_ecnu.py` 中相关已有公开接缝，不新增镜像提示测试。下方“实际工具验证”记录现已完成的代码与验证；最小绿、mypy及独立两轴后由Root独立本地主题提交，当前没有新模型HTTP或真实run registry。

## 实际场次边界

全140可作为一次最终候选回归与完整当前观察，不称第四基线或完整A/B。固定cap280来自本目标从未启用的专属配额，不借关闭余额；每窗最多E/V各一次，合法空E不会为了耗完额度补V。全部140与原Gold21保留；一旦停止，余窗仍unrun，闭账余款不复用。

已运行四窗857.171294秒简单线性投影约8小时21分钟，不能据此保证全量时长。全量参考和工具冻结完成后，需要一次充足但有限的绝对场次（例如10至12小时，由Root按当时实际时刻固定），每HTTP保留300+45秒起发余量，raw／full各600秒并受总绝对截止保护。不提前设一个会在准备期耗尽的激活窗口，不滚动延长已激活stage；截止或安全／未知停止不得写为完成。最后一场完整21或全量140真实执行结果不能由合成绿、单V控制或前四窗一般错误代替。

## 实际工具验证

Root在单V真实终态、SQLite closed及in-flight无持锁独立核验后，已授权三个Module、三个现有测试与本文件的实现。`run_ecnu_evaluation(case_set="full140")`现在只取原140固定顺序，强制300秒、0重试、cap280，拒绝subset、未完整参考和错映射；默认`reference21`及最多四窗的原config、P1／diagnostic路径、cap和字段保持。真实运行仍要求精确`PhasedEvaluationAudit`，没有自由cases、validator或新产品接口。RecordStore不需要新白名单键，full沿已有`selected_case_positions`冻结运行位置→参考位置。

全量参考只接受固定新路径 `memory-gold-full140-reference-20261013.json` 和配套中文判据路径，二者当前尚未发布为有效Gold。装配provenance绑定原21完整对象、固定文件／规范SHA、原140完整case对象SHA、映射、各范围rules摘要；`reference_complete=true`、空未决列表和显式装配复审是必要条件。119候选的七个未决仍保留，不能靠自填准备标记成为质量证明。原21case的raw/full继续给原完整21对象与原摘要；119给扩展容器和119规则，两阶段绑定同一份作用域摘要。未决、来源／日期／14E4V／前缀／原oracle／摘要错误都在预算和凭据之前拒绝。

有意义的红绿和工具失败全部保存在私有目录 `/private/tmp/notalone-memory-full140-tools-20261013-zp8xu0i_/`（0700，证据文件0600）：

| 证据 | 实际结果 | 边界 |
| --- | --- | --- |
| `red-first.log/json` | 3个加载error | 首次私有runner缺backend的sys.path，未进入项目测试，不算产品red；修runner后重做 |
| `red-interface.log/json` | 3测试、6接口error，0.341秒 | 缺全量参考入口与case_set参数；预算／key／HTTP均未运行 |
| `red-scope-reference-green.log/json` | 10测试、7绿／3新接口测试共6error，0.700秒 | 纯参考先绿，两阶段固定作用域接口仍red |
| `green-first-three.log/json` | 56测试、2失败，13.469秒 | 新夹具把A08原全局位置误写83，实际82；改为按原case对象定位，不改生产答案 |
| `red-meaning-shape-scope-green.log/json` | 3测试、1结构负控失败，1.468秒 | meaning_requirements字符串被误当列表；明确list门修复，两scope测试已绿 |
| `green-final-three.log/json` | 57／57，14.053秒；外层14.351857秒 | exactMock跑固定140、cap280；不签真实模型语义 |
| `mypy-first.log/json` | 3源中1类型error | parent annotation的Any或None未收窄；补明确str门 |
| `green-final-v2.log/json` | 58／58，15.461秒；外层15.776554秒 | 补真实RecordStore与Phased串联的旧21→119→unknown控制；原140分母、137unrun、closed保留 |
| `mypy-final.log/json` | 三个改动源通过，0.700755秒 | 静态类型检查，非模型运行 |
| `red-date-interval.log/json` | 2方法、4子例失败，1.101秒 | 两轴发现双非空区间须end>start；等值／反向区间仍触达预算建库守卫，须先拒绝 |
| `red-prefix-types-with-date.log/json` | 2方法、6子例失败，1.998秒 | 其中4个bool／float旧prefix负控，加2个尚未修的日期负控；Python相等不能代替规范JSON相同 |
| `green-axes-v3.log/json` | 59／59，15.317秒；外层15.564968秒 | 按实际时区比较日期、规范摘要核旧prefix，原21 raw直接取所选parent对象；默认与全量相关控制均通过 |
| `mypy-axes-v3.log/json` | 三个改动源通过，0.734807秒 | 独立轴增量后的当前源码类型检查 |

最终59项与类型检查前后六文件SHA完全相同。日期正控包括跨时区真实晚一秒、起点明确／终点空和双null；负控拒同一时刻及反向区间。旧prefix对比使用规范摘要，拒将整数来源位置0改为false或0.0；raw和full从同一个选定参考对象取case。该修复只校验可执行结构，不替119日期或正文语义认证。初次本文件整行替换未匹配、apply_patch原子失败0写入，随后按实际整行修正，另存`doc-apply-first-error.json`。

私有runner清空供应商环境，禁止`.env`文件读取、socket／DNS和真实HTTP transport；守卫触发0。Mock的预算registry仅位于测试的TemporaryDirectory HOME并随测试清理，真实新run registry0、真实HTTP0、App／CLI／probe／业务库0。原Gold21、全部旧oracle、scorer、schema、两个提示常量、采纳门和默认空放行表未改。旧结果的`synthetic_only`继承字段描述公开合成输入范围，不能用它证明实际transport；后续真实桥须另记真实预约、响应、模式与闭账。

工具能机械拒绝未完整参考，不表示119中文语义参考已经完成。下一步先完成独立两轴与Root的主题本地提交；mac继续source-only119装配和冲突核对。Root另已批准准备新的完整21当前候选观察，它只复用原21 Gold和600秒显式审核；新有限预算、source freeze及唯一首发仍需独立预注册与Root末核。原票保持各自State及未满足验收，默认维度放行表不变。
