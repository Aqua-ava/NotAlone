# 确定删除边界与跨存储清理合同

Triage: ready-for-agent
State: resolved
Type: grilling
Map: [SQLite 数据库重建设计决策地图](../map.md)
Blocked by: 05, 06, 07

## Question

删除来源、清空联系人聊天、删除联系人和重置账户时，各数据对象及文件如何失效、清理和复核？单调代次、历史截断、晚到写入、本人跨来源依赖和最小调用记录怎样保持一致？

## 已有输入

- [spec.md](../spec.md)
- [data-model-draft.md](../data-model-draft.md)
- [cross-domain-deletion.ts](../../../backend-ts/src/deletion/cross-domain-deletion.ts)
- [assistant-runtime-erasure.ts](../../../backend-ts/src/reply/runtime/assistant-runtime-erasure.ts)
- [109_wechat_auto_read_suppression.sql](../../../backend-ts/database/migrations/109_wechat_auto_read_suppression.sql)

## 完成条件

逐范围列出数据、事务、库外清理步骤、资格与复核条件；覆盖未读历史、同秒／乱序、清空在途和恢复操作，不将单库事务误称为文件与数据库原子。

## Proposal：先撤销使用资格，再可恢复清理和复核

本轮仅为数据库／存储设计，未执行删除、SQL、App 或用户目录扫描。Q42 已确认统一操作账本、目标进度及复核结果，各领域保留自身清理与范围校验。普通业务关系继续使用 owner/contact 的真实复合 FK；删除计划中的身份则是受保护的清理地址快照，不代表活业务对象。

### 已有决定及真实实现缺口

- 清空只删除 NotAlone 保存的该联系人全部聊天及实际派生，不删除微信原消息；联系人、有效同步选择保留。未读旧历史也不得补回，清空后新消息在有效授权下继续同步；精确渠道边界仍待证实，不重新询问这些产品决定。
- `cross-domain-deletion.ts:101–129` 当前只有 source/discussion/contact/account，未实现“清空聊天、保留联系人”的独立动作。113 的永久 target subject 去重也不能原样复用到同联系人反复清空。
- `113:3–38` 的删除 operation 本就独立于 live owner/contact/target，118 的 runtime target 只 FK operation；这是为业务行删后仍能重试清文件，不是缺少普通业务 FK 的借口。
- `sync-incremental-store.ts:176–181` 当前开关只有 bool，没有开关代次；108 的 consent version=1 不是 grant 生命周期代次。新库必须补独立授权／控制代次，避免 off→on 或取消→重选放行旧页。
- CLI 身份和精确清空边界的限制沿[既有研究](../../../research/sqlite-wechat-message-identity.md)，本项不运行 CLI 或发明最大 local_id／时间算法。

### 一、删除范围矩阵

| 动作 | 直接目标与派生 | 保留及禁止 |
| --- | --- | --- |
| 删除一份来源／捕获 | 原始出现及该实际捕获；清受影响证明、过程、候选／派生和受管副本 | 同 message 仍有其他合法捕获时不误删 message；独立手录根可保留。不能借新 capture UUID恢复被删记录。 |
| 清空联系人聊天 | 该联系人旧数据代次的全部 batch/record/message，含Q32隔离原始记录、非文字占位和全部实际依赖闭包 | 保留 contact、仍有效的选择／身份；独立于聊天的合法手录资料不按内容相似猜删。停止旧历史任务，未来消息须经新边界和数据代次准入。 |
| 删除联系人 | 同 contact 的资料、手录、偏好版本、助手会话、任务和调用记录；递归清本人／其他对象中依赖此来源的敏感内容 | 其他联系人独立合法工作保留；渠道排除／必要最小边界独立于 live contact，防自动重建。 |
| 删除助手会话 | 输入、候选全部版本／段、选择、运行副本，及依赖该会话的后续携入／学习／审核／发布 | 不删除无此依赖的真实外部聊天或其他独立资料；先捕获后续引用，不留FK悬空。 |
| 删除某条记忆／过程 | 记忆删除清正文、历史及恢复派生；单独过程删除清实际输入输出与过程副本 | 合法 memory 自有证据不只藏在trace；只删trace不等于删除独立合法事实。最小trace/call关系按允许范围保留，不能复活已删内容。 |
| 本次从空SQLite重建 | 按已确认范围清旧PG业务库、App旧助手／缓存／敏感派生及受管副本，不迁旧业务数据或保留旧库备份 | 模型密钥、用户原始文件、原Skill目录按Q41保留；官方DSH加载、仅必要关联、不默认全停用，未知逐项待核验。不能直接执行旧account路径删除用户Skill工作目录。 |

