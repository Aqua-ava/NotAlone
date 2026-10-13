# 历史动作、当前状态与未来安排的提示分支修复（2026-10-13）

本叶以`c8d0a5ed`中的两适配器源码字节为before，依据[当前21窗中断结果](goal-memory-20261013-complete21-observation-result.md)中已保留的真实E/V失败实施。Root首先批准的patch SHA `410da3bc4061e533457c1d73c57f5a81d3f8da91ae72464429f392aaa48e95e0`及后续源读发现的有限转引未来分支澄清，都只修改[提取E系统常量](../../backend/src/notalone/memory_extraction/adapters.py)和[核验V系统常量](../../backend/src/notalone/memory_extraction/verification_adapters.py)，加本文共三path。最终两源码完整diff SHA `1c17400f5ca36d4371380d3931f862b9f4d3a44d9c62dc62a53c38eb4c0b648b`。写入前与负责原03运行字段的Agent串行协调：我独占两SYSTEM常量，对方不保存这两个文件，typed解析及其余模块另轨实施。本叶不能替代其迁移／模型DTO／维度合取验收，后续真实调用须冻结届时共同的全部实际依赖源码（含原03新增evidence模块，旧60清单不可复用），不能沿用旧全局快照。

实际red分开保留：A05本人接收姐姐车的历史关系经历被E按纯第三方report/reported处理；A07未来来访安排被E按relationship_note/reported处理，V未指出可见分支错误；A08已完成阅读动作被E当recent_state并套来源日有效期；A06当前等待状态沿观察点／日终边界却被V错误time拒绝，历史到达分支的完整契约另缺。本场A08完整答复缺失，仍是unknown而非已签正式坏auto，不能补签或伪造完整控制。原三票验收、Gold、旧sealed、全部分数保持。

现行E同时存在纯第三方宽转述规则、本人的接收经历窄例外、未来plan/asserted分支，且在“已发生双null”之后又写“只有真正长期有效才留空”；V要求日期由原话支持，却未说明现行瞬时状态的观察点和来源当天检索边界。以上是提示文本与真实输出的可核对重叠／缺项，属于修复假设；未读内部思考，不声称已定位模型为何选择错误槽。

E现在先区分本人明确参与的历史接收／借用／赠予、纯第三方转述、直接表达的未来安排；纯第三方的真实转引仍保留report/reported，未知身份仍非空备选、不得归给联系人本人。无明确资料期限的已完成普通动作用common_fact／双null，“刚／已经完成”不证明当前持续；当前状态沿recent_state观察点分支，历史动作与当前状态各自保留完整字段，不用一条观察区间冒充两个完整分支。原历史关系经历、未来期间、假设／条件、否定、风险、source和暂时限定要求不变。A04无据事项类型备选的既有失败单列，未用复制相同规则宣称已修好。

V对应核对历史普通动作、历史关系经历、当前持续状态和未来安排；瞬时状态的valid_at是来源观察点，invalid_at可沿来源偏移取当天结束的检索边界，不声称真实事件在边界结束，也不因此要求原文明确真实结束时刻。明确期间不能截断／延长；未来明确安排的存在与第三人身份未知分别核，真实转引仍保留报告边界。V依旧只降不升，只核其实际可见字段；不获取E的risk／alternatives／confidence／reason，不借supported签E14、现实真相或自动采纳。

同叶后续只读119候选v5的原公开来源时，发现内层被转引未来安排可用完整plan＋reported分支，但V旧句强迫所有明确转述都同时report／reported，E也宽称所有转引说法为report／reported。Root认可这个可见合同冲突，批准最小增量：保存已说／听闻的历史动作沿report＋reported／历史双null；真正保存被转引的未来安排本身则沿plan＋reported／原完整期间，日期无法核实时留null，不强迫report、不升级asserted，不拼接两个阶段的标签与日期。直接未来安排仍plan＋asserted；历史邀约、真实转述及未知人物边界保留。source-only发现不证明任何模型内部因果，未编辑119候选／旧oracle或Gold21。

