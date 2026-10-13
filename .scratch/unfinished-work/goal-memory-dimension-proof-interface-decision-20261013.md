# 原03：同一次V证明协议与受限语义合同决策草案

状态：**待用户架构批准，尚未实现或激活**。本片只准备一份公共可审合同，代码／项目测试／PG／模型HTTP／App／Git均为0，以下正负控全部为`planned_not_run`。已有可空JSONB、来源绑定和相关维度AND门的批准继续有效，不重复请求；本次新决定仅为同一次V的扩展协议、可独立验证的窄语义规则及其持久版本。[原03](../memory-accuracy-next/issues/03-per-dimension-rollout.md)、[已采纳字段合同ADR-046](../../architecture/adr/046-source-bound-dimension-evidence.md)

## 建议一次批准的具体范围

| 决定 | 建议批准的合同 | 保留的边界 |
| --- | --- | --- |
| D1 | 在现有一次V调用中采用`nullable-proof-v1`：原四槽加唯一可空、带版本的`proof`提案；原V4继续独立校验 | 不增第二调用、供应商或联网fallback；只允许新增proof缺键／null为UNKNOWN，原V4四槽仍必填且拒绝null；非法proof停止，不改E14和原评分答案 |
| D2 | 本地按参数化句法及受控词元分别解析外层行动角色与代词指称；未名“她／他”只在来源正文有明确、唯一指称句时生成归属依据 | 禁止整句／case答案白名单；把字句的施事、请求提出者、单target或性别一致都不证明车主／受益人同一；原两句的未名代词保持UNKNOWN，复杂引用／多目标／超规则均UNKNOWN |
| D3 | 在同一JSONB列新增显式version2语义依据：持久原子命题、否定／数量／条件／程度／时间的归属关系与摘要；只批准有限等价改写 | v1／NULL兼容、不回填旧候选；须新增前向约束迁移及隔离回归，业务库DDL仍另批；字符覆盖或模型自称完整不能认证非字面保真 |

三项组成同一最小可交付切片。若只实现D1装配而D2／D3还未过实际producer正负控，应报告“协议接线、语义UNKNOWN”，不勾原03四类生产依据完成。不让用户补技术语法；建议范围及拒绝条件在下文已定，Root可据本稿集中请求批准或拒绝该切片。

## 现有Interface与缺口

现[V4校验器](../../backend/src/notalone/memory_extraction/verification.py)98行仅接受每结果四键，173–199行核同窗口原来源及实际逐字片段；224–235行要求supported含目标消息。[V适配器](../../backend/src/notalone/memory_extraction/verification_adapters.py)保持一次调用，候选投影为既有11槽，未接收证明对象。原四槽是`candidate_index/verdict/issues/evidence`，不是四类维度已被证明。

[生产装配器](../../backend/src/notalone/memory_extraction/evidence.py)51–77行仅在quote、完整source.text和fact.text三者逐字相同才生成保真对齐；reference／reported恒None，media取actual窗口。[维度判断](../../backend/src/notalone/memory_extraction/dimensions.py)107–125行的5–7项是保守超集；175–201行的目标数量／标签条件不能单独证明唯一人物或内外归属。新接缝不能先把模型选的锚喂到这些条件，就称生产指代／转述有效。

[持久值对象](../../backend/src/notalone/memory/dimension_evidence.py)328–453行只支持version1／十键；[056约束](../../backend/database/migrations/056_memory_candidate_dimension_evidence.sql)12行只允许version1。因此D3确实需要新DTO合同和前向迁移，不是“JSONB任意加key、无DDL”。与ADR-046的“版本1及E14／V4保持”约束需显式复审：原03尚缺真实生产指代、转述及非字面保真依据，现结构不能表达其限定关系。本文不覆写ADR或056。[ADR-033](../../architecture/adr/033-source-semantic-verification-before-adoption.md)的一次核验、同来源、只降不升及不认证现实真伪继续有效。

## D1：同一次V的有界可空提案

保留明确的`legacy-v4`入口；新入口选择`nullable-proof-v1`和固定工具schema，旧四槽的字段／覆盖／verdict／issues／quote仍按原函数校验。新结果只多允许`proof`一键；**仅新增proof可以缺键或为JSON null**，不触发协议重试。`candidate_index/verdict/issues/evidence`四槽缺任何一键或置null仍是非法输出；证据条目中的`message_id/quote`也保持原必填、类型与非空规则。先严格解析新envelope和proof，再把原四槽投影给旧校验器；不能先丢掉非法proof、仅靠合法supported继续。合法空数组仍按原verdict条件处理，不等于允许原槽为null。

proof固定为`{version, atom_links, reference, reported}`，version为builtin整数1，后三项为可空数组。每候选总链接≤32：atom_links≤16、reference≤8、reported≤8；每个数组对象使用固定字段，未知键／版本／布尔索引／浮点位置／超上限一律非法。模型不提交hash、owner／contact、sender、source_bound、媒体类型、processed、完整性或唯一性布尔。

- `atom_link={rule_id, variant_id, source, candidate}`：source为`{message_id,start,end}`，candidate为`{start,end}`；rule_id／variant_id仅限D2的组合表，不接受模型新增词元／变体。
- `reference={rule_id, mention, target, binding}`：mention、target为该原来源消息上的SourceSpan；binding为SourceSpan或null。SOURCE_IDENTITY_H1中mention指正文中的代词用法，target指来源指称句里明示的角色短语，非null binding覆盖完整指称句；仅直接作者“我”允许binding=null，此时target与mention为同一个实际“我”Span，以受控sender核作者，不拿它处理第三方代词。这只是位置提案；服务端从全文核对三项关系、全部角色和其他可见指称，不相信目标个数。没有来源指称句不能用模型选定的target替代binding。
- `reported={rule_id, frame, source, candidate}`：frame仅direct／quoted_request_h／received_request_h，source和candidate分别为来源／候选Span；说话人和内层主体由规则计算，不从模型标签生成。

