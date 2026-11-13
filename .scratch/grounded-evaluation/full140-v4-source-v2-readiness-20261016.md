# 完整140窗：v4与来源保真v2的固定评测准备

Triage: ready-for-agent
State: resolved

日期：2026-10-16。本规格只交付固定入口与离线验证，完成后由主Agent另行生成一次实际冻结并唯一启动。沿用用户对必要、有界、公开合成DeepSeek验证的授权，不使用ECNU，不重复启用已关闭的预算。当前没有创建新真实预算、读取凭据或发送请求。

## 问题与完成范围

[main16结果](v3-main16-result-20261016.md)在第11窗因V没有具名工具返回而停止；原22/32预算已关闭。A05原参考又把已知出借者当作车主，其完整／安全认证已撤回。该场不能补算成完整通过，也不能沿用旧参考签名评价新协议。

后继固定使用完整公开140原输入、138个必需命题及A15的1个可选命题；窗口、映射、156分支、162来源选择不变。读取[来源保真v2](reference-source-fidelity-v2-spec-20261016.md)的实际独审版；只修A05及直接相关通则／版本来源，不重算旧运行。提取协议为已经独审的[初版v4](../grounded-v4-protocol-readiness/spec.md)及[物品归属修订](../grounded-v4-object-ownership/spec.md)，包括四个封闭kind扩展、完整日历下月和七码歧义说明。给定标签或Mock通过不证明模型质量。

## Implementation Decisions

### 固定入口与资格

新增唯一 `execution_plan=full140-grounded-v4-source-v2`。必须同时满足 `case_set=full140`、`case_positions=None`（不能任意子集）、`reference_version=source-fidelity-v2`、`extraction_mode=grounded-v4`、`verification_mode=nullable-proof-v1`、`provider_profile=deepseek-flash-max`、`request_limit=280`、HTTPX 300秒、`max_retries=0`及专属自有worker墙钟控制。任何混版、错误类型、缺少必需字段或旧计划带v4／新参考，在预算、凭据、审核或传输前拒绝。生产factory继续grounded-v2；旧计划、旧四槽、原21与子集、ECNU守卫保持。

E/V均只省略 `tool_choice` 字段，保留实际工具schema和严格唯一具名工具返回校验。模型请求及响应必须为 `deepseek-flash`，唯一官方端点 `https://api.deepseek.com/chat/completions`，thinking开启、reasoning_effort=max；不跟重定向、不继承代理、不fallback、不额外探测。不解析普通content中的XML，不修复／重试缺工具或非法响应。

