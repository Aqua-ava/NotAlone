# 单次V协议探针：关闭思考并强制具名返回

Triage: ready-for-agent
State: resolved

> 2026-10-17 状态同步：本探针已按[结果](deepseek-v-off-forced-pilot-result-20261016.md) closed 1／1 并闭账；没有可用 verification，响应记录缺口未补造，本计划不再保留执行预算。

日期：2026-10-16。承接[完整140结果](full140-v4-result-20261016.md)，仅形成一个独立、公开合成、有界的协议可用性探针。沿用户对必要官方DeepSeek合成验证的持续授权，不重发任何旧unknown请求，不使用ECNU。当前没有本探针真实预算或请求。

## 问题与有限结论

旧main16曾取得HTTP200但缺具名工具，完整140新场又在V读取超时且未取得响应；两场均已独立闭账。不能把它们归因为同一个原因，也不能推断是thinking导致。当前thinking enabled不允许强制具名tool_choice；官方允许关闭thinking并指定具名工具，故只检查这一整套新合同单次能否给出合法V返回及实际耗时。它同时改变思考和工具选择，不能分离因果或证明普遍可靠性。[官方接口](https://api-docs.deepseek.com/api/create-chat-completion/)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。

只发一次V，不调用E。输入为新的单条公开合成“我刚到家。”，contact sender／唯一target；给定标签由现有v4编译成完整引用候选，编译结果及来源窗口预先冻结。不读取旧未知V的请求／响应，不把本次结果接回旧场。这个给定候选不代表模型提取能力，也不验证E合同。

## 固定合同

- 独立版本`deepseek-v-off-forced-pilot-v1`，只有这一个窗口、一个候选、一个V调用；cap1、max_retries=0，失败／未知不退款或补发，无自动后继。
- 唯一端点`https://api.deepseek.com/chat/completions`，model及响应身份`deepseek-flash`；`thinking={"type":"disabled"}`、`reasoning_effort="none"`，保留实际nullable-proof-v1 V提示与schema，强制`SourceVerificationOutput`具名function。不是strict／beta模式，不从content补解析。
- 使用实际已安装SDK及现有V适配器，核完整返回合同；缺工具、错名、多工具、非法参数、错model、错端点、额外请求或冻结漂移均失败安全。
- HTTP读取30秒、完整调用60秒、工作70秒、外层80秒，共用prepare至launch的带时区绝对窗口；完成／失败立即关闭。短窗口仅限探针，绝不延长到旧场。
- 新UUID／nonce、0700目录、0600独占记录、固定输入／候选／来源／提示／schema／代码／安装版本／wire合同及授权SHA全部绑定；prepare只处理公开材料，不读home／registry／key。唯一worker成功领取新台账并复核后才读取一次已有官方凭据。
- 复用Budget与自有进程组／deadline控制，不放宽旧provider合同、full140入口、records、phased审核、生产模型或门；若使用独立探针记录格式须明确命名，不能伪装成完整评测记录或以legacy mode绕过v4守卫。
- 请求／响应仅记录任务所需公开内容和状态，沿现有脱敏规则，不持久化Authorization或凭据。闭账、关闭未知、自有worker及后代回收、远端未知保持既有严格边界。

## Implementation Decisions

最小独立fixture与其测试实现上述唯一合同，复用当前端侧已审文件函数／凭据适配，实际helper纳入freeze；是当前本机验收夹具，不承诺干净checkout可运行。旧源码和已闭账场不改，E仍维持原合同但本片不调用E。若需将新V合同接入后续完整140，必须另写显式分阶段请求版本和新计划、完成测试／审查／冻结，不能因探针成功直接开批。

## Testing Decisions

按TDD：实际SDK经精确MockTransport验证disabled／none／forced与唯一V名、原schema、零重试；临时home／合成预算测试cap1及第二次拒绝、fresh claim后唯一凭据读取、未授权／错冻结／源码漂移在外部请求前拒绝。验证一次supported或unknown／失败均正确记录，缺工具和read timeout不修复、不重发；专属60／70／80秒上界、自有组与closed／close_unknown控制保持。只跑最小必要相关检查、类型检查及两轴独审，再由Root在最终材料稳定后实际prepare、复核并唯一launch。

## Out of Scope

不改旧Gold／输入／审核／分母／成绩／预算，不调整阈值、V语义门、typed证明语法或来源可信前提，不放开自动采纳，不接业务库、真实聊天、GUI或外部发送。包装证明[决策B](typed-proof-representation-decision-20261016.md)仍待用户决定，探针不得替代该决定。没有至少15窗、完整140、核心保留、指代质量、typed可用或逐维度放行认证。

## 实际验证

待实现。当前仅有公开文档与已有代码的只读可行性核对，没有探针真实请求或质量结论。

2026-10-16离线实施追加：新增独立fixture与测试，具体变更、红绿过程和命令见[实施记录](deepseek-v-off-forced-pilot-implementation-20261016.md)。实际SDK精确Mock、临时home／合成台账与自有合成子组的10项新测试通过，两个文件类型检查通过，共享预算／provider／main16 deadline的36项最小相关回归通过。没有真实请求、真实凭据读取或真实评测预算；尚待Root独立两轴审查与最终冻结，不声明本计划审查通过或State完成。

初审修正追加：两轴发现同一PID类型缺口，Spec另发现choice index类型缺口。先用两项新增测试取得4个真实红灯，再将新fixture的两条worker PID读取与choice index读取改为严格整数；12项通过，两个文件类型检查通过。int正控及float／bool／错PID、bool／float index负控均已覆盖。详见实施记录；不预标复审通过，也未启动真实调用。

Root已收到两轴独立审查及修正后增审：初审Standards1／Spec2项P2、剩余均0；最终新测试12项及最小provider1项通过、mypy两个文件无错误。离线实施完成，真实prepare／审批／唯一launch仍由Root按固定合同执行，运行结论另记，不据此给质量资格。