位置采用Python Unicode码点半开区间，严格`0≤start<end≤实际字符串长度`，builtin int且拒bool；不混用UTF-8字节／JS UTF-16，也不以find首命中消歧。消息UUID必须同时在完整当前窗口及fact.source_message_ids内；模型不能补来源。服务器从RAM文本计算实际片段摘要，quote仍遵守原V4，不把它复制进JSONB。

新增proof缺键／null，或proof内某个可空数组为null／空数组，只表示相应新增语义依据UNKNOWN；非null proof必须四键齐全，缺内部键非法。**原V4四槽缺／null不适用这条兼容规则**。现有v1全篇逐字与actual media路径保持原合同，不据此补reference／reported。格式或范围非法沿既有非法输出路径停止当前批；来源或候选超出下文全部可核语法时UNKNOWN，相关维度AND门保持pending。候选落在本地校验语法时，明示角色／方向／限定的图差异，或可穷尽来源没有支持的新增接受／义务／执行节点，按明确判据只降到unsupported／拒绝候选；这里表示完整来源支持合同未满足，不宣称现实一定虚假。未名代词缺指称句属于证据不足，不证明另一归属一定错误，不能套新增节点判据拒绝未解槽。proof缺失不能产生有效新依据，但不阻止同一实际来源／候选独立可核的降级；新增负向语法不增模型proof规则或持久正例资格。保留模型原四槽及程序降级原因，不能升级uncertain为supported或改写候选。原始模型E14／V4评分视图分别保留，proof另作元数据，不能清掉模型错误后签质量通过。

## D2：参数化完整句法与独立词元表

所有规则仅处理**完整窗口恰一个目标、没有其他文本上下文，且全部候选来源就是该消息**；message sender必须为受控self或contact，actual纯文字表示／活动来源指纹完整。模型选少一个目标或摘掉上下文不能满足此条件。首尾空白可以保留并单独定位；句末仅允许一个可选`。`，内部分隔只能使用下列产生式指定的`。／，／；／“／”`，不做姓名、全文Unicode或语义模糊归一。来源全文必须由来源产生式穷尽；候选全文可由正例或仅用于本地核验的候选校验产生式穷尽，继而比较完整图。两者中任一超出相应全部语法才是UNKNOWN，不能因候选不等于正例输出形态就漏掉已定义的错误判据。

**Implementation不得保存或比较完整来源句／候选句的许可集合，不读case ID、Gold、昵称或评测答案。** 先由词元表识别局部词项，再由产生式组合作者、关系角色、物件、阶段和限定；示例句只作为测试输入，不能成为匹配分支。每个组合须走同一词元／语法／图比较路径；修改一个词元不能跳到另一份整句答案。这继续遵守[原准确率spec](../memory-extraction-accuracy/spec.md)第33／42条，不请求整句白名单例外，也不把有限语法控制缩成原07、核心01或原03的完成目标。

| 参数／词元 | 初始封闭值及规范意义 | 禁止推断 |
| --- | --- | --- |
| A／Author | 来源词元`我`；候选由actual sender映射为`用户`（self）或`联系人`（contact） | 昵称、引用内我及model subject不能绑定作者 |
| R／RelatedRole | `我姐／我哥／我同事`分别为作者的elder_sister／elder_brother／colleague；Kin仅前两者 | 不补姓名或现实身份；不靠性别把Pronoun归给R |
| Pronoun | `她／他` | 只记录代词使用，归属另由来源指称句证明 |
| Object | `车／书／雨伞`分别为vehicle／book／umbrella | 物件词不证明property_owner |
| Recency | `刚／刚刚`都规范为just；仅修饰arrive_home完成阶段 | 不生成绝对到家时间或持续到当前的状态 |
| PastTime | `昨天／前天`，相对实际来源观察时点的事件叙述限定 | 不把事件日改为资料生效日或补未知时区 |
| RequestTime／PlanTime | `周末／明天／后天`；plan只取明天／后天 | 请托内容时间不移到接收动作上；周末不猜绝对起止 |
| Weather／Activity | Weather初始仅`天晴`→clear_weather；Activity初始仅`跑`→run | 条件未被证明成立；不得引入其他活动同义词 |
| Number／Unit | Number为ASCII十进制`[1-9][0-9]{0,5}`或该整数后接1–3位小数，精确值须≤100000；Unit仅`公里／米` | 不接受负数、指数、逗号、w、倍数或model给的数值；Decimal精确换为米 |
| Only／Approx | 各为可选`只`／`约`，存在时分别为only／approx并限定distance quantity | 缺词就是缺限定，不靠同义词或字符覆盖补齐 |

下列是**产生式**而非完整句白名单。`[X]`表示可选，`{X}`表示读到的词元参数；每个必需词元及标点都保留实际Span。候选作者词元只取`用户／联系人`，关系词元只取这两种前缀下的`姐姐／哥哥／同事`，指回关系词元只取`该姐姐／该哥哥／该同事`。源／候选各自独立解析后，源actual sender的规范作者须等于候选AR，源R的kind须等于候选RR／ThatR；不能用源期待词直接匹配候选，遇姐姐改哥哥便判规则外UNKNOWN。候选改成另一个合法角色仍须走同一语法并发现图矛盾，不能从model的角色文字反推或修改源R。合法前缀转换之外的同义词UNKNOWN。

下表的rule_id／variant_id只定义**模型可提案且可能产生正例依据**的规则，合法提案仍须通过本地语义复核。下一节候选校验语法是同一Implementation的内部负向解析能力，没有模型可提交的rule_id／variant_id，不新增永久predicate／phase或有效维度类别。

