# 原公开21窗的完整v4分阶段当前基线

Triage: ready-for-agent
State: claimed

## 问题与目标

原公开21窗旧场及后继各场均已独立关闭；最新混合完整140场仅三窗已审，R002字段错误触发bad_auto停止，不能代签原21或至少15窗。其后[稳定事实叶](../grounded-v4-stable-facts/spec.md)与[附属数量角色](../grounded-v4-quantity-continuation/spec.md)已完成离线修复及独立审查，尚无模型标签选择或真实质量改善信用。

在已授权的必要有界官方DeepSeek公开合成验证范围内，新增一个固定原21入口，使用当前v4及已审来源参考v2，核验本场完整分层结果。旧九场闭账、Gold及审核保持；无未知请求补发、借余额或跨场拼成绩。此计划不放开产品自动采纳、不读取真实聊天、不使用ECNU。

## 唯一固定合同

| 字段 | 固定值 |
| --- | --- |
| execution_plan | `reference21-grounded-v4-source-v2-v-off-forced` |
| case_set／case_positions | `reference21`／`None` |
| 原输入／顺序 | 原positions 0–20，A01–A19、B01、B02；28必需＋1可选 |
| extraction／reference／verification | `grounded-v4`／`source-fidelity-v2`／`nullable-proof-v1` |
| provider_profile／phase_request_version | 复用 `deepseek-phase-split-v1`，不开放任意策略 |
| E | thinking enabled、reasoning max、省略tool_choice、唯一 `GroundedMemoryLabelsV4` |
| V | thinking disabled、reasoning none、强制具名 `SourceVerificationOutput` |
| endpoint／model | 仅 `https://api.deepseek.com/chat/completions`／`deepseek-flash`，请求及响应身份均核 |
| 请求／重试 | 上限42、max_retries=0；领取后唯一凭据、同transport及预算 |
| mode／stage／owned kind | 分别使用reference21专属固定身份，不借32／280控制或旧profile配对 |

public21-v2参考沿现有固定loader与canonical／annotation绑定，须`execution_ready=true`、`quality_certified=false`，Phased bundle精确同版；不修改参考JSON、中文判据、输入消息、scope／sender／target／时间或分母。A05产权UNKNOWN仍按已批准D2及来源参考v2，不恢复旧争议答案。

## 实施决定

1. 在现有provider_contract／ecnu／records／offline／phased_audit／owned_process显式增加本固定身份；保持旧身份原严格配对。新21必须case_set、原完整21、cap42、profile／mode／stage／版本及引用摘要全部相容，bool／float位置、sequence及PID拒绝。新mode建议 `deepseek_bounded_reference21_v4_source_v2_v_off_forced`，stage `reference21-v4-source-v2-v-off-forced`，owned kind `reference21-v4-v-off-forced`。
2. 复用`mixed_phase_policy()`、两内部模型的purpose分发、真实SDK request wire核验、安全响应观测和原预算底层。新身份sequence严格1–42；坏参数／NaN／孤立代理等仅保存实际HTTP状态及安全digest元数据后硬停，发布失败不伪造证据。不新增修复调用、回退provider或动态模型策略。
3. 新固定runner及薄deadline复用已审纯helper、ExplicitReviewBridge、自有进程组和绝对截止控制；不调用旧helper的prepare或registry_snapshot，不仅替换full140入口名称。领取前核新registry不存在、旧九场closed、实际安装版本及完整源码／合同／输入／提示／动态schema。实际数量按闭包计算，不照抄79／89。
4. 新闭包含实际nullable源码、public21-v2 JSON与中文判据、新runner／deadline／计划／实施记录、实际helper／bridge、runtime_config及相关v4／stable_fact／continuation规格与ADR；不冻结未读取的full140参考来冒称必需依赖。新增deadline进入动态源码集合时同步当前相关fixture断言，不重写任何旧freeze。
5. RAW独立Agent只看前层，先封存并取得正式receipt；Root FULL保留全部RAW判定，核V语义、各层对应及完整组去向。不得以模型supported、保守pending、机械matcher或人工默认pass认证质量；每个窗口只按本场实际证据，未知不补签。

## 时间、停止与关闭

HTTP读取300秒；每E／V调用、RAW及FULL各600秒。**工作14380秒、从prepare起绝对14400秒（4小时）**，取较早截止，保留20秒外层关闭余量；上界不是承诺全部阶段都可耗尽600秒。通常完成立即关闭；提前截止则保留unknown／unrun，不延时或补跑。

一般错误继续；safety、语义unknown、技术／结构／来源或冻结漂移、记录／审核失败按既有严格规则立即停止。未知请求不退款、不重试。关闭失败保持close_unknown并保留原件；不终止未知归属进程，不自动启动后继。Root关闭后核源码冻结、事件副本与摘要、SQL只读闭账、正式审核receipt及自有进程／组退出。

## 测试与完成边界

在既有准入、实际SDK Mock和owned／phased公开接缝先红后绿：精确原21／42和新身份装配，范围／cap／类型／参考／工具策略及旧身份串用均在领取或凭据前拒绝；真实wire验证阶段分离、一次凭据与同预算。完整Mock跑到B02；仅给定A12／A14为空E的控制应21E＋19V＝40次，cap仍42，不按Gold跳过E。

覆盖RAW盲视、先封存、FULL不可改RAW、receipt绑定、一般续行／safety与unknown停止；实际schema含stable_fact／continuation、给定A13合并仍0.55 pending无完整auto信用。覆盖cap43、bool／float位置／sequence／PID、坏响应安全观测、关闭失败、总体截止优先及自有组回收，旧runner合同不变。最小后跑完整相关回归／类型及Standards／Spec双轴，自动本地提交、历史扫描；真实新台账由Root最终核验后唯一启动，不让worker自动调用。

相关回归发现既有macOS自有组回收在退出期的`killpg(pid,0)` EPERM，须先用实际自有PID证据定位。修复限现有owned公开接缝：普通查询默认100毫秒、每10毫秒作无信号存在检查；reap发出信号后的查询沿用原已存在的每信号1秒绝对截止，不让内层100毫秒先中断，也不每次重置或增加外层时间。EPERM保持未知，仅实际后续ESRCH才能认定组已退出，真实查询成功仍视为存在。持续错误到同一截止仍抛回，不因未知发下一个信号；实际发送TERM／KILL的错误立即硬停且不补发，不扩大到其他组或桌面运行时，不签进程回收成功；HTTP零重试、总体截止和关闭未知合同保持。新增真实fork接缝的200毫秒错误后恢复控制、持续／发送失败负控须先红后绿，复验原新／旧实际场景；控制能力不代签历史无PID失败或断言其原因。

结果分别报告A01–A16主集、A17–A19补充、B01／B02核心；≥15门只能用本场主集实际审核窗口，不拿28命题或旧部分场替代。旧真实核心6／12等仍单独保留，公开合成不代签私人目标；typed可用性、业务采纳和逐类放行另验。此准备不结三张原票、不改空放行表，不涉及GUI、外部聊天发送、真实数据或远端Git。
