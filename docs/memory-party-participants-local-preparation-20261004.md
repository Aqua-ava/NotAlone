# 直接参与者判断的本机诊断与准备（2026-10-04）

用户要求把记忆语义准确性与完整性设为持续目标，继续按既有工作流处理。本轮完成本机诊断和一处提示修订准备，尚未验证模型效果。原24次试验已经关闭，不重开预算；实际聊天的历史必需6/12、可选2/6没有复测或改善。

## 问题与归因

沿已认可的公开模型I/O、`verify(window,facts)`、`ExtractionFlow.run`与`can_auto_adopt`重放[上轮](memory-party-guard-pilot-result-20261004.md)保存的匿名返回。原话“朋友邀请我。”、候选“联系人的朋友邀请联系人。”，独立冻结参考仍为mixed，不改Gold。

原、新提示下各运行3个症状检查：两次C4人物断言均失败，20个已知候选的完整14字段及去向保留检查通过。新提示下重放同一旧返回仍失败，不能当作模型修复失败或成功的新样本。剥去用量与响应metadata后，最小有效公开返回仍是contact；正确候选继续pending，完整Fact没有被错误临时人物字段改写。这只完成捕获边界的最小重放，未离线证明模型真实行为的因果机制。

三个预先记录的假设分别为：主要人物或资料范围影响了排他分类、输入遗漏参与者、解析丢失正确分类。两份逐字SHA核对的原请求都完整包含朋友、联系人、sender及候选；两份原始公开模型返回已经是contact，原适配器重放也是contact。因此后两项与已观察错误不符。模型为什么忽略另一位参与者仍属待实测假设，不能凭查看提示确定。

## 修订准备

在独立私有副本中，仅替换原人物附加提示的一段说明：先识别状态承担者及动作的发起者、承受者、共同参与者，再按人物归属集合分类。原命题明确涉及两方行为时两方都计入；认知对象、所有者或被提及者不因此参与。不补原话未说明的人物，不输出检查过程或新字段。

完整原产品V前缀、原六键临时schema、11键候选请求、解析函数、证据校验、third_party窄guard及公开四键出口保持。函数体AST逐项相同；六组已知输入的两臂公开调用在schema、工具选择、user消息、捕获结果及完整Flow结果上相同，仅system提示改变。人物字段仍不进入业务Fact；不把mixed/unclear一律降级，不升级任何候选。

准备12条新的手工合成开发样本，覆盖owner3、contact1、both2、third_party3、mixed3。它们用于检验改进能否超出“邀请”这一句话，另含认知对象反例；unclear没有新模型语义机会。原稿D2补回“曾说”的历史限定，D5/D6/D10明确亲友归属，另存v2并保留v1；这是联网前的夹具修正，不根据模型返回改参考。首审支持v2的主体/人物与原话，补核现提取提示后发现统一类别/话题不准确，D7本人共同完成也应为assertion/asserted。联网前另存v3：按近况、共同经历和习惯修正分类与话题，D7转为正确auto，其他语用/去向、原话、人物、subject、范围ID、风险和日期保持。v1/v2和首审全部保留；v3已独立逐条增量核对。这些仍不是用户Gold、盲测或最终留出，也不是E提取结果。

## 验证与限制

- 本机3项不同契约控制通过：最小捕获仍暴露错误且保持正确pending；提示单叶变化保持schema、请求与编译；12条人工正确响应可完整保留给定Fact及预期auto/pending。先前v2检查只证明当时给定字段的接线；v3改动后同3个方法重跑通过，6auto/6pending，不叠加成6个新测试。这些是结构和表达正控制，不能说明模型会输出正确人物，也不证明E补漏。
- 3个私有目标文件mypy和AST通过；mypy使用`--no-incremental --cache-dir /dev/null --follow-imports=skip --ignore-missing-imports`，导入依赖跳过。首次9个ClassVar属性声明错误及当时源码保留，只补类属性类型声明。旧语义断言没有改成通过。独立审查另发现初始本机scope说明仅列旧捕获、漏列后续自行编写的D合成资料，保留首scope并新增范围说明收据；没有借补充说明授予外部调用或真实资料权限。
- 不涉及第三方API修改，没有安装依赖、构造真实SDK、查找模型key或新增网络调用。旧关闭收据逐字保持，业务记忆、水位、旧五条、产品源码及默认没有改变；仅处理获准的已知匿名捕获和本机合成资料，未读取actual/private held。