本人事实或全局偏好按真实来源逐项判断：人工确认／编辑不切断原聊天依赖；真正 origin_kind=manual_entry 的独立根才可独立保留。范围变化和旧版本引用不自动扩大删除，也不能成为隐蔽副本。

### 二、deletion_operation：一个持久化删除请求

| 字段 | 含义／约束 |
| --- | --- |
| `operation_id` | 全局主键。 |
| `request_key,requester_fingerprint,request_digest` | UNIQUE(requester_fingerprint,request_key)，命名空间来自可信宿主／用户／安装范围，不由客户端任意替换。接受短事务原子幂等；仍有合法摘要时同键不同范围冲突。不得含正文、昵称或凭据。 |
| `action_kind` | source / clear_contact_chat / contact / discussion / memory / trace / reset_business 等已定义动作，范围形状受控。 |
| `owner_address,contact_address,target_address` | 接受时从真实业务范围核验后捕获的最小地址；不是指向已删live行的FK。不得接收任意SQL、路径或扩大范围的客户端指令。 |
| `accepted_data_generation,plan_revision,plan_state` | 接受时目标代次、计划修订和enumerating/complete；用于重复清空与可恢复闭包。 |
| `state,phase,error_code` | queued/running/verifying/succeeded/failed；fence/plan/row_erase/file_erase/verify/complete 等有定义阶段；错误是有界码。 |
| `worker_id,lease_generation,lease_expires_at` | 删除控制器自己的单调租约；旧执行者不得覆盖新进度。 |
| `requested_at,updated_at,finished_at` | 操作时间。 |

不对 owner/contact 建会随对象消失的 FK；本行是独立控制凭证，权限只用于已接受的删除，不能授权读取正文、创建对象或外发。成功后清地址／输入摘要等不再需要的私密值，保留合法最小请求键映射和结果；长期抑制另存，不靠完整计划永久留存。若摘要已清不能再比较原范围，旧键只返回已消费／不可重建的最小回执或410，不重新受理、不恢复内容，也不假称仍能核同输入。

新清空用新 request_key 和当前数据代次；不能 UNIQUE(contact_id) 或永久 UNIQUE(固定联系人subject) 导致第二次返回旧成功。重试沿原 operation，不重新选择当前目标。重叠删除要按范围序列化或验证包含关系，不能无声扩大动作。

删除凭证不依赖会被清理的 owner 任务生命周期；可复用通用执行／租约代码，但不能为复用05的task FK把重试清单一起级联删掉。删除作业与记忆处理的启动恢复用途不同：已接受删除可安全续清／接管过期租约，failed保留原因等待显式重试，不因此自动调用模型。

### 三、目标与复核表

| 表 | 主键与字段 | FK与生命周期 |
| --- | --- | --- |
| `deletion_row_target` | PK operation/target_no；target_kind、受控复合键地址、expected_data_generation、expected_object_revision、state、error_code | 真实 FK operation；业务地址是待清对象快照，按明确kind解码为预定义表／键，不拼任意SQL。删父行后仍存活，复核后清除私密地址。 |
| `deletion_file_target` | PK operation/target_no；root_kind、受管locator、expected_identity、manifest_digest、state、error_code、verified_at | 真实 FK operation；身份／定位先独立提交再清盘。runtime/Skill/cache/旧App快照用明确类型合同，不只凭相对路径。 |
| `deletion_verification` | PK operation/check_kind；plan_revision、scope_generation、verifier_version、result、checked_at、非正文有界证据 | 真实 FK operation；rows/index/cache/runtime/Skill/snapshot/writer门禁等分面pass/fail/not_applicable。旧计划报告不冒充新目标已清。 |

目标表只为清理而保存必要地址，不充当普通业务依赖表、日志或备份。runtime/Skill等此前专用target可在统一文件目标中按类型承接，身份保护较强的规则不能被公共表降级。

目录核验受管根、scope、权限、设备／inode／birthtime及marker，无符号链接或路径替换；已持久同操作身份才可在部分清理后重试。marker最后移除。Skill目标还须核对预期manifest／工作副本指纹；用户并发修改或身份不符不能按旧路径继续递归删除。目录不存在是可验证幂等结果，不等于所有其他存储面都完成。

### 四、读取资格与删除控制分开