| rule_id／variant_id | 来源产生式 | 候选产生式及独立核验 |
| --- | --- | --- |
| AUTHOR_ARRIVAL_H1／direct_h | `我{Recency}到家[。]` | `{AR}{Recency}到家[。]`；实际sender作者自指、just、arrive_home及completed一致，H双null，不造日期 |
| KIN_LEND_BA_H1／completed_h | `{Kin}[{PastTime}]把{Pronoun}的{Object}借给我了[。{Identity}][。]` | `{CP_agent}[{PastTime}]把{OwnedObject}借给了{CP_recipient}[。]`；CP／OwnedObject按下文独立解析，只有agent=源Kin、recipient=源作者、物件kind／完成阶段对应且owner有Identity证明才可签正例；自己的与明确同角色owner均可对应，不靠固定RR位置判对 |
| KIN_LEND_BA_H1／negative_h | `{Kin}{PastTime}{Negation}把{Pronoun}的{Object}借给我[。{Identity}][。]`，Negation仅没／没有 | `{CP_agent}[{PastTime}]没有把{OwnedObject}借给{CP_recipient}[。]`；只有两端已知角色及Identity证明的owner、polarity=false和完整源PastTime对应才可签正例，H双null；候选缺／变time或变完成仍按独立图差异拒绝 |
| REQUEST_ROLE_H1／quoted_request_h | `{R}让我{RequestTime}帮{Pronoun}顶个班[。{Identity}][。]`，本切片author仅self | `{RR}已提出请托，内容是希望用户{RequestTime}替{ThatR}顶班，未说明接受[。]`；request主体=R、recipient=作者，内层cover_shift主体=作者；beneficiary独立经Identity得到R，report／reported／relationship_note／H双null |
| REQUEST_ROLE_H1／received_request_h | 同一请求产生式与实际self作者 | `用户已收到{RR}请托；所请内容为用户{RequestTime}替{ThatR}顶班，未说明接受[。]`；主命题receive_request为历史接收，assertion／asserted／relationship_note／H双null；接收不等答应／义务，内层角色和时间独立完整 |
| SOURCE_IDENTITY_H1／explicit_role_identity | Identity仅`这里的“{Pronoun}”指{R}`，R须为同一行动句已经引入的那个角色 | 不是新增候选主张；mention定位行动句代词用法，target定位本指称句R，binding覆盖完整Identity。全文恰一代词用法及一身份句、两者参数逐词一致才能认证局部角色同一 |
| COND_PLAN_RUN_V1／conditional_plan | `如果{Weather}，我计划{PlanTime}{Only}跑{Approx}{Number}{Unit}[。]` | `如果{Weather}，{AR}计划{PlanTime}{Only}跑{Approx}{Number}{Unit}[。]`；Number／Unit可按精确米值等价转换；计划、条件、时间、only／approx均独立比较，仍pending |

### 仅用于本地核验的参数化候选语法

本节让错误候选也能被**同一词元／图解析器**识别；不引入整句反例表或case ID分支。CandidatePerson（CP）只取上面的`用户／联系人`以及这两种前缀下的`姐姐／哥哥／同事`；每一人槽独立读取，规范键为`{base_sender:self|contact, relation_kind:author|elder_sister|elder_brother|colleague}`。例如来源作者contact的我姐对应`{contact,elder_sister}`，候选用户对应`{self,author}`，不因其位置在recipient就偷改成源作者。CP仅作候选文本里的主张对象，实际来源角色仍从actual sender与来源R计算。指回词`该姐姐／该哥哥／该同事`只可回指本候选前文已引入、kind一致且唯一的关系角色，否则UNKNOWN，不能从源期待角色补候选指称。

| 校验族（内部名称，不是proof规则） | 完整候选产生式／独立词元 | 从可核来源导出的判据 |
| --- | --- | --- |
| lend_candidate | `{CP_agent}[{PastTime}]{LendClause}[。]`；正向LendClause=`把{OwnedObject}借给了{CP_recipient}`，负向=`没有把{OwnedObject}借给{CP_recipient}`；OwnedObject仅`自己的{Object}`或`{CP_owner}的{Object}` | agent／recipient／object分别解析；自己的绑定**候选agent**，明确CP_owner另解析。源lend这些已明示槽、polarity及PastTime必须逐项对应：交换两端、改物件、反转否定、删／变时间是已知图差异→unsupported。源Identity已解时owner改成另一CP才是归属矛盾；源owner未解时不得据施事、recipient或另一猜测判owner矛盾，该槽及完整相关依据UNKNOWN |
| request_candidate | quoted=`{CP_requester}已提出请托，内容是希望{CP_actor}[{RequestTime_inner}]替{CP_beneficiary}顶班，未说明接受[。]`；received=`{CP_recipient}[{RequestTime_outer}]已收到{CP_requester}请托；所请内容为{CP_actor}[{RequestTime_inner}]替{CP_beneficiary}顶班，未说明接受[。]`；这里CP_beneficiary还可取已在本候选唯一引入的ThatR | 内外角色各自解析。原request的时间仅附cover_shift.requested_time；加到receive_request、删内层时间或替为另一合法时间是所请内容限定挪位／丢失→unsupported。beneficiary只有源Identity已解时才能判角色差异；未知时保留UNKNOWN。两种H主命题仍分别核正文与原语用标签，不能靠改frame或E标签互换 |
| unsupported_commitment_candidate | 接受=`{CP_actor}{AcceptToken}[{RequestTime}]替{CP_beneficiary}顶班[。]`，AcceptToken仅答应／已答应；义务=`{CP_actor}有义务[{RequestTime}]替{CP_beneficiary}顶班[。]`；执行=`{CP_actor}{ExecutionToken}[{RequestTime}]替{CP_beneficiary}顶班[了][。]`或`{CP_actor}{ExecutionToken}顶班[了][。]`，ExecutionToken仅已／已经 | 答应／已答应、有义务、已／已经是独立局部词元，分别生成仅RAM诊断的accept_request、obligation或cover_shift.completed节点。可穷尽的源REQUEST_ROLE只提供已提出／收到及cover_shift.requested，未说明接受；没有这些新增节点的来源支持，故unsupported_addition／stage_change→拒绝。**不推导已拒绝、无义务或现实未执行**，不为诊断节点新增持久正例规则；proof引用既有request规则也不能使这些节点有效 |
| run_candidate | `[{IfClause}]{CP_actor}{ValidationPhase}[{PlanTime}]{Only}跑{Approx}{Distance}[了][。]`；IfClause仅`如果{Weather}，`；ValidationPhase仅计划／已／已经／肯定／空；Distance为Number＋Unit、仅Number、仅Unit或空 | 独立读取条件是否在、phase及time/only/approx/quantity/unit。源COND完整明确的条件／计划阶段／时间／限定及量不能丢、改或移：没有IfClause、漏Only/Approx、缺量／单位、漏时间或数值不等均为已知完整图差异→unsupported。已／已经生成仅RAM phase_completed，肯定生成仅RAM certainty，空phase记missing_plan，均不从源有条件计划推出，不能经模型proof生成有效依据。可选了只用于识别完成扩写，计划＋了的冲突也拒绝 |

