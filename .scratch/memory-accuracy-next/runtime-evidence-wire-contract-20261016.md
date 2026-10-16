# 有限六类运行依据：版本三协议与版本四依据的精确合同

状态：实施前合同，尚未实现或验收。范围来自[用户已批准的决定稿](runtime-evidence-completion-decision-20261016.md)，与[实施规格](runtime-evidence-implementation-spec-20261016.md)共同使用。本文固定新模式的字段和产生式，不修改旧proof1/2、basis1/2、evidence1/2/3，不切换grounded-v2默认、不改变其编译器或字段组合。

## 共同类型和确定性规则

所有对象的键必须与本文表格完全相等，没有可忽略的未知键。`?`表示值可为null，不表示键可缺；数组长度包含端点。整数必须是JSON整数，不能以布尔、浮点、字符串代替；所有字符串、数组和对象拒绝非有限数值和重复JSON键。UUID统一为小写连字符标准表示，摘要为64位小写十六进制。

| 类型 | 精确形状与限制 |
| --- | --- |
| `Span` | `{start:int,end:int}`，Unicode码点半开区间，`0 <= start < end <= 4096` |
| `SourceSpan` | `{message_id:UUID,start:int,end:int}`，其余限制同Span；UUID必须属于完整实际窗口 |
| `TextSpan` | `{start:int,end:int,sha256:SHA}`；SHA为当前对应候选片段的UTF-8原始字节SHA256 |
| `MessageSpan` | `{message_id:UUID,span:TextSpan}`；内部SHA取当前对应消息片段，不取候选片段 |
| `CanonicalSHA` | 对JSON使用`ensure_ascii=False,sort_keys=True,separators=(",",":"),allow_nan=False`编码为UTF-8后SHA256；数组原序保留 |
| 编号 | 各数组中的ID从0连续编号；对象数组按下文规范顺序存储，不接受稀疏、乱序或重复ID |

窗口须有1–4条、ID互异、顺序与实际loader一致的消息。每条消息及整个候选正文长度均为1–4096码点；每条消息有actual sender及活动来源快照。每候选有且只有一个主目标消息，属于原target集合；原target集合可以含其他消息，但其他target不能被伪装为context来回避独立主张。其他消息和主消息未被主引句覆盖的单元仍须完整解析。

除下文允许的角色介绍、显式声明和唯一问句外，窗口出现其他独立主张、未覆盖尾句或词法即UNKNOWN。至多两个第三方角色、一条显式指称链或者一组问答；二者不同时使用。作者两方不计入第三方数量。消息顺序是实际数组顺序；不借相同时间戳、昵称或模型选择重排。原文首尾可以仅有U+0020空格，匹配时可以去除这些空格，但定位始终保留实际偏移；不做其他空白、全角、同义词或标点归一化。

## 同一次V的proof3

V仍逐候选返回必填`candidate_index/verdict/issues/evidence`四槽；新显式协议允许增加`proof`，缺失或null表示没有提案。非null proof精确包含下列四键。没有唯一性、可信、source_bound、能力或质量字段。

| 字段 | 类型与限制 |
| --- | --- |
| `version` | 整数3 |
| `atom_links` | null或0–16个`AtomLink` |
| `reference` | null或0–8个`ReferenceLink` |
| `reported` | null或0–8个`ReportedLink` |

| 对象 | 全部字段 |
| --- | --- |
| `AtomLink` | `{rule_id:RuleID,variant_id:VariantID,source:SourceSpan,candidate:Span}` |
| `ReferenceLink` | `{rule_id:RuleID,mention:SourceSpan,target:SourceSpan,binding:SourceSpan?}` |
| `ReportedLink` | `{rule_id:RuleID,frame:Frame,source:SourceSpan,candidate:Span}` |