| 表 | 主键／字段 | 真实关系与边界 |
| --- | --- | --- |
| `account_sync_control` | PK owner/account；read_enabled、read_switch_generation | FK channel_account。真实开关变化推进代次，发起与落库复验，off→on不放行旧页；不作为已保存记忆的派发门禁。 |
| `conversation_read_grant` | PK owner/grant_id；contact_id、binding_id、grant_no、state、authorization_operation_key、consent_contract_version、confirmed_at | 完整范围 FK 到contact和binding，提供owner/contact/binding/grant超键供batch引用；UNIQUE(owner,binding,grant_no)，同binding至多一个current active grant。新grant建立与旧grant撤销同事务；身份与授权分离，重选仍沿用合法binding_id。 |
| `contact_data_control` | PK owner/contact；data_generation、source_set_revision、current_clear_boundary_id、lifecycle_state | FK contact、可空真实 boundary。清空／整联系人删除推进硬数据代次；局部source变化推进source修订，复验实际依赖，不一律取消未受影响整轮。 |

source_batch 补真实 grant FK、read_switch_generation_at_capture、binding_revision_at_capture、data_generation_at_capture 和必要来源快照；同一次捕获重试不能刷新成新授权／删除代次。grant_no与consent_contract_version含义不同；当前active也不证明历史结果有效。

05 processing_scope 的硬撤销事件明确为取消联系人、整联系人清空／删除和身份失效。局部source删除使相关证据／窗口失效，未受影响的固定目标可在新attempt中实际复验；不能让所有source变化都增加硬代次，也不能为已取消round刷新accepted代次放行。

### 五、conversation_clear_boundary：覆盖尚未读入历史

PK owner/boundary_id。字段：account_id、conversation_identity_scheme/key、operation_id、data_generation、adapter_contract_version、boundary_token、state(pending/established/unsupported/invalidated)、created_at。

FK 到同owner账号和真实删除operation。边界按已核验稳定渠道会话身份命名，不依赖live contact或binding行存活；contact_data_control及排除记录引用它，并复验当前binding的真实账号／会话身份相符。外部身份只用于必要无正文删除控制，不含展示名／正文。

boundary_token 必须来自经验证的渠道分界合同，能覆盖未读历史、同秒、乱序、重复编号及跨重启续读。普通cursor、最大local_id、某秒时间、当前已保存最大序号都不足。其生效点、事件分区和读取失败处理必须在适配器合同中明确，本文没有发明CLI接口。

现有锁定CLI证明不了这个能力，10必须先解决适配器／协议缺口并合成验证，再声称“截断旧历史且新消息继续同步”整体可用。无法证明时保存真实boundary/reading受阻状态，不能悄悄退化成只删已读、跳过同秒新消息或虚报无缺口。数据库清理完成与后续同步资格状态分别记录，但功能验收不能跳过边界门禁。

### 六、最小抑制与排除

`ingestion_tombstone`：PK owner/account/会话身份scheme+key/tombstone_kind/identity_scheme+key；字段operation_id、deletion_generation、created_at。真实FK账号／operation；明确两类：capture只阻止同一旧捕获结果重放，message才按可靠渠道消息身份阻止新UUID重捕获。不能混用两种身份或照搬旧local_id+create_time猜全局唯一。

`conversation_exclusion`：PK owner/account/会话身份scheme+key；reason、exclusion_generation、operation_id、retained_boundary_id。FK账号、operation和可空同渠道boundary，故意不FK会被删的contact。删除联系人后阻止自动重新建联；普通重启／重选不清掉过去删除边界。新库仍按已确认选中联系人范围工作，不因此开启全部私聊。

Q32隔离原始记录也受删除资格限制：只有能证明不属于已删除范围才可保存其正文；身份待核验不等于删除资格获准。不能先读可能属于旧历史的正文，再存raw隔离区绕过清空。无法准入时只记有界无正文阻碍／覆盖缺口，不能推进“规范化完整”或“历史全部完成”来隐藏缺失。

这些身份不是内容hash，不能据正文／昵称合并。联系人删除后的最小排除／边界仍按可信渠道身份保护，显式恢复才有新资格。新建contact／binding／grant及控制行时须先按owner/account真实会话身份关联既存boundary/exclusion；不能因新contact_id或默认generation=0误授首次全部历史资格。owner/account被删除时清相关最小标识，独立operation的清文件凭证留到复核结束再去身份。

### 七、显式历史恢复与检查点

