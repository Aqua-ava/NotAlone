# 单次V探针v2：安全保存响应失败元数据

Triage: ready-for-agent
State: resolved

> 2026-10-17 状态同步：本探针已按[结果](deepseek-v-off-forced-v2-result-20261016.md) closed 1／1、取得 HTTP200；只证明本次协议与记录路径可运行，不认证 E、质量或 typed。

日期：2026-10-16。承接[v1独立结果](deepseek-v-off-forced-pilot-result-20261016.md)与已复现的记录缺口，只修未来专用fixture，不覆盖v1材料或重新解释旧响应。沿用户对必要官方DeepSeek公开合成验证的持续授权；目前v2没有真实台账或请求。

## 问题与范围

v1的响应脱敏／摘要普通异常可能先丢失HTTP响应记录，再被归为`response_obtained=false`，而内存实际已进入响应保存。先以纯Mock修正此观测缺口，再用**新的**公开合成“我刚刚到家。”单消息／contact／唯一target及给定v4标签编译候选，最多一次V，检查新合同与观测能否实际工作。不给E能力、质量、因果或旧未知修复信用，不重发v1输入。

## Implementation Decisions

- 独立版本`deepseek-v-off-forced-pilot-v2`，实际旧runner作为未来入口升级，旧v1计划／实施／freeze／事件／结果保留原样；新计划与新实施记录进入新freeze。仅改这个专用runner与其测试，不改共享预算、records、provider、完整140、生产或typed门。
- 请求合同沿v1：官方`https://api.deepseek.com/chat/completions`、请求／响应`deepseek-flash`、thinking disabled／reasoning none、强制`SourceVerificationOutput`，实际原nullable-proof-v1提示／schema／SDK／V适配器，零重试，无strict／beta、content补解析或宽松工具合同。唯一变化为新输入、观测修正与版本绑定。
- 先标记实际已进入响应保存；遇脱敏／规范化失败，拒绝继续V解析，同时仅保存安全的实际HTTP状态、长度、固定失败码及`response_obtained=true`等受控元数据。不得保存未脱敏arguments、任意错误信息、headers、凭据或正文副本，也不从这些元数据推断模型质量。无法保存元数据时继续失败安全，不报响应保存成功。
- transport失败事件的`response_obtained`须反映本轮真实响应状态；真正无响应timeout仍false。不能把仅保存元数据称为合法tool响应或completed。
- 沿v1的cap1、fresh claim先于唯一凭据loader、0700／0600独占文件、源／安装版本／输入／候选／wire／授权SHA及run／nonce绑定，60秒调用／70秒工作／prepare至launch原80秒绝对时窗、自有组清理、closed／close_unknown与无自动后继边界。完成／失败立即闭账，未知不退款不补发。

## Testing Decisions

先加能复现v1缺口的非法arguments／非object／非有限数及HTTP503反例，确认红灯，再实现只含安全字段的响应元数据；核响应已取得和read timeout两条路径、I/O保存失败、无原始arguments／reasoning／headers／凭据、原成功SDK wire、严格索引／PID及一次闭账不回归。只跑新fixture和必要共享最小回归、类型检查及Standards／Spec独审。

材料最终稳定并本地提交扫描后，Root另行prepare／核查／绑定现有授权／唯一launch。新台账cap1，禁止因异常自动创建后继；实际结论另写结果。若未得到合法工具返回，先诊断可见事实，不能以增加预算替代定位问题。

## Out of Scope

不变更原公开21／140输入、Gold、旧审查、分母或任何闭账，不连接业务库、真实聊天、GUI或外部发送。默认放行为空、生产v2及所有语义门保持；typed包装B仍待用户决定。该探针不完成至少15窗、核心保留、指代或逐维度采纳验收。

## 离线收尾

实际实施与真红／绿见[独立记录](deepseek-v-off-forced-v2-implementation-20261016.md)。17项新fixture及最小共享2项通过、mypy两个文件无错误；Root与Spec另各复跑17项通过，分开记录不累加样本。Standards／Spec独立初审均0。当前真实预算／请求尚不存在，仍由Root在本地提交与扫描后按上述单次合同冻结、核查并唯一启动；本准备不认证服务可用或质量。

## 实际离线验证

2026-10-16：专用runner／test已按TDD实施，记录见[v2实施记录](deepseek-v-off-forced-v2-implementation-20261016.md)。首红17项／7失败及10错误；修正后17项通过（3.764秒），最小共享回归2项通过，两个文件类型检查通过。坏arguments／非object／非有限数／HTTP503仅保存安全实际元数据后硬停；I/O失败不冒称已保存或completed，无响应timeout仍false。实际SDK wire、严格整数、授权／freeze／claim、一次闭账及60／70／80秒控制均保持覆盖。尚待独立两轴审查与最终冻结，没有v2真实凭据读取、台账或模型调用，不标记审查通过或State完成。