相同类型中完全重复的链接非法。无效版本、未知规则/变体、非当前窗口UUID、越界、布尔位置、反向区间及重复边均为协议错误，停止整批；位置合法但没有覆盖独立解析所得的必需关系为UNKNOWN。空数组不证明“不需要这些关系”；由独立解析器决定所需边。reference的跨消息mention/target/binding仅在proof3允许，不能放宽旧同消息合同。

| RuleID（规则版本均为整数1） | VariantID闭集 | Frame闭集 |
| --- | --- | --- |
| `BR_AUTHOR_ARRIVAL_V1` | `direct_quote` | `direct` |
| `BR_KIN_LEND_V1` | `completed_inline`,`negative_inline`,`completed_cross`,`negative_cross` | `direct` |
| `BR_COMPLETED_QA_V1` | `completed_answer` | `direct` |
| `BR_TWO_ROLES_V1` | `completed_inline`,`negative_inline`,`completed_cross`,`negative_cross` | `direct` |
| `BR_REQUEST_V1` | `reported_inline`,`reported_cross`,`received_inline`,`received_cross` | `reported_request`,`received_request`，与变体前缀相同 |
| `BR_COND_RUN_V1` | `conditional_plan` | `direct` |

每个候选只选择一个主规则。完整窗口有下述合法双角色介绍时，借用选择BR_TWO_ROLES，否则选择BR_KIN_LEND；不能把相同事件同时签成两条规则。内联/跨消息按声明与事件是否同消息决定。atom_links须覆盖所有事件原子；reference须覆盖下文的作者自指、显式第三方或问答绑定；reported须有一个覆盖完整主结构的归属链接。模型提案只定位已经存在的关系，不决定角色身份、事实阶段或图是否相等。

## 封闭来源产生式

以下记号为文法元符号，不是允许原文含这些符号：`[]`可选、`|`选择、`+`连接。原文不允许出现未列出的修饰。`S`是可选单个中文句号`。`；问句终止符`Q`为单个`？`或`?`。同一消息多句用单个中文句号连接，不支持ASCII句号、重复标点、换行或未列出的叹号。条件结构的连接符仅为单个中文逗号`，`。

| 记号 | 精确词元 |
| --- | --- |
| `REL` | `我姐`、`我哥`、`我同事` |
| `P` | `她`、`他`；不从性别推导REL或作者 |
| `OBJ` | `车`、`书`、`雨伞` |
| `H` | `昨天`、`前天` |
| `T` | `周末`、`明天`、`后天` |
| `D` | `家`、`公司`、`学校`、`机场`、`车站` |
| `V` | `到`、`到达`、`抵达` |
| `A` | `我刚到家`、`我刚刚到家` |
| `I`（显式声明） | `这里的“` + P + `”指` + REL + S |
| `R`（双角色介绍） | `这里提到` + REL1 + `和` + REL2 + `。`；REL1与REL2不同 |

I是明确的元语言指称声明，不从物品施事、受话者或亲属称呼猜所有者。至多一个I、一个R；同作者同角色的重复声明也不当作新增确定性，重复/冲突/修正均UNKNOWN。I与事件必须同actual sender；I的代词与事件中全部相应代词相同。R中的关系以R作者为关系资料范围，必须与I和事件同作者。所有事件所用REL都须属于唯一关系目录；R存在时两角色均保留为全文理解背景，不能删除另一角色后声称唯一。

