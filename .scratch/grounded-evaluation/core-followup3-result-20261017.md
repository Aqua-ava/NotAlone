# 核心固定集追加第三场：读取超时硬停并关闭

沿[追加56次方案](../memory-core-claim-retention/fixed-repair-followup-decision-20261016.md)，本场在当前判断指导修复及两轴通过后使用原固定六窗和原Gold。新四窗未读取、未激活。

## 实际运行

- run：`f41ab276-37e8-4fc0-ae1f-4fa15027b50a`，语义源码`043fa0dda4c9ef2deab293f91d45f34e0f52c0c5`。
- 配置保持官方DeepSeek Flash、E grounded-v2／V legacy-v4、两阶段thinking enabled／effort max、temperature 0、tool_choice省略、SDK I/O timeout 300秒、max_retries 0。I/O timeout不是整请求墙钟保证。
- 独立cap12，实际预约及请求3次：W01的E/V各1，均HTTP200；W02的E为第3次请求，记录`read_timeout`、`response_obtained=false`，没有重试。耗时864.5985046249989秒，registry关闭3/12，未用9次永久关闭。
- 16条事件包括W01完整12步，以及W02 started→request→provider_failure→case_result。没有W02 adapter、E编译、RAW、V或FULL，不能补签；W03–06均未运行。

## 已审与未完成分开

| 窗口 | RAW／FULL实证 | 运行状态 |
| --- | --- | --- |
| W01 | 3条／42字段全pass；必需raw、接受、完整各1；全部正确extra保留 | safe |
| W02 | 无响应、无E／RAW／V／FULL | unknown：技术失败 |
| W03–06 | 未调用、未审核 | unrun |

W01实际V三个supported，最终三个pending，语义假事、错人、坏auto、正文损失及不必要降级均0；三份旧version1、source_bound=false、semantic_basis=null，不计新类型化依据。RAW先行封存，RAW60.484秒、FULL25.154秒，五键和时钟均通过。

只审W01的semantic unknown0不能覆盖全场运行unknown1。原结果的planned6、completed1、unknown1、unrun4及plan_complete=false原样保留；六窗义务仅1窗有完整实证，不能称核心质量通过。本次当前判断提示在目标W03尚未实际受测，也不能据此宣称改善或退化。

## 独立闭账与后继范围

独立核对全部16条事件及canonical SHA、W01来源／Gold／全部字段／原V和最终去向、唯一实际故障及未运行状态。76份源文件、8个安装包、2份输入摘要一致，闭账时HEAD正确且Git干净。exact-run registry已关闭，claimed／closed标记存在；PID36418退出、当前相关PID／PPID／PGID匹配0、in-flight锁无持有者，文件／目录权限0600／0700通过。启动后进程观察仅作当时观察，不能认证原始完整进程谱系。

独立收据SHA256：`04b63c57f37f9146e14bc0727c215ad0c5f839e99915bbc9c23b8860b8ffb602`，明确释放本场源码冻结；原HTTP字节SHA仍不能由脱敏重排JSON重建。凭据只作stat，运行loader收据reads1／secret_persisted=false；无业务库、桌面、聊天发送或远端Git。

追加56次累计实际27；本场未用9不能转借，原第四固定场12及唯一留出8合计最多20仍未激活。原方案同时要求同配置及每次有真实修复，本次读取超时未提供新语义修复依据，因此不得自动原样重跑。后继[技术恢复决定稿](../memory-core-claim-retention/transport-interruption-final-stage-decision-20261017.md)须明确批准例外后才可运行；未确认前保持核心票claimed及留出封存。其他两张记忆票的本地实现可继续，不占本方案调用额度。
