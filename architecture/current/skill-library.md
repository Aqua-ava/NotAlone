# Skill Library（Skill 库）

> 目录存储决定：[ADR-096](../adr/096-directory-backed-reply-skills.md)采用标准目录保存已发布正文及辅助资源，自动发现新增和修改；数据库仅保留业务状态和内容定位。实现及本机迁移证据见[本次规格](../../.scratch/directory-reply-skills/spec.md)。

> 2026-10-21 决定收敛：按 [ADR-093](../adr/093-retain-current-skill-resource-budget.md)沿用当前导入限制和整轮输入预算，不新增独立辅助资源额度。原规格中的独立额度缺口已不属于必做功能；导入边界测试、真实质量及桌面／HTTP 等其他历史验证仍按实际证据核对，不能据接口存在宣称全部完成。

> 状态：已采纳；已有管理、资源持久化与运行时读取实现，各项完成及验收范围须按证据分别核对。测试入口见
> [tests](../../backend/tests/unit/skills)、[tests](../../backend/tests/integration/persistence) 与
> [tests](../../backend/tests/unit/reply)，以 在 `backend/` 运行 `python -m unittest discover -s tests` 的真实验证为准。
> 日期：2026-08-24

> [ADR-048](../adr/048-memory-skill-evolution-lifecycle.md)的授权经验草稿、同输入审核及明确范围发布已在独立集成候选接线并签收；实际范围见[09](../../.scratch/memory-skill-integration-preparation/issues/09-learning-drafts.md)与[11集成记录](../../.scratch/memory-skill-integration-preparation/frontier-11-validation.md)。12接续版本历史、更新／合并与合法回滚，实际验证见[12集成记录](../../.scratch/memory-skill-integration-preparation/frontier-12-validation.md)；范围政策继续13。下方 v1 本地包路径保持，不能以其直接发布行为替代自动草稿的用户审核。

## 授权经验草稿的承接契约

- 授权按已确认 `owner_id + contact_id` 保存并默认关闭；同步绑定不等于允许新的模型用途。启停使用操作UUID和当前授权修订，旧动作重放不覆盖后来的关闭。
- 只整理该范围的实际助手任务、用户编辑／选择及同绑定有实际任务锚点的可靠后续观察。纠正优先，普通经验有界合批；模型许可后与提交事务持续复验授权、来源和完整参与世代。
- `skill_draft` 保留修订、逻辑Skill／方法身份、清洗策略、私人依据、实际目标版本、依赖及无正文来源摘要；与运行目录分离，允许无新增或复用，不写发布版本。
- 已保存的合法历史材料保留局部 historical 核验；当前生成依赖不全局放宽。实际使用偏好保留原始来源闭包，原材料消费或助手会话先删都不能洗掉其参与依赖。
- 来源、偏好、记忆、助手会话或Skill删除清空受影响工作副本；无正文消费身份阻止重复草稿，迟到写入必须再次复验。选择或复制不证明已发送或方法有效。

草稿、授权和可恢复任务沿09合同；审核发布、版本管理分别按正式11、12接续。13候选追加canonical068范围政策，实际验证与尚未签收边界见[13集成记录](../../.scratch/memory-skill-integration-preparation/frontier-13-validation.md)。

## 已审核更新、合并与版本历史

更新和合并沿同一对照审核，目标须精确匹配当前版本；同次合并只处理用户明确确认且适用范围相同的集合，展示旧正文、范围、替代对象和方法延续。历史读取再次校验范围与完整发布来历，可读取仍合法的非当前／停用历史。回滚核当前版本和库修订的双重预期，原操作键不能覆盖后续决定；只切换当前版本，保留用户停用，也不恢复合并中的其他目标。canonical067只保存无正文动作及复合范围外键。

已明确本人或精确场景范围的版本可供同Owner其他已确认联系人更新；父发布在原取材联系人范围递归核验，私有祖先不因此成为其他联系人的独立目标。学习模型只见本联系人的普通材料、清洗策略及合法版本锚点，完整私密来历留在删除依赖；去身份不会自动取得广范围资格。来源排队删除后拒绝加载、预览、导出与回滚；删除事务擦除受影响正文及恢复副本，独立合法旧包仍可显式恢复为当前，但保持停用。方法政策的实际执行与祖先停用继承仍待13组合验证。

## 1. 目标与范围