准确两常量赋值之外的AST与before完整相同，本叶没有修改这两个模块的schema、parser、runtime和factory，未增加字段、确定性日期兜底、caseID／答案特判或采纳策略。E从`f5d5fa1a6f005f69a3e19b98332d5c1138723a27f8661ac015ed03a80b0b7ef9`经首叶`0fc8caba8fa934a8a503e8b686a71f1190160bac739f2b77e38d28f1ef77b652`变为最终`70c9860c93c35d44e0df97e95820cb51602229c667ab03333c8e52f6c13cd562`；V从`adfe2bc79254fdd4ca07252b6ae5f0a82e6b6cdb4c5bd0d5573d688cceae16df`经首叶`2261ee6d2eb963f556349bd4992fa13693598be9be32cbca38d4e6238a2cd37c`变为最终`8fcdeb73f6cf35fb94e151f9f88d4fc8850581766fb3c493bb7fa3fc30fe7ef4`。共同60源在两次最小测试各自前后均无漂移，但这不冻结其他Agent之后的原03实现。

Conda `NotAlone`首叶复用原八模块：E/V适配器、既有核验提示契约、Flow、语用、采纳、维度及ECNU受控SDK integration；旧114在此前全140接口片新增5方法后，本次实际 **119/119／0skip／0fail/error**，验证入口单调 **17.235463417秒**，exit0；首叶两源码mypy exit0／6.347361541秒。转引未来增量只重跑受影响的E/V适配器和既有核验提示契约三模块，最终 **22/22／0skip／0fail/error**，入口单调 **2.016620709秒**、exit0；最终两源码`mypy --follow-imports=silent` **exit0／1.468278167秒**。原03的Flow／models／dimension／adoption实现尚另轨推进，最终22绿不冒当前完整119全量重验。两次socket／DNS、HTTPX及HTTPX2真实transport、根`.env`读取守卫均0触发；dotenv依赖本环境不存在，未调用或安装。没有新增只镜像提示文字的测试，这些绿只证明既有结构、来源接线与门继续工作，不能证明新提示真实语义生效。

私有验证入口的两次失败保留：首次多导入本环境没有的非必要dotenv，未进入unittest；第二次绝对脚本路径缺backend根，8个loader错误均为找不到tests模块，未进入产品测试。仅修仓库外验证入口，第三次才得到上面的119绿，未重跑已通过的mypy、删除失败或将工具失败写成模型red。真实语义red仍是原run实际结果。本叶新增HTTP／预算注册／App／UI／业务库操作均0，累计59个旧真实请求及其closed记录不变，秘密与真实聊天未读取或提交。

公开跨例控制的正负边界保留：已完成普通动作不变未来或当前状态；正在持续状态不变历史双null；本人参与接收不因有亲友一概report，而纯第三方参与不归本人；直接表达未来安排与明确转引他人说法区分；未知身份不猜角色，历史来源日不充当事件生效起点。这里只核对现行来源规则，不生成新模型响应或凭输出填写答案。

私有证据根 `/private/tmp/notalone-memory-goal-20261013-ac04d687/complete21-branch-priority-repair/`（0700、证据文件0600）：两源码before／after及increment前后、`source-projection.json`首叶（SHA `6e49f20b71de844dee3eb6c5672f09c3dc0d6354106c22d979e6a0ccc2a84468`）与`source-projection-v2.json`、四个验证入口与首失败metadata、`minimal-tests.txt/status.json`第二次8个loader错误、`minimal-tests-v3.txt/status.json`首叶119绿、`minimal-tests-v4.txt/status.json`最终22绿、两版mypy记录、`quoted-future-increment-v2.patch`（SHA `ede933eeba96063c0acdd6b47e9329d554be99d50304ef1c711fabde426d1bfe`）与`full-source-fixed-v2.patch`。获批patch及初提案、原模型失败、原A08 missing-review钟与终态均在上一级保留。旧两轴0只覆盖首叶SHA，最终增量两轴及Root任务独立本地提交另核。

Root原则批准另增fresh cap8工程分配（总530），但注册／HTTP尚未授权：拟固定原位置(4,5,6,7)的A05–A08、4窗／5必需，SDK300／0、raw/full600、最多2小时绝对期限与每HTTP1845秒起发余量。只有旧正式A05–A07可作非盲历史对照，A08旧fullunknown不能伪paired，A04原失败保留；本小控制不签≥15／完整21／140或整体质量。全部旧closed_unused、退休12、专属full280不借，具体freshUUID、共同当前源码、固定时窗及持久真实HTTP计数仍需预注册／两轴／Root终冻，禁止自动后继。

[ADR-033](../../architecture/adr/033-source-semantic-verification-before-adoption.md)的来源核验只降不升与[ADR-036](../../architecture/adr/036-per-dimension-adoption-release.md)的质量门、默认空放行及逐类批准保持；新运行时字段授权由原03另轨实施，不因此放行任何维度。原票各自State及未满足验收、核心旧严格／可选成绩、119待独审参考和原难例不变。
