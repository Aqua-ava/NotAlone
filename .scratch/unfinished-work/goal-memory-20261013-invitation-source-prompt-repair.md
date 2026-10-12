# 来源边界与邀约阶段的最小提示修复（2026-10-13）

本叶基点`8154a30d`，仅修改两个既有system常量：[提取E](../../backend/src/notalone/memory_extraction/adapters.py)、[核验V](../../backend/src/notalone/memory_extraction/verification_adapters.py)及本文。真实red来自[固定四窗正式结果](goal-memory-20261013-diagnostic4-result.md)：A01备选身份无据、A02的V在正确转述上误判pragmatics、A04理由无据补“当面”。没有新增镜像提示文字的测试，不改旧Gold、sealed判断或3/3/1正式计数；本叶新增供应商HTTP、预算注册、App及业务库操作均0，原八runclosed合42保持。

A02实际V输入已经包含上文人物与target两条来源、contact、relationship_note、report/reported、literal及双null；实际V仍返回uncertain、issues=[pragmatics]，原证据片段真实。输入没有丢字段或丢上下文，V也不接收E的备选／理由。现行提示先处理普遍未来计划，再用后置报告规则说明report本身不是uncertain；“已发生邀约”与其内容里的未来活动容易被当成同一阶段。本叶将已有“来源支持与参与者独立”的整段前移，在一般时态规则前说明正确报告仍可supported；再先固定候选主张的外层邀约动作，只有候选本身主张未来打算／安排才要求plan。保留缺report/reported、升级本人事实、真正未来安排、假设／条件及日期错误的降级规则。未读内部思考，不能证明本次误判的具体因果就是规则顺序，也不能强制某例返回supported。

E补的是所有候选槽共同的来源边界：text、alternatives与interpretation_reason只能保留引用输入支持的内容；subject的owner/contact资料范围不是人物属于谁的圈子的证据；短理由不补来源未给的当面／通话场景、人物关系或互动。保留原有身份／事项未知时非空备选、否定／暂时限定及语用规则。A05的有据额外家庭事实保持，不增加压制称谓或减少候选的规则，不删输出、改Gold optional或降低质量门。

公开跨例参考边界仍为：未知第三人不能猜圈子，已明确身份的原文称谓不删除；仅有文字消息不能补面对面，有原文明示的互动不能一律禁止；已经收到的邀请与本人未来计划分别标注，直接转述的正确report/reported可受来源支持，遗漏转述标签仍须降级；本人参与的已发生亲友借用不因出现第三人就全部reported。这里只核对公开材料与现行规则的正负边界，没有执行新的模型响应，不能当作语义绿。

AST移除两个准确常量赋值后，与本叶before快照完整相同，schema／parser／factory／storage／采纳门未变，实际diff与Root批准的外部提案逐字节相同。E源码前`f20c164835686ab7b068cee0dc98338c83e9c635b600a50d9cd424f7bfa63e2f`→后`f5d5fa1a6f005f69a3e19b98332d5c1138723a27f8661ac015ed03a80b0b7ef9`；V前`6f7e3c64821bb4da73d9d24c732910e3fb3349a53d78221a3227694183f63e64`→后`adfe2bc79254fdd4ca07252b6ae5f0a82e6b6cdb4c5bd0d5573d688cceae16df`。新提示规范JSON摘要为E`4215dc3e02c67ebb3af33dfa81ea52f1922b11f0d9b776e0af476f1fb5d65e0f`／V`e4f5797d0942f4ad55c6caa567dc2bfdb6b8dca7eb9868d52afbde2e2a5ab151`，与源码字节摘要分别记录；无caseID或标准答案特判。

Conda `NotAlone`下，以socket／DNS、真实HTTPX及HTTPX2默认transport、dotenv守卫运行原八个相关模块：E/V适配器、既有核验提示契约、Flow、语用、采纳、维度及ECNU受控SDK integration，实际 **114/114、0skip、0fail/error**，unittest **3.137秒**、外层monotonic **4.610766417秒**，exit0；测试前后两源码SHA一致。两源码`mypy --follow-imports=silent` exit0，**5.646225625秒**。这些验证只证明原接线、结构、来源与门仍能工作，不能证明新提示遵守率、完整140窗回归或原三票质量达标。

证据根 `/private/tmp/notalone-memory-goal-20261013-ac04d687/`，0700／0600：`diagnostic4-next-prompt-proposal.patch`及元数据、`next-prompt-before-{adapters,verification_adapters}.py`、`next-prompt-projection.json`、`next-prompt-actual-fixed-diff.patch`、`next-prompt-minimal-tests.{txt,status.json}`、`next-prompt-mypy.{txt,status.json}`。源码diff SHA`bbfc2985654a7f414c17447522fa95e62b3c381d3b65bbf5ab804c1612141fef`。独立两轴及Root本地提交另核；全140入口／119份补充参考仍是下一工具主题，本叶不实现它们或激活尚未使用的280／余1。

[ADR-033](../../architecture/adr/033-source-semantic-verification-before-adoption.md)的核验只降不升、[ADR-036](../../architecture/adr/036-per-dimension-adoption-release.md)的默认空放行及逐类批准继续适用。原21窗／全部难例、0.7与风险语义、安全门、四类typed字段缺口和真实核心严格6/12／可选2/6不变，不读取或上传真实聊天。