上述校验语法的可选槽用于**检测候选遗漏或新增**，不放宽来源语法或正例依据。缺quantity或unit形成内部`missing_quantity／missing_unit`标记，不能用另一端数值补齐；本地诊断图可出现accept_request／obligation／phase_completed／certainty／missing槽，均不得装成D3的有效semantic_basis或扩展其持久枚举。只有来源和候选均落正例产生式、全部节点／角色／限定对应且unresolved为空，才能进一步考虑server依据；任何已核错误只能降级，不通过删掉错误节点恢复候选。

判定顺序明确为：范围和原V4／proof结构校验→实际源全文及候选全文各自解析→比较**已知**节点／槽并记录拒绝原因→若无已知错误而仍有未解槽，则UNKNOWN→只有全部正例关系完整才装配v2。source Identity缺失时，property_owner／beneficiary这个既有槽的任一猜测仍UNKNOWN，不以“源没有该owner节点”套unsupported_addition；其他独立已知的方向、时间或阶段错误仍可降级。源不匹配、候选含新名字／未定义同义词／新句式、多上下文或歧义超规则时走UNKNOWN；本节不承诺拒绝任何未被完整解析的自然语言。本地UNKNOWN只说明新增依据及本地核验未能证明，不覆写更严格的原V4 unsupported／uncertain，不因新解析器未知而升级模型原裁决。

Identity必须由同一受控sender写在活动来源中，不能来自模型解释、候选、自造上下文或未确认手工标签。其他指称句、同词多处代词使用、多个R、冲突或嵌套引用均UNKNOWN；不存在Identity时可解析行动角色，但property_owner／beneficiary登记unresolved，不用把字句施事、请托者或性别代填。SOURCE_IDENTITY_H1只认证所见文本局部同一关系，不认证现实产权、人物身份或请托确已发生。纯作者自指使用actual_sender；请求／借物中的“我”也要各自核actual sender，不能凭已解第三方角色省略作者复核。

这是有限、可组合的语法能力，不是汉语通用指代／转述解析器；只识别上述完整顶班请托，不泛化所有“让”为请求、许可或接受。**原A05“我姐把她的车借给我了”与R105“我同事让我周末帮他顶个班”均没有本合同所需的来源指称句**：可核姐姐为出借行动施事、同事为请托提出者及作者为接收／行动角色，但不能认证姐姐为车主或同事为受益人。未解角色进入`unresolved`，reference及依赖该角色的完整paraphrase／reported依据保持UNKNOWN；保留代词原字也不等于消歧。原R105两种H框架合同、Gold／旧pending／ideal-auto和原E72示例竞争均保留原文与原成绩，不加句、不替答案、不补签。新增Identity只用于独立合成协议控制，不计原窗通过或全量质量收益。[三窗合同记录](continuous-goal-20261013.md)

程序分别从源全文和候选全文生成完整角色图；同一个原子命题所有参与者、谓词、归属、限定和阶段须对应，不能跨两个变体挑字段。纯转引的report／reported与接收经历的assertion／asserted保持各自完整正文；接受／义务／执行只有落入上述完整候选校验语法才可按新增节点或阶段错误拒绝，不得成为有效依据；其他未识别说法UNKNOWN。一般第三方未来计划、多层引用、他／她有多个可见目标、shared或来源sender未知均UNKNOWN，不借此修正其他语用合同。

reference依据须同时有独立作者自指核验，或SOURCE_IDENTITY_H1的提及／目标／指称句三锚及全角色对应；reported依据须保存“主命题究竟是历史收到，还是转引的请求内容”的frame，并核查该主张全部内外角色。直接作者句则核direct关系。两者都不能因无歧义布尔、模型direct/reported或当前目标数量符合v1条件就有效；v2判定额外要求本地rule_id、规则版本及角色图复查，现有v1数量检查不承担此新证明。局部已解析角色可以作为诊断保留，不能通过只存已知项隐去unresolved，或签整项维度有效。

## D3：真正非字面保真的持久关系

建议只批准D2产生式的有限等价变换：作者“我”到受控用户／联系人角色、具有明确来源指称依据的把字句及请托H完整角色关系、距离数值单位换算和限定完整保留。未名“她／他”到“自己／该同事／其”的替换不在无证据许可内。其余同义词、缩写、程度释义、多句摘要及无法整体识别的表达UNKNOWN，模型给的atom_link不证明其完整。

`COND_PLAN_RUN_V1`按D2参数组合解析，不保存“3公里→3000米”等答案表；任一合法Number都用同一Decimal尺度换为米，例如新组合7.5公里与7500米。候选必须保留两端各自存在的Only／Approx、PlanTime和Weather条件，不能写为已跑／肯定跑或条件已成立。语用仍是有条件计划；本合同不扩到金额或含糊数量。规则及词元表先于新增组合控制冻结，控制不反向生成Implementation分支。