| 主结构 | 精确产生式、顺序和独立判断 |
| --- | --- |
| 作者到达 | `A + S`。actual sender是actor，事件为已完成，`刚/刚刚`均归规范限定`just`；不能改成“说过某文本”这一较弱事件 |
| 肯定借出 | `REL_L + [H] + 把 + P + 的 + OBJ + 借给我了 + S` |
| 否定借出 | `REL_L + H + (没有|没) + 把 + P + 的 + OBJ + 借给我 + S`；H必填，不得有完成“了” |
| 借用内联声明 | 主事件与I在同消息；允许`事件。I`或`I。事件`，相连处只保留一个句号。REL_L只为我姐/我哥；I的REL可以是REL_L或另一已介绍角色，产权归I明示角色，不因出借人相同而认定 |
| 借用跨消息声明 | `[R所在消息] → I所在消息 → 主事件所在消息`，I在事件前；R可与I共一消息且在I前，也可单列为更早消息。不得反向读取后文声明补先前未定身份 |
| 双第三人 | 合法R加上述借用结构；R可与I同消息或在其前一消息，不能与主事件合成第二项独立事件。目录恰有两不同REL，I只绑定一个P；未选中的角色不形成额外事件原子 |
| 完成问答 | 前一相邻实际消息为`你 + [已|已经] + V + D + 了吗 + Q`；后一目标消息为`[我] + [已|已经] + V + 了 + [。]`。两消息作者相反，V逐字相同，答案从0偏移开始且是完整消息，只有这一个问题可匹配；D由该问句保留，不从“到了”独立发明目的地 |
| 亲友请托 | `REL + [H] + 让我 + T + 帮 + P + 顶个班 + S`；有同作者I明示beneficiary。I内联在主结构前/后，或在其前一消息；可有同作者R，其位置限制同上。H限定已发生请托，T限定被请求行动，不能相互替换 |
| 条件跑步 | `如果天晴，我计划 + (明天|后天) + [只] + 跑 + [约] + N + U + S`。条件和行动是同一主结构，在同一目标消息中是两个相邻SourceUnit；没有独立尾句 |

条件跑步的N/U复用旧`source_proof.py`的`_NUMBER/_UNIT/_plan`已公布词法，本文精确固定为：N匹配`[1-9][0-9]{0,5}(\.[0-9]{1,3})?`且十进制值不大于100000；不接受0、前导零、正负号、指数、范围、概数或中文数字。U只为`米/公里`；米按十进制精确乘1、公里乘1000换算为米，去小数末尾0及末尾小数点，不使用浮点。`只/约`各最多一次且位置固定，分别保留only/approx，不用单位换算抹掉程度。

除完成问答外，窗口中的非主消息只能是本规则需要的I或R；可在一条消息中依R→I顺序出现。主消息除主结构外只能含同作者I，其他分句UNKNOWN。完成问答窗口只含这两个消息，不接受其他问句、时间到期、约定、年龄、目的地修正或插入消息。肯定/否定、过去/将来、作者改变或事件动词改变在可解析范围内产生明确图差异；其他词法或无唯一解释时UNKNOWN，不靠命中某个字签错误事实。

请托的两种Frame必须与候选实际语用同时相容：`reported_request`为relationship_note/report/reported/literal；`received_request`为relationship_note/assertion/asserted/literal。二者都只保存“亲友向作者提出/作者收到请托”的历史动作，以及尚被请求的顶班内容；不包含已接受、义务或已履行。`REL让我…`支持实际作者是受托者，不证明已同意。未经来源表达的“答应/有义务/已经顶班”等节点属于新增主张，不能以换frame救分。actual sender为self或contact均可，亲友范围依实际作者保留；不能仅因出现“我”一概改为shared或自动把转述升级为本人执行。

借用按本人已参与关系经历沿relationship_note/assertion/asserted/literal，subject为接收者实际作者的资料范围；否定经历仍保留被否定的人物、方向和产权。作者到达和完成问答为common_fact/assertion/asserted/literal、subject=目标实际作者。条件跑步为recent_state/plan/conditional/literal、subject=实际作者。任何实际标签与该单一完整分支不相容时不生成正向basis；不改写标签或替模型另选事实阶段。

## 实际grounded候选包装与定位

新正向合同只接受grounded-v2实际输出的包装，不接受自由改写。SourceUnit定位严格复用当前`source_units`的分句表达式`[^，；;。！？!?\n]+[，；;。！？!?\n]*`；这是结构定位，不是语义判定。主引句可以是一条完整SourceUnit，或条件结构的同消息两条相邻SourceUnit拼接；**不要求主引句等于整条message**。消息余部仍按上一节完整解析。

