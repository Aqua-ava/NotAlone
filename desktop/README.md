# 桌面端

当前独立交付目标为 **macOS 15+、Apple Silicon（arm64）**。App 的 `LSMinimumSystemVersion` 和 PostgreSQL 编译部署目标统一读取 `scripts/runtime/component-sources.lock.json` 的 `minimumMacOS`；打包在签名前写入，并复查最终 App，避免外壳仍声明支持 macOS 13／14 而包内后台要求更高版本。2026-10-17 官方 ZIP 静态打包回归先实际复现 `13.0` 对 `15.0` 的失败，修复后为 `15.0` 且严格签名通过；本轮没有在旧系统运行或启动 GUI／数据库，不扩展 x86／universal 支持。

## 手动首版使用

双击受管版 `NotAlone.app` → “开始本机设置” → 填写本人展示名称并初始化 → 在 App 输入对应模型密钥。新安装使用 DeepSeek 官方 `https://api.deepseek.com` 与 `deepseek-flash`；旧自定义模型／地址不会因更新密钥被静默改写。如需恢复官方默认配置，页面会展示目标，并要求重新输入对应密钥和明确确认。

打开“联系人”，填写展示名称并创建，再明确选择联系人，点击“手动输入本次聊天”。“回应粘贴文字”将对方当前文字与自己的表达方向分开；“改写”处理自己的草稿。生成后可查看依据、修改、复制候选，消息由用户亲自发送。手动输入默认仅使用本次文字，关系上下文需另行选择，表达要求不自动成为长期记忆。已有单联系人 JSONL 可先预览并确认归属，随后查看／删除来源；混杂或损坏资料会拒绝。

普通使用不需要 Conda、单独 PostgreSQL、微信、CLI、终端路径或录屏权限。微信自动接入尚未交付，同步页保留实际授权／暂停状态和关闭动作，不引导新用户准备未完成渠道。以下源码、原生探针与历史实机记录用于研发，不能作为手动首版的前置步骤或最终组合包的证据。当前仍待最终组合包、真正无开发环境机器及正式分发签名／公证验收。