本地解析器必须穷尽被批准完整句的原子命题及限定，并比较两端规范图：

- 原子命题：受控predicate、agent／recipient／object／owner等局部角色及H／计划阶段；不把接收请求与未来执行同一化。
- 否定：归属到哪一命题、正负方向；“未说明接受”的UNKNOWN与明确拒绝不同，不能通过遗漏否定签完整。
- 数量／程度：精确量及单位、约／只等限定分别绑定对应槽；没有程度、单位或范围关系时不接受字符覆盖代替。
- 条件：`requires`边绑定条件和行动；不把条件或假设为true，不把其时间偷给别的动作。
- 时间：主动作时间／所请内容时间／来源观察时点分别存role；按已有时间政策绑定，H不能因观察日期或TTL变正在成立。源中未定日期仍null，不替旧Gold修答案。

**存储建议：dimension_evidence.version=2，原十键语义保留，唯一新增semantic_basis。** 顶层严格十一键：`version/scope/candidate_sha256/window_sha256/pragmatics/messages/paraphrase/reference/media/reported/semantic_basis`；原十键必填性及类型不放宽，version取builtin整数2，semantic_basis必填但可为JSON null。它只能由server核实际来源及候选全文后生成，不能把模型proof直接写入。

非null semantic_basis固定为`{version, rule_set_sha256, rules, roles, atoms, qualifiers, reference_bindings, frame, unresolved, source_graph_sha256, candidate_graph_sha256}`，内部version为builtin整数1，与模型proof.version=1及持久顶层version=2分别解释。建议下列固定形状及边界一并批准，未知键／版本、重复编号、越界关系或hash格式非法即拒绝；每候选rules≤8、roles≤16、atoms≤16、qualifiers≤32、reference_bindings≤8、unresolved≤32。

| 字段 | 固定条目形状／取值 | 服务端责任 |
| --- | --- | --- |
| rules | `{rule_id, rule_version}`；ID只取D2／D3名单，rule_version为builtin整数1 | 以实际执行的批准规则清单和确定序列化算法计算rule_set_sha256，不读model版号认证能力 |
| roles | `{role_id, kind, sender, source}`；role_id为0–15，kind为author／elder_sister／elder_brother／colleague／vehicle／book／umbrella，sender仅author取self／contact、其他为null；source沿v1 MessageSpan固定为`{message_id, span:{start,end,sha256}}` | 角色是消息内局部编号；只有author由受控sender绑定，不为姐姐／哥哥／同事补现实ID。物件kind不混淆scope.owner_id与产权角色；候选转换不能把elder_sister变elder_brother |
| atoms | `{atom_id, predicate, phase, roles, source, candidate}`；atom_id为0–15，predicate仅arrive_home／lend／request／receive_request／cover_shift／run／clear_weather；phase仅completed／historical／requested／planned／condition；roles固定agent／recipient／object／property_owner／beneficiary／actor六槽，值为role_id或null | source／candidate为实际字符区间及摘要；不适用槽可null，但应适用而未解的槽必须同时登记unresolved，不能以null当无关。全部source和candidate命题由全文解析，不照抄model的链接名单 |
| qualifiers | 以kind选择下文五个严格固定条目形状；各条目带唯一qualifier_id（0–31），两端Span分别用MessageSpan／TextSpan | 不把quantity挂到人物角色槽，不把degree从quantity拆走，不以value_sha256隐含尚未声明的condition边；未知kind或多／缺key非法 |
| reference_bindings | `{role_id, method, mention, target, binding}`；method仅actual_sender／source_identity，三个定位沿D1，但持久Span增加实际片段SHA | actual_sender只用于直接作者“我”，binding=null；source_identity必须有非null来源完整指称句，明确把mention映射到target角色，不能由出借施事／请托者推产权／受益人 |
| frame | direct／quoted_request_h／received_request_h | 保存整项主命题和内外阶段，不靠E标签或局部外层可核补完整关系 |
| unresolved | `{atom_id, slot, source, reason}`；reason仅missing_source_identity／ambiguous_source／unsupported_grammar | 明确保存应适用但未核清的关系；任一该关系参与候选主张时，相应reference／完整paraphrase／reported维度UNKNOWN，不能用已知角色投影签完整 |
| 两个graph摘要 | SHA256格式字符串 | 从两端完整规范图分别计算；必须带角色、谓词、全部限定和阶段，不以字符覆盖率代替。所有关系可核且规范图等价才产生完整语义依据；partial图仍留unresolved |

qualifiers的**判别式固定合同**如下；字段名完整列出，不能跨kind复制字段。source固定MessageSpan，candidate固定TextSpan=`{start,end,sha256}`；编号为builtin整数并拒bool。关系目标必须属于本候选的同一图，重复id、引用缺失、跨图、反向边或kind不符均非法／当前复核失败，不让hash补齐关系。

| kind | 唯一允许的条目形状 | 结构及语义复核 |
| --- | --- | --- |
| polarity | `{qualifier_id,kind,atom_id,slot,value_sha256,source,candidate}`；slot只能predicate | atom_id仅lend；源没／没有与候选没有映射false，附同一lend原子命题。不能挂作者角色或request／condition |
| quantity | `{qualifier_id,kind,atom_id,slot,value_sha256,source,candidate}`；slot只能distance | atom_id必须为run，distance是动作属性槽而非object角色；两端实际Number／Unit精确换米并比较规范值。范围／单位缺失UNKNOWN，不根据摘要存在判等 |
| degree | `{qualifier_id,kind,quantity_qualifier_id,modifier,value_sha256,source,candidate}`；modifier仅only／approx | quantity_qualifier_id必须指本图一个quantity.distance条目；两端Only／Approx实际词元分别核验。两种修饰可以同指同一quantity，但同modifier不重复；禁止指另一个quantity、time或自身，不能把约解释成精确 |
| condition | `{qualifier_id,kind,condition_atom_id,action_atom_id,relation,source,candidate}`；relation只能requires | condition_atom_id须clear_weather／phase=condition，action_atom_id须run／phase=planned，且两者来自同一完整COND_PLAN_RUN_V1语法树。保存方向为action requires condition，禁止交换id、条件附别的行动、用condition作completed事实或自环 |
| time | `{qualifier_id,kind,atom_id,slot,value_sha256,source,candidate}`；slot仅event_time／requested_time／observation_time | arrive_home Recency只附arrive_home.event_time且值为just，不造日期；lend PastTime只附lend.event_time；请求RequestTime只附cover_shift.requested_time，不能附receive_request；计划PlanTime只附run.event_time。初始语法没有正文观察时点词元，故不生成observation_time条目；实际来源观察时间沿messages.occurred_at元数据复核，不伪造TextSpan或给H补事件日期 |

