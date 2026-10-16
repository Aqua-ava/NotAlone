# 完整140的固定分阶段DeepSeek合同

Triage: ready-for-agent
State: claimed

日期：2026-10-16。承接[单V v2实际成功](deepseek-v-off-forced-v2-result-20261016.md)，只为未来一次独立公开合成完整140场建立封闭的分阶段合同。用户对必要官方DeepSeek合成验证的持续授权有效；当前只有计划，没有本场真实预算或请求。不得直接沿旧完整140身份切换V参数。

## 问题和目标

旧完整140因首窗V读取超时闭账，旧main16曾因缺具名工具停止；这两种失败不同。新单V证明disabled／none／强制具名在一次新输入中可运行，不能证明可靠性或参数因果。现有offline仅构造一个E／V共用模型，因此须先贯通一个显式固定的新执行身份，之后才可验证完整140的当前质量。

新场使用与旧完整140相同的140原输入、顺序、138必需＋A15可选1、已审source-fidelity-v2参考及grounded-v4物品归属合同；不改Gold、分母、源可信元数据或提示来获取通过。输入与旧场相同但阶段请求合同不同，必须新freeze／run／nonce／台账；不补发或接回旧未知V，不拼旧部分场成绩。

## Implementation Decisions

1. 新固定执行计划`full140-grounded-v4-source-v2-v-off-forced`与请求版本`deepseek-phase-split-v1`，唯一新mode／stage／owned kind及冻结阶段策略须全层精确配对。只允许该完整140，不提供任意窗口、模型、策略或预算注入。
2. E保留原官方`deepseek-flash`、thinking enabled／reasoning max、省略tool_choice；V固定同一model、thinking disabled／reasoning none、强制`SourceVerificationOutput`。两阶段都用同一官方`https://api.deepseek.com/chat/completions`、同一领取后的凭据／transport／预算，原实际E v4及V nullable-proof-v1提示／schema、0温度与非流式保持。无strict／beta、content修复或工具合同放宽。
3. offline仅在新固定计划下构造两个内部模型并按purpose分发。provider invocation_scope核完整实际wire；records冻结并验证阶段策略和新身份，phased bundle核同一身份，owned准入核mode／stage／范围／版本。新增配置字段不能被旧计划借用；旧全140和其他入口继续原严格参数配对。
4. 新profile显式阶段策略内部使用`thinking_mode`等不会被脱敏器误删的固定键；实际HTTP仍用官方`thinking`。固定值、schema、计划、输入、来源参考、实际源码及安装版本共同冻结；不把文件摘要相等当模型或语义正确。
5. 复用原完整140夹具共用流程，内部只允许旧、新两个固定变体，新建薄入口；旧source闭包名称和旧控制边界保持，新闭包另加本计划／新实施记录／入口。更新ADR-059只说明新增离线封闭准入，不改v4语义或生产默认。仍声明实际本机helper依赖，不承诺干净checkout可运行。
6. cap280、零重试、HTTP读取300秒、每次调用／RAW／FULL各600秒、工作86380秒／prepare至launch原外层86400秒；完整140最坏耗时不保证落在一天内。完成／任一硬停立即独立闭账，无自动后继，不退款或复用未知请求；继续复用自有进程组、截止及16384事件恢复上限，超限整体保守未知。
7. 仅新profile修完整响应观测：共享records现有digest-only路径已处理坏arguments，但正文其他位置的NaN／孤立代理仍可能在规范化阶段丢response。新profile按request_sequence记实际响应进入状态，在写盘前完整预验解析／脱敏／规范化／摘要；失败只存现有安全digest-only元数据、实际HTTP状态及response_obtained=true后硬停，不保存未脱敏正文或任意异常文本。failure按该sequence真实状态记录，真正无响应timeout仍false。I/O发布失败继续硬停，不补写覆盖；旧profile行为不变，不改共享transport。
8. 独立RAW Agent只看前层，Root只做FULL；原冻结参考、14字段及安全／一般错误口径不变，不凭V supported、保守pending或机械matcher认证语义。遇来源事实／错人或合同失败按现行固定控制停止，未知不补签。

## Testing Decisions

按TDD从新计划准入和精确SDK Mock开始，分别验证E max／omitted与V off／forced、同预算／领取后凭据、完整140输入映射、来源参考v2、原schema和身份。负控覆盖阶段串用、旧／新计划或审核bundle混版、bool／float位置和PID／索引、错端点／model、源码／schema漂移、缺工具／非法参数／timeout、额外请求／并发、未授权／过期、关闭与自有组回收。新records还须复现非200坏arguments、正文NaN／孤立代理、安全digest-only及发布失败／timeout的实际响应状态，并证明旧profile路径保持。

新完整SDK Mock须覆盖140E与实际需要的V（原139必需／可选事实并不等于V窗数），核末窗及cap280关闭。最小相关单元／集成／类型检查和新旧runner回归通过后，独立Standards／Spec审查；只因本次改动造成失败或未决才扩大测试，不反复重跑无关完整包。保留初审发现与真实红绿记录。

Root在所有源码／文档稳定、本地提交扫描后才prepare；核原八场均closed、新registry在绑定现有授权前不存在、实际源码及固定合同一致，唯一启动。材料准备不代表真实质量或批准放行；实际启动与最终结果分别记录，未运行不预签。

## Out of Scope

不读取或上传真实聊天、不连接业务PG、不运行GUI或外部发送、不使用ECNU、不push。旧场、旧冻结、审核、失败及预算保持原样。生产仍grounded-v2、默认放行空表、现有语用／风险／0.7／V只降不升和逐维度合取不变。包装B仍待用户决定；本新场即使完成，也不能自动宣称可信来源链、typed依据、真实六窗核心保留或逐类放行。

## 实际离线实施记录

2026-10-16：见[实施记录](full140-mixed-v-off-implementation-20261016.md)。首SDK缺入口真红后首E／V垂直切片转绿；请求序号True／float／越界四个真红后补严格门。必要共享及集成87项通过，新增owned／phased边界4项通过；新完整Mock稳定复跑到末窗（140E／138V、278请求、cap280闭账），旧runner9项回归通过，10文件类型检查通过。首次全量Mock被实施者运行中编辑闭包触发source drift，已如实记录并仅复跑该完整单项。未改旧场、Gold或生产门，没有本场真实凭据、预算或模型请求；尚待Root独立两轴审查和最终冻结，不预标State完成或质量通过。

Root后续整合验证：评测单元193项／评测集成112项分别通过，两轴15文件独立初审均0。旧A13条件复现仍按原整组安全分类处理，不把请求合同成功写成质量修复。新source闭包实际89份、旧85份名称集合保持；当前仍只完成离线准备，真实启动和最终结果另记。