macOS App 图标使用独立的 `assets/app-icon.png` 母版（1024×1024、sRGB、透明通道），打包时生成 16、32、128、256、512 点的普通与 Retina `.icns` 表示。当前传统 `.icns` 为 macOS 15 显式保留圆角和透明留边：底板 824×824、每边留白 100、圆角半径 185，Logo 等比居中，避免在 Dock 中出现铺满画布、比邻近 App 更大的直角方块。这些留白数值是本项目的视觉对齐参数；Apple 的[图标规范](https://developer.apple.com/design/human-interface-guidelines/app-icons/)规定方形布局及 1024×1024 画布，[传统高分辨率规范](https://developer.apple.com/library/archive/documentation/GraphicsAnimation/Conceptual/HighResolutionOSX/Optimizing/Optimizing.html)列出 `.iconset` 尺寸。新分层图标的系统遮罩流程不直接套用到现有传统 `.icns`。

修改品牌 Logo 后，在 `desktop/` 执行 `swift scripts/render-app-icon.swift src/renderer/assets/logo.png assets/app-icon.png` 重新生成 App 母版，再正常打包。生成器仅供开发使用，普通打包直接读取 PNG，不新增 Swift 编译依赖；界面与官网继续使用各自的原 Logo。

2026-10-10 23:30 实机补记：同一微信 PID 的 52×20 辅助小窗口曾触发窗口歧义；现在仅排除极小辅助窗，未知尺寸与多个聊天窗口仍拒绝。纯原生布局和门禁测试 9/9，打包及严格 ad-hoc 签名通过，真实公开坐标保存已成功。此前两次校验停在 `context / wechat_not_in_front`；23:34 用户手动切前台后已进入真实最小区域采集/OCR，但在 `names / quality_unverified` 安全停止。23:39分项诊断进一步确认两处完整名称一致、最低OCR置信度不足0.90（`session_name_confidence_low`）；未降低门槛。尚无可信 profile，前台定位未通过；没有新权限申请或原始帧持久化。限定单联系人实际新事件读取已通过；生产后台有界轮询与独立 PostgreSQL 验收确认测试消息入库 1 条、重启/重开不重复、关闭时 CLI 调用为 0，空结果最新性修复后补齐无错误。相关后端 85/85；临时库已清理。全局流、异常恢复、双联系人切换及完整 App 退出仍待验证，见[验收台账](../docs/macos-app-permissions-and-errors.md)。

任务 05 已接入应用运行期间的多联系人生成调度：用户显式生成先取得准备回执并固定上下文，再等待一个执行许可；当前连接最多接纳 8 个未结算任务。切换、编辑、隐藏不会改写已准备请求，切回从原会话只读恢复，失败重试复用原操作。原请求被替换的实际回执或连接失效会释放本地执行许可；旧传输可能仍在收尾，实际模型互斥仍由后端保证。

独立记忆集成候选的固定上下文使用 `version=2`、`schema_revision=5`。旧版、未知修订或损坏材料显式要求重新准备，当前编辑继续保留；普通读取和刷新不调用模型。用户点击“核对旧准备并重新生成”时，先用原 `request_key + input_version_id` 调用 `POST /api/contacts/{contact_id}/assistant-sessions/{session_id}/preparation-format`，同事务核对原 generation／attempt。仍运行或终态未知时继续等待，零 C 或可靠失败封旧键后才准备新输入；已可靠保存的完成结果继续重放。不自动释放有效租约或补取新消息冒充原快照。

任务状态只保存身份与状态，终态最多 32 条。旧连接未确认身份保留原退出核对能力，不挤占新连接的 8 项额度；跨代际总未结算身份达到 32 项时停止接纳并显示退出核对提示。同键已结束请求的显式核对可接管旧身份。消息提醒最多保留 32 个会话的消息标识，切回认证读取核验；继续/策略重试最多保留 32 个原冻结命令引用，完成、失效和断线清理。真实退出停止派发并走既有中断协议，重新打开只读恢复，不自动续跑。上述是公开 Main/preload → HTTP/隔离 PG 合成验证，未运行真实 App、页面或微信，组合实机验收仍属任务 06。

Electron + React/TypeScript 的本机 Mac App，当前完成管理后台与横向输入小窗。两个窗口独立打开，关闭时隐藏，可从原生“窗口”菜单恢复；使用“隐藏 NotAlone”整体收起后，窗口菜单只恢复所选窗口。“NotAlone → 退出 NotAlone”明确退出。小窗标题空白区域可拖动，底部图钉按钮可切换置顶；隐藏和恢复保留本次置顶状态，管理后台保持独立。

主进程认证连接本机 Python 后端，并在两个窗口显示真实连接状态。重复启动只恢复已有 App；关闭窗口继续隐藏，明确退出先阻止新业务，再通过原已验证连接确认停读。连接或退出失败保留安全说明和重试入口。已接入真实联系人目录、双窗口选择、历史文件预览、原子提交与任务进度、会话读取授权、草稿改写、明确方向回复与候选编辑和关系资料查看与编辑；来源删除、后台同步总开关与补齐已接入；候选复制和前台定位的原生任务状态见各自验收记录。任务 08/09/13/16 的新增 App 用例尚待预约执行，不能把连接、构建或 HTTP 成功当作完整业务闭环可用。

管理后台可确认删除导入来源，显示原后台任务的执行、失败和显式恢复；最终不可检索验证成功后才显示完成。删除检查点立即使两窗相关正文和旧依据不可用，无关资料与仍有其他来源支持的消息/记忆保留；依据读取失败保持隐藏，用户可重新核对。任务15在最终生命周期整理源ff66d4e普通页面10/10通过，独立两轴最终全部0；删除仅覆盖NotAlone资料，外部模型副本另按供应商规则处理。

“同步设置”提供已确认范围的总开关、后台状态与历史补齐进度，以及显式暂停/重试。关闭成功后停止新增正文读取，恢复只在原active范围；失败不推进游标。前台定位状态独立，最近同步报告不用于自动选择联系人。任务17在固定69e1e2a普通页面3/3通过，独立两轴全部0。真实微信、原生窗口退出、helper签名和权限仍待任务18/20验收。

前台定位由可信宿主持续串行调度，也在显示小窗前取得有界新观察；正式观察每轮一张当前前台唯一微信窗口内存帧，自动布局后仅OCR顶部名称，不依赖旧人工profile。探针最多2.5秒、后端3.2秒、UI／HTTP3.5秒，底层请求未结算时不发下一轮。正常轮次结束后最多等待2秒作周期复验，技术失败与认证繁忙保留4／8秒退避；完整名称等待联系人选择按正常间隔刷新。名称按实际采集时间最多显示5秒，例行刷新不延长旧时间戳。

顶部变化辅助源按[ADR-057](../architecture/adr/057-header-change-triggered-foreground-observation.md)只在已确认总开关开启、连接／目录范围有效、助手未获焦且正式观察证实微信在前台时运行。它初始化另取一张整窗布局帧，再用仅含目标窗口的display过滤器与sourceRect，以最多4Hz比较顶部局部像素，不OCR、不保存图像／摘要／坐标／名称；独立单窗过滤器忽略sourceRect，不能用它冒充局部采集。首版仅支持原点显示器上的完整窗口，其余情况停源并保留周期观察。每源最长60秒、最多240次局部比较，同连接一自有子进程；提前失败在连续许可内锁住，正常到期需新鲜观察续租，旧子确认退出后才替代。固定变化提示可取消正常空等，在途只合并一次，不能绕过真实失败退避或授予身份。关闭开始、状态未知、助手获焦、上下文变化、断连和退出停止辅助源并丢缓冲，退出前确认子进程结束。

唯一已验证绑定可自动切换，即使存在草稿、编辑或任务；同联系人不重置内容。助手获焦暂停定位并保留确认，其他App前台由原生元数据门禁停采；已授权CLI后台同步独立运行。明确采集上下文变化与认证409繁忙撤销当轮资格，新鲜可靠已有绑定可恢复；低分、歧义、真实超时等仍保留人工确认门。群聊暂停不展示群名或开放新生成，可靠私聊可恢复；停止、解绑、删除和连接变化使旧资格及迟到响应失效。机制经公共控制器→认证HTTP／隔离PG及纯局部图像验证；额外帧、真实窗口裁剪、宿主权限、资源与切换延迟仍须同版正式App实机记录，合成测试和编译不证明集成已验。

“联系人与绑定”显示当前运行本人范围内的联系人、消息数与来源数，不提供不存在的联系人添加或详情接口。目录先以同一已验证连接查询真实 `runtime_owner_configured`；缺模型密钥不阻塞查看联系人。目录首次默认不选，联系人由你手动确认；空目录说明通过历史导入或同步确认建立联系人。管理后台按钮和小窗选择器使用稳定的内部 `contact_id`，名称只用于展示。两个窗口共享本次联系人，小窗保持显示归属；同联系人隐藏恢复保留草稿、候选和编辑，切换（包括 A→B→A）、断线、换连接和退出清空本次状态，旧成功或失败不会覆盖新范围。App 的输入、语气、候选选择和编辑稿仅在内存中保留，重启不恢复；提交生成后的原草稿、原候选与依据由真实后端按联系人保存，不会把编辑稿静默写成长期偏好或发送消息。

小窗默认使用 `rewrite_draft`，关闭“结合关系语境”，只提交已确认的当前联系人、本次草稿和可选语气/要求。明确开启后才允许使用同一联系人的历史资料。主进程通过真实助手会话 `replies` 接口生成，显示本次等待、返回的 1–3 个候选、依据摘要和风险备注；草稿改写沿用原候选结果；两种聊天场景的公开澄清见下文。后端仍要求有效会话绑定，未绑定、超时与服务失败显示稳定说明，不跳过绑定生成候选。每个候选可独立编辑并查看原文与生成输入快照；重试同一次请求复用幂等键和原结果，保留已有编辑，改变草稿/语气/要求或明确重新生成使用新键。小窗展开到 520 像素高，选项、编辑区与窗口操作在实际窗口中可见；候选依据和复制的当前验证范围见下文，完整原生交付仍待实机。

2026-10-16 修复默认小窗中候选被输入区挤出、又排在多轮历史之后的问题：输入与结果共用中部滚动区，顶部和底部操作栏固定；当前候选先于已保存讨论显示，新结果及生成失败会自动进入视口。`candidate-visibility` 使用 680×520 页面、生产控制器及隔离 HTTP/PG，覆盖三轮草稿、回应消息、编辑框可见比例、固定操作栏和失败提示；修复前候选编辑框视口交集为 0。主 Agent 已用 Computer Use 在新签名 App 中恢复既有讨论并直接看到三条候选，未重新调用模型或发送消息；原启动路径已更新并保留旧包备份。验证命令与限制见[验收台账](../docs/macos-app-permissions-and-errors.md)。

方向探索仍有关键问题或歧义时，回应和主动联系的生成按钮禁用，并在旁边说明尚未生成新候选；“去回答关键问题”会定位到现有回答框。确认方向本身不清除未知信息，回答或更新理解后才可继续显式生成。探索、修改方向、等待或失败期间保留的旧结果，以及重开后恢复的候选，均标为“上一组候选”，不会冒充本次生成；新结果完成后移除旧标识。这些提示不自动回答、改变立场或绕过后端澄清门。

候选依据默认折叠，展开读取当前联系人及请求的原生成快照，标明本候选引用、同组候选引用与未被候选引用的上下文。入选原因、生成时状态、来源时间、保存时间和有效期来自真实契约；编辑不会改变快照，未知时间不补当前资料。新生成、联系人或连接变化会废弃旧结果，404清空缓存正文。当前API不提供未入选资料清单或完整运行轨迹，界面没有伪造这些内容。任务12在源`c61d86c`普通页面9/9通过，完整双轴hard0/possible0、Spec0；来源删除的当前验证范围见下文；原生App仍待完整验收。

“复制”取得当前已选择候选的编辑文本；主进程复核联系人、请求和候选范围，等待系统写入完成才显示成功。“复制并收起”在成功后复核本次范围并隐藏同一小窗。失败保留编辑与窗口，空白文本禁用复制；复制期间切换联系人时，旧完成不会收起新会话或发布旧提示。复制不会记录为发送、采纳或长期偏好。任务10在源`60053895`普通页面4/4通过，双轴初审与增量复核均为0；系统边界使用合成接收端。`tests/candidate-copy.spec.ts` 已在用户认可的 2026-10-10 15:00–15:15（UTC+8）时段实际通过：先写合成占位，再比较当前编辑的真实剪贴板结果、管理窗口拒绝与复制后的原生隐藏／恢复；真实隔离 HTTP/PG 与本地合成模型配合，任务 10 已 resolved。日志见 `artifacts/native-copy-scheduling-20261010-1500/`；最终签名包完整交付仍由任务 20 验收。

主动切换“回应消息”后，每页20条读取已确认联系人的消息，目标默认不选；用户可输入明确方向直接生成。选择“主动聊聊”时单独输入目的，不伪造对方消息。意愿不清楚时点击“帮我理清方向”，主进程先读取实际助手会话当前输入UUID，再使用 `/api/contacts/{contact_id}/assistant-sessions/{session_id}/explorations` 持久探索接口。理解、依据、歧义、当前一步、取舍、方向与关键问题分别展示；纠正理解和回答问题不会建立意愿确认。明确确认方向或输入意愿后沿原生成链路继续；尚有关键问题时继续澄清。

探索只使用同联系人的有界消息及已确认资料，静态Skill可辅助理解，实际名称与不可变版本可见，用户可关闭或更换；探索不使用表达样本或业务Tool补查。操作键、问题ID、建议ID与A持久输入UUID共同核验，失败可重试原操作；旧整数 `/api/reply/explore` 返回409。探索正文按原根15分钟期限管理，原生成与存储仍复用助手会话接口。普通再次生成固定探索实际Skill选择，明确关闭不自动选回。修改目标、目的或场景清除失效回答；来源删除清除受影响候选和派生方向／目的。原草稿、默认关闭的关系背景和同键恢复保留；切换场景不自动调用模型，候选由用户亲自发送。

B负责人工作树的 `reply-strategy-dialogue` 和 `reply-strategy-invalidation` 在真实页面、HTTP及正式001–052隔离PG上共五场通过，主树接入后复验仍待执行：两种入口纠正／回答不确认、明确选择生成、完成同键无新调用、关闭Skill后普通生成、主动来源删除，以及修改目的／场景／目标后的旧回答失效。控制模型只返回合成结构；完整换组、Skill版本更换、新消息生命周期与总预算仍按各任务接续，不能据这些页面证据宣称原生窗口或模型语义质量完成。

已确认当前联系人后，主进程通过认证的 `/api/events` 接收真实新消息事件，再以当前联系人有界消息页核验消息归属。界面只提示上下文更新，候选和编辑文本保持原样；用户可以主动刷新消息或重新生成，新请求与旧请求依据分别保存。联系人或连接变化会取消旧流和迟到核验。断流如实提示，用户明确重连后提示期间可能遗漏，再按每页20条主动刷新核对，不自动扫描历史、生成或发送。认证信息及事件帧不交给renderer。

“历史导入”通过系统单文件选择器读取用户本次主动选择的单联系人 JSONL；联系人选择默认留空，用户明确选既有联系人或填写新联系人名称。真实后端先完整校验格式、群聊、混合联系人与本人身份，再只读核对当前运行本人及所选联系人的渠道一致性。预览只显示文件名、本人和联系人身份、记录数及类型统计；选择、预览和确认都不写入联系人、身份或消息。换文件、换归属、另一窗口切换联系人、连接变化或主动取消会撤销本次预览；确认时重新读取预览核对内容摘要，迟到结果不能恢复旧范围。确认后用户再明确点击正式导入，主进程一次性消耗确认并提交；保存与后台关系处理分别展示。停止查看或断线不会撤回已发出的数据库提交，也不取消后台任务；结果未知时重新预览确认才能恢复原结果。外部导出工具的非官方能力、密钥与缓存风险在选择前说明。

“同步设置”已接通会话元数据与后台读取授权。首次、刷新和新出现的会话均不代选；勾选后必须明确选择已存在的联系人（同名时显示完整内部标识），或明确新建联系人，最后点击“确认并授权所选会话”。最终提交复核稳定定位、当前显示名和联系人范围，后端按可选 `observed_display_name` 再核对提交时元数据；原 `display_name` 的自定义展示名契约保留。新建选择若在最后确认时已被另一合法确认占用，则整批拒绝并要求重新选择，避免静默复用另一联系人。批量确认只追加，取消勾选不会撤销旧权限。若总开关已经开启，新增确认范围会立即允许后台读取；总开关与补齐的独立控制已接入，验证范围见上文同步设置说明。

已授权目录包含当前 CLI 列表消失的 active 绑定；改名与消失有明确提示，不能静默改绑或更新名称。用户在专门的撤销确认中核对会话与联系人后，可撤销后台读取授权：服务最多等待 4 秒取得与同步 cycle 相同的锁，等待当前一轮收尾后幂等撤销；成功响应后不再为该绑定新增 tail。取得锁前超时不执行迟到撤销，页面保留授权与重试；失败不显示成功。绑定记录和历史资料保留，清除来源使用独立删除流程。改名需显式撤销后重新选择确认。CLI 不可用时仍可管理真实已授权目录；本人渠道身份缺失则说明先确认单联系人历史导入并正常重启，不伪造首用就绪或新增本人渠道初始化入口。

任务16当前普通页面源码 `858db1f` 的授权11场与迟到2场全部通过，独立双轴hard0/possible0、Spec0。真实HTTP／PG和生产桥接复用，仅CLI使用合成脚本；13库精确回收且两租约absent。新版App包装、真实微信与最终签名包仍须任务20的实机验收，历史App结果不作为本轮原生通过证据。

“应用配置 → 本人身份与模型”已沿用后端 setup 接口：空库等待用户明确初始化本人，App 固定使用 `create_only`，服务端在同一事务内原子检查和创建；发现既有身份时拒绝并保持本轮配置不变。`setup/status` 的只读 `runtime_owner_configured` 核对当前实例受控身份在同库存在，就绪时直接复用。全库已有本人但本次运行身份缺失或不存在时提示检查受控配置，不自动选取其他身份。

本人初始化或 DeepSeek 密钥保存成功后，先认证停读同一服务，等待旧运行时退场，再通过正常启动检查重连。初始化已写库和配置而响应丢失时，用户可明确选择“重新加载受控配置”；重载只读取实际配置，不重复初始化。失败显示真实结果，恢复查询结束后再次复核连接与操作，旧错误不能覆盖断线或较新状态。密钥输入为密码框，提交后清空，页面只显示是否配置；配置本身不会发起模型调用。页面说明本机配置文件和 PostgreSQL 资料长期保存、未提供静态加密，以及供应商外部副本的独立删除限制。

后端生产启动会沿用本人身份和已确认同步范围；每次启动或复用前先通过机器环境只读诊断，连接状态不能代替数据库就绪。测试使用本轮随机新建的隔离 `_test` 库、握手、配置与 userData，不访问既有业务库、模型或微信。主进程才持有认证 token，渲染层只收到具名操作和非秘密状态。
已接入默认 `Command+Shift+Space` 的系统注册与小窗显示/隐藏回调。在“应用配置 → 桌面操作”查看真实注册结果并修改组合；无效、注册失败或保存失败时保留旧键与旧设置。支持 `Command`、`Control`、`Alt`、`Shift` 加字母、数字、F1–F24 或常用导航键，至少需要前三种修饰键之一。注册结果不保证该组合没有被其他程序处理。经用户明确授权，任务 03 保存的本机签名 App 已在全新隔离配置下接收两次真实系统按键，分别隐藏并恢复同一小窗，窗口 ID 和位置保持不变；没有启动业务后端、输入正文或操作微信。也可使用公开按钮和“窗口”菜单。

2026-10-09 阶段收尾：集成分支 `codex/mac-desktop-app` 已合入此前留在任务工作树的 `d6a3e6a`。本次联系人确认适配的相关普通页面共 43/43：保留同源码改写/定向回复 20 场，本次补验依据/消息事件 14 场、导入/草稿 5 场、复制 4 场；每场随机测试库均已清理，自有进程与两类租约正常释放。`npm test` 的类型检查和 24 项合成调度检查通过，页面命令中的构建通过；固定测试适配增量的既有 Standards/Spec 双轴评审均为 0。日志、精确库核对和评审副本保存在 `artifacts/acceptance-closeout-d6a3e6a/`（忽略的本地产物）。任务仍为 17/20 resolved：10 待真实剪贴板/窗口，18 待可信定位布局与成功自动识别、原生验证，20 待完整 helper 输入、打包和最终验收。用户本次确认 CLI/WCDB 材料尚未准备；真实桌面操作继续暂停，不能将这些页面结果称为完整 App 交付。

“记忆”按联系人记忆、本人记忆、待确认候选、联系人概览、本人概览及来源与过程切换查看；记忆、概览和来源列表每页最多显示 6 条。卡片默认显示正文、采纳方式与核实状态，展开后查看时间、来源、事件和处理依据。

“记忆 → 来源与过程 → 提取与来源处理过程”提供两个独立批次目录、详情与手动删除。每条记忆和待确认候选可直接反查提取批次；也可明确输入消息、来源或记录标识查询。阶段展开显示当时保存的实际输入输出、处理规则、调用、候选与写入收据，历史未记录、手输不适用与已删除分别说明。追踪只向管理窗口提供，读取失败、联系人或连接变化、来源删除检查点均清除旧正文；不会重提取历史或触发模型。

2026-10-10 合成普通页面验证：基础缺口、完整查看/分页/删除、范围/断线/来源删除三个组通过；完整组使用正式提取产生的 21 个零候选、1 个有候选、1 个失败批次及独立来源处理记录。删除过程保留权威记忆；来源删除完成后，已清除事件不能恢复。仅处理随机隔离库中的合成资料，Electron、系统剪贴板、权限及真实微信均未运行，仍按原票保留实机验收。

## 数据库沿用与结构补齐

已有安装继续使用已配置的本机数据库和资料目录。App 先只读核对真实版本账本；结构就绪时直接连接，存在缺少版本时才在原库逐版本执行受信任 SQL，再复验并连接。执行前须确认本 App 原后台已认证停读、生成已结算、目标库没有其他连接，并持有同一迁移锁；旧 App 或其他程序仍连接时，正常退出后重试。原连接与资料位置保持不变，不再显示“备份并完成更新”，也不自动备份、恢复到临时库或复制切换数据库。

没有既有配置的新安装仍通过“开始本机设置”创建 App 自带 PostgreSQL 的空库和完整结构；以后重开沿用同一目录。已有配置连接失败不能触发新空库替代。联系人、聊天、关系资料、来源、绑定、同步开关和暂停状态继续属于原库，不重新生成。

仅支持具有正式版本账本，或已核验035基线并有后续真实版本记录的本机库。文件或账本漂移、未知基线、账本与受信任 SQL 不一致的开发分叉和其他连接均停止并显示固定原因；不猜历史、不改写成功记录、不自动覆盖恢复。中断后保留已成功版本，修正问题再由正常启动入口补齐剩余版本，不重复执行成功 SQL。

旧流程已经生成的备份或未完成现场会保留。用户确认删除来源、过程、关系资料或助手会话时，仍按原归属核验清除本 App 管理的完整更新快照，避免通过恢复找回已删除内容。未知、损坏、未完成或清理失败时不显示删除成功；可查看固定本机目录及清理恢复说明，核对后处理，不能因新流程停用就清空旧目录。外置原库、自行导出的文件及模型供应商副本继续由各自删除路径处理，App 不擅自删除。

本次决定见 [ADR-066](../architecture/adr/066-in-place-schema-updates-and-database-reuse.md)，实施与实际验证见[原库结构补齐与正常首启](../.scratch/in-place-database-startup/spec.md)。旧备份搬库用例仅为[历史实现记录](../.scratch/standalone-app-delivery/data-update-validation.md)，不证明新流程、最终安装包或微信集成已验收。

## 本机运行与构建

### 日常开发热更新

日常修改默认使用开发模式，先检查并复用已运行的 `scripts/dev.mjs`；没有实例才启动。不要从 `out/` 打开打包版代替开发实例，也不为普通代码修改重新打包：

```bash
cd desktop
PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" npm run dev
```

React 界面和 CSS 保存后直接更新；兼容的组件修改会保留当前页面和组件状态，修改 Hook 结构或入口 HTML 时仍可能重新挂载或刷新页面。main、preload 和被引用的共享 TypeScript 编译成功后自动重启；后端 `backend/src/notalone/` 的 Python 与迁移 SQL 变化也会请求重启。重启前沿用正式的认证停读和生成结算流程；未确认停止时保留原 App 及恢复提示，不强杀，也不启动第二份。主进程重启会清除尚未保存的界面临时状态。

开发模式沿用既有解释器、配置文件和资料位置，后端源码固定从本次命令所在仓库加载；该覆盖只在内存中生效，不改写原来的启动路径。首次仍需在“本机启动路径”选择 `NotAlone` 环境的解释器。先通过菜单退出已有安装版 App，避免单例只唤回旧窗口。需要独立空配置做界面验收时使用 `npm run dev -- --user-data-dir /绝对路径`。开发服务只监听本机并验证本次令牌，窗口仍使用 `notalone://app`，正式包不读取开发资源。

终端输入 `r` 再回车可手动重启；`Ctrl+C` 或 App 的“退出 NotAlone”会正常停服并结束开发服务器。编译错误会保留原 App，修正并保存后自动重试；新增依赖后重新运行开发命令。开发启动与安全重启复用上述数据库检查：仅有真实缺少的版本时原地补齐结构，界面或普通源码保存不会另建、备份或搬动数据库，不更改同步授权。构建缓存位于忽略的 `.dev/`；它不包含应用资料。

`npm start` 用于一次性编译后启动磁盘资源；`npm run build` 验证生产前端构建；准备交付或验证签名、权限、原生组件和包内运行时时再运行 `npm run package`。开发模式通过不能代替这些交付检查。

打包缺省仍使用本地 ad-hoc 签名。需要固定证书身份时，显式执行 `npm run package -- --with-probe --signing-identity "$NOTALONE_SIGNING_IDENTITY"`；该变量由操作者事先设置为已选身份名称或完整证书摘要，不保存到仓库。App 与自研探针使用同一参数；单独准备探针可用 `node scripts/prepare-probe.mjs --destination <绝对路径> --signing-identity "$NOTALONE_SIGNING_IDENTITY"`。参数无效或签名失败立即停止，不自动选择或回退。输出按实际签名检查区分 ad-hoc 与证书签名，权限延续、正式分发及公证仍须另验，见[权限记录](../docs/macos-app-permissions-and-errors.md)。

随包 `notalone-runtime/licenses/replacement-kit/README.md` 提供可选的离线组件修改与 App 新副本安装流程；接收者无需本仓库或 Conda。只有开发者重建才需要 Node／clang，普通用户双击流程不变。来源、签名边界与实际证据见[修改库说明](scripts/runtime/PSYCOPG-REBUILD.md)。

任务18于2026-10-10 17:06–17:16（UTC+8）由主Agent直接操作当前微信与隔离App，公开坐标表单成功保存五处pending几何，但唯一布局校验未形成profile，实际1场失败，原因尚未定位。自有进程/目录及精确租约已核验收尾，未自动重启。现已补0600固定阶段/错误码结果和对应公开断言，原始画面不保存；新诊断未再实机验证，真实最小采集、成功自动定位和权限归属继续待验。后端两名质量解析及旧匹配入口的统一资格门禁在新建隔离库38/38通过，不能代替现场green。

需要 macOS 13 或更新版本、Node.js ≥ 22.12，以及构建图标/本机签名所需的 Xcode Command Line Tools。依赖版本固定在 `package-lock.json`。

```bash
cd desktop
npm ci
npx install-electron     # 首次显式准备锁定版本的 Electron 运行时
npm run typecheck
npm test                # 类型检查、安全调度、自研探针及外置路径配置，真实 App 不运行
npm run dev             # 日常开发
npm start               # 一次性编译启动
npm run package
```

本机 arm64 产物为 `out/NotAlone-darwin-arm64/NotAlone.app`。可在 Finder 双击打开；包只包含编译后的本地资源和最小启动清单，不依赖开发服务器、原型目录或仓库绝对路径。打包只替换本目录的 `out/` 产物，不覆盖历史 App。当前为 ad-hoc 本机签名，未做 Developer ID 分发、公证或 DMG；权限与签名边界见[台账](../docs/macos-app-permissions-and-errors.md)。

桌面资源构建、打包和仓库探针准备会在写入前核对实际输出卷与临时卷，任一可用空间不足 15 GiB 即停止；新输出按最近的已有祖先核验，已有目录的软链接按目标卷核验。在线打包还核对并复用 `~/Library/Caches/electron` 下载缓存，`download.cacheRoot` 已按[官方接口](https://electron.github.io/packager/main/interfaces/Options.html#download)与安装的 Packager 20.3.0 / Get 5.1.0 核对。开发时复用固定输出，验收后的旧 App、重复运行时与临时编译目录按[开发磁盘占用规则](../docs/agents/engineering.md#开发磁盘占用)清理；自定义 `--output-directory` 成功后由调用者负责收尾。

## 屏幕录制授权

外置配置模式启动与热重启仅静默检查屏幕录制权限，不显示模态授权引导；缺权限在应用配置和输入小窗中提示。权限检查、主动授权和后端定位共用本机启动配置的探针解析，开发模式不要求重新打包。点击“开启屏幕录制授权”才请求系统许可，“已授权，重新检测”只复查；系统未再次弹窗时，在打开的“屏幕与系统音频录制”中核对本次应用或探针，开发模式可能显示 Electron。系统要求重新打开时，正常退出再启动开发模式。原生权限命令不采集画面或聊天内容，权限就绪也不代替联系人绑定核验。

## 外置微信工具

App 与本仓库不提供第三方 `wechat-cli`、WCDB 二进制或独立 CLI 源码。微信同步使用用户自行准备的本机工具；在“应用配置 → 机器环境”填写外置 CLI 的绝对路径，或显式设置 `NOTALONE_WECHAT_CLI`。已保存路径优先于环境变量；未配置时不自动搜索 PATH 或旧包内 CLI，同步不可用不妨碍独立后端配置。外置工具所需 WCDB 库由该工具自己的安装及环境负责，NotAlone 不注入包内库。

第三方工具的 `check:helpers`、`prepare:helpers` 与 `--helper-directory/version/source` 打包入口已移除，旧打包参数在读取输入或创建输出前拒绝。CLI 只读适配器、联系人确认、总开关及停读行为保留。自研探针可按下文 `--with-probe` 附带。

### 已退役分发路径的历史记录

以下日期段只描述此前包含第三方工具的候选包与来源核查。2026-10-14 用户决定取消该分发路径，专用许可材料及复制代码已从当前树移除，旧内容可从本地 Git 提交 `40a5f054` 查看。来源获取任务停止，已取得的证据及未证明结论保留；旧包的 Finder、快捷键与权限结果不认证当前新包。

静态核查、搬运和默认启动接线属于任务 20 的实现，不授权渠道读取。2026-10-10 用户授权自行查找后，已从维护者现行[发行仓库 v1.6.25](https://github.com/r266-tech/wechat-cli-releases/releases/tag/v1.6.25)取得固定 arm64 ZIP、checksum 和 manifest，匹配 API 与组件哈希并通过严格静态检查；已用该输入实际构建未启动的候选 App。上游 WCDB 版本、构建时间声明为 unknown，同版本原源码目前不可取得，运行兼容与最终原生/微信验收继续待办；不以 v2 RC 源码代替稳定包证据。产物及实测记录见任务 20。

2026-10-10 后续来源补查：WCDB install name 为 `2.1.15`，库内 SQLite `3.27.2`、SQLCipher `4.1.0` 与腾讯固定 tag/子模块相容；版本函数静态指向 `Custom build`。腾讯官方源码 ZIP 的 API digest 已匹配，但无对应 WCDB 成品库，精确构建来源和完整许可组合仍未证明。稳定 CLI 已在 OS 默认拒绝的临时隔离中运行 version/tools/schema/help，返回 `1.6.25`、38 项 schema；隔离先用自有 canary 证实范围外读写、联网、其他 exec 和 Keychain 服务查找被拒绝。只取得契约声明；合成 tail 因未定义 HOME 失败，数据初始化、事件及媒体查询行为未验证。后端三个文字同步入口显式关闭媒体路径补齐，75 项合成回归通过。原始 JSON 与材料保留于 `artifacts/helper-provenance-20261010.GT1GQm/`，详见[任务 20](../.scratch/mac-desktop-app/issues/20-mac-app-delivery.md)；候选 App、安装器、wxkey、真实微信和原生权限均未运行或验收。

### 旧包许可材料与人工验收

2026-10-12 许可材料补查：固定发行CLI与WCDB字节同时匹配时，`package`自动把完整许可原文与来源索引（当前树已移除，历史见 `40a5f054`）放入`.app/Contents/Resources/notalone-third-party`，共9文件，复制后及签名后核对集合和哈希；拖动App仍保留这些材料。未知CLI／库字节不套用这组材料，已有目标不覆盖。候选Tencent源码及子模块许可已收集，精确构建来源和二进制完整许可覆盖仍未确认；不把`Custom build`默认值认作私有修改证明。只补交付材料，不新增权限或读取行为，不恢复OCR；旧Finder与生命周期验收仍只属于原包，后续资源候选包的静态检查另行记录在任务20。

2026-10-12 新资源候选包后续Finder场已通过：主Agent在13:34–13:44有限`test:app`窗口真实Finder双击，认证后端／配置就绪，输入小窗打开／隐藏，公开菜单正常退出，实际1场／1次启动、100.115秒、exit0。Root确认原默认目录身份恢复、自有库／进程／握手／临时目录及租约收尾；运行后签名、9份材料与4个helper／ASAR／归档哈希不变。首个锁屏等待场未启动App且未通过，失败与精确清理记录保留；[新包验收摘要](../.scratch/unfinished-work/wcdb-notice-finder-20261012.json)不代替生命周期重开、真实微信、快捷键或OCR验收。新功能冻结、OCR暂停，WCDB精确构建／二进制许可覆盖缺口保持。

2026-10-12 同一新包继续非OCR验收：20个完整App场景累计通过（后端10、首启4、真实剪贴板1、合成CLI同步4、重开生命周期1）；系统文件选择导入6条及任务核验分项通过，后续CUA全局按键未观察到小窗，原生整场未通过，实际键盘反馈仍待。默认安全46／46和相关后端44／44通过；产品代码及包未改。一次测试退场后的CUA刷新意外重开默认配置实例，公开页未连接后端，已正常退出；目录身份不变，但不宣称配置／缓存内容未变。精确自有资源清理及包内9材料／4helper／ASAR／ZIP复核完成，原失败独立保留，详见[非OCR验收摘要](../.scratch/unfinished-work/mac-delivery-non-ocr-20261012.json)。合成同步不代替真实微信、模型质量或OCR，完整20票仍未收口。

2026-10-12 后续实际键盘场沿已有授权仅启动1次，系统文件选择导入6条及前置小窗检查通过；显示阶段180秒未观察到小窗、结束前未收到明确实际按键反馈，隐藏未运行，人工收据和整场结果未写，runner exit1／235.663秒。不能确定实际按键是否送达或认定产品快捷键故障；Root确认App／精确库／自有目录／租约退场，包签名及ASAR／ZIP保持，没有退场后CUA重开。详见[实际键盘复验摘要](../.scratch/unfinished-work/mac-delivery-human-shortcut-20261012.json)，前轮20场成功与失败历史独立保留，完整交付缺项及OCR暂停不变。

2026-10-12最终人工场在14:59:01–15:29:01有限窗口实际1次启动，**1／1通过、610.520秒／exit0**。同一新包系统选入合成文件、6条导入及任务核验、用户实际Cmd+Shift+Y显示／隐藏同一小窗和两次明确确认、公开菜单正常退出通过；Root核对6个记录进程、4路径、精确库、两租约及原目录身份，4helper／9材料／ASAR／ZIP／strict保持。第二次按键早于hide-request，但用户后续明确确认隐藏，收据只在同场存活及nonce／截止核验后写入；不使用机器观察代签。管理后台是本场已打开的窗口，其他App前台焦点返回未独立验。当前同包非OCR完整场景累计21个，原失败与迟到反馈分列，见[最终人工摘要](../.scratch/unfinished-work/mac-delivery-human-shortcut-final-20261012.json)。完整20票、WCDB精确构建／二进制许可及真实渠道／OCR边界保持；产品与包未改。

### 仓库探针与核心库

```bash
npm run prepare:probe -- --destination /已有父目录/notalone-probe
npm run package -- --with-probe
```

`prepare:probe` 不接收外部二进制或探针目录。只读取仓库固定 Swift 源码清单与 `build_cli.sh`，拒绝源码符号链接/变化，在自有临时目录保存快照并执行该构建脚本；使用 `zsh -f` 禁用用户启动文件，`ZDOTDIR` 指向本轮临时目录，不改变用户 HOME。明确 ad-hoc 签名，不继承证书选择或用户配置。编译最多 120 秒，模块缓存和编译产物留在本轮临时目录，完成后清理；生成的 CLI 和动态库从不执行或加载。随后复用完整性、架构、签名和相对依赖检查，搬运到不存在的目标，只保留 `notalone-sync-probe`、`libNotAloneSyncCore.dylib` 与 manifest。已有目录拒绝且不覆盖，JSON 不回显绝对路径或编译输出。

探针 manifest 使用 `runtimeKind=repository-probe`，记录固定源码集合及 SHA-256 总摘要、`repository:` 来源声明，保留来源发行者/实际运行/原生验收未验证。仅显式 `--with-probe` 才构建并复制到 `Contents/Resources/notalone-probe`；第三方微信工具始终外置。探针在 Packager 复制后和最终包复核，保留原签名，不给探针注入 Electron JIT entitlement。主进程核对源码清单摘要和运行时文件后投影 `syncProbePath`，保存值及环境变量指向它时继续核验；探针失效不阻塞外置 CLI 或独立首启配置。

现行 `--session --json`（含 `--minimal-region`）在缺少0600已校验布局profile时于OS动作前返回 `minimal_region_layout_unverified`；有效profile路径才允许逐最小区域采集并重验。当前真实校验失败，没有可用profile或真实自动定位结果。公开Node回归实际编译、签名和搬运仓库探针，验证包内默认值、保存后损坏停用和配置优先；离线检查包验证了Packager拷贝/签名流程，权限及动态运行仍须现场验收。

### 离线检查包

```bash
npm run build
NOTALONE_ELECTRON_ZIP_DIRECTORY=/绝对路径/官方ElectronZIP目录 npm run test:package
```

显式 `test:package` 在自有临时目录复制当前编译资源、logo 和指定的官方 Electron ZIP，使用仓库探针调用生产打包命令。实际核对包内没有第三方 CLI/WCDB，自研探针原字节／SHA256 保持、严格签名通过且未获 JIT entitlement；另核对原始分发许可及包 Resources 下的 Node 启动诊断／后端环境；不执行 Electron、CLI 或探针，不覆盖既有 `out/`，最后精确清理本轮复制品。测试必须提供官方 ZIP 目录，不再重包安装副本；该结果不能关闭 Finder、权限或微信验收。

签名所需的 plist 在本轮 staging 内生成一次，再以文件路径传给 osx-sign；内容仍只有 `com.apple.security.cs.allow-jit=true`，helper 保留原签名。此前数组参数会逐文件生成 staging 外的临时目录，2026-10-10 的公开构建检查实际复现 250 份残留；修复后命令返回时本轮临时目录清空，调用者既有哨兵保留，主 App entitlement 精确等于原单项。旧候选构建的 250 份自有普通 plist 经哈希/目录身份核对后逐项清理，候选包四个运行时哈希未变；不扫描或批量删除系统临时目录。`test:package` 的 red/green 与清理证据见[任务 20](../.scratch/mac-desktop-app/issues/20-mac-app-delivery.md)。

需要把 App 与自研探针构建到独立目录时，公开 `package` 可附加以下选项：

```bash
npm run package -- --output-directory /已有父目录/新的输出目录 --electron-zip-directory /绝对路径/离线ElectronZIP目录 --with-probe
```

两项路径必须为绝对路径且不重复。显式输出目录必须不存在，先独占创建，失败时只按目录身份清理本次自有目标；已有目录保留并拒绝，不允许覆盖。离线目录须含 `electron-v版本-darwin-架构.zip` 普通文件，版本来自锁定配置、架构来自本机；缺档或摘要不同均在 Packager 执行前拒绝，不回退下载。`distribution-notices.lock.json` 固定官方 44.7.0 SHASUMS 的 macOS arm64／x64 归档摘要；本轮实际构建覆盖 arm64。在线默认路径沿用已安装 `@electron/get` 5.1.0 的 SHASUMS 下载及 SHA256 校验（缓存命中也复核），没有启用跳过校验选项。Packager 临时树留在本轮 staging 下，随本轮清理。未给这些选项时保留原 `out/` 构建方式。SDK 的 [electronZipDir](https://electron.github.io/packager/main/interfaces/Options.html#electronZipDir)、[out/tmpdir](https://electron.github.io/packager/main/interfaces/Options.html#out)已与安装 20.3.0 源码核对。

2026-10-17 补齐前端分发通知：构建先核对安装包名称／版本、package-lock 的版本／URL／完整性字段及原文 SHA256，再将 react 19.3.0、react-dom 19.3.0、scheduler 0.28.0 的三份 `LICENSE` 和 vite 8.3.3 完整 `LICENSE.md` 原样保存到 `dist/licenses/frontend/`，附固定来源收据。这四份原文已从官方 npm 归档按锁内 SHA512 核验，并与安装副本逐字节相同；没有只保存 MIT 名称或自行生成版权文字。打包进一步保留到 `Contents/Resources/licenses/frontend/`。Electron 官方 ZIP 原有 `LICENSE`（1096 字节）和 `LICENSES.chromium.html`（20115518 字节）也在签名前保留到 `Contents/Resources/licenses/electron/`，复制后与签名后复查原文摘要和文件集合，拖动单个 App 仍保留。两组共六份原文、两份来源收据，不扩大为全部 node_modules 通知闭包或法律认证。

同日实际验证：同名重包 ZIP 因容器 SHA256 不同而被拒绝；独立对照记录确认其 583 个 member 的路径、原始内容和权限均与官方 ZIP 相同，拒绝不表示其中代码被修改。官方 arm64 ZIP 构建的静态 App 严格签名通过，六份通知保留；含自研探针的 `test:package` 1／1 通过，缺档／改字节／锁不匹配的轻量回归进入默认安全组。本轮没有启动 App、GUI、微信或访问用户资料。

实际构建检查位于独立 `tests/packaging/command.test.mjs`，不加入默认 `npm test`；轻量的第三方参数拒绝回归加入默认测试。2026-10-14 外置模式离线构建 1/1、默认类型检查及安全组 44/44 通过；默认组不构建 App 包。已有输出保留、缺 ZIP 后自有输出清理均验证通过；签名是 ad-hoc，不证明可信发行者或权限身份稳定。

## 轻量无头页面验证

用户已同意普通页面采用后台接口和单实例无头浏览器；宿主桌面的可见 Electron 批量验收继续暂停，不安装虚拟机。`test:pages` 使用本机已有的 Google Chrome 与锁定 Playwright，独立临时 profile，最多两个明确页面组，串行运行；没有浏览器则失败，不隐式下载。先激活 Conda `NotAlone`：

```bash
npm run test:pages -- --case memory-reading --case draft-rewrite --timeout-seconds 120
npm run test:pages -- --case draft-rewrite-acceptance --timeout-seconds 180
npm run test:pages -- --case draft-rewrite-session --timeout-seconds 120
npm run test:pages -- --case memory-reading-full --case memory-stale-full --timeout-seconds 240
npm run test:pages -- --case memory-traces-full --case memory-traces-lifecycle --timeout-seconds 180
npm run test:pages -- --case directed-reply --case draft-rewrite-acceptance --timeout-seconds 300
npm run test:pages -- --case message-events --timeout-seconds 300
npm run test:pages -- --status  # 只读租约，不启动浏览器或 Electron
```

08 的 `expression-preferences` 页面组验证明确长期保存、当次意图优先、范围切换、同库服务恢复和偏好/来源删除。先指定仓库外700目录 `NOTALONE_PREFERENCE_EVIDENCE_DIR`，执行 `npm run test:pages -- --case expression-preferences --timeout-seconds 180`；runner固定关键模块摘要并核对真实加载来源。本轮页面、Electron与真实模型验证按[08集成任务](../.scratch/memory-skill-integration-preparation/issues/08-expression-preferences.md)分别记录；脚本模型不代表语义质量放行。

时限为 1–300 秒，包含构建；没有默认全量。`memory-reading` 验证实际资料/采纳方式/来源引用/切换/空状态及具名参数与角色限制；`draft-rewrite` 验证真实模型替代边界下的生成、候选编辑与原快照、选择和跨联系人迟到结果。`draft-rewrite-acceptance` 串行验证任务 09 的九个具名普通页面场景，每场景新建随机库和页面上下文；包括关系语境、真实 1–3 候选、等待/风险/编辑、幂等、失败与空候选、联系人及连接迟到成功/失败、同 userData 新生产会话清空及具名参数/角色/来源限制。六类交互与原 App 用例共用公开页面场景；新会话的输入准备/清空断言也与原生重启用例共享，各自保留停读、PageHost 或原生生命周期。`draft-rewrite-session` 固定只运行完整组中的同一个新会话场景，供相关小修复核使用；不能把单场景结果扩张为全部九项重跑。原生隐藏/恢复及真正 App 重启仍保留实际 App 验收。页面组复用生产 React、联系人/资料/回复 handler、参数校验、preload 传输接口及真实 HTTP/PostgreSQL；生产 Electron adapter 仍使用原 `validateCaller` 与角色检查。headless 的角色由 host 登记的 page 对象确定，不接受 renderer 自报；具名函数只接收已注册操作，renderer 不持有后端 token、数据库地址或任意 HTTP/系统调用。回环资源 host 与浏览器控制端仅用于测试，不进入交付 App。

每例创建自己的随机 `_test` 库、合成联系人/本人、配置、握手和 context，仅外部模型及必要传输迟到被替代。窗口切换在测试中创建对应角色的页面，原生隐藏/置顶/快捷键/剪贴板与未接通业务入口明确拒绝，不返回假成功。未改正常 App 的 show/focus。原生窗口、真实 IPC 来源、系统对话框、签名 App、微信权限和完整 App 验收仍待实机，两个最小页面组不能替代功能票全部条件。

`directed-reply` 含任务 11 的十一项普通页面场景：主动目标与非空方向、真实 22 条分页与较早目标、原输入/候选/编辑稿分离、丢包同键恢复与输入改变的新键、无消息/列表失败重试/绑定拒绝、目标来源不再有效后失败并转草稿、联系人或连接变化后的迟到列表与生成成功/失败、新生产会话不恢复输入，以及具名参数/角色/范围拒绝。每项使用独立随机库与真实生产 handler；同组串行复用本轮唯一无头浏览器。模型脚本只在外部模型边界返回受控候选，不能证明自然表达质量，也不把这些页面操作当作原生验收。

`message-events` 串行验收真实认证SSE提示、显式刷新保留编辑和原依据、实际断流和用户重连、联系人与认证连接变化后的迟到消息核验、owner/contact消息投影与具名边界、新请求保留旧依据。事件来自生产EventBus，消息来自随机隔离PG；传输夹具原样流式转发SSE，只暂缓已完成的真实消息页安排竞态。源码 `ff6343019c45009b566627bf5b4649da40ae6b90` 的累计唯一5场及真实HTTP EOF回归均已通过，独立双轴复核无问题。该组不读取微信或私人资料，也不证明原生App、IPC来源或签名。

页面 CLI 的构建/运行子进程及共用 Python 测试环境主动剥除全部 `LANGSMITH_` / `LANGCHAIN_` 追踪配置与凭据，并明确关闭当前和旧版 tracing 开关；调用方覆盖值也不能重新开启。合成模型仍会经过真实 LangChain 回调，不能靠替换模型阻止外部 trace。检查命令只使用自有回环收集器和假密钥：

```bash
node tests/headless/tracing-isolation-check.mjs          # 真实 pipeline 正控制与隔离效果
node tests/headless/tracing-isolation-check.mjs --pages  # 另跑限定 draft-rewrite 一组
node tests/headless/rewrite-lifecycle-check.mjs          # 实际未知命令故障与随机库收尾
```

改写 App/页面入口只共用 tempdir、Python 启动、ready 和清理生命周期，各自保留资源登记。控制通道失败仍关闭本轮 stdin，尝试触发 Python 的原有 finally 清理；退出码或清理未确认则保留私有 `cleanup-unconfirmed.json`（自有 PID、退出状态、已限定的随机 `_test` 库名），不撤销登记或解除租约，不包含 token/连接串。故障检查须另核验本轮库和进程后才清理自有诊断目录。

全机用户租约为 `.notalone-desktop-tests/headless.lock`，跨工作树和独立命令互斥，复用私有归属检查；不创建 App broker 或 App token。到期/中断只通知本轮 `ChildProcess` 收尾；控制器停读、HTTP/PG/临时目录、浏览器退出和自有进程组均需确认，失败保锁且不抢占陈旧锁、不杀未知 PID。`--status` 只提供归属线索，不能证明残余资源已清理。

`artifacts/headless-pages/` 保存仅合成资料的页面截图及 `resources.json`。资源记录为自有子树 RSS 之和的采样峰值，共享页可能重复计，不是精确物理内存或永久上限；Node 指页面控制器进程，构建/Swift 编译开销未计入该峰值。小型 Swift helper 以约 700 ms 间隔只读本轮浏览器 PID 的 AppKit 激活状态和 CoreGraphics 屏上窗口数，不截屏、不读取其他 App 的标题、无 AX/系统输入或 TCC 请求；有限采样不能保证采样间没有任何瞬时行为。

本轮最小两组 2/2 通过；12 次 owned PID 观测中 active 为 0、屏上窗口数为 0、激活策略为 prohibited。随后资源采集收窄为全局仅 PID/PPID、仅本轮子树读取 RSS/进程名，并等待在途采样后收尾；迟到组保留公开生成 Promise，释放真实 HTTP 后等其完成才检查新范围。只重跑该改写组，1/1 通过，8 次静默观测仍为 0/0；最新峰值 RSS：Chrome 子树 1,027,536 KiB、页面控制器 Node 156,256 KiB、合成 Python 153,584 KiB。正常收尾后租约 absent。公开 CLI 的范围拒绝、跨命令互斥、截止、中断收尾与不确定保锁通过；不更新原生或完整功能票的完成状态。

双轴评审后的隔离修复取得真实 red→green：旧隔离器在合成追踪父环境下向回环收集器发出 1 次 POST；修复后真实 pipeline 正控制 1 次、隔离 0 次，公共 CLI→Node→Python 的实际改写组 1/1 且 trace 为 0。该次 8 次 owned PID 观测仍为 active 0 / 屏上窗口 0 / prohibited；RSS 采样峰值 KiB 为 Chrome 子树 1,035,920 / 控制器 Node 160,000 / 合成 Python 155,120，正常清理与租约 absent。未知命令故障使实际夹具 exit 1、随机库残留 0，同时未确认 marker 保留、诊断先保留后由检查者核验清理；CLI 10/10 与共享传输 6/6 通过。此次只重跑受影响改写组，没有重跑两组或原生 App。

官方接口核验：[Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype)、[BrowserServer](https://playwright.dev/docs/api/class-browserserver)、[Apple NSRunningApplication](https://developer.apple.com/documentation/appkit/nsrunningapplication?language=objc)、[窗口信息](https://developer.apple.com/documentation/coregraphics/cgwindowlistcopywindowinfo(_:_:))。Context7 本轮不可用，官方一手资料与已安装 Playwright 1.64.0、macOS SDK 的实际编译/运行均已核对。

追踪隔离核对 [LangSmith 的 LangChain 追踪](https://docs.langchain.com/langsmith/trace-with-langchain)与实际安装 `langchain-core 1.5.5` / `langsmith 0.11.0` / `langchain 1.3.15`：环境开关可自动安装真实回调，检查显式等待 trace flush；本轮只处理合成正文与 owned loopback，不审阅真实追踪密钥，也不据风险推断历史数据已上传。

### 授权经验草稿页面（09）

管理页“Skill 待审核”按当前已确认联系人显示独立草稿。用户明确开启此联系人的经验整理后，才使用该模型用途；页面可核对私人依据、实际候选措辞、方法映射和范围建议，未审核草稿不进入回复。选择与复制不证明已发送。切换联系人、连接代际或发生来源／偏好／记忆／助手会话删除时先隔离旧状态，再从权威目录复验。

有限合成入口要求 `NOTALONE_LEARNING_EVIDENCE_DIR` 指向仓库外700目录，再执行 `npm run test:pages -- --case skill-learning --timeout-seconds 240`。父进程固定关键模块路径与SHA，隔离Python夹具核对实际加载路径、当前连续迁移和重复0；页面保留实际执行artifact与浏览器响应原字节。09本票运行的001–064结果、模型调用数与资源收尾见[09集成任务](../.scratch/memory-skill-integration-preparation/issues/09-learning-drafts.md)。脚本模型验证不证明真实模型质量、Electron或微信验收。

### 版本化旧资料升级页面（10）

管理窗口“旧资料升级”允许明确选择当前联系人或本人范围、消息与调用预算，先查看新旧差异，再勾选批次确认应用。比较卡片展示冻结算法协议和指纹；旧未知身份保持可回看，重新比较后才能应用。进度支持取消、按剩余预算恢复、合法撤销和删除工作副本；未知响应通过刷新重试原动作。原人工资料与旧版未知证明保留，来源或资料删除同步撤下受影响比较。

有限合成入口要求 `NOTALONE_UPGRADE_EVIDENCE_DIR` 指向仓库外700目录，再执行 `npm run test:pages -- --case memory-upgrade --timeout-seconds 240`。该组使用生产Main/preload/React控制器、隔离HTTP/PG和精确001–065迁移，记录实际加载的关键模块及执行资源摘要、数据库归属与退出结果；仅受控模型脚本替换外部调用。实际验证与未验范围见[10集成任务](../.scratch/memory-skill-integration-preparation/issues/10-versioned-memory-upgrade.md)，页面入口不代表Electron或微信验收。

### 同输入审核与范围发布页面（11）

“打开对照审核”支持方法编辑与显式保存、同一来话／当前意图／精确场景的旧新两侧对照，以及拒绝或暂留。用户核对事实、承诺、适用范围和方法替代映射后，双确认批准才发布不可变版本。方法、输入或范围变化会撤下旧对照；轮询保留未保存编辑，审核POST未结算时不取消原任务。未知写入结果保留原动作和 `operation_key`；来源、样本或关联资料删除先撤下审核内容，实际删除结算前不重新读取。

三种回复输入模式均提供可选的“本次精确场景”，空白不使用场景限定方法；场景来自用户声明，不从输入模式或来话推断。准备与执行共用冻结输入，同次重试、连续修改和中断恢复沿各自的权威原场景。A→B→A恢复各自输入和编辑，原任务晚结果仍属原联系人；连接变化清理缓存后重新核验。候选显示后端确认的实际Skill名称、版本号与范围，旧未知元数据不补成当前批准信息。

有限页面入口为 `npm run test:pages -- --case skill-review --timeout-seconds 300`，先激活Conda NotAlone并把 `NOTALONE_LEARNING_EVIDENCE_DIR` 设为仓库外700目录。该组核精确001–066迁移、重复0及真实加载模块SHA；单Chrome、单自有PG库，受控学习模型最多1次、回复模型最多9次、真实外部模型调用0。页面保留实际执行资源、数据库归属、失败原栈和清理证据；工程结果见[11集成任务](../.scratch/memory-skill-integration-preparation/issues/11-review-and-publication.md)。页面与Node验证不代表Electron、微信或真实模型质量已通过。

2026-10-16本集成候选的该页面1/1通过，实际受控调用为学习1次、回复9次，精确001–066、重复0；22个关键模块及276个实际加载模块核验通过。自有库已删除并核不存在、页面租约已解除，浏览器42次采样均未激活且屏上窗口为0；实际执行资源和来源原字节保存在端侧。相关纯Node回归175/175、`npm test`的类型／安全与探针构建搬运组65/65通过；实际App与微信未运行。

## 桌面验收与自动化测试

开发测试和验收时，按根`AGENTS.md`与[工程工作流](../docs/agents/engineering.md)主动使用可用的Computer Use，直接操作实际App和微信并核对结果；无需另行预约时段、申请启动次数或强制经过`test:app`。Agent负责桌面协调、测试数据隔离及收尾，用户无需代做重复操作。本节保留的`test:app`时间、预算和租约约束只属于该自动化runner；历史预约记录不构成当前Computer Use验收的前置要求。

前台切换延迟的只读能力核验：`native/macos/Diagnostics/SessionEventCapabilities.swift` 是独立开发诊断，编译至 `native/macos/build/diagnostics/session-event-capabilities` 后，显式设置 `NOTALONE_SESSION_EVENT_DIAGNOSTIC=1` 并通过有限 `test:app` 运行 `tests/native-session-events.spec.ts`。仅统计当前唯一微信的 AX 通知类别及前台切换次数；无 UI、无截图/OCR、无 AX 文本、无权限申请，最长 90 秒（预约优先）。注册成功不等于会话切换覆盖率，独立诊断的辅助功能准入也不代表正式 App；必须结合实际操作记录判断。它不属于产品启动或正文同步入口，计划与结果见[事件触发规格](../.scratch/foreground-event-trigger/spec.md)。

用户可视验收使用同一入口：先运行 `zsh -f native/macos/scripts/build_session_event_diagnostic.sh`（仓库根目录，仅编译和ad-hoc签名），再设置 `NOTALONE_SESSION_EVENT_PREVIEW=1`，通过有限 `test:app` 执行 `tests/native-session-events.spec.ts`。该模式显示非激活悬浮窗，最长90秒、最多一次启动；内部通知和进出微信分别计数，显示最近五条固定类别／启动后相对时间，并提供“这次切换有提示／无提示”和结束按钮。没有辅助功能准入、微信实例不唯一或注册失败时明确显示未验证，不申请权限；注册和反馈都不直接证明切换覆盖率，列表时间也不是实际切换延迟。不截图／OCR、不读取AX文本、CLI或业务库，不调用模型。关闭／到期注销监听并退出；生命周期用例通过与用户体验结果分开记录。

`npm test` 默认执行 TypeScript 检查、测试 CLI 的合成回归（`tests/scheduling/`、`tests/headless/command.test.mjs`）及自研探针静态构建/搬运与外置 CLI 的 Node 启动配置（`tests/helpers/probe.test.mjs`、`tests/helpers/external-cli.test.mjs`）：未协调调用拒绝、跨独立命令副本/TMPDIR 互斥、启动预算、到期、Ctrl+C/SIGTERM、崩溃与损坏租约，以及 Playwright 门禁和限定文件发现。调度的合成孩子固定为 Node；自研探针核查在 macOS 只编译和 ad-hoc 签名仓库源码，检查格式、架构、依赖和签名；外置 CLI 测试只加载合成配置，不执行工具。原始 Electron API 的拒绝检查也显式使用 Node 可执行文件，避免门禁回归时打开桌面。命令明确报告真实 App 未运行。这些结果不能证明窗口、业务 UI、后端 HTTP 接线、签名包或实机验收通过；安全目录从真实 App 全量中排除。

自动化Electron用例可使用下面的`test:app`命令，复用隔离夹具、进程追踪和互斥；Agent自行设置运行参数，无需用户批准时段或次数。Computer Use可直接操作实际App，选择启动方式时核对包与配置、隔离用户目录并记录自有实例，避免影响用户正常运行的App。

```bash
npm run test:app -- --interactive --coordinator main-agent \
  --from '<Agent设定的测试开始，带时区的 ISO8601>' --until '<测试截止，带时区的 ISO8601>' \
  --max-launches 4 -- tests/windows.spec.ts
```

该自动化runner要求开始时间已到、截止尚未到，两者间隔最多一小时，构建计入脚本运行时段；这些参数由Agent自行安排。给出最小相关的 `tests/<name>.spec.ts` 文件，可加 `--grep` 缩小用例和 `--output artifacts/<name>` 保存合成输出。每次 Electron 首次启动、重启和重复实例消耗脚本预算；单次命令失败即停，后续诊断与复验由Agent按实际需要继续安排。`workers: 1` 是单命令内部约束，自动化命令间互斥另由租约负责。最终集成可显式以 `--suite` 替代文件列表，给出适合该组的启动预算（最大250），协调各Agent避免重复执行完整回归。

租约位于 OS 用户账户目录中的 `.notalone-desktop-tests/interactive.lock`，使用 OS 用户信息而非 HOME/TMPDIR/userData 或工作树路径决定位置。目录、记录和本机 Unix socket 均核验所有者与私有权限，随机 token 只传给本 runner 的孩子，不写入记录或输出。主配置在 fixture 前检查活 runner；fixture 与独立启动/重启也检查随机 token、工作树归属、截止时间和预算。直接 `npx playwright test` 默认失败关闭；`--list` 只列出用例，不能证明运行。生产窗口的 show/focus 与正常快捷键行为保持原状，没有通过隐藏 App 或未知 headless 参数伪造静默 UI 验收。

到期或 Ctrl+C 先关闭新启动资格，再要求本 runner 的孩子收尾；App 守卫同时检查截止及活 runner。兜底只对本次 spawn/launch 返回且仍存活的 ChildProcess 发信号，强制回收不算产品认证停读通过。结束后还核验本轮进程组消失和启动登记归零；EPERM、疑似 PID 复用、未完成登记或其他不确定性都保留锁，不依据未知 PID 终止任何进程。runner 崩溃留下的锁即使到期也不自动抢占。

```bash
npm run test:app:status  # 只读租约归属线索，App 不运行，不自动解锁
```

`tests/app-test-expiry.spec.ts` 只在 `NOTALONE_APP_TEST_EXPIRY_ACCEPTANCE=1` 时执行，默认全量跳过。该场景故意等待调度时限到期，命令截止须在60秒内，由Agent设置；预期runner返回124，Playwright的interrupted不是普通PASS。收口须同时核验窗口ready、自有PID／userData回收及租约absent。2026-10-10已用保留的严格签名候选App完成上述到期检查；这不证明产品认证停读或完整App交付。

持续会话19／17收尾入口：普通页面用 `npm run test:pages -- --case assistant-session-combination --timeout-seconds 240`，串联双合成联系人、版本续改、新消息显式采用、权威恢复、硬预算、携入和会话删除；不运行Electron或OCR。多来源及后继／携入删除另由后端 `tests.integration.server.test_assistant_combination` 验证。

`tests/assistant-native-lifecycle.spec.ts` 默认跳过，只有显式设置 `NOTALONE_ASSISTANT_LIFECYCLE_ACCEPTANCE=1` 并经有限 `test:app` 门禁才运行。原生场景使用同一隔离userData与随机测试库，最多两次App启动、单场180秒：真实小窗关闭后生成继续，公开菜单退出停止未完成生成，迟到结果不得复活，重开只读显示中断，明确重试才生成。测试源App默认不等同最终签名包／Finder交付；微信CLI和OCR路径固定为本轮不存在路径，无外部模型或消息发送。2026-10-12该源App场在有限门禁窗口完整1／1通过（11.3秒、两次启动），真实小窗关闭继续、菜单退出中断、同目录重开零自动模型及明确重试均核验；最终自有进程／库／目录无剩余。此前三场测试失败与累计6次启动分别保留，实际命令和边界见[19最终收口](../.scratch/assistant-session-context/issues/19-combined-native-acceptance.md#最终收口2026-10-12)。

先激活Conda `NotAlone`，在用户认可的有限时段内使用以下入口；起止时间必须填写实际已认可的值，不以示例作为授权：

```bash
NOTALONE_ASSISTANT_LIFECYCLE_ACCEPTANCE=1 npm run test:app -- --interactive --coordinator main-agent \
  --from <已认可的ISO起始时间> --until <已认可的ISO截止时间> --max-launches 2 \
  tests/assistant-native-lifecycle.spec.ts --output artifacts/assistant-native-closeout
```

`tests/finder-package-acceptance.spec.ts`默认跳过，显式`NOTALONE_FINDER_PACKAGE_ACCEPTANCE=1`、最终包可执行文件及有限`test:app`活租约才预留一次Finder启动。主Agent实际CUA在Finder双击，读取最终包管理／配置、小窗打开／隐藏和公开菜单退出；只使用随机PG与独立配置，原默认userData仅元数据核验、整体暂存并按原身份恢复。App／后端退场不确定或目录改变时保留备份／库／租约，不清理未知资源。协调等待5分钟、整场8分钟，预约截止优先，不新增产品启动参数或权限。

2026-10-12当前`b6fed39f`产品源码的本机arm64 ad-hoc包已离线构建、运行前后严格验签，6份ASAR资源匹配当前dist，4份helper哈希／架构／签名通过。同一包生命周期1／1（14.4秒、两次启动）和真实Finder整场1／1（约2.1分钟、一次启动）通过，原目录恢复且资源清理；第一场Finder协调超时独立保留，本轮累计4次启动。归档及具体命令见[任务20结果](../.scratch/mac-desktop-app/issues/20-mac-app-delivery.md#2026-10-12-当前签名包与finder启动收口)和[摘要](../.scratch/unfinished-work/final-package-finder-20261012.json)。OCR／微信保持暂停，完整交付、WCDB精确构建／许可及Developer ID／公证分发没有由本场代签。

`tests/native-desktop-acceptance.spec.ts` 默认全量跳过，显式 `NOTALONE_NATIVE_DESKTOP_ACCEPTANCE=1` 启用人工模式，`NOTALONE_AGENT_NATIVE_DESKTOP_ACCEPTANCE=1` 启用主Agent实际桌面操作模式，两者同时启用时拒绝。必须通过上述预约门禁，并以 `NOTALONE_TEST_APP_EXECUTABLE` 指定实际签名包可执行文件。沿用隔离导入夹具的真实 HTTP/PG 与合成资料，等待现场操作真实系统文件选择器和两次系统快捷键，不替换文件选择结果或调用快捷键回调。文件选择最多等待3分钟；人工模式两次操作及对应反馈共用固定25分钟交互截止、单场28分钟，Agent模式保持单场8分钟、窗口观察3分钟、收据90秒；测试总时限与runner预约截止均优先于分段等待。观察到窗口状态后仍等待对应actor的真实收据，两次都确认后才正常菜单退出，退出后系统快捷键注销。缺失、否定或非法反馈均不算通过，失败或预约到期仍按门禁收尾。

协调者从日志所列 `human-show-request.json`／`human-hide-request.json` 读取本轮 `requestId`、操作、`observationUntil` 与随机 `responsePath`；恢复协调时先核验已知App仍存活、阶段及预约未过期。程序观察完成后另写`shortcut-human-...-observed.json`的时间及收据截止；该记录不代表用户确认，不作为响应收据。只在收到对应用户反馈后向该自有路径原子写入 `0600` 收据：`{"requestId":"本次请求标识","confirmed":true}` 或 `false`。Agent请求使用 `agent-...` 文件，收据严格为 `{"requestId":"本次请求标识","performed":true,"observed":true}`，必须有主Agent实际系统按键及窗口观察，不能代签用户认可。收据只存布尔结论，不存用户原话；未答、含糊回答或机器窗口状态不得写成用户确认。不同操作各有随机请求，旧收据不能复用；不允许符号链接、非普通文件或超过1 KiB的响应。2026-10-12同包Agent场未唤起，人工最小场显示超时且用户随后明确按键发生在App退出后；两场均未形成快捷键整场验收。随后复验已由程序观察显示、用户也在退场后确认显示，但4分钟收据等待先超时，隐藏未运行；详见[第二场人工摘要](../.scratch/unfinished-work/mac-delivery-human-shortcut-retry-20261012.json)。旧版或显示分项结果不代替新版人工隐藏／退出验收。

2026-10-10 15:23–15:43（UTC+8）的第二次有限现场预约最多启动 2 次。官方输入候选签名包的 `candidate-copy` 与上述原生场景实际 2/2 通过：真实剪贴板、单文件选择及 6 条合成消息的导入/任务核验成功。用户确认第一次物理 `Command+Shift+Y` 唤起；程序随后观察到同一小窗隐藏后正常退出，15:30:34 的收尾记录确认 App 已退出，用户反馈“现在小窗都不能呼出来了”，隐藏体验仍未获人工确认。本轮末次 PID、userData、夹具目录已回收，租约 absent；没有运行真实微信、外部模型或 Finder。原始结果与分开的人工反馈保留于 `artifacts/native-system-20261010-1523/`；任务 20 继续未完成。

状态文件和 PID 只提供线索。出现 `app_test_locked`、`app_test_lease_unsafe` 或 `app_test_cleanup_unconfirmed` 时，主 Agent 必须先核验上轮自己创建的资源已收尾；未知归属时继续暂停，不能以删除锁或按进程名 kill 继续测试。恢复旧工作树之前必须先合入最新集成提交并审计新增启动路径；尚未合入门禁的旧脚本不会被机器租约自动拦截，暂停/恢复由主 Agent 协调，不新增常驻监控。

原 [App/HTTP 测试接缝](../.scratch/mac-desktop-app/spec.md)继续保留。真实UI项优先由可用Computer Use实测；能力不可用时说明具体缺口并保留未验证，不用DOM检查替代原生证据。以下测试组说明的是既有约定和已实现夹具范围，安全CLI通过不会更新其实际App验收结果。

包含真实 Python 宿主的测试需先激活 Conda `NotAlone`。测试使用当前工作树的 `backend/src`，隔离 dotenv 的读取和写回、握手、owner、模型、CLI/探针和 App 配置。测试准备阶段只对自己随机新建的 `_test` 库显式迁移，App 始终运行真实只读诊断；完成后只清理本轮拥有的库。数据库不可用场景使用受控回环端口，其他生命周期场景使用已迁移的隔离库，不连接已有数据库。

`tests/setup.spec.ts`、`tests/setup-stale.spec.ts`、`tests/setup-recovery.spec.ts` 与 `tests/setup-concurrency.spec.ts` 使用本轮随机 `_test` PostgreSQL 库、正式迁移和真实 `notalone.server.command` / HTTP。受控解释器夹具只从独立 `synthetic.env` 加载本轮本人与合成密钥，继续禁止默认 dotenv，并把模型 URL 固定到无服务的回环端口；CLI 与探针使用不存在的本轮路径。覆盖首次初始化、既有配置、缺失或不存在的运行身份、密钥保存失败、启动失败恢复、经验证的复用服务重启、具名 IPC 限制与迟到响应失效；新增响应丢失后的明确重载、失败刷新失效，以及同库两个真实客户端并发初始化。延迟夹具只控制真实后端的 HTTP 传输，PG 锁只安排并发写入窗口，不替换业务仓储。测试完成只清理本轮库、配置和进程，不调用真实模型或微信。

`tests/contact-*.spec.ts` 同样使用随机新建、正式迁移的 `_test` 库及当前工作树真实 HTTP，包含两个合成联系人和同库另一 owner。验证真实统计、本人就绪与空列表、两窗选择、目录外 ID 与过期草稿拒绝、隐藏恢复、A→B→A 清空、断线/连接更换撤销旧成功和失败、相同 userData 重启清空；延迟目录只在本轮回环传输边界安排，不替换联系人业务模块。目录外参数无法从 UI 构造的场景经过公开具名桥接，结果仍核验真实两窗；不使用私有会话模块或通用 renderer 请求。草稿、截图与测试输出均使用合成文字，只清理本轮创建的库、配置、握手与进程。SSE 的联系人失效验证由任务 19 延续。

`tests/draft-rewrite.spec.ts` 与 `tests/rewrite-*.spec.ts` 使用真实生产回复装配、LangChain 调用、HTTP、随机 `_test` 库和正式持久化，只把外部模型替换成可捕获输入的受控模型。两个本人联系人、另一 owner 的资料和有效绑定均为合成准备；不证明绑定 UI、真实微信或模型语义质量。覆盖默认不读取历史、明确开启后的联系人范围、真实 1–3 候选/风险提醒/原文快照、编辑与选择、真实响应丢失后的幂等恢复、新输入和重新生成、实际绑定撤销拒绝、真实超时/失败、迟到结果失效、隐藏恢复、重启清空与受限桥接。延迟和丢包只安排真实回环 HTTP 传输，模型故障仍经过真实运行时与错误契约；不替换业务仓储、不读取剪贴板或微信，不访问供应商服务。

任务 09 最新普通页面验收 `draft-rewrite-acceptance` 为 9/9 green（单个无头 Chrome、真实隔离 HTTP/PG）；首轮最后一场景因页面尚未初始化而失败，补齐公开控件可见等待后末轮通过，不能称业务缺陷的 red → green。生产控制器正常停读后在同一 userData 新建会话，不恢复草稿、编辑、语气和本次要求；该结果不证明原生 App 重启、隐藏/恢复、剪贴板、签名或真实模型质量。完整评审与修复增量均已清零，任务 09 的普通页面条件已 resolved；P3 共享场景修复只另跑新会话 1/1，与此前完整 9/9 分开记录。任务 09 的历史 9 条 App 行为已通过；首轮完整回归为 95/96，旧占位按钮断言已修正，末轮完整回归在用户要求解决桌面干扰时中止为 21 passed / 75 did not run（exit 130）。用户随后选择只继续不触桌面的工作：当前保留原实现，合入门禁并把独立重启改为 `launchApp`；类型与构建通过不更新 App 验收结果。候选单选、标签布局/快照措辞及联系人条件已由本轮普通页面验收；门禁下的原生 App 重启与最终签名 App 仍待后续预约，不能称完整 App 回归通过。详见[任务 09 记录](../.scratch/mac-desktop-app/issues/09-draft-rewrite.md)。

`tests/import-preview.spec.ts` 由实际 App 选择、预览、手动确认与取消，连接同一真实 HTTP／随机 `_test` 库。自动化只替换必要的系统文件选择返回，不替换导入业务；覆盖有效单联系人资料、损坏、混合联系人、群聊、多本人、库内身份冲突、文件内容变化、换文件、换归属和双窗口迟到结果。任意路径和目录外联系人经过公开具名桥接拒绝；无正文、完整路径或摘要交给渲染层。门禁引入前源码 14 项预览及全组 101 项已有历史通过记录；后续不触桌面的构建签名产物按原源版本保留，UUID 去重只检查类型与 build，没有重打包或运行 App。真实系统文件选择器与签名包 UI 列为任务 20 的待实机项，等用户安排验收时段；自动化中的必要对话框 I/O 替代不能证明这两项通过。

关系资料页的只读链路读取当前联系人有效记忆、当前本人有效记忆、当前联系人 pending 候选和来源目录。`auto` 展示为“自动采纳（可撤销）”，`manual` 展示为“手动采纳”，pending 明示不是已确认事实；来源聊天时间、保存时间和有效期分开，未知或不完整时间不补造。来源目录只解析实际匹配的来源记录，其余消息、观察或人工引用保留未知说明；已有版本和候选引用可展开，当前公开接口没有完整历史正文。各栏独立加载和重读，连接、联系人范围或更新的读取操作会废弃旧响应；业务 SSE 尚未接入；管理页的具名编辑与删除行为见下段。

`memory-reading-full` 与 `memory-stale-full` 分别验证九个资料/独立重读/真实空结果场景和六个迟到成功/失败场景，每场景使用新随机库与页面上下文。原十条 App 用例的公开页面断言共用；四栏加载、失败和独立重读只安排真实回环传输，旧操作的公开 refresh Promise 完成后才核对可见页面。当前两组 15/15 green，单个无头 Chrome、85 次自有进程静默采样未见激活或可见窗口，真实资源收尾确认、两租约 absent；固定候选完整双轴 Standards hard 0 / possible 0、Spec P0–P3 全 0，任务 13 的普通页面条件已 resolved。首次完整组仅因相同保存时间命中两张卡的旧选择器而失败，限定对应记忆卡后通过，生产源码没有变化。实际 App、签名和原生能力仍须各自验收。

关系资料管理页支持补充本人或联系人资料、修正当前版本、单条删除、撤销自动采纳，以及确认或丢弃待确认候选。补充与确认均沿用 `manual`，候选 `self` 保存到本人、`contact/shared` 保存到当前联系人。本人修正在一个后端事务中创建新 ID/manual 版本、引用旧版并使旧版退出当前上下文；不覆盖历史回复依据快照。撤销自动采纳调用既有删除接口，不删除来源消息，不承诺恢复。所有写操作仅允许管理页的具名能力，范围或版本失效必须重读；提交后受影响列表核对失败不显示成功，连接或联系人变化会废弃旧操作结果。

任务 14 最新普通页面验证在源 `3a9be09` 上完成：`memory-editing-full` 12/12、受影响 `memory-reading-full` 9/9 与 `memory-stale-full` 6/6，单 CLI 最多两组、deadline 240 秒、每组串行独立随机库/上下文，单 Chrome，quiet active/window 0、资源正常收尾且两 leases absent。相关后端 12 模块 123/123 通过，外层 HTTP 夹具认证 stopped/exit 0、精确本轮库缺席。旧回复依据与新生成上下文的真实 HTTP 回归已通过，模型只在外部 provider 边界返回合成结果。首次新增迟到测试因断言请求也被自身代理挂起导致 deadline/cleanup_unconfirmed；该轮不记通过，主协调核验并回收唯一已证明的后端与库后单独安全释放租约。后续夹具 HTTP 有五秒可取消超时，运行器持续保存自有进程身份；修正后四种迟到场景与最终完整组正常通过。评审只要求合并六入口的夹具生命周期，`2b604fd` 完成提取，`60053895` 的必要本人修正页面回归 1/1 通过。最终 Standards hard0/possible0、Spec0，任务 14 完成普通页面与后端范围；原生 App、剪贴板、微信和真实模型质量仍须另行验收。

`tests/memory-reading.spec.ts` 与 `tests/memory-stale.spec.ts` 已准备上述公开 App 用例，包含 A→B→A、同范围重读、连接失效、独立失败和受限参数。夹具使用当前工作树真实 HTTP 与随机 `_test` PostgreSQL 库，仅延迟或拒绝本轮回环传输来安排迟到结果。**本轮实际 App 用例未运行，其原生生命周期与签名验收仍待认可时段**；上述普通页面 green 覆盖当前资料 React 交互与真实隔离 HTTP/PG，不代表完整 Mac App 或微信渠道验收。类型检查、构建和历史夹具 HTTP 自检不能单独替代页面验收。`tests/fixtures/memory-database.py check-http` 在激活 Conda `NotAlone`、显式禁用默认 dotenv 并指定本轮独立 `synthetic.env`/握手路径后，可只核验合成数据的公开列表契约与隔离；它不启动 Electron，不读取真实微信、剪贴板或私人资料，不调用模型，结束后认证停读并只清理自己创建的后端、临时目录与库。

任务 08 的 `tests/import-submit.spec.ts` 与 `tests/import-submit-stale.spec.ts` 已准备公开 App 操作：正式保存、真实五步任务、原失败任务恢复、文件变动拒绝、取消/换联系人/换连接后的迟到成功与失败、保存响应丢失后重新确认，以及首份渠道身份后的明确认证停读重启。合成模型仅替换外部 provider，HTTP、持久任务、调度、回复范围与 PostgreSQL 使用生产模块；文件选择只替换必要对话框 I/O。普通页面在源 `60301e84` 完整12/12通过；准备失败精确清理修复后，源 `c21b05ef` 的损坏JSON与正常首份导入两项通过，精确库残留0、cleanupConfirmed=true、两租约absent。独立双轴最终hard0/possible0、Spec0，任务08完成普通页面范围。这些 App 用例、真实系统选择器与最终签名包仍待任务20验收，没有本轮原生通过或真实微信／语义质量证据。首份身份不会自动授权同步，用户明确重启只沿用既有开关与确认范围。

无桌面 HTTP 检查可以单独执行，入口自动隔离 dotenv 读写、握手、模型、CLI/探针，随机创建 `_test` 库并仅迁移和清理该库：

```bash
conda activate NotAlone
NOTALONE_DISABLE_DOTENV=1 PYTHONNOUSERSITE=1 PYTHONPATH="$PWD/backend/src:$PWD/backend:$PWD/desktop/tests/fixtures" \
  python desktop/tests/fixtures/import_http_check.py
```

以上命令从仓库根目录执行，Conda 未初始化的 shell 须先加载其 `etc/profile.d/conda.sh`。它已验证同 body 新建重放与并发复用原 contact/task，结果为零新增与原消息数重复，名称/文件/owner/确认方式/来源状态/撤销身份的拒绝，原任务失败恢复与前台回复优先调度；不能替代桌面或微信集成验收。HTTP 首份导入以 owner 行 UPDATE 锁串行，CLI 仍遵循原 owner KEY SHARE 与本人渠道身份 UPDATE 锁；重放额外锁定原渠道身份、联系人、来源与确认记录，不把 HTTP 的锁约束称为所有入口的同一行为。

`tests/binding-consent.spec.ts`、`tests/binding-stale.spec.ts` 通过实际 App、当前工作树生产启动命令及真实 HTTP 使用随机 `notalone_binding_<UUID>_test` 库，正式迁移只作用本轮库。夹具明确 seed 合成 Owner 渠道身份，并以独立的合成 CLI 可执行文件替代微信；它不证明 setup→首份导入→重启的首用完整链路。覆盖未预选/刷新/群聊排除、同名 UUID 选择、新建与追加、开关已开时新增读取、改名/消失/冲突重确认、撤销取消/超时重试/成功后零新增 tail、CLI 与本人渠道缺失、受限桥接与旧连接成功/失败失效。等待只在合成 CLI 进程与回环传输边界安排，数据库与同步业务模块保持真实。可对签名包运行同一测试；没有读取真实微信、模型、私人配置或业务库，也没有使用 CGEvent。

使用 Playwright 的 experimental Electron 支持，在真实窗口上操作公开按钮和原生关闭/菜单。测试使用独立随机用户数据目录并正常回收进程；不读取 React 私有状态，不访问已有业务数据。构建源码资源与打包 App 共用同一行为测试：

```bash
NOTALONE_TEST_APP_EXECUTABLE="$PWD/out/NotAlone-darwin-arm64/NotAlone.app/Contents/MacOS/NotAlone" \
  npm run test:app -- --interactive --coordinator main-agent \
    --from '<预约开始，带时区的 ISO8601>' --until '<预约截止，带时区的 ISO8601>' \
    --max-launches 4 -- tests/windows.spec.ts --output artifacts/packaged
```

窗口测试验证双窗口打开、关闭隐藏、互相恢复、菜单恢复、整体隐藏后仅恢复目标窗口、退出回收，以及随包 logo 加载和真实未就绪状态。macOS 的 `hide` 菜单角色由 Cocoa 执行，`MenuItem.click()` 不执行该默认动作；自动化确认公开菜单项后，通过 `Menu.sendActionToFirstResponder('hide:')` 执行原生隐藏，再操作窗口菜单并读取两窗可见结果。实际 CUA 点击菜单另行核验同一边界。后端测试通过公开 App 操作和本机 HTTP 核验单实例、受控启动/复用、认证、断线重试、握手非法或变化、迟到状态、退出失败/超时与恢复；包含实际 `notalone.server.command` 和 `BackendServer` 的启动/停读场景。入口资源故障只修改隔离构建副本，不损坏签名包。

`tests/desktop-controls.spec.ts` 验证注册结果、改键与重启恢复、注册/保存失败保留旧键、正文置顶按钮、隐藏恢复及退出注销。注册失败场景在隔离启动包装中先安排系统注册，再同步加载原始 App 入口；只控制必要系统边界，不替换业务模块，不调用快捷键回调，签名包跳过该夹具。截图在 `test-results/` 或指定 `artifacts/` 目录中，均不提交。这些自动验收不证明全局键盘派发、联系人隔离、剪贴板、权限或真实微信渠道可用；另行完成的两次系统按键实机结果见[权限与验收台账](../docs/macos-app-permissions-and-errors.md)。

`tests/startup-diagnostics.spec.ts` 验证 Python/包缺失、数据库不可用、缺基线、账本漂移、待迁移和必要结构缺失，以及公开路径修正和重试。真实只读 Python 入口与实际 `BackendServer` 均来自当前工作树。App 以 `/` 为工作目录、清空 Conda 变量并限制 PATH，检查无需预先激活终端的启动条件；这项自动化不等同于用户在 Finder 双击的实机验收。`tests/startup-cancellation.spec.ts` 在受控 Python 包装边界延迟诊断并忽略 SIGTERM，验证超时/退出回收自有子进程、迟到结果不能启动后端；释放后仍执行真实诊断入口。

`tests/startup-setup.spec.ts` 联合真实首启 HTTP 与本轮迁移库，验证账本漂移同时阻止既有运行时复用和初始化后的重启，修正测试条件后由公开操作恢复；路径停读未获确认时，配置保持不变且不另起服务。测试只故意修改并恢复本轮已执行的账本 checksum，不提供业务库补写记录或恢复工具。

`tests/startup-path-recovery.spec.ts` 分别验证项目目录不可访问和有效目录内缺少后端源码的提示及修正。机器 schema 检查包含 setup 状态查询依赖的 `owner.created_at`；本轮测试库故意缺列时先阻止启动，测试准备恢复后再从 App 重试。失联恢复用例仍操作原真实后端，不能把断线当作已停读。

## 非秘密启动配置与退出

2026-10-12焦点分项准备：`tests/native-focus-acceptance.spec.ts`沿受限`test:app`和同一签名候选包，用空隔离启动配置、不提供Python／项目路径，保持后端未连接，CLI／探针指向本轮不存在路径。先隐藏管理后台和小窗，主Agent把自有空目录的Finder窗口置于前台并写独立Agent收据；真实键盘显示／隐藏用另外两组nonce和对应actor收据。只读记录同helper的可见／焦点、两窗身份及管理窗口保持隐藏，再通过公开菜单确认App正常退出。

这个最小场景不重复系统导入，不代签真实微信／后端停读，也不把“没有NotAlone窗口取得焦点”写成系统必然恢复原外部App。人工模式两次操作及反馈仍共用25分钟交互截止、整场28分钟，实际运行由主Agent声明有限窗口／启动数；准备的类型检查和纯收据3／3不证明真实焦点分项通过。协议协调从原native场抽为共享测试辅助，产品、当前包和原native验收行为保持。接口核对依据官方[BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)及[Playwright ElectronApplication](https://playwright.dev/docs/api/class-electronapplication)，与安装Electron44.7.0／Playwright1.64.0类型核对；实机仍待本场结果。

2026-10-12焦点分项实机收口：同一签名包复验在16:50:47–17:20:47有限`test:app`窗口实际1次启动，**1／1、585.149秒／exit0**。管理后台先隐藏，主Agent实际置前自有空白Finder；用户实际两次Command+Shift+Y及分别明确反馈，程序确认同一小窗显示且focused、第二次隐藏、后台保持隐藏和两个窗口身份，公开菜单正常退出。三组Agent／真人nonce分开，机器状态不代签；系统是否恢复原外部App焦点未认证。首场实际1次启动，用户用按钮／关窗隐藏，收据拒绝、exit1／767.591秒，失败独立保留。

Root核对两场20个记录进程、隔离目录及自有Finder窗口／目录清理，两租约absent；复验默认目录身份、主包strict／4helper strict与SHA／9材料集合／ASAR／ZIP保持。首场默认目录基线缺对应路径，未认证该场默认身份前后不变，后场重新录基线且不读正文。没有后端、业务库、微信／官方helper／OCR、模型、权限／TCC或退场后的NotAlone CUA操作。当前同包非OCR完整场景累计22个，见[焦点最终摘要](../.scratch/unfinished-work/mac-focus-final-20261012.json)；准备与旧失败不覆盖，完整20票及来源／渠道／OCR条件保持，新功能冻结。

主进程读取当前 userData 中的 `backend-launch.json`。在“应用配置 → 机器环境”可查看、修正和保存下列非秘密绝对路径。Python 和项目目录必须同时提供；没有可核验的项目环境时阻止启动和复用，显示恢复说明：

```json
{
  "pythonExecutable": "/绝对路径/Conda环境/bin/python",
  "projectDirectory": "/绝对路径/NotAlone",
  "envFilePath": "/绝对路径/受控配置.env",
  "backendInfoPath": "/绝对路径/backend.info",
  "wechatCliPath": "/绝对路径/wechat-cli",
  "syncProbePath": "/绝对路径/notalone-sync-probe"
}
```

未保存时，`envFilePath` 默认使用所选项目根目录 `.env`，`backendInfoPath` 默认使用 `~/.notalone/backend.info`；受控运行可用 `NOTALONE_ENV_FILE` / `NOTALONE_BACKEND_INFO` 提供初始值。已保存路径优先于这些初始环境变量。CLI/探针可留空，显示对应渠道不可用；诊断只检查可执行文件，不运行 helper，缺 helper 不阻塞独立的后端配置能力。保存文件只含路径，不含配置内容、模型密钥或握手 token。

诊断固定调用已核验的绝对解释器及 `-m notalone.startup_diagnostics --migrations ...`，诊断就绪后才允许 `-m notalone.server.command`；两者从所选项目的 `backend/src` 加载代码，不依赖 Finder 的 PATH、工作目录或其他 checkout 的 editable install。只读入口使用有界连接和 READ ONLY 事务，仅核对必要 schema 元数据、审计基线与迁移账本，不读取联系人/聊天正文、不迁移或接管业务库、不创建参考库。只读结果为 `migration_pending` 时，另一个受控步骤按[原库结构补齐](#数据库沿用与结构补齐)执行缺少版本并复验；诊断本身保持只读。缺基线、文件或账本漂移、必要结构缺失继续阻止连接，不用新空库绕过。机器就绪与本人身份/模型首启分开显示。

主进程确认没有持有运行时或未完成的启动任务时，才允许直接保存。连接查询失败产生的“尚未连接”仍可能持有原服务；此时先点击“停止服务以修改路径”，通过原已验证目标认证确认停读并等待服务退场，才恢复路径编辑。失败保留旧目标、原路径和停读恢复入口，不能保存新路径或另起后端。保存与新连接串行，落盘前再次核验资格；保存不会自动连接。点击“重新检查并连接”重新经过只读门禁，重复重试不会启动多个后端。

握手必须是当前用户拥有、没有组/其他用户访问权限的普通文件，拒绝符号链接、重复字段和非法 `127.0.0.1:1–65535` 地址。HTTP 不跟随重定向，不向界面转发原始错误、stdout/stderr 或 token。认证 POST 返回 `state: stopped` 后可以退出；响应未确认时只向原连接查询状态。断线、超时和子进程消失都不能代替停读确认。退出失败会打开管理后台并保留“重试停读并退出”；不启动新读取，不改持久同步开关。只回收本 App 创建并仍持有身份的子进程，不根据握手 PID 杀复用实例。

握手和启动配置以非阻塞方式打开后再核验普通文件，拒绝符号链接；FIFO 不会卡住连接或退出，启动配置限制为 8 KiB。正常连接阶段的明确重试会重新认证最新合法握手，成功后替换连接；退出开始后则固定原已验证目标，认证中的新握手不能改变关闭目标。连接中明确退出会取消尚未发生的启动，并在最终 spawn 前复查；已创建的子进程仍等待握手、认证确认与受控收尾。

## 工程边界

| 目录 | 职责 |
| --- | --- |
| `src/main/` | 窗口、菜单、资源、单实例、全局快捷键和非秘密桌面设置；`startup/` 管理路径、只读机器门禁与受控原库结构补齐，`backend/` 管理启动、握手、认证 HTTP、连接与退出状态；`contacts/` 管理两窗本次联系人和草稿，`imports/` 管理单文件预览、一次确认、提交与持久任务进度，`reply/` 管理本次改写、幂等和编辑状态，`memory/` 管理资料查询、具名编辑及范围/版本失效 |
| `src/preload/` | 具名窗口、桌面设置、联系人、历史预览、改写、资料查看和后端桥接及非秘密状态订阅，不暴露通用 IPC、URL 请求或认证信息 |
| `src/renderer/` | React 界面、交互与展示状态 |
| `src/shared/` | 跨进程桥接类型 |
| `tests/` | 实际 Electron App 公开行为自动化、统一启动门禁；`scheduling/` 只验证安全命令 |
| `scripts/` | 本地资源编译、白名单打包、图标与 ad-hoc 签名、安全检查和预约测试租约 |

历史预览的公开具名桥接为 `imports.getState()`、`chooseFile()`、`setTarget(target)`、`preview({ selectionRevision })`、`confirmPreview({ selectionRevision })`、`cancelConfirmation({ selectionRevision })` 和 `onStateChanged`。渲染层只持有展示数据与本次选择版本。任务 08 的主进程提交操作调用 `ImportController.takeConfirmedSelection(selectionRevision)`，返回 `{ generation, body }`；`body` 包含本轮系统选择的 `path`、`expected_content_sha256` 和二选一的 `contact_id`／`new_contact_name`。该方法同步核对连接 generation、两窗联系人范围及选择版本，并立即消耗确认；提交前再次核对 generation 后，以 `BackendHost.requestJson` 调用 `POST /api/imports/commit`。提交失败或取消必须重新预览确认，不能缓存 body 作为重试授权。服务器从一次读取的同一文档校验摘要、规范化并原子写入，内容不同返回 `409 / import_file_changed`，预览身份冲突返回 `422 / import_identity_conflict`；旧 HTTP 调用的摘要参数仍为可选。

正式导入新增 `submit`、`refreshTask`、`retryTask`、`runTask`、`reloadSyncHost`，均只接受 `{ selectionRevision }`，仅管理窗口可调用。主进程从真实 commit 取得 contact/task 后刷新目录、来源和原任务；渲染层不能传路径、body、摘要或任务 UUID。重试先恢复原失败任务，再明确启动同一任务，保留成功步骤；任务进度只按持久 status/step/count 展示，最终完成要求五步均成功。停止查看只废弃本次窗口结果，不宣称撤回已落库资料。

渲染层开启 context isolation、进程沙箱、关闭 Node 集成；正常界面只从受控 `notalone://app/` 资源加载，设置 CSP、拒绝导航/新窗口/网页权限。主进程校验桥接的窗口、主框架、精确资源来源、参数个数和类型。入口资源失败时使用无脚本的安全中文说明页，来源校验拒绝它调用桥接；可从原生菜单重试。临时界面会话使用内存分区；默认应用配置目录是 `~/Library/Application Support/NotAloneDesktop`，与历史 App 分开；`desktop-settings.json` 只保存 `helperShortcut`，不保存草稿、候选、置顶状态或业务资料。

联系人、导入、数据库、记忆、检索及候选生成由 [Python 后端](../backend/README.md)提供。平台原生截图、OCR 与会话定位由 [Mac 原生探针](../native/macos/README.md)提供，Windows 平台适配尚未实现。

新 UI 继续遵守[产品边界](../CONTEXT.md)：用户确认联系人与读取范围、查看并编辑候选、亲自发送；后端接入后桌面退出必须停止本次后台读取。原 Swift 主界面已按 [ADR-039](../architecture/adr/039-retire-swift-main-interface.md) 退役，新宿主边界见 [ADR-040](../architecture/adr/040-electron-dual-window-host.md)。

已核对的官方接口资料：[Electron 安全](https://www.electronjs.org/docs/latest/tutorial/security)、[BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)、[原生菜单](https://www.electronjs.org/docs/latest/api/menu)、[App 生命周期](https://www.electronjs.org/docs/latest/api/app)、[全局快捷键](https://www.electronjs.org/docs/latest/api/global-shortcut)、[系统文件选择器](https://www.electronjs.org/docs/latest/api/dialog)、[拖动区域](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)、[资源协议](https://www.electronjs.org/docs/latest/api/protocol)、[打包器](https://electron.github.io/packager/main/)、[Playwright Electron](https://playwright.dev/docs/api/class-electron)。调度修复没有可用 Context7，回退核对 [Playwright 配置](https://playwright.dev/docs/test-configuration)、[Node Unix socket](https://nodejs.org/api/net.html)、[ChildProcess](https://nodejs.org/api/child_process.html)、[OS 用户信息](https://nodejs.org/api/os.html#osuserinfooptions) 和 [文件打开标志](https://nodejs.org/docs/latest-v25.x/api/fs.html#file-open-constants)。本轮实际 Node 25.2.1、安装的 Playwright 1.64.0 / Electron 44.7.0 与锁定文件一致；Playwright 的脱离进程组行为也与安装版本源码核对，只用于保守的归属探测，不据此终止未知组。前期真实 Electron 已有独立验收记录，本轮仅通过安全命令/类型检查，文档不能替代预约 App 验收。

### 2026-10-12 最终包真实CLI退出分项

`tests/real-sync-quit-acceptance.spec.ts`默认跳过，仅显式`NOTALONE_REAL_SYNC_QUIT_ACCEPTANCE=1`、私有`NOTALONE_TEST_REAL_SYNC_SCOPE`与有限`test:app`运行。只由主Agent协调既有唯一联系人，隔离随机_test库、userData／握手和合成身份，明确关闭dotenv／模型／追踪，probe为不存在路径。解释器夹具复用真实生产服务与认证HTTP，只在CLI进程接缝拒绝越界参数／输出；sandbox仅devNull可写，真实CLI/WCDB固定同包字节。管理页会话列表请求拒绝且不执行，不能代签列表或新绑定。

整场1／1、报告1.2m／exit0：Root实际置前空Finder及独立收据之后，正式后台线程新的tail启动并完成有效来源读取；正常菜单退出、原token stopped、自有后端和CLI退场、5秒无新增启动。类型与相关62／62合成检查通过。首两场脚本失败保留，三次受控启动、自有资源全部清理，包／签名／默认目录身份保持，见[独立摘要](../.scratch/unfinished-work/mac-real-sync-quit-final-20261012.json)。同包完整非OCR场景累计23，不认证新消息来信、双联系人、整个间隔外部App持续前台、模型质量或OCR；完整Mac20仍未收口。

## 2026-10-14 自动前台定位

按 ADR-049 的窗口边界、ADR-050 的单帧语义和 ADR-052 的顶部名称修订，正式 session 每轮只取得当前前台唯一微信窗口一帧，在内存分析布局，仅将顶部名称送入本机 OCR，与名称预览共用实现。移除用户校准与校验坐标菜单，不再依赖 `foreground-layout-profile.json`；旧 CLI 校准仅保留历史诊断，不能代替新入口验收。新宿主显式传入 `--single-frame`；成功输出 `automatic-header-v3` 和 `captured_at`（图像取得时的 UTC 时间），顶部质量包含完整性与置信度，不伪造左侧名称。新观察兼容旧单帧v2，其他旧协议及预览协议不能自动确认联系人。

识别后不再采第二帧；保留不采图的前台、窗口、几何与质量检查。同窗切换可能要下一轮才发现，助手明确展示采集时的会话语义，确认结果的 `observed_at` 使用原始采集时点。失焦、采集中移动或未知布局仍拒绝；正式匹配要求完整顶部名称、至少0.90置信度、有界CLI核验的唯一私聊和已有确认绑定；当前有限预算按下方ADR-056修订。首次、改名、重名或身份失败仍要求选择。当前适配微信4.0.6/29387，未知版本失败关闭。原单次入口见[任务01](../.scratch/foreground-contact-follow/issues/01-single-frame-locator.md)，顶部修订与实测分别记录在[集成续接](../.scratch/foreground-contact-follow/app-integration-18.md)；新版正式App匹配与耗时由06验证，不能把预览反馈或合成测试视作正式App实机通过。

正式助手会显示“微信会话”与实际识别文字、置信度。未绑定或低分时也能看见读到的名称，但仍需选择对应联系人。按ADR-053，例行刷新保留未过期的上次结果与提示，并展示采集时点；名称最多保留至原采集时点后五秒，暂停或失效立即清名。读准名称而等待联系人选择使用正常两秒间隔，质量或技术失败仍按四／八秒退避；两秒为本轮结束后的等待，不是识别总耗时承诺。此显示只在本机认证HTTP和界面内存中流转，不保存为联系人身份或日志。

按ADR-054，仅采集时前台／窗口／尺寸变化的三个明确错误不再新增永久人工门；当前变化帧仍拒绝并撤销生成资格，保持技术退避。新版顶部观察的上下文变化使用明确错误码，旧含义较宽的布局错误继续人工确认。下一轮须重新通过完整名称、置信度、唯一私聊与已有有效绑定校验后自动恢复，或跟随新观察对应的另一个已有绑定；不复用旧资格。低分、重名、未绑定、其他错误和此前已存在的人工门保持。界面在临时变化期间显示等待重新识别，修复包实际恢复效果仍须后续有限场次验证。

ADR-056另允许可信后端客户端收到固定409 `foreground_observation_busy` 后等待下一轮可靠绑定恢复；繁忙当轮清名并禁止生成，不清除已有人工门。未知409、一般传输失败和真实超时仍要求确认。执行预算修订为探针2.5秒、后端3.2秒、UI／HTTP3.5秒，五秒新鲜度及单轮在途保持。`node --test tests/foreground-observation-budget-http.test.mjs`通过生产控制器、认证HTTP及随机PG验证慢单帧、迟到交付、真实同步占锁与挂起拒绝；该命令不启动实际App或微信。小屏窄窗的顶部边界另要求21点中至少16点支持，防止局部气泡横边干扰；名称裁剪不变。最终修复包实际移动、平铺、缩放及草稿恢复结果见[窗口恢复验收](../.scratch/foreground-header-layout/window-recovery-acceptance-20261015.md)，不代签完整18/06。

按ADR-055，明确群聊或带数字括号人数的疑似群聊暂停前台联系人匹配和新生成，清除名称与生成资格，禁止人工确认绕过；原私聊草稿保留，已授权私聊的CLI后台同步继续。CLI已返回的精确群元数据优先于候选截断和质量失败处理，低质量文字只能用于保守判群。完整原名本身含数字括号的私聊仍须通过原质量门、唯一private元数据及已有绑定，不能剥去尾缀后获得私聊资格。保留有界顶部复查，切回可靠私聊后重新核验，之前已有的人工门保持。

### OCR 本机可视化验收

直接在正式助手核对顶部名称时，用最终签名包、`NOTALONE_CONTINUOUS_APP_ACCEPTANCE=1` 与 `NOTALONE_FORMAL_HEADER_PREVIEW=1` 经有限 `test:app` 执行 `tests/continuous-contact-follow-acceptance.spec.ts`。该模式不提供预期姓名，不建绑定，不弹验收浮窗；正式助手自动显示当前OCR文字及置信度，业务库和userData隔离，CLI／消息为空合成输入。退出或预约截止前自动正常收尾，只记录匿名生命周期，不代替已确认联系人绑定验收。

只核对“实际读出了什么名字”时，使用 `NOTALONE_SESSION_NAME_PREVIEW=1` 和 `tests/native-session-name-preview.spec.ts`，经有限 `test:app` 启动仓库探针 `--preview-session-name`。不提前输入姓名、不经过联系人确认或业务库；“微信会话名称 · 自动识别”浮窗直接显示顶部名称区域的原始 OCR 文字和置信度，失败或离开微信清名，后续读到文字即可展示。无分步检查、不抢焦点，结束或20分钟内退出；外部预约截止优先，生命周期未完整收口时不标通过。当前微信窗口仅在本机内存作布局分析，仅顶部名称区域执行OCR，不识别左侧选中行或正文；预览不以0.90或两处名称一致性过滤文字，姓名、图像不进入日志或文件。`preview-header-v1`仅供此开发窗口，正式定位的质量及联系人绑定门保持；此项不能代签正式App绑定或生成资格。

显式开发入口为仓库探针 `--preview-session`，由主 Agent 在认可的有限时段经 `test:app` 的 `tests/native-session-preview.spec.ts` 启动（环境开关 `NOTALONE_SESSION_PREVIEW_ACCEPTANCE=1`）。窗口不会自动采集；用户点击按钮后有5秒切回已确认的微信测试会话，随后只观察一次。预览仅在本机内存显示第一帧、红色顶部名称框、蓝色选中行名称框及实际 OCR 文字/置信度；失败显示固定阶段和原因，未执行 OCR 时不伪造文字。每次重新识别清空旧图，关闭即释放，最长8分钟自动退出。不保存、不上传、不发送消息，不代表联系人绑定通过。

前台状态另有 `--preview-foreground`：环境开关 `NOTALONE_FOREGROUND_STATUS_PREVIEW=1`，仍经有限 `test:app` / `tests/native-foreground-status-preview.spec.ts` 单实例启动。悬浮窗不主动激活或成为键盘窗口，每0.5秒显示系统前台分类和正式观察共用的采集前检查；用户记录“微信/其他应用在前台”，过期和未知状态保持未验证。只读元数据，零截图/OCR/正文/CLI/模型；关闭或8分钟到期退出，只输出固定事件和聚合计数。生命周期用例通过不代表人工核对通过，也不证明正式App端到端状态正常。

无窗口的 `--foreground-status --json` 对照入口为 `tests/native-foreground-runtime.spec.ts`，环境开关 `NOTALONE_FOREGROUND_RUNTIME_DIAGNOSTIC=1`；仍通过有限 `test:app` 和 `spawnApp`，不截图或读取正文。短生命周期探针退出后须等待 `waitForTestCleanup()`，避免worker退出截断原异步释放。正式观察区分未知前台和确定其他应用，未知原因经认证HTTP显示为“系统前台状态未知”；有限实机协调只保存探针可用、未知和超时等固定布尔，不输出原始错误或标题。

`tests/native-automatic-foreground.spec.ts` 是原位/移动/缩放的受限实机反馈入口，需 `NOTALONE_AUTOMATIC_FOREGROUND_ACCEPTANCE=1`、本轮隔离协调目录和已确认会话名环境变量。窗口动作由操作者完成，触发文件不提供坐标；落盘只保留匹配布尔、固定错误和耗时。阶段标签不能证明窗口实际移动/缩放，须另记操作证据。当前用户改为先看预览再迭代，尚未完成移动/缩放验收。

### 持续联系人实机协调（失败留窗）

`tests/continuous-contact-follow-acceptance.spec.ts`只通过受限`test:app`运行。预约、正式包和单联系人范围继续沿用[06验收记录](../.scratch/foreground-contact-follow/acceptance-06.md)，普通`npm test`不启动App。

每轮使用新建的私有协调目录。夹具启动成功后，目录内的`control-state.json`包含本轮随机`runId`、精确`pid`、协调状态和阶段。主Agent必须先核对自有PID仍存活、租约有效且状态不是`closing`，才能选取既有App窗口；不能通过Computer Use的打开应用能力启动测试。进程退出、租约到期、状态文件缺失或不可读时停止UI调用，不能读取已退出App以尝试恢复。该检查不能消除所有外部工具竞态，工具仍无法可靠绑定既有实例时应停止，不用重启补救。

实际操作完成后，将当前`runId`原样写入对应`<stage>.trigger`，不加换行；旧的`ready`字串不再有效。阶段为`baseline`、`moved`、`resized`、可选`switch-b`/`return-a`、`other-app`、`resume-a`及最后的`finish`。触发信号只表示操作者已完成约定动作，不能替代移动位置或前台切换的独立证据。真实姓名不得写入信号或报告。

原位、移动、缩放和恢复阶段先等待前台前置条件，最多15秒：Electron小窗实际失焦、控制器不再标记助手获焦，以及触发后的新观察报告微信在前台。全部满足后才进入匹配计时；该检查采用宿主焦点及产品探针投影，不能独立证明OS前台判断正确。15秒内未满足时进入`waiting-user`，停止后续阶段，不冒充识别测试已经开始。用户点击既有微信后，操作者将本轮`runId`写入`<stage>-retry.trigger`，同一实例重新检查前台，并要求恢复信号后的新观察；重试信号消费后删除，不自动重复。仍未满足则继续等待用户或finish/租约结束。`control-state.json`保留前置条件的三个布尔值供检查。若工具无法完成前台切换，只请求用户点击已经确认的测试会话窗口，不要求提供聊天正文。

断言失败会先保存匿名报告并进入`failed-held`，同一实例保留供检查；不会自动重试或重启。向`finish.trigger`写入本轮`runId`结束检查，原失败仍向测试框架抛出。正常场景完成也等待`finish`，随后标记`closing`并通过公开菜单退出。预约到期、租约失效或自有进程退出都会结束等待；原有租约监控及夹具负责回收，不因留窗延长授权。失败留窗期间产品的已授权观察可能继续，仍受原数据范围及总时限约束。`closing`不可逆，退出失败也不重新开放检查；收到该状态后禁止再调用该App的Computer Use接口。

安全验证：`node --test tests/scheduling/acceptance-coordinator.test.mjs`仅使用临时信号文件及合成时钟/进程状态；已并入`npm test`。它验证协调行为，不证明真实App、OS焦点或原生识别通过。

用户可视验收模式：在同一入口增加 `NOTALONE_CONTINUOUS_VISUAL_ACCEPTANCE=1`，不提供会话名环境变量。正式包启动后先显示“正式App定位 · 实时可视验收”；用户填写一位准确会话名，可选第二位不同会话名，确认开始后才配置本轮临时合成CLI绑定和开启观察。浮窗随后隐藏、关闭获焦能力再 `showInactive`，使用macOS非激活panel；自动刷新助手公开状态，不自行调用探针，也不等待分步检查。窗口显示实际私聊名称、置信度、联系人A/B、当前绑定、生成是否阻止、草稿字数、暂停原因与观察新鲜度；群聊不显示名称。逐项检查读名、移动、缩放、群聊暂停、私聊恢复、进出助手、联系人切换及草稿／结果隔离，人工点击“符合／有问题／未验证”立即反馈，报告保留各项结果；只有一位时，涉及两位联系人的项目保持未验证。未知原生错误仍泛化，不显示原始错误。“打开正式助手”沿公开菜单检查暂停体验，“结束验收并退出”及关闭窗都只结束当前实例；识别失败不会阻塞结束，预约到期仍强制收尾，不自动重启。旧轮次、过期观察及closing继续拒绝。

持续预览的报告标记 `diagnosticOnly`、`manualAcceptanceRequired`，正常退出或测试生命周期通过不能代替联系人匹配、移动/缩放及暂停恢复签收。会话名仅存本轮临时夹具，报告只保留固定失败码、布尔和聚合计数；无截图落盘、私人正文读取或消息发送。安全投影和按钮边界由 `tests/scheduling/visual-acceptance.test.mjs` 验证；`test:pages -- --case foreground-visual-preview --timeout-seconds 90` 复用实际窗口的HTML及状态渲染，覆盖点击反馈、失败原因与结束按钮，只运行单实例无头Chrome。普通 `npm test` 仍不运行App或浏览器。