命令使用Conda `NotAlone`与`PYTHONDONTWRITEBYTECODE=1`，以下省略私有目录前缀，完整绝对路径参数在收据中：`python replay_participation_v1.py first-feedback-v1`记录原反馈；`python replay_participation_v1.py candidate-feedback-v1 candidate`记录候选提示下旧响应重放；`python local_controls_v1.py`验证契约；`python -m mypy --no-incremental --cache-dir /dev/null --follow-imports=skip --ignore-missing-imports party_participants_runtime_v1.py replay_participation_v1.py local_controls_v1.py`检查3文件。前两条命令预期退出1、各2个明确人物断言失败，其余保留检查通过，不能汇报为全绿。收据采用独占创建，不能覆盖重跑。

私有材料位于`~/.notalone/audits/memory-party-participation-diagnosis-20261004/`，目录0700、文件0600，不提交原始资料。主要SHA如下：

| 材料 | SHA256 |
| --- | --- |
| 原症状反馈 | `4a63277fe670e6473cdcae69db7c4dbf368ff2007797f1f4ab8ea5da8cfee97f` |
| 候选提示下旧返回反馈 | `afb55d708d205d6d31a875c1956cfcd9e20fe5607cb17138a71d3aa171d17460` |
| 单叶差异及归因 | `d8a65f8e5948c443aeb2ca56352fb51353bc66a43dacd328889464674cfb29a5` |
| 候选私有适配器 | `e96c2a17694c1db97370e77b63ea9eb8a7e390bdd58b443e4ff7c25a7466dcd6` |
| 新合成输入v3 | `947931329d6bf156e22f2cba9cde2f9ab8b33b3de1dedb1fdb0965a6122672e1` |
| 新合成参考草案v3 | `c2b72c6d96bec8bb7c404ecd44c6a5b2717682de96f36922a49ce1ea079c608d` |
| 最终类型/AST | `5e0c1775074b1ddc260136d6426c6be96a6403e5e514fe7b8b65c7c5946e544d` |
| 首次本机核对收据（v2） | `6abbd82b331cac74b47214a4f9491f58c071500c12aa7658bcc0235cf6e7b98b` |
| 本机合成材料首范围说明补充 | `fdf5fdedb091787d8e48ca15877429e76947a3a1023e2782136828c1df475ffd` |
| Standards独立首审 | `a7397c80a58edb6fbe15fcd0dc3a7c0bbe03565e10d7dc43209bda9e29ceb303` |
| Spec首审及v2人物判断（后续缺口另存） | `7919857059d5fbf42e7f832bb306f639a8826ea3b1acc13f2e0c8883a8d7a952` |
| v3人工响应控制 | `c376b29fc18a53e63adcf243f22f6415c5249457a98d4543863fc4e3639fd029` |
| 本机v3材料范围记录 | `2c0828927d9518a73a9512492c149920aa9b79995f787f06a256c9a82e460ed9` |
| Standards增量终审 | `fa47c3167c295ea4bf63acaccd3c28ba01a0200d359dd2e2e40d75c7b96d48b0` |
| Spec增量终审与v3独立判断 | `0af14710308d722be44e22bcc2814abbf6164cbb66a23de83fa77c4f2f0a3560` |

## 两轴审阅

### Standards

首审与v3增量终审的硬规范及阻断均0；判断性气味1：重放与本机控制的Fact投影、采纳去向断言重复，可后续提取测试helper，本轮不要求改动。审查确认两次原人物失败被保留，人工控制未当模型收益，单叶之外模块AST、schema和guard相同；旧预算关闭、48次未批准。

### Spec

首审未发现人物/正文阻断，随后补核类别与说话行为发现人工夹具准备缺口，不能把合法枚举当语义全正确。首审及v2保留，v3修正后独立12条判断支持角色及6auto/6pending参考，4/20/24调用及每臂2/18/12机会不变；初scope遗漏另有补充。最终增量终审已通过，当前缺失、范围扩展和错误阻断均0，修前记录不改。整体修复、E漏提、实际6/12与2/6仍未完成，下一轮只属待批准工作。审阅者没有模型/SDK/测试调用；root只因夹具路径改变复跑同3控制及类型/AST，不当新语义样本。

下一步的[有限对照提案](memory-party-participants-prompt-pilot-proposal-20261004.md)已形成，未批准联网。总体目标继续保持未完成；本机准备不替代真实模型对照、实际同批核验、完整性验收或产品发布。
