# 非回复正式评测执行准备

2026-10-25。已交付可执行离线适配、发送拒绝接口、最小缺口探针、完整 E/V 及业务投影盲包和路径 SHA。**真实模型0、App/微信操作0；正式质量仍未测，票25/26不批准。**

旧臂固定 `3c168296e9e8edaa43b8b323ff693e790e709069`；新臂固定 `4f89bb976dd4086a02b7ae983fee2760d6e4ff64`。归档执行与当前 working tree 分开，未把后续 HEAD 或腾讯未提交策略签成固定来源。DSH 固定 `0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`。合成库迁移上限115，没有应用116。

原 `resumed-nonreply-evaluation` 及 `final-candidate-a61a2140` 原样复用、只读保留；原24逻辑/51本机HTTP和统一1152中1128未执行不变，未导入为当前 pin 的质量结果。新计划仍为140提取、L2/L3/Skill各12例，每例3次双臂，1056非回复及1152统一分母；56份材料、301 case 摘要均校验，未改材料、oracle或门槛。

## 实际执行的合成硬合同

最小合同复验 **10/10**，0失败、0跳过。全历史58条探针尝试涉及16个不同 run ID、52次 loopback HTTP；包含夹具调试及重试，不是58条正式质量结果，也不合并成完整矩阵。逐轮记录和所有失败见 [probe-history.json](probe-history.json)。

| 缺口 | 实际证据 | 边界 |
| --- | --- | --- |
| 三域取消及迟到 | [cancel-wire-final](cancel-wire-final/probe-summary.json)：三例双臂6条，各1次HTTP；公开HTTP/旧公开命令先持久取消，再返回带冻结late文本的实际write或pending draft提案；原响应正文、SHA与顺序均捕获；新增版本、画像、草稿均0 | L3沿真实L2→L3共用任务在首个请求处注入，不认证每个L3内部提交点；旧学习保存抛租约失效，原异常仍保留 |
| 学习错误主体 | [speaker-capture](speaker-capture/probe-summary.json)：双臂capture中一条普通观察、真实 `speaker=contact`，非用户反馈；单条未达ready、0HTTP | 不用subject充当speaker；不把未调模型说成语义通过 |
| 既有版本 | Skill当前联系人范围、启用v1进入双臂capture；修正草稿精确绑定该版本，前后启用状态不变 | 所有冻结L2/L3 `existing_projection=null`，明确绑定不存在，不额外制造旧投影 |
| 修正与来源 | [correction-proposals](correction-proposals/probe-summary.json)中的双臂学习均产生pending更新草稿，依赖含s4来源及消息；[correction-l2-final](correction-l2-final/probe-summary.json)的新场景引用s4及revision1，并保留三个原来源版本 | 旧L2假响应仍no_change，不能视为语义等价；假方法文本不作为真实质量评分 |
| 初始删除态 | [deletion-public-entry](deletion-public-entry/probe-summary.json)：双臂0HTTP，无正文删除回执，活动派生资料为空 | 冻结初始状态适配及公开管理入口过滤，不宣称额外做过完整产品删除验收 |
| E/V完整捕获与盲化 | [extraction-ev-ledger](extraction-ev-ledger/probe-summary.json)：双臂各一次非空E与V、各2HTTP且各2笔持久记账；[E/V盲包](neutral-ev-final-receipt.json)2条完整、[原模块业务投影盲包](projection-final-receipt.json)2条/1对；原文与返回保留，运行身份进入私有绑定 | 两名独立审阅及第三人裁决均未执行；中性标签检查不等于结构侧信道已被独立审查 |
| 预算/许可/网络 | 缺根端口、过期、外部URL、real开关均在传输前拒绝；失败不退预留。Node Socket连接前拒绝外部目标，旧Python socket只允许本机 | 只实现根注入端口与有界内存测试替身，不创建真实问题预算，不提供可开启的真实传输 |

所有新臂显式设置 `NOTALONE_HOST_RUNTIME=typescript` 及职责flags，经过官方profile和既有公开业务服务；评测薄插件不替代产品完整主宿主端到端验收。L2/L3公开clock及旧Store clock采用冻结as_of；Skill保留冻结观察时间，产品没有独立学习as_of参数。

## 仍未准备完成

1. 根持久问题账本、供应商许可和真实发送守卫的最终接线；两臂的真实物理上限、截止时间与每次发送复验。接口及复现命令见 [execution-contract.md](execution-contract.md)，任何费用暂豁免都不授权外呼。
2. 正式两臂实际模型配置、提示、工具schema及生产宿主装配的同配置审计；本机假provider的结构/参数不能冒充真实等价。
3. 提取冻结材料没有as_of，原适配器仍使用2026-09-15消息锚点；正式时间类质量的适配资格需根明确核对，不改原oracle。学习只有冻结来源时间，没有公共统一clock注入选项。
4. 全176例的独立语义适配、完整输出盲审与结构泄漏审查。当前只做缺口最小集；所有 unknown、失败和未执行保持可见。

现有109/140不重跑数值推理。46份检索相关来源中44份与263证据相同，另两份仅连接函数export及discussion_input别名扩展；差异与SHA见 [retrieval-source-equivalence.json](retrieval-source-equivalence.json)。这保留历史327/420证据及当前差异，未自动认证当前宿主集成。

## 真实未跑与失败保留

正式1056非回复、统一1152、120资格、96回复、真实性能/用量/费用、实际App/微信及切换均未由本轮执行；独立语义评分0，结论 `undetermined`，不批准25/26。条件3、数量1的原样本不足不变。

保留所有RED及旧失败。其中 `extraction-ev` 旧臂2HTTP仅1台账的硬失败原样保留；原因是本评测脚本漏传旧核验器ledger，补接旧公开构造器后以新双臂证据得到2/2台账，未改产品。L2假引用错误被正式核验拒绝、初始删除回执不完整、包目录和输入格式错误等也保留。早期空/no_change取消小集不作为最终迟到写入证明；最终证明使用完整冻结载荷。

仅写本独占目录和仓库外自有临时文件；未改生产源码、原报告、已有测试、票、Git index，未提交/push/PR/打包。未读真实资料、真实密钥、项目配置或真实问题账本。自有源码快照/引用进程为0，26份已记录合成库回执均dropped；最后源码快照49,912 KiB→0。原始证据保留仓库外0700/0600，不删除未知资料，见 [cleanup.json](cleanup.json)。

精确来源见 [fixed-source-manifest.json](fixed-source-manifest.json)，执行/日志SHA见 [verification.json](verification.json)，完整交付清单见 [artifact-manifest.json](artifact-manifest.json) 与 [SHA256SUMS](SHA256SUMS)。最终源码与提交由根统一处理。