候选整体文法为：`O? + AUTHOR + 原话：“ + MAIN + ” + C?`。AUTHOR只能为`用户/联系人`并与主目标actual sender相等；没有自由空格。MAIN逐字等于主单元片段，或条件两单元原序连接，包含其实际终止标点。O若存在，只能为`截至YYYY-MM-DD，`，日期须严格等于主目标occurred_at自带时区的日历日期，不能用机器今天或其他消息日期。

C的精确形状为`（相关原文：` + `AUTHOR1说“CONTEXT1”` + 零或若干`；AUTHORn说“CONTEXTn”` + `）`。每个CONTEXT逐字对应唯一SourceUnit，每个AUTHORn核该SourceUnit的actual sender。上下文单元数为1–4；不得重复，顺序必须等于既有`_dependencies`对主成员、依赖递归的确定顺序；依赖中源消息均进入fact.source_message_ids。源文自己可以含中文引号，不能凭非贪婪正则截到第一个引号：应枚举实际SourceUnit/主成员和受控作者包装，重建整个候选并要求唯一全串匹配；不唯一即UNKNOWN。

完整窗口中的I/R或问句并不一定全部印入C。候选实际使用的声明、问句及图角色绑定须在MAIN/C中有对应原话，不能借完整窗口存在而替候选暗补删掉的必需限定。R只作为竞争角色目录且不贡献事件时可不印入C，但必须仍在完整窗口内参与唯一性检查；此时不能把R作为候选语义图的正文来源。独立解析器对来源与候选分别生成完整主事件图，再比较；不能仅验证复制片段。

O是观察前缀，不是事件时间槽。本文六规则的完成/历史正向分支要求H日期双null；条件计划按实际目标occurred_at的同一时区，明天/后天分别取对应当地午夜至次日午夜。无aware锚点时不能证明绝对期间，保持UNKNOWN；周末/昨天/前天等在历史请托/经历正文中只保留相对限定，不能填入其历史H日期。当前v2对完成短答会沿既有完成转换去掉观察期；若实际输出仍是临时state/request及O，不能当完成分支正例。本合同定位O以诊断其来源，但不新增临时状态或直接请求的正向规则，不修改E2让这些包装过门。

## basis3：完整精确形状

只有独立全文核对、提案覆盖、活动来源及全部规则内关系均通过，才生成非null basis3。UNKNOWN/unsupported不伪造部分成功basis。basis由服务端产生，模型不返回这些字段。

| 顶层字段 | 类型/精确限制 |
| --- | --- |
| `version` | 整数3 |
| `rule_set_sha256` | CanonicalSHA，覆盖本合同规则/产生式/规范化/形状/能力表及执行版本；与任务冻结摘要一致 |
| `rules` | 恰1个`{rule_id:RuleID,rule_version:1}` |
| `roles` | 1–16个Role，ID按下文身份规范顺序连续 |
| `atoms` | 1–16个Atom；本文结构实际上最多2个 |
| `qualifiers` | 0–32个下列带判别kind的Qualifier |
| `reference_bindings` | 1–8个Binding；覆盖实际需要的作者、代词或问答关系 |
| `frame` | `direct/reported_request/received_request` |
| `unresolved` | 精确空数组`[]`；未解不能形成正向basis |
| `source_graph_sha256` | 独立来源规范图的CanonicalSHA |
| `candidate_graph_sha256` | 独立候选规范图的CanonicalSHA，须与前项相等；相等摘要本身不代替实际重解析 |
| `representation` | 下表Representation，version为1 |
| `capabilities` | 能力闭集的去重有序子集；逐项校验，不从非null basis直接填满 |