官方API在省略tool_choice时默认auto，允许普通message；这不保证满足本地必需工具合同。上一场已核实原message缺tool_calls，未发现SDK漏读或已知不兼容，内部原因仍未知。因此本场继续严格检验实际具名工具，不能把HTTP200或普通文本当结构成功，也不借此声称供应商违反HTTP协议。[官方接口说明](https://api-docs.deepseek.com/api/create-chat-completion/)。

新参考先接受独立Standards／Spec语义及结构审查，再由主Agent明确记录真实审核来源、日期和范围，更新固定规范／文件／中文摘要及full140的parent21绑定。不能提前标passed或临时伪造已审视图。版本验证器可识别明确的待审材料，但 `execution_ready=false` 必须阻断真实入口；本计划仅接受固定已审装配及 `execution_ready=true`。纯结构函数不授资格；原packet入口的已审门与原评分不变。旧参考、中文判据及历史成绩原件不改。

`EvaluationExtractionMode`显式接v4合同／工具名／runtime，records与offline实际程序追踪接同版本。新config绑定execution_plan与reference_version；缺省旧合同保持，新增字段必须成对、精确匹配。PhasedEvaluationAudit显式选同一参考版本，与入口、config、参考规范摘要和逐窗合同交叉核对。执行的140位置与Gold存储位置沿 `full_case_reference_positions()` 映射，不能把该映射替换为 `range(140)`；原21投影仍按同版本parent作用域评分。

### 准备、领取与收尾

新增固定fixture `desktop/tests/fixtures/full140-v4-public.py`，接口沿现有 `prepare/validate/verify_claim/worker/launch`。复用现有Budget、SDK、显式raw/full审核桥、owned进程组与最薄专属deadline，不预建通用编排或后台自动任务。

实际freeze精确绑定：新UUID／nonce、绝对带时区时窗、140个原输入和实际执行顺序、Gold位置选择、逐窗实际E提示／动态schema、V提示／schema、源码闭包、四份新参考材料、安装版本、本规格及已审协议规格。校验实际字节和精确集合；每次请求前继续检查冻结漂移。实际审核桥及凭据加载适配仍来自当前端侧的已审ignored helper，须把这两个实际文件纳入freeze；这是一份当前本机验收fixture，不承诺干净checkout可直接运行，也不把helper或本机身份／凭据路径复制进公开源码。prepare不访问home、registry或key；仅实际成功领取后，worker复核fresh claim再读取一次已有显式官方凭据。

外层绝对86400秒（24小时），工作86380秒，留20秒收尾。prepare到launch消耗同一绝对窗口；完成即退出，不等满。E/V调用及raw/full各绝对600秒，受整批更早截止。`140×4×600=336000`秒，即93小时20分钟，因此24小时是明确硬上界，**不保证最坏情况下完成140窗**。到期如实保留unknown／unrun，不延时、不自动启动下一场。

每窗E、V各至多一次；空E不调用V，失败和远端未知占预约、不退款。一般语义错误保留后按原顺序继续；safety、语义unknown、技术／结构／供应商／冻结／记录错误立即停批。raw由只读原E的独立审查者完成，Root只承担full，不让同一审核者先看V再补签raw。每阶段独立封存，不能重写旧审核。

仅关闭本场预算并fsync收据后退出自有worker；关闭失败保持close_unknown。外层只回收自己start_new_session且已记录的进程组，核对leader和后代均gone，不终止未知PID。正常result预算收据核本场run／cap／预约数，来源依同run私有目录及自有spawn，不声称该预算收据有独立PID签名；deadline收据另严格核实际worker_pid，错误或不完整的对应凭据不当作closed。fallback读取event日志必须覆盖末窗；发现超出所支持事件边界时保守unknown，不能因截断前缀把已开始窗标unrun。最终保留140／138分母，未用余额永久关闭，无自动后继。

## Testing Decisions

按TDD逐个垂直切片，最小红绿后运行完整相关组：

- 正确新合同经实际SDK的精确MockTransport跑固定完整140；核对末窗、Gold映射、同版本parent、零候选免V、最多280请求和281拒绝、失败不退款。Mock只证明集成，不签语义或质量。
- 旧计划混v4／v2参考、待审／伪造passed、错误路径／摘要／parent、错误输入与位置、bool／float冒充固定整数，在领取／凭据／审核／网络前拒绝。旧入口及生产v2回归保留。
- 每次实际工具schema、模型／端点／thinking／省略tool_choice的wire合同；普通content、工具缺失／重名、错模型、额外重试、源码／Gold／提示漂移保持原失败安全。
- 专属600秒调用／审核及更早整批截止，先close再退；close失败unknown、自有进程组后代回收、异run／cap／PID收据拒绝、末窗事件与超过扫描边界的保守状态。
- 使用临时home与合成预算、无真实socket／凭据／模型／PG／GUI；禁dotenv，Conda NotAlone，隔离工作树显式PYTHONPATH。完成类型检查、diff检查及独立Standards／Spec后才由主Agent生成新真实冻结。

## Out of Scope

不改变来源事实、旧参考／旧审核／成绩、0.7阈值、A08置信度、风险／语用门、维度合取或默认空放行表。不扩大typed proof的来源可信前提或包装语法；相关[决策稿B](typed-proof-representation-decision-20261016.md)仍待用户决定。不写业务库、不上传真实聊天、不操作App／微信、不发送外部消息，不声称A15可选双候选缺口已解决。

真实结果分别报告计划／完成／unknown／unrun、模型labels、E14十四字段、raw／程序接受／full、V与typed UNKNOWN、auto／pending及原matcher。至少15窗质量门不能靠命题数、跨场拼接、pending安全或离线Mock替代；完整140运行通过也不等于真实泛化或逐类放行。

## 实际验证与审查

参考与协议装配已在[独立记录](full140-v4-reference-integration-20261016.md)完成：初审两轴各1项位置类型问题经真红／绿修复，111项相关回归通过，增审剩余0。[固定控制记录](full140-v4-control-implementation-20261016.md)包含103项相关控制、29项新旧runner与8文件类型检查；完整140 SDK Mock为140E＋138V，共278次，末窗完成且cap280预算关闭，只证明合成集成。

Root整合回归实际unit500／500、集成112／112通过；这两组与前述103／111等重叠，不重复累加。控制记录初审两轴各1项冻结检查范围的过述已据实际实现收窄，增审均剩余0。当前精确闭包85份，含端侧两个helper及参考装配记录，缺失0。生产默认、typed证明范围及默认空表保持；尚无实际模型结果。

## Answer

固定入口与离线准备完成，主Agent后续按现有授权独立核对实际冻结、旧预算关闭和新授权绑定，再唯一启动。resolved不是140真实运行完成、至少15窗质量通过或原三张记忆任务完成；没有以部分场、Mock、pending安全或材料资格代签质量。