Skill Library 管理用户可用于候选回复的 Reply Skill。Reply Skill 是一种可独立安装、启用、停用、更新和删除的回复策略；它只影响当前候选回复的表达方式，不是联系人事实、关系记忆、Style Sample 或 Tool。

特定教学视频在项目外完成清洗。进入 NotAlone 的产物是经过人工或外部流程整理的 Skill 包，而不是原始视频，也不是自动保存的 Style Sample。清洗结果中的规则、步骤、好回复和反例可以写入 Skill 正文或辅助资源。

本设计与官方 Agent Skills 规范兼容：Skill 至少包含一个目录和 SKILL.md；SKILL.md 必须声明 name 和 description；正文没有强制章节格式；辅助目录可以按需加载。参考：[Agent Skills 规范](https://agentskills.io/specification)、[LangChain Skills](https://docs.langchain.com/oss/python/langchain/multi-agent/skills)、[Deep Agents Skills](https://docs.langchain.com/oss/python/deepagents/skills)。

## 2. 已确认的产品决定

| 主题 | 当前决定 |
| --- | --- |
| 归属 | Skill 属于一个 Owner；当前用户导入的全局 Skill 对该 Owner 的所有联系人可用，不跨 Owner 共享。 |
| 使用次数 | 每次候选回复最多加载一个 Skill，也可以不加载。 |
| 选择 | 正常回复按 ADR-074（自动 Skill）自动判断零或一个受控版本，界面只显示实际策略；管理启停、显式版本 API 和历史兼容不等于回复区提供手选控件。 |
| 版本 | 发布为隐藏的不可变文件快照；工作目录修改创建新版本，保留仍合法的历史以便回滚。 |
| 导入与发现 | 明确导入或把独立包放入本人管理目录均可安装；管理刷新和每轮运行前发现新增/修改，完整校验后发布。授权经验学习仍先形成草稿，审核后发布；带审核来源的工作副本修改不绕过审核及范围。 |
| 管理 | 管理模块提供导入、更新、启用、停用、删除、导出和试用。 |
| 资源 | 支持 references 和必要的静态 assets；资源与版本绑定，按需只读加载。scripts 不进入可运行能力。 |
| 作用 | Skill 只影响当前候选回复，不能写入记忆、长期偏好、系统设置或外部聊天渠道。 |

## 3. Skill 包契约

### 3.1 目录结构

已发布内容保存在 `NOTALONE_SKILLS_DIR` 指定的根目录（默认 `~/.notalone/skills`）。每个 Owner 的可编辑包位于 `<根>/<owner_id>/<name>/`；隐藏的 `.versions/` 保存不可变版本，扫描不进入隐藏历史。每个包采用以下结构：

~~~text
reply-skill/
├── SKILL.md
├── references/       可选：按需读取的清洗后说明和案例
└── assets/           可选：受控的静态模板或素材
~~~

SKILL.md 是唯一必需文件。导入器必须校验目录名与 name 一致；name 使用小写字母、数字和单连字符，长度为 1 至 64；description 必须说明 Skill 做什么以及何时使用，长度不超过官方限制。

正文不强制固定标题。为了帮助视频清洗结果稳定复用，建议按实际需要包含：

- 适用场景和不适用场景；
- 回复目标、核心规则和操作步骤；
- 好回复、坏回复或边界案例；
- 高风险话题和明确禁忌；
- 需要读取的 references 路径。

### 3.2 辅助资源

references 用于承载不需要每次都加载的长说明、分类规则和更多案例；assets 用于承载受控的静态模板或其他经允许的资源。它们必须：

- 使用包内相对路径，并通过路径遍历、符号链接和大小校验；
- 绑定到一个不可变 Skill 版本，记录相对路径、媒体类型、大小和内容哈希；
- 只在当前 Skill 已被选中且确有需要时读取；
- 不从外部 URL 临时下载，也不携带联系人资料、聊天原文或原始教学视频。

scripts 不作为 NotAlone v1 的运行资源。包含脚本的包不能产生可执行脚本能力；实现时应拒绝该包或要求用户移除不支持内容后重新导入。allowed-tools 等声明是文本，不是权限，也不能增加 Tool、MCP、Shell、网络或文件写入能力。

### 3.3 大小与加载预算

按 [ADR-093](../adr/093-retain-current-skill-resource-budget.md)沿用现有两层限制：导入时 SKILL.md 最多 500 行、估算 5000 tokens；辅助资源最多 100 个、单个 1 MiB、合计 4 MiB，超限拒绝导入。每次模型调用另行检查完整输入和输出预留，不因包导入成功而允许超限生成。

运行时辅助资源经当前版本与范围校验后返回全文并记录路径，不新增独立单次或累计资源额度，也不新增自动裁剪；SKILL.md 保留受控 offset／limit 读取。大资源可能导致后续输入预算拒绝，按现有错误路径处理。资源路径仍限制在包内，不能借引用跳出 Skill 包。这些是当前实现与设计边界，不代表对应测试全部通过。

## 4. 模块与接口

Skill Library 是一个深模块：调用方只了解少量稳定接口，导入校验、版本切换、资源完整性、删除和缓存失效都封装在实现内部。

### 4.1 管理接口

SkillLibraryManagementPort 只供用户明确触发的管理入口使用：

| 操作 | 结果 |
| --- | --- |
| import package | 校验整个本地包，发布第一个不可变版本并启用。 |
| update package | 在同一 Skill 名称下发布新版本，旧版本保留。 |
| enable / disable | 改变目录可用性并递增目录修订。 |
| delete | 清除正文、辅助资源和来源定位，保留最小删除凭证。 |
| export | 导出可移植 Skill 包，不包含联系人数据、聊天记录或使用日志。 |
| preview | 用选定 Reply Task 生成候选预览，不发送、不改记忆。 |

管理接口必须执行用户权限、Owner 归属、同名规则、完整校验和原子发布。模型、Reply Runtime 和 SkillsMiddleware 均不能调用管理接口。

### 4.2 运行接口

SkillPort 是 Reply Runtime 使用的框架无关只读接口：

- catalog(scope) 返回当前 Owner、联系人范围和 skill_library_revision 下的目录元数据；
- load_version(scope, version_id) 返回一个当前可用且不可变的 Skill 正文；
- 受控资源读取能力按相同 scope、version_id 和相对路径返回 references 或允许的 assets。

每个运行接口都必须重新校验 Owner、联系人范围、启用状态、当前版本和目录修订。资源读取不能退化为任意文件读取。

SkillsMiddleware 是运行时 Adapter，不是 Skill Library 的领域接口。它只把 SkillPort 的受控视图转换为模型可见的目录和按需读取能力。

## 5. 生命周期

### 5.1 导入

1. 用户明确选择一个本地 Skill 包。
2. 导入器检查目录结构、frontmatter、名称、描述、大小、编码、路径、符号链接、资源类型和内容哈希。
3. 导入器检查内容是否包含越权工具、外部发送、网络下载、联系人隐私或把一次性规则写成长期偏好的指令。
4. SKILL.md 和全部辅助资源通过校验后，原子准备不可变文件快照，再由数据库事务发布目录项、内容定位、版本哈希与资源清单；数据库不新增正文或资源字节。未提交快照不进入运行目录。
5. 第一个版本直接成为 current 和 active；质量问题可以产生警告，但结构或安全失败不得发布。

任何文件失败都不能发布半成品。显式 import 遇同名仍要求 update；用户管理目录内的合法修改自动形成新版本，相同内容不重复发布。非法、消失或带审核来源且未经再次审核的变更不可运行，不静默回退成编辑前版本。扫描保留停用与删除决定，不能把来源撤销的工作副本当作新包安装。

### 5.2 更新、停用与删除

更新永远创建新的不可变文件版本。显式更新按既有管理合同发布；目录发现保留用户的停用决定，旧版本在来源仍合法时可回滚。启用、停用、更新、导入和删除都必须在同一事务中递增 Owner 级 skill_library_revision。最终提交前再次检查工作目录和本轮版本，目录修改后在途旧结果不能提交。

删除是不可恢复的业务状态：清除所有版本正文、辅助资源、来源定位、目录缓存、Skill Tool 结果和相关摘要；历史 Reply Task 可以保留最小内部关联，但不能用历史记录恢复正文。

### 5.3 导出与试用

导出只包含当前明确允许的 Skill 包内容和必要的包元数据，不包含联系人范围、聊天记录、候选正文、关系记忆和使用日志。

试用使用用户指定的 Reply Task 或合成任务，只产生应用内预览。试用不能发送消息，不能创建 Style Sample，不能修改关系记忆或长期偏好。

## 6. 回复运行流程

~~~text
validate_scope
  → assess_request_risk
  → Retrieval / Context 组装当前联系人 ReplyContext
  → SkillPort.catalog(scope) 发现元数据
  → 系统根据当前对话与精简目录自动选择 0/1 个 Skill
  → 按需加载 SKILL.md 和辅助资源
  → Reply Runtime 生成候选
  → 校验候选并持久化
  → 用户编辑并亲自发送
~~~

Skill 不负责检索，Retrieval 不负责管理或理解 Skill。Skill 只能读取当前已验证联系人的 ReplyContext，不能直接读取数据库、其他联系人、原始截图、语音或未授权 Tool。

运行时先展示 name、description、状态和版本等目录元数据，选中后才读取完整正文。加载成功时记录实际 skill_version_id、选择原因、目录修订和已加载的资源路径；用户可以看到本次使用的 Skill。未选择、不可用或加载失败时，继续按无 Skill 路径生成候选。

内容优先级为产品安全与权限约束、用户本次明确要求、联系人已确认事实、当前 Skill 策略和 Skill 示例。Skill 不能覆盖联系人事实，也不能把自己的文本要求变成执行权限。

## 7. 数据与删除

Skill Library 的权威数据归属于 Owner，使用 Owner 级 revision：

| 对象 | 作用 |
| --- | --- |
| skill_library | 保存 Owner 级目录修订。 |
| reply_skill | 保存名称、归属、描述和 active / disabled / deleted 状态。v1 用户导入的 Skill 默认是 Owner 全局 Skill。 |
| reply_skill_version | 保存不可变文件版本的受控路径、版本、来源定位、内容哈希和校验结果，不保存已发布正文。 |
| reply_skill_resource | 保存版本绑定的资源清单、相对路径、媒体类型、大小、哈希和受控文件定位，不保存资源字节。 |
| reply_request | 保存实际使用的 Skill 版本、选择原因、目录修订和使用结果。 |

目录文件是已发布 Skill 正文和资源的权威来源；PostgreSQL 仅管理身份、目录摘要、范围、启停、版本/哈希、受控文件定位、资源清单、审核来源依赖及使用/删除状态。待审核业务草稿与对照继续受数据库事务管理，不因此自动发布。旧库先完整落盘核验，再清空正文及资源字节；失败可恢复，迁移前原数据不丢失。

删除必须覆盖工作目录、不可变版本、暂存、资源索引、目录缓存、运行状态、Skill Tool 结果和包含旧正文的摘要；数据库撤销资格并记录可重试文件清理，完成后只保留不含正文和可恢复来源定位的最小删除凭证。

## 8. 安全、隐私与故障

- 本机只发现用户明确导入或放入本人管理目录的包；未来若增加网络安装，必须是独立用户操作，并执行同一套校验。
- Skill 包不接收原始教学视频，不默认接收联系人或聊天资料。
- Skill 内容不能注册 Tool、MCP、Shell、网络、文件写入或聊天发送能力。
- 运行缓存绑定 owner_id + contact_id + skill_library_revision；联系人或目录变化后旧运行状态失效。
- 任何越权、版本不一致、资源路径非法、内容被删除或读取失败，都返回受控错误并退回无 Skill 路径。
- 运行日志只保留 Skill 和版本等非正文元数据，不复制完整 Prompt、Skill 正文或聊天原文。

## 9. 当前实现状态与完成条件

仓库已有以下 Skill Library 实现入口：领域模型见 [skills/models.py](../../backend/src/notalone/skills/models.py)，只读受控目录、版本与资源读取见 [skill_port.py](../../backend/src/notalone/persistence/skill_port.py)，管理接口 import/update/enable/disable/rollback/delete/export/preview 见 [skill_library.py](../../backend/src/notalone/persistence/skill_library.py)。运行时按需读取 SKILL.md 与受控 references/assets 的 Adapter 见 [langchain_runtime.py](../../backend/src/notalone/reply/adapters/langchain_runtime.py)，试用执行器见 [skill_preview.py](../../backend/src/notalone/reply/adapters/skill_preview.py)，运行记录与资源摘要见 [reply_store.py](../../backend/src/notalone/persistence/reply_store.py) 和 [024_skill_run_record.sql](../../backend/database/migrations/024_skill_run_record.sql)，包导入校验见 [008_skill_port.sql](../../backend/database/migrations/008_skill_port.sql) 与 [023_skill_library_resources.sql](../../backend/database/migrations/023_skill_library_resources.sql)。

需按实际执行记录核对的验证范围（此清单本身不代表全部通过）：

1. 正常 Skill 包、损坏 frontmatter、重复名称、路径遍历和符号链接测试；
2. references/assets 的版本绑定、按需读取、导入大小限制、整轮输入预算和脚本拒绝测试；独立资源额度按 ADR-093 不属于当前要求；
3. 两个 Owner、两个联系人的目录隔离和 revision 变更测试；
4. 更新、回滚、停用、删除后正文与资源不可恢复测试；
5. Skill 加载失败时无 Skill 回退、候选不发送消息和不写入长期资料测试。

上述入口已有工程实现；原规格中其他历史测试与桌面／HTTP 缺口仍须逐项核对，不能将接口存在写成全部验收完成。网络安装、脚本执行和跨 Owner 共享仍不在初版范围内。

## 10. 不在本轮范围

- 原始教学视频在项目内的转写、清洗和标注流水线；
- Style Sample 的保存范围和权重调整；
- Skill 脚本执行、Tool 扩展、网络运行时资源和跨 Owner 共享；
- 候选回复自动发送；
- 用候选采纳结果自动改写、启用或发布 Skill。

## 11. 审核发布与明确范围

自动学习只产生同一联系人的待审核草稿。用户提供审核输入及精确场景，选择联系人、场景或本人范围；旧版本或无 Skill 与草稿使用同一次构建的冻结上下文，仅替换策略。草稿经隔离只读端口试用，不临时发布，也不写消息或长期偏好。审核输入不是外部来话或发送证明。

编辑递增修订并撤销旧对照；暂留保持待审核，拒绝保存明确决定。对照绑定输入版本、草稿修订、来源世代、偏好修订、目标版本与库修订。用户明确确认范围和替代关系后，同一持锁事务幂等发布不可变版本、来源记录和方法映射。旧本地包保持 `review_origin=false`，不能回填为用户审核。

目录、正文、资源、准备与最终候选均核对版本和来源范围。按 [ADR-074](../adr/074-automatic-conversation-skill-loading.md)，当前对话自动判断受控目录内的策略相关性，回复区仅展示实际策略。授权场景仍只按用户声明逐字匹配，进入输入身份、继续、中断恢复及联系人缓存；入口模式不建立场景授权。13候选的准备编码为version2/schema5：已编码的历史依据变化新增`reply_skill/skill_policy_changed`严格变体，旧schema4必须经原身份、可靠终态及租约核对后显式重新准备；不补签执行视图或场景。

私人依据留在原取材联系人范围；扩大策略范围不扩大依据读取权限。额外对照材料、偏好与概览隐藏导航均承担删除依赖。来源删除在原事务清除对照、发布正文、资源、方法及跨联系人使用副本，也清除尚未创建回复请求但明确选择了该版本的准备输入。实际验证与未验边界见[11集成记录](../../.scratch/memory-skill-integration-preparation/frontier-11-validation.md)。

## 明确范围的执行决定

用户明确选择具体方法或整个Skill，再确认联系人、本人、联系人内精确场景或本人精确场景范围后，停用即时生效。普通措辞反馈先修改当前候选，长期调整仍形成待审核草稿；回复模型没有政策或发布管理Tool。政策与不可变正文分开保存，更新、合并及回滚沿方法和逻辑Skill祖先继承停用，明确撤销才恢复许可。

目录及资源许可只读取方法身份、映射、祖先和政策，不读取未选版本或方法正文，也不伪造执行凭证。实际选择版本后，筛选正文仅由允许方法构成，描述替换为安全说明，未分离资源拒绝读取；全部停用或无法可靠映射时回退通用回复。执行凭证绑定实际正文、允许方法及相关政策最大修订，区别于owner全局单调政策修订和目录修订。

最终候选事务复验实际投影，重放、继续、携入、讨论后代及中断恢复递归检查真正旧输入。政策变化保留合法历史和用户编辑，并展示依据变化；来源删除仍优先擦除正文和恢复副本，无正文决定可撤销但不能恢复策略。候选工程验证不代表真实模型质量、实际App或微信能力。