Role全部键为`{role_id:int,kind:RoleKind,owner:Party?,sender:Party?,source:MessageSpan,candidate:TextSpan}`。Party仅self/contact。RoleKind闭集顺序为`author,elder_sister,elder_brother,colleague,vehicle,book,umbrella,home,company,school,airport,station`。author的owner和sender均为其实际Party；亲友kind的owner为关系所依实际Party、sender为null；物品/目的地owner和sender均null。人物角色身份按`(owner,kind)`区分，非人物按kind区分；同一结构不支持两个同kind物品。先按owner顺序self/contact/null，再按上述kind顺序编号。source/candidate定位各自图第一次承载该角色的实际片段；目标省略“我”时author的source允许取完整主回答单元作为作者元数据锚，不能谎称那里有字面“我”。候选author锚定位外层AUTHOR。

Atom全部键为`{atom_id:int,predicate:Predicate,phase:Phase,roles:RoleSlots,source:MessageSpan,candidate:TextSpan}`。RoleSlots精确七键`agent,recipient,object,property_owner,beneficiary,actor,destination`，值均为已有role_id或null；不适用槽必须null，适用槽必须非null。source/candidate是该原子所属的实际主子句位置；问答到达原子source定位回答，destination角色另定位问句中目的地，不能把问句当成已经完成的事件。

| predicate/phase | 必需非null槽、原子顺序 |
| --- | --- |
| `arrive/completed` | actor、destination；作者到家和问答均使用此谓词，不降低为说话事件 |
| `lend/completed` | agent、recipient、object、property_owner；否定由polarity限定表达，不认证借用实际发生 |
| `request/historical` | agent、recipient；reported_request外层，atom0 |
| `receive_request/historical` | agent、recipient；received_request外层，atom0；agent仍为请求者 |
| `cover_shift/requested` | actor、beneficiary；请托内层，atom1，不是已完成顶班 |
| `clear_weather/condition` | 无；条件计划atom0 |
| `run/planned` | actor；条件计划atom1 |

单事件atom0；两原子的主结构按表顺序，不按模型返回顺序。未用人物不进入主事件roles数组，但完整窗口中仍检查R、I的竞争和冲突。

Qualifier共同键为`qualifier_id,kind,source,candidate`，source为MessageSpan、candidate为TextSpan，另加且只加下表键。限定ID按kind顺序`polarity,quantity,degree,condition,time`、所引用原子ID、槽名顺序连续；degree在同组按only/approx排序。

| kind | 其他全部键及语义 |
| --- | --- |
| `polarity` | `atom_id,slot,value_sha256`；只用于lend/predicate，规范值为JSON boolean |
| `quantity` | `atom_id,slot,value_sha256`；只用于run/distance，规范值为`{metres:规范十进制字符串}` |
| `degree` | `quantity_qualifier_id,modifier,value_sha256`；modifier只为only/approx，指向同图quantity，规范值为modifier字符串 |
| `condition` | `condition_atom_id,action_atom_id,relation`；relation固定requires，只连接clear_weather→run |
| `time` | `atom_id,slot,value_sha256`；slot为event_time/requested_time，规范值见下文 |

value_sha256均为该规范值的CanonicalSHA。time规范值精确三键`{token,anchor,interval}`：token闭集just/yesterday/day_before_yesterday/weekend/tomorrow/day_after_tomorrow；anchor为对应来源aware occurred_at的ISO字符串或null；interval为null或`{start:ISO,end:ISO}`。只有条件跑步的明天/后天有非null interval，其余是保留正文相对限定、interval为null。原子无时间词则没有time条目，不凭观察时间新增事件时间。请托外层H写event_time，内层T写requested_time；不得用同一条目遮蔽两个时间归属。

Binding全部键为`{role_id,method,mention,target,binding}`。后三项分别为MessageSpan、MessageSpan、MessageSpan?。method闭集：