数量规范值在RAM使用规范十进制米字符串（去无意义末尾零、不用float／指数）；degree规范值是对应modifier及其所指quantity的规范值；time规范值带其实际role及按原时间政策可证明的值。仅规范值摘要写入持久条目，保留无正文定位；condition靠显式双atom边而非秘密hash关系表达。各图在RAM按author／关系角色／物件、外层／内层动作、条件／行动及qualifier语义槽确定局部编号；规范序列化使用UTF-8、排序键、无空白JSON、禁止NaN，不含原字符位置或来源UUID以便比较语义，但持久定位独立参与当前来源复核。两个graph摘要必须涵盖全部角色kind、谓词、阶段、角色槽、quantity／degree／condition／time／polarity边及未解关系；未解非空就不能签完整，两个hash相同也不绕过全文重解析。

所有编号／位置拒bool与float，SourceSpan消息UUID属于完整当前窗口和候选来源，candidate Span属于fact.text；条目只能引用本候选的role／atom。NULL或任何未覆盖关系保持UNKNOWN；空数组不是“相关性为空”的证明。v1四类旧依据仍使用原形状；v2语义有效性额外依赖semantic_basis、同版本重解析及三锚，不能仅沿旧targets数量或reported标签条件认证新关系。

保存和确认事务从当前真实文本重新执行同版本有限规则，重算atom／限定图与摘要，并复用原scope／完整窗口／活动来源／语用快照核验；不能只查hash存在或读取此前valid=true。真实正文、三项标签、来源raw_payload指纹、源类型、时效或规则版本变化失效，UTC与+08等价瞬间仅沿原proof时间摘要兼容，原载荷字面变化不宽松。[原绑定接缝](../../backend/src/notalone/memory/evidence_binding.py)

v2若独立解析发现任何时间限定，不得因H两日期为空就把time漏出相关集合：只允许把time加入原保守超集，不移除原五必选或媒体项；无法核清事件时间／所请内容时间／资料期限角色时保持UNKNOWN和pending。时间依据不把叙述限定或请求内容改成资料生效期。

新JSONB版本需要新增前向迁移扩展版本／形状约束，原056和历史版本不改写；仅在明确批准后的隔离测试库应用。055保持NULL读取／拒新依据，056只写v1，具备新约束的schema才能写v2。v1数据维持原行为，不自动重解释成v2；旧NULL不回填、不重采纳，解析未知版本拒绝。**业务库迁移、回滚或删除没有本次自动授权。** API仍沿候选依据查看／导出，v2规则／关系和unknown原因须可查看；候选拒绝／删除及任一窗口来源失效清除新字段，残留复查涵盖v2。已采纳资料的上下文依赖删除缺口不在本稿实施范围。

## 四类生产路径与第四门

| 类别 | 实际producer应接的Interface | 不可代替的限制 |
| --- | --- | --- |
| 保真 | Flow收到真实V结果→严格提案解析→源／候选完整规则图→v2依据→存储回读复核 | 非字面只能走上面有限语义关系；v1继续全篇逐字。只quoted substring、覆盖率或model完整标签不能有效 |
| 指代 | 受控MessageRef sender＋完整源语法＋所有角色链接，复核当前candidate subject | Model target一个、昵称展示、关系人物未命名或引用内我不证明唯一；超语法UNKNOWN |
| 转述 | source frame与候选主命题同时核H接收／H纯引用，保持外层动作／内层内容及标签整体 | received不等答应／义务；report仍按原门pending，proof不能提升语用去向 |
| 媒体 | 继续只由loader的actual message_type／text_representation、活动源指纹和受控适配器结果装配 | text可沿现路径；当前image／voice的placeholder／unknown仍UNKNOWN。V不得填processed；没有实际OCR／转写来源链不宣布processed_text有效，不读／上传帧或音频 |

缺媒体作者保证时，不从OCR内“我”映射发图联系人。新增proof不查窗口、用户文件、联系人目录或新模型上下文，数据范围不扩大。数据库来源指纹复核仍不认证外部文件或微信实物真伪。[隐私边界](../../architecture/current/privacy-deletion.md)

required仍采用现有5–7保守超集；没有proof不能证明某维度无关，不能仅把有证据项加进valid集合而漏未核维度。每项必须有当前有效依据且逐类获用户批准AND；0.7、风险、语用、默认空放行表和原Gold全部保留。新schema、关系结构绿、API保存成功或V supported，都不是该维度质量达标、现实真伪认证或自动放行授权。

## 实施切片与真正生产测试接缝

建议深Module `source_proof.py`在V解析→Flow producer的Seam提供一个小Interface中的两步：`parse_proposal(raw)`只校结构；`verify_proposal(proposal, window, fact, trusted_sources)`独立全文核规则并返回server依据／UNKNOWN／unsupported(reason)，无I/O副作用。unsupported的reason区分known_graph_difference、unsupported_addition及stage_change，不把来源不支持新增主张统称现实矛盾。Interface同时规定先结构后语义、完整实际窗口、只降不升、原V4独立必填以及有限输入规模；Implementation隐藏字符定位、参数化词元／产生式、正例与负向诊断图、限定边和规范摘要。调用者与计划控制跨同一Seam，不公开AST或另造可写Tool。V Adapter只负责同一调用及解析，Flow仍负责原核验和producer；I/O留现有loader／仓储，Depth由同一规则对不同词元组合的独立核验体现，不能由整句匹配表制造。

