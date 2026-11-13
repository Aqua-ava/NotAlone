# L3 逐条核验与合格条目发布
Triage: ready-for-agent
State: resolved

用户决定：逐条检查，通过条目即可发布；单条未支持不应拖住整份概览。

## 范围
- 先核对完整原始提案/核验包，再按原索引选择已支持条目；保留原模型回执。
- 未通过条目保留状态；全部未通过不创建空画像，既有有效版本保留。
- 失败更新不删除有效旧条目；来源、版本、引用、容量与删除保护不降低。
- 页面显示通过/未通过数量；已发布内容可见。
- 对已有失败画像提供显式本地零模型重放，同一逻辑步骤新尝试，复验完整来源/封印/回执。
- 不新调模型，不开启自动处理，不手改用户库，不发布任何未通过条目。

## 验证
- 新SQLite回归先红后绿：16条提案15支持/1拒绝，后续条目证据不串位；全拒绝；已有版本保留；坏协议；撤权与删除。
- 新运行时重放合成验证：旧失败尝试/回执保留，无新模型调用，非法/未知/变更回执拒绝。
- 原有工作区/发布/调度/来源/删除相关回归与类型检查。
- 主Agent通过现有已认证HTTP临时验收接线显式调用产品恢复逻辑，只作用于样本王威；结束立即还原。
- 实际pnpm dev界面核对15条发布/1条拒绝，自动处理保持关闭，不打包/推送。

## Answer

逐条发布实现、离线验证及最终真实发布/桌面验收均已完成。用户明确授权重启已核实归属的旧开发实例后，产品启动恢复复用已保存成功尝试完成正式发布：15条通过、1条新提案未采纳；未新增模型调用。

本地提交9ef56ccce、574841932、f5586567b、4ff0680f0、8efa19bb6。混合支持按原entry_index选择，原包与证据不改写；全拒绝不建空版本，旧有效条目按完整身份保留，超预算不删旧挤容量。显式零模型回放复验同step原回执/封印/来源/版本，保留旧失败尝试；核验重试和主题替换复用正式合同；保存成功后中断可恢复同成功attempt。

历史阻塞：初次正式恢复已保存15条并拒绝1条新提案，随后publish触发15秒action_timeout，尚未建立publication、schedule仍running。认证runtime/status确认action=memoryDocuments.publish。副本首写屏障实测publish纯读11982ms/352238 SQL→2336ms/12743 SQL，物理写0/模型0，副本已删除；修复缓存只在无写验证区生效，所有门禁保持。该中断已由下述正式启动恢复结清。

最终独立审计：private证据l3-partial-replay-before/after/result确认同一task/run，global model_call647条及完整账本hash不变、原始6个输入输出包hash不变，modelCallDelta0；automatic前后均0、onlySample=true、sampleUnknown0、activeCalls0。published=true、profileEntries15、selection为accepted15/rejected1/retained0；block_no保留1至13、15、16，不挪用被拒绝的原索引14。schedule=succeeded、run=completed、profile step=succeeded；原attempt1仍failed/document_profile_unverified，attempt2仍succeeded，没有新增attempt。recoveryPath=product_startup_publish_saved_profile、secondReplayRequest=false，最终恢复无需再次安装或调用临时HTTP。preserved-state文件保留重启前中断快照，最终结果以after/result为准。

验证：逐条发布12/12，核心回归含增长94/94，桌面选择4/4、管理控制21/21，回放及中断36/36，发布缓存边界/增长/永久worker失联恢复20/20；关闭修复及现行删除19/19、取得阶段关闭1/1。类型检查、diff检查通过；两轴独立审查无新增发现。

历史关闭阻塞来自讨论副本排空后向死库登记manifest的退出缺陷，最小修复已提交；健康库/删除仍严格登记，driver关闭失败不吞，文件与旧账本保留。正常“重试停读并退出”未成功后，用户明确授权结束已核实归属的旧App/backend实例；主Agent按授权完成重启，复用pnpm dev热更新开发实例，没有打包。Computer Use实际打开王威“长期概览”，核对“长期概览1篇”“主题资料与长期概览已完成发布”“15条通过，1条未通过，未通过的新提案未采纳”，正文15条依据入口可见，总开关关闭；Computer Use已正常结束。

清理核对：http.ts、runtime.ts及.env与HEAD一致，本轮未安装临时HTTP，未手改用户库。实验清理记录确认用户库未由实验修改、副本已删除；无新增图片副本或模型调用。architecture/及.scratch/被git忽略，本规格和ADR等记录不进入本地提交；工作区其他会话的media相关改动未触碰。