- `actual_sender`：author角色；mention/target同一作者词，若目标无“我”则同为完整回答单元；binding=null，实际身份由message.sender核定。
- `source_identity`：亲友角色；mention定位事件中的P，target定位I中的REL，binding定位完整I。I和事件同作者，消息先后符合产生式；不同消息UUID明确保留。不要求mention与target同消息，也不放宽旧版。
- `completed_question`：destination角色；mention定位回答的V，target定位唯一前问中的D，binding定位完整前问。角色、动词、先后和completed阶段分别核对。

Binding按role_id、上述method顺序、mention窗口位置排序，同一三锚不重复；不同代词出现位置须逐个覆盖，不能一条边代签未核的另一代词。单个全局声明可以被该同一主结构中的多个P引用，仍是一条指称链，不变成多个身份猜测。

规范图用于相等比较的精确顶层键为`{roles,atoms,qualifiers,frame}`：roles仅保留`role_id,kind,owner,sender`，atoms仅保留`atom_id,predicate,phase,roles`；qualifiers保留各自的ID、kind和语义字段，移除source/candidate，以`value`替换`value_sha256`，condition不添加value；frame照录。图无正文、位置、摘要、消息UUID或候选包装；来源图与候选图独立生成后严格规范JSON相等才可封存相等摘要，不能把来源图复制成候选图。

### Representation

Representation精确键为`{version,kind,target_message_id,source_full,whole,observation,author,quote,quote_sources,contexts}`。

| 字段 | 类型与约束 |
| --- | --- |
| `version/kind` | 整数1、固定`grounded_window_quote_v1` |
| `target_message_id` | 主目标UUID，属于evidence4.target_message_ids |
| `source_full` | 1–4个MessageSpan，实际消息原序、每个span从0至整条text_length，覆盖整个窗口，不是裁剪后的图输入 |
| `whole` | 候选TextSpan，精确覆盖从0至整个候选长度 |
| `observation` | null或`{message_id:UUID,candidate:TextSpan}`，定位完整O，message_id等于主目标 |
| `author` | 定位主外层AUTHOR的TextSpan |
| `quote` | 定位MAIN内文的TextSpan，不含外层引号；内文原有标点/引号属于MAIN |
| `quote_sources` | 1–2个同主目标的MessageSpan；单SourceUnit或条件两单元，原序、连续且逐字拼成MAIN |
| `contexts` | 0–4个`{source:MessageSpan,whole:TextSpan,author:TextSpan,quote:TextSpan}`；whole覆盖一条`AUTHOR说“CONTEXT”`，quote仅内文 |

候选完整包装必须按实际字符串重建全等，所有定位及摘要重新计算。source_full是窗口新鲜度/完整性定位，允许包含纯窗口背景；其余语义角色/限定/指称及实际印出的主引句、context消息均须在fact.source_message_ids中。不能因为source_full包含某消息就把它当成候选已经引用。主消息、MAIN、C及图关系的对应必须唯一；错误位置非法，合法但不能唯一对应为UNKNOWN。

### 能力闭集与维度映射

capabilities数组按下表顺序，任何未知值、重复值、虚报值均拒绝；模型提案没有此数组。每项需要对应独立检查全部通过，并且不能有fact.alternatives或语用未知。保守相关集合不因为缺能力而缩小。

| capability | 独立检查 | 贡献维度 |
| --- | --- | --- |
| `subject_binding` | 主目标actual sender、外层作者、资料范围及图角色正确；请求/收到请求分支不把执行方当资料归属方 | subject |
| `event_preservation` | 主事件图完整相等，全文/包装无遗漏、新增或阶段/限定改变 | paraphrase |
| `reference_resolution` | 作者、显式声明或唯一完成问答的全部适用三锚有效；竞争读法为0，不因模型仅给一个target而认定唯一 | reference |
| `direct_attribution` | frame=direct，实际作者、内文作者及主体相容，无转述层丢失 | reported |
| `reported_attribution` | frame为reported_request/received_request，外层请求/收到与内层尚被请求行动分别核对，没有新增接受/义务/履行 | reported |
| `temporal_preservation` | 所有适用时间词、内外归属及H日期槽按本合同核定；历史双null不冒充当前持续，计划期间有真实aware锚点且精确一致 | time |