批准后预计修改：verification.py／verification_adapters.py／新source_proof.py／evidence.py，memory/dimension_evidence.py／evidence_binding.py、dimensions.py及现有DTO／mapper／候选仓储／查看导出／删除复查接缝，新增前向迁移和对应纯producer／隔离PG测试；须在实施前给实际精确文件清单。不得捎带Gold、case／labels、评测标准、App／OCR／CLI或真实模型实验工具。ADR-046及相关current合同仅在决策获批后显式修订。

顺序为：接口拒非法／缺proof未知的真红→绿；真实V解析和build_dimension_evidence生产路径正负控；真实producer进入隔离PG的保存／回读／导出／来源与候选删除；最后最小相关类型／两轴评审。禁止手工构造DimensionEvidence或注入source_bound=true来代签生产路径；模型mock只验证协议和装配，质量另轨。

## 预注册控制：全部planned_not_run

| ID | 实际输入／单变量变更 | 预期生产结果 |
| --- | --- | --- |
| P01 | contact纯文字“我刚到家”→“联系人刚到家”完整作者规则 | 原源、主体、刚和H整体可核；不造日期，v2角色依据可回读 |
| P02 | 新合成`我姐把她的车借给我了。这里的“她”指我姐。`→对应完整角色句 | lender、车owner、recipient与完成阶段全等价，产权角色只由来源完整指称句绑定，不猜现实身份 |
| P03／P04 | 新合成`我同事让我周末帮他顶个班。这里的“他”指我同事。`分别走pure quoted／received两个完整H正文 | 各自frame／语用／时间角色成立，beneficiary须有来源指称句；不使用原R105冒正控，不计用户已接受 |
| P05 | “如果天晴，我计划明天只跑约3公里”→同限定的约3000米 | 条件、计划、明天、只、约及单位等值都存在；仍按原门pending |
| P08／N13 | D2参数化Kin＋PastTime＋Negation＋Object带来源指称句；候选单变量改借了／删PastTime | 原子polarity和事件时间角色分别完整保留才可核；反例降级unsupported，不用子串或覆盖率签通过 |
| P06 | actual文本类型、活动refs／完整指纹，经正常loader→Flow→producer | 媒体依据来自受控行，非model type；JSONB无正文副本 |
| N01 | 我不喝酒→我喝酒；该初始规则不覆盖此句 | 不因子串喝酒或supported有效；UNKNOWN，日后无新规则不扩大正例 |
| N02 | P02有来源Identity时，候选lend_candidate单交换CP_agent／CP_recipient，或OwnedObject从自己的车改为联系人的车 | 同一候选语法独立核两端／物件owner；源明示方向或已解产权槽不同→unsupported。另去掉**源**Identity且仅改owner的范围控制必须UNKNOWN，不能借owner猜测拒绝原A05 |
| N03 | P03／P04来源保持，候选分别用unsupported_commitment_candidate的已答应／有义务／已经执行产生式；或received语法把周末从RequestTime_inner移到RequestTime_outer | accept_request／obligation／completed节点在源request图无支持，或requested_time被移到receive_request→unsupported；保留原V4和程序拒绝原因，不签现实已拒绝／无义务，不救旧评分 |
| N04 | P05来源完整不变，run_candidate逐项删IfClause／Only／Approx／Distance的Number或Unit／PlanTime；或ValidationPhase从计划换已经 | 候选全文在校验语法内，缺必需限定／精确量或phase_completed差异→unsupported；任意未定义表达仍UNKNOWN，字符覆盖大半不构成保真 |
| N05 | 小王说“我…”、两个他目标、额外上下文／第二target | 不按model一个target或我前缀认定唯一，UNKNOWN |
| N06 | image／voice placeholder或unknown，model声称processed | 保持unknown，不运行OCR／转写或新来源读取 |
| N07 | 负／bool／浮点／越界位置、错误源UUID、未知version或超32链接 | 非法输出停批、无剥离proof继续、无第二HTTP |
| N08 | 缺／null proof、合法但规则外的表达 | 旧V4原校验保留；新增语义未知、不回填、不放行 |
| N09 | 同正文只变语用标签／真实时间＋1秒／raw载荷指纹／owner或contact | 当前依据失效；等价时区仅沿既有UTC摘要兼容 |
| N10 | 仅model fidelity／unique／valid=true或人工设置source_bound | 严格拒额外字段／绕过；真正producer正例不可被此夹具替代 |
| P07／N11 | v2正常保存回读导出；随后删candidate或任何上下文源 | 保存前与确认内复核；依据清除／残留0，业务库不触碰 |
| N12 | 055／056环境尝试写v2、旧v1／NULL与未知版本读取 | 明确拒新写／未知版本，兼容旧读，不自动DDL或旧数据认证 |
| N14 | 原A05“我姐把她的车借给我了”，不添加指称句，model只选姐姐target | property_owner缺来源指称依据，reference及依赖该关系的完整paraphrase保持UNKNOWN；不修改原Gold或把未解认定为矛盾 |
| N15 | 原R105“我同事让我周末帮他顶个班”，不添加指称句，model只选同事target | beneficiary缺来源指称依据，reference及依赖该关系的完整reported／paraphrase保持UNKNOWN；原两种H合同和原成绩不变 |
| P09／N16 | **未见组合**：contact源`我哥前天没有把他的书借给我。这里的“他”指我哥。`→`联系人的哥哥前天没有把自己的书借给联系人`；单变为姐姐／车／已借 | 同一Kin／物件／时间／否定产生式应核全部参数，变角色kind／物件／polarity独立矛盾拒绝；不可新增整句分支救正例 |
| P10／N17 | **未见组合**：self源`我姐让我后天帮她顶个班。这里的“她”指我姐。`分别形成quoted／received完整H候选；单变RequestTime_inner为明天；另取接受产生式`用户已答应后天替用户的姐姐顶班` | 同一request_candidate解析明天／后天的已知requested_time差异，接受产生式解析源无支持的accept_request节点，分别unsupported；正例仍核两个H frame，原R105不修改 |
| P11／N18 | **未见组合**：contact源`如果天晴，我计划后天跑约7.5公里。`→`如果天晴，联系人计划后天跑约7500米`；单变添只／删约／7.6公里 | Number走通用Decimal；原无only不得新增，approx必须指对应distance量，完整图保真；不是固定3公里答案表 |
| N19 | P11的合法提案在本地组装后单换degree.quantity_qualifier_id为不存在编号／time编号；或将quantity.atom_id改到clear_weather | 固定kind合同及全文重解析都须失败；不能保存跨kind限定，不能把距离量挂人物槽 |
| N20 | P11单换condition_atom_id／action_atom_id或让action指另一个已编号命题，源／候选字面不改 | 实际COND语法树的action requires condition方向必须一致；反向、错行动、自环拒绝，graph hash存在不救关系 |
| N21 | 对P09／P10／P11的来源词元作一项合法替换，候选保持旧词元；源全文仍能按同一语法解析 | 规则必须发现参数不对应而降级，不能仅因为句法匹配签完整；重复case ID或换展示昵称不得改变结果 |
| N22 | P02仅去源Identity，候选OwnedObject用联系人的车；以及原R105候选写该同事但源无Identity | source已有property_owner／beneficiary槽未解，另一归属只是未证猜测，必须UNKNOWN而非unsupported_addition；原A05/R105原文／Gold保持 |
| N23 | N02–N04／N17任一候选改用词元表外的新姓名、接收措辞同义词或多层引用；或来源加第二目标／未列上下文 | 超出全部可核语法／范围，必须UNKNOWN；不能靠负控ID或一句关键词拒绝，不能把规则外控制称已核否定／归属 |