`history_restore_authorization`：PK owner/restore_id；contact_id、account_id、binding_id、grant_id、accepted_data_generation、operation_key、scope_kind=all_readable_history、state、created_at/finished_at。完整范围真实FK到contact/account/binding/grant；操作只属于用户明确确认的一位联系人，新来源不恢复旧助手／记忆／证明。

source_batch.mode=history_restore 时必须带匹配且仍有效的 restore_id FK；其他mode该字段为空。恢复须等待相关删除资格／清理满足安全前提，后来再次清空或撤销立即使旧恢复失效。完成不全局删除旧抑制，普通增量／补齐不能借旧restore资格读回历史。

`sync_checkpoint`：PK owner/grant/data_generation/stream_episode_id；stream_kind、capture_cursor、normalization_state、coverage_state、clear_boundary_id、可空restore_id、reason_code、updated_at，真实FK grant／boundary／匹配的restore。首次历史、普通增量和每次显式restore各有确定episode，结束旧代次不覆盖它的目标身份。捕获进度、规范化资格和历史覆盖分开；has_more=false、最大message_id或已存条数都不单独证明历史完整。

重选后的新grant可真实FK引用并核验同binding／同data_generation的有效前驱checkpoint接续位置，不能新grant就丢进度或重启全部历史；旧grant的迟到页仍不能改新位置。普通清空结束旧历史episode，之后从经验证的新边界进入新代次，不让旧history未完成永久挡住合法新增量。

### 八、执行协议与并发

1. **接受并fence**：短事务核验用户范围、幂等身份和当前代次，持久化operation、根目标和必要最小外部定位，撤销旧写入资格；清空增加data_generation并终止旧历史计划。不能先drain再撤销。
2. **形成闭包**：大量数据可分批枚举，保存plan_revision／进度。受影响来源和相关引用在目标持久化前不能无声消失；所有引用变更要通过同一删除协议／重叠操作协调。plan未complete不宣告擦除完成，不要求在接受事务塞入整库大扫描。
3. **排空并擦除**：事务外停止旧writer／释放缓存；分批短事务按已捕获的旧代次／对象修订清正文和关系，独立清文件。正常新代次数据不能被无边界的DELETE contact_id误扫；清空只清旧代次，整联系人删除则先排除新入口。
4. **逐面复核**：验证正文、索引、候选版本、派生／携入／学习／发布、运行文件、缓存、旧App副本及相关writer均满足范围；必要抑制与门禁已持久。任何目标身份不符、文件失败或计划未闭合都保持未完成。
5. **完成并去身份**：仅全部适用复核通过后succeeded，清不再需要的私密地址与目标。保留合法最小回执及必要抑制；不把snapshot/旧库备份作为隐式恢复后门。succeeded仅证明本应用所管理、此次范围内的数据库／副本完成清理，不据此宣称供应商已收到的数据或用户另存文件也被删除。

新消息在边界已成立后可按新data_generation接收；旧目标枚举／擦除必须按代次限定，不能误删清空后的新source。显式恢复不能与未复核的旧清理争同一来源；未获资格时等待或受阻，不假称已同步。

### 九、来源逻辑与跨联系人派生

- memory正文必需message是AND，同message的活动捕获是OR；最后支持丢失才擦依赖正文，但实际被删背景也使整份旧证明／trace失效，不能拿其他捕获悄悄恢复旧证明。
- 偏好按07已核现行合同保留当时实际来源任一删除即擦除边界，不能未经决定套用memory OR。文档／Skill完整实际输入依赖及用户编辑继承关系也不能只看展示citation。
- 取消／清空A时本人任务逐一复验A的原round及代次，混合A+B旧结果拒绝提交；B独立工作继续。受影响本人事实按实际必需依赖／合法手录根处理，不删除其他独立owner资料。
- source/trace删除可保留合法最小无正文call；整contact/owner删除按ADR-094清对应记录及恢复副本。owner范围调用若涉及被删联系人，必须清其可识别来源关联；是否还有独立owner最小账目须按范围合同逐项验证，不以contact_id=NULL作豁免。
- 调用结果迟到可在仍存在且允许保留的原call上结算，不得upsert已删contact／call或写回正文；删记录不构成退款或新的模型授权。单独trace删除不让合法记忆失去唯一可查证据，正文支持关系应独立保存。

### 十、库外维护与本次切换