direct_attribution与reported_attribution恰适用其一，不能同时出现。没有时间词的历史完成事件仍可在正确保留双null后取得temporal_preservation，这只证明没有捏造日期，不认证当前仍成立。缺必要时间锚点的计划不能靠双null获得该能力或完整正向basis。

media不来自capabilities；只从actual message_type/text_representation及来源链独立生成。truth_intent仍沿既有受控语用判定。能力不是逐类放行记录，也不证明现实世界真假。

## evidence4：完整精确形状

evidence4恰有十二键：`version,scope,candidate_sha256,window_sha256,pragmatics,messages,target_message_ids,paraphrase,reference,media,reported,semantic_basis`。source_bound不序列化、不由调用者输入。

| 字段 | 类型与限制 |
| --- | --- |
| `version` | 整数4 |
| `scope` | `{owner_id:UUID,contact_id:UUID}`，与实际候选范围一致 |
| `candidate_sha256` | 新v4摘要：对既有candidate_digest所覆盖的候选字段对象增加`source_dependency_mode:"all"`后取CanonicalSHA；旧版本摘要不重解释 |
| `window_sha256` | 对`{version:4,scope,messages,target_message_ids}`取CanonicalSHA；实际消息和target原序不变 |
| `pragmatics` | null或`{speech_act,assertion_status,figurative_type}`；speech_act为assertion/plan/question/request/report/correction/unknown，assertion_status为asserted/hypothetical/conditional/reported/unknown，figurative_type为literal/joke/sarcasm/hyperbole/unknown；非null basis必须非null且与当前候选精确一致 |
| `messages` | 1–4个下表EvidenceMessage，实际窗口原序，消息ID唯一 |
| `target_message_ids` | 1–4个UUID，唯一、按实际消息原序，是实际target集合，且非空subset messages；主目标属于它 |
| `paraphrase` | null或0–16个`{candidate:TextSpan,source:MessageSpan}`；只表达真逐字对齐，不以这些锚点签事件保真 |
| `reference` | 固定null；新语义关系只在basis3，不填旧v1锚点绕过新规则 |
| `media` | null或0–4个`{message_id:UUID,message_type:string,representation:RepresentationKind}`；去重、按窗口序，只对应fact.sources |
| `reported` | 固定null；同上，不填旧v1结构代签新归属 |
| `semantic_basis` | null或严格basis3；不能配basis1/2，也不能把basis3保存为旧外层版本 |

EvidenceMessage精确九键：`message_id,text_sha256,text_length,sender,message_type,text_representation,source_state_sha256,occurred_at,source_refs`。message_id为UUID，text_sha256为完整文本SHA，text_length为1–4096整数；sender仅self/contact；message_type为实际非空类型；text_representation为text/processed_text/placeholder/unknown；source_state_sha256为SHA或null；occurred_at为actual aware时间的`isoformat()`字符串或null，v4保留其实际UTC偏移，旧版UTC序列化不变；source_refs为0–64个`{ref_id:UUID,source_id:UUID}`，ref_id唯一且按其UUID字符串排序，不取代当前活动引用校验。非null basis要求全部窗口消息都有非空活动source_refs、有效source_state_sha256且实际为text/text；placeholder/unknown不签内容，processed_text只有真实处理链存在后才可另验，本次无该正控。

v4时间重核同时验证当前actual来源的时刻和用于本地日历计算的偏移；不能在绑定时把UTC化后的时刻擅自当作原来源日历，或只信已存偏移。若正式loader/保存读路由无法独立恢复生产该期间所用的来源偏移，该计划时间依据保持UNKNOWN；不扩大原时间模型或靠改E2计算方式救正例。UTC来源可以沿原正式链验证；非UTC来源必须实际经过完整读写复核后才能获得该时间能力。