P09–P11是相对于此前整句示例尚未出现的词元组合，全部`planned_not_run`；它们不是未知留出，不能称独立质量样本。实现批准后在同一词元／产生式版本冻结下，另由独立Agent选择未用于实现的组合并冻结正负控，选择不能使用model返回或Gold答案。所有组合仍跨同一真实producer Seam；通过这些有限控制只证明参数组合与图关系接线，不能替代原07跨消息／省略／多第三方等完整验收、核心01同批留出或原03四类质量资格。

批准实现后还须实际验证所有来源保真、角色／媒体／转述producer路径和存储；如语法正例不能安全成立，退为UNKNOWN并如实留下未覆盖AC，不把wire绿称四类已完成。≥15例、假事0、记错人0、一般错误≤1的原质量门另用固定公开材料、新有限模型预算与完整停止条件，不改答案、不删难例、不借旧额度；达标后仍由用户逐类批准。[ADR-036](../../architecture/adr/036-per-dimension-adoption-release.md)

Root可集中请求的批准表述为：是否批准按D1–D3上述同一次V、有限句型和version2语义依据合同实现及隔离测试；明确不包含业务库迁移、任何维度放行、旧数据回填、新供应商或追加模型执行授权。此前JSONB／AND批准保持，无需重复确认。本稿自身只是一份待审提案，不代表用户已接受这段表述。

## 本次草案修订与验证边界

冻结v1输入SHA256为`10c3442b1bba8f93877f49eba94e6afccb483cd0d56f641b5069f935d8d1379e`；只读Spec审指出两项P2：完整句名单与原spec禁止按用例硬码相冲突，以及quantity／degree／condition关系未在固定持久形状中表达。草案v2针对前者改为独立词元表、完整产生式、源／候选独立图比较及未见组合正负控；针对后者增加distance动作属性槽、degree→quantity引用及action requires condition的显式双atom边，并列跨kind／错目标／反向关系负控。没有放宽旧难例、评分、V4槽、默认空表或逐类批准门，也没有将任何控制标成成功。

冻结v2输入SHA256为`33b0234b1da41625d79c9daa9eb4b01e114edadb89733e6cba715b32cdf3ce95`；独立Spec指出“候选不匹配正例一律UNKNOWN”与部分负控承诺unsupported不一致。草案v3增加仅用于本地核验的参数化CP两端／显式物件归属、请求接受／义务／执行、条件与限定缺省／阶段扩写产生式，给每一负控图差异判据，并明确这些诊断节点不能新增proof规则／持久正例枚举。未解源归属保持UNKNOWN，范围外另列UNKNOWN控制；不以全部UNKNOWN避开已定义的错误判定。

本地仅用Node标准库校验本文14个相对链接均存在、无尾随空白及末尾换行，并核候选校验产生式、负控族和持久正例枚举的文档对应；私有v3冻结保存在`desktop/artifacts/goal-resume-proof-decision-20261013/`，保留v1／v2原件。此静态校验不属于项目／producer回归；所有控制`planned_not_run`，产品代码／项目测试／模型HTTP／App／PG／凭据读取／Git操作均0。修订后必须另由独立Standards／Spec两轴评审，作者不自签P2已关闭；接口、version2合同及实施仍待用户架构批准。

Root后续复核：v3冻结摘要为`55a3be6f3aa9122922d786008716b8f31f18cf02ddf4de30fe43c22d11cd9291`。独立Standards增量复审hard0／smell0，独立Spec复审missing0／scope0／error0；此前P2在**方案层面**解决。私有报告分别为`standards-v3-review.md`与`spec-v3-review.md`，均保留带行号证据。Root核对冻结与工作稿一致后，仅追加本复核记录并提交方案；这不是批准或运行控制，也不关闭原三票。
