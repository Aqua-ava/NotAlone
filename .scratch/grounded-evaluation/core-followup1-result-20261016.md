# 核心固定集追加第一场：关闭，完整契约5/6

本场沿[用户已批准的最多56次方案](../memory-core-claim-retention/fixed-repair-followup-decision-20261016.md)，不是旧场续跑。固定六窗的来源、target、Gold及顺序保持；新独立四窗未激活或用于修改。

## 实际运行与关闭

- run：`1b4db3be-959a-41e2-8afe-2e42571db5b4`。
- 源码：隔离提交`64c736a8ff44ac0b461be12ea79c40f7238088fc`；包含四份已通过独立两轴的真实错误修复，未切换默认协议。
- 配置：官方DeepSeek Flash，E=`grounded-v2`、V=`legacy-v4`；两阶段thinking enabled／effort max，temperature 0，tool_choice省略，SDK timeout 300秒、max_retries 0。300秒不是整次请求墙钟保证，实际仍受冻结绝对结束时间约束。
- 预算：本场独立cap12，实际12次预约、12次请求及12个HTTP200，E/V各6，无重试／fallback／未知返回。耗时4624.465713250014秒；正常关闭12/12，未用0。
- 实际完成6个RAW及6个FULL；全部先封RAW，再开放FULL。每阶段的run、phase、case、nonce、view SHA及600秒时钟均匹配。

## 语义与字段结果

| 固定窗口 | RAW行／通过字段 | 必需raw | 接受 | 完整 | FULL结论 |
| --- | ---: | ---: | ---: | ---: | --- |
| W01 | 3／42 | 1 | 1 | 1 | 未来安排及正确额外请求完整 |
| W02 | 5／70 | 1 | 1 | 1 | 作者观点及正确额外候选保留，无多余降级 |
| W03 | 2／28 | 1 | 1 | 1 | 习惯及相连未来判断均保留 |
| W04 | 1／14 | 1 | 1 | 1 | 当前状态及观察边界完整 |
| W05 | 1／14 | 1 | 1 | 1 | 模糊未来计划的先后与双null完整 |
| W06 | 2／28 | 1 | 1 | 0 | E日期正确，V仍不必要地降级time |
| 合计 | 14／196 | 6/6 | 6/6 | 5/6 | 5 safe、1 general_error |

全部196个E字段通过，全部正确可选及额外候选保留；正文损失0、假事0、错人0、错误／歧义auto0、技术／审核未知0。13条实际V supported，只有W06第2条uncertain/time；该条正确的来源自然日日期因此新增`semantic:time`，计1次不必要降级。正文还在不代表完整合同通过；保留`quality_certified=false`，不能进入新四窗留出或关闭核心票。

最终在隔离评测中auto1、pending13，没有业务采纳。W03的正确习惯auto符合本次Gold及安全合同；原通用case仅用dummy expected=pending，机械诊断仍为false_fact1／passed=false。原result和事件完整保留，机械诊断不替代本次冻结Gold的独立字段与语义审核，也不将该正确auto冒称错误自动采纳。

14份依据仍是旧version1，source_bound=false、semantic_basis=null；本场不认证新类型化运行依据、逐维度放行或业务端到端集成。

## 独立核对与后继

独立关闭审计核对72条落盘事件及全部canonical payload SHA、配置／plan／input绑定、逐窗E→V→result→RAW→FULL顺序、审核收据及六对时钟；与正式result一致。76份实际源文件、8个安装包及2份私有输入摘要均与activation一致，关闭时HEAD正确且Git干净。原HTTP字节SHA因脱敏和JSON重排不能从保存的JSON重建，不能宣称完成原HTTP字节复核。

exact-run registry只读核对为closed、requests12，claimed与closed标记存在；自有PID及进程组已退出，in-flight锁无持有者。全部既有118份文件／目录符合0600／0700。运行按预算领取后的一次loader加载凭据，独立关闭核对未读取凭据；收据声明secret_persisted=false，保存内容无密钥／token模式。独立私有关闭收据SHA256：`ade6d2fab4965280595ab2d628c2960c2d0678b1bfd49314a52358298a911fad`。

新56次中本场已用12，剩余三个固定场各cap12及唯一四窗cap8仍未激活。本场代码不得原样重跑；下一场须先完成[来源自然日核验修复](../memory-core-claim-retention/natural-day-verification-followup-spec-20261016.md)、相关检查及独立两轴，再重新冻结。旧已关闭32次方案及本场记录不重开、不借余额、不补写旧成绩；新四窗继续保留，不能因固定集的旧split文字误读为已经测过新留出。

原核心票仍claimed。公开21／140及指代至少15个实际窗口另行验收；本结果不混入它们的质量分母。本轮无业务库读写、迁移、桌面、聊天发送或远端Git。