新v4在proof缺失、范围不支持时可保存semantic_basis=null的未知快照，不因此成为自动采纳依据；包装来源及source_dependency_mode=all的必要消息检查仍须通过，不能以UNKNOWN接受来自未引用上下文的正文。无法核对完整包装或必要来源时拒绝保存该新记录，不能退回any。保存和确认前重建窗口必须原样传入target_message_ids，重新核对当前消息全文/作者/活动来源和basis3，不借先前valid/source_bound结果。

source_dependency_mode是三类资料独立持久闭集，不新增为模型字段或basis字段；all/any的传播、同message多source_ref的替代关系、删除前收集及独立manual保护严格沿实施规格“正文依赖与删除”。清proof后all仍保留，拒绝指纹和修正版不得丢失该模式。

## 受控API投影

任务运行请求仅新增可选`extraction_runtime_mode`字符串，闭集legacy/bounded-runtime-v1，出现时必须带现有task_id；不接收客户端的自由配置对象、规则摘要或证明。任务状态响应只在配置非NULL时新增`extraction_runtime_config`，精确为实施规格的version/mode/rule_set_sha256三键。省略模式不修改已存配置；retry不接收该新增选择字段。

三类资料的查看/导出仅在持久mode=all时新增`source_dependency_mode:"all"`，旧any投影保持。候选继续保留既有dimension_evidence及dimension_evidence_source_current；新all候选另增加`dimension_evidence_dimensions`，其键固定为subject/time/truth_intent/paraphrase/reference/media/reported。每项精确三键`{required:bool,state:string,reason:string?}`：required来自既有保守相关集合；state闭集valid/unknown/stale。reason在valid时为null，在unknown时固定not_proven，在stale时固定source_changed_or_candidate_changed，不接受模型自由理由。

有v4快照且source_current为true时，仅`valid_evidence_dimensions`实际输出的键为valid，其他为unknown；有v4快照但当前绑定失败时全部stale。mode=all但快照已清空时全部unknown，相关集合取保守七项，不凭缺语用快照缩小范围。物理删除导致资料不存在时仍沿原not-found，不用stale代替擦除。此投影只描述当前依据，未放行的valid项仍不能自动采纳。旧any/v1–3投影不增加该映射，也不重解释历史状态。

## 验收与已有编译器的不相容处理

工程正控必须经过正式导入、loader、指定任务、既有E2/同次V、producer、保存/API和来源生命周期；模型只返回既有E2标签及上述proof3提案。不得手注basis、可信元数据或source_bound。规则控制还须覆盖句号/问号变体、同动词问答、跨作者声明、竞争声明、角色互换、数量/程度、内外时间、错误主目标、合法但不唯一定位及范围外尾句。

以下情况不是“稍改compiler即可”的默认授权：模型未将必需声明/问句加入dependency，实际候选丢了context；主结构需要两个不相邻主单元；除条件前件外想用prefix把另一个完整独立主张拼入MAIN；未知产权被当作已定；想把request/state包装当历史完成。上述均记录具体UNKNOWN/不相容，不删正文、补来源、改E2协议或更换默认来制造正例。文法内正例可选择由现E2真实表达的单SourceUnit或既有条件组合，不要求整条message成为主引句。

真实模型依据交付与SDK工程控制分别计数。真实冻结前固定本合同字节、规则集合摘要、窗口、Gold、版本、精确上限及停止规则。正式工具逐维度报告至少15例/假事0/错人0/一般错误≤1的原口径；混合总窗数、有限单例或安全pending不能冒充任一维度达标，也不产生生产逐类放行资格。规格存在不代表任何规则、接线、迁移、模型交付或关票已完成。