- Q41原Skill目录保留、DSH官方加载、最小必要关联、不默认全停用继续有效。清理App实际敏感派生不扩大成删除用户保留目录／其他独立包；已知启用、已知停用、未知分别处理。缺DB引用不是删除授权。
- 旧Skill队列主要按relative_path（skill-cleanup.ts:5–22），须补同operation身份。旧App快照／缓存已有消费者及归属核验，不能只检查当前SQLite行；新非文字只占位不启用媒体获取，但旧敏感缓存仍在切换清单。
- 整库切换的删除账本不能只放即将drop的旧PG内；由新存储或独立最小控制清单持有，内容不含正文／凭据。这样旧库消失后仍能完成未清文件并复核。具体位置及实例身份证明归10。
- SQL DELETE／逻辑不可用不等于所有SQLite页、WAL及App副本已验证清除。10须设计普通表secure_delete、受控checkpoint／必要维护、虚拟表和损坏／繁忙情况的验证；不能手动删除活WAL，也不为清理新建VACUUM INTO副本。依据[secure_delete](https://www.sqlite.org/pragma.html#pragma_secure_delete)、[WAL](https://www.sqlite.org/wal.html)、[checkpoint](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint)、[VACUUM](https://www.sqlite.org/lang_vacuum.html)。不宣称取证级SSD／外部备份擦除，不擅自扩展加密或外部文件范围。

### 十一、验证与未闭合门禁

最小合成场景：同source双捕获／最后支持；仅背景删除；手工修正与独立根；A+B本人混合；Q32和非文字清空；反复清空／同键重试；off→on、取消→重选旧页；未读历史、同秒／乱序／重复编号、清空期间到达；新代次数据与旧清理并发；删除前后crash；marker部分删除；Skill用户并发修改；文件失败不成功；contact/account ledger范围；旧PG先消失后目标可恢复；不存在的／已删业务身份不被迟到结算重建。

物理FK、CHECK、条件唯一、边界adapter、快照归属、SQLite维护和全量旧表／使用者覆盖由10闭合。这里的待验证不允许实现时省略资格，逻辑模型完成也不代表精确清空现已可用。

## 本轮决定与后续校核

- Q42 已确认 A：统一 deletion_operation＋明确类型的行／文件目标＋分面复核，所有重试沿同 operation，各领域保留实际清理逻辑与范围校验。先撤销资格、完整清副本并复核，不能把“DB已删”当作全部完成；精确读取边界仍是独立适配器门禁。

## Answer

2026-10-28，本项形成物理主设计与切换验证所用的删除逻辑基线。

**用户明确决定**：Q42 选择 A，统一操作账本与目标进度。来源、聊天、联系人及助手等删除共用 deletion_operation，关联明确类型的数据库／文件目标和分面复核；同一操作幂等续清，各领域保留自己的清理规则与范围校验。只有此次管理范围内的数据库及副本均通过复核才完成。

**工程建模结论**：删除请求、目标及复核独立于被删业务行存活；先在短事务建立门禁，再分批捕获闭包、排空并实际清理。反复清空使用新操作键／代次，旧键封存不重受理；清旧代次不能扫新数据。账号读取开关、逐绑定grant、数据代次与局部来源修订分开；边界／排除按稳定渠道身份延续，checkpoint明确generation/episode。Q32隔离不允许绕过删除资格。Q41保留目录、官方加载及逐项未知状态继续有效，不能复用旧账户删除误删原Skill目录。

**必须继续闭合的合同**：10须解决稳定消息身份与精确清空adapter合同，覆盖未读历史、同秒／乱序／重复编号、清空期间到达及跨重启；未证不得宣称新消息同步无缺口。还须完成全部FK／CHECK／索引、分批枚举并发、checkpoint／grant接续、旧副本归属、SQLite页／WAL维护及新存储持有切换账本的实测。resolved仅表示本轮逻辑决定完成，不表示删除实现或精确清空能力已交付。

**验证**：三项独立只读代码查证及草稿审查，补幂等键和封存语义、grant当前唯一、代次episode及本地成功边界；文档链接、空白、状态和依赖检查。未执行SQL、App／微信、模型调用、实际删除或用户目录扫描。

## Comments

- 本任务只产生设计决定或事实查证；表数不是硬指标。沿用仓库隐私、手动发送和桌面热更新约束，不读取私人资料，不执行真实删库，不做远端操作。
- 三项独立只读查证及草稿审查完成，已补请求幂等候选键／去身份后封存语义、grant当前唯一性、checkpoint的data_generation/episode、重建contact继承既存渠道边界和本地清理成功范围；SQLite维护引用官方资料。未执行SQL或App，未读取用户目录。
