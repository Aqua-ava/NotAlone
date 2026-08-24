# Skill Library（Skill 库）

> 状态：已采纳且已按本文件完成初版实现；管理接口、辅助资源持久化与运行时读取均已落地，测试见
> [tests](../../tests/unit/skills)、[tests](../../tests/integration/persistence) 与
> [tests](../../tests/unit/reply)，以 `python -m unittest discover -s tests` 的真实验证为准。
> 日期：2026-08-24

## 1. 目标与范围

Skill Library 管理用户可用于候选回复的 Reply Skill。Reply Skill 是一种可独立安装、启用、停用、更新和删除的回复策略；它只影响当前候选回复的表达方式，不是联系人事实、关系记忆、Style Sample 或 Tool。

特定教学视频在项目外完成清洗。进入 NotAlone 的产物是经过人工或外部流程整理的 Skill 包，而不是原始视频，也不是自动保存的 Style Sample。清洗结果中的规则、步骤、好回复和反例可以写入 Skill 正文或辅助资源。

本设计与官方 Agent Skills 规范兼容：Skill 至少包含一个目录和 SKILL.md；SKILL.md 必须声明 name 和 description；正文没有强制章节格式；辅助目录可以按需加载。参考：[Agent Skills 规范](https://agentskills.io/specification)、[LangChain Skills](https://docs.langchain.com/oss/python/langchain/multi-agent/skills)、[Deep Agents Skills](https://docs.langchain.com/oss/python/deepagents/skills)。

## 2. 已确认的产品决定

| 主题 | 当前决定 |
| --- | --- |
| 归属 | Skill 属于一个 Owner；当前用户导入的全局 Skill 对该 Owner 的所有联系人可用，不跨 Owner 共享。 |
| 使用次数 | 每次候选回复最多加载一个 Skill，也可以不加载。 |
| 选择 | 系统可以依据目录元数据推荐，用户可以关闭或改选；界面显示本次实际使用的 Skill 和版本。 |
| 版本 | 发布版本不可变；更新创建新版本并保留旧版本以便回滚。 |
| 导入 | v1 只接受用户明确选择的本地 Skill 包；通过完整校验后直接启用，不建立项目内 SkillDraft。 |
| 管理 | 管理模块提供导入、更新、启用、停用、删除、导出和试用。 |
| 资源 | 支持 references 和必要的静态 assets；资源与版本绑定，按需只读加载。scripts 不进入可运行能力。 |
| 作用 | Skill 只影响当前候选回复，不能写入记忆、长期偏好、系统设置或外部聊天渠道。 |

## 3. Skill 包契约

### 3.1 目录结构

一个可导入的 Skill 包采用以下结构：

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

SKILL.md 应保持在约 500 行、5000 tokens 以内；references 和 assets 使用单次加载预算。超出预算时返回可解释的校验或加载错误，不自动截断、不使用半截正文。references 的读取深度限制在包内受控路径，不能借引用跳出 Skill 包。

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
4. SKILL.md 和全部辅助资源通过校验后，在同一事务中创建目录项、版本和资源记录。
5. 第一个版本直接成为 current 和 active；质量问题可以产生警告，但结构或安全失败不得发布。

任何文件失败都不能发布半成品。名称重复时，只有用户明确执行 update 才能创建新版本；普通 import 必须要求改名或确认更新，不能静默覆盖。

### 5.2 更新、停用与删除

更新永远创建新的不可变版本。新版本通过校验后成为 current 和 active，旧版本保留并可回滚。启用、停用、更新、导入和删除都必须在同一事务中递增 Owner 级 skill_library_revision。

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
  → 系统或用户选择 0/1 个 Skill
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
| reply_skill_version | 保存不可变的 SKILL.md 正文、版本、来源定位、内容哈希和校验结果。 |
| reply_skill_resource | 保存版本绑定的受控辅助资源清单、相对路径、媒体类型、大小、内容哈希和内容定位。 |
| reply_request | 保存实际使用的 Skill 版本、选择原因、目录修订和使用结果。 |

PostgreSQL 继续是 Skill 目录、版本、状态、资源元数据和删除状态的权威库。若未来使用对象存储保存大型静态资源，资源记录和删除任务仍必须由 PostgreSQL 权威管理，运行时不能直接访问任意对象路径。

删除必须覆盖资源正文、资源索引、目录缓存、运行状态、Skill Tool 结果和包含旧正文的摘要；完成后只保留不含正文和可恢复来源定位的最小删除凭证。

## 8. 安全、隐私与故障

- v1 只导入用户明确选择的本地包；未来若增加网络安装，必须是独立用户操作，并重新执行同一套校验。
- Skill 包不接收原始教学视频，不默认接收联系人或聊天资料。
- Skill 内容不能注册 Tool、MCP、Shell、网络、文件写入或聊天发送能力。
- 运行缓存绑定 owner_id + contact_id + skill_library_revision；联系人或目录变化后旧运行状态失效。
- 任何越权、版本不一致、资源路径非法、内容被删除或读取失败，都返回受控错误并退回无 Skill 路径。
- 运行日志只保留 Skill 和版本等非正文元数据，不复制完整 Prompt、Skill 正文或聊天原文。

## 9. 当前实现状态与完成条件

仓库已完成 Skill Library 初版实现：领域模型见 [skills/models.py](../../src/notalone/skills/models.py)，只读受控目录、版本与资源读取见 [skill_port.py](../../src/notalone/persistence/skill_port.py)，管理接口 import/update/enable/disable/rollback/delete/export/preview 见 [skill_library.py](../../src/notalone/persistence/skill_library.py)。运行时按需读取 SKILL.md 与受控 references/assets 的 Adapter 见 [langchain_runtime.py](../../src/notalone/reply/adapters/langchain_runtime.py)，试用执行器见 [skill_preview.py](../../src/notalone/reply/adapters/skill_preview.py)，运行记录与资源摘要见 [reply_store.py](../../src/notalone/persistence/reply_store.py) 和 [024_skill_run_record.sql](../../database/migrations/024_skill_run_record.sql)，包导入校验见 [008_skill_port.sql](../../database/migrations/008_skill_port.sql) 与 [023_skill_library_resources.sql](../../database/migrations/023_skill_library_resources.sql)。

初版实现已通过的完成条件：

1. 正常 Skill 包、损坏 frontmatter、重复名称、路径遍历和符号链接测试；
2. references/assets 的版本绑定、按需读取、大小预算和脚本拒绝测试；
3. 两个 Owner、两个联系人的目录隔离和 revision 变更测试；
4. 更新、回滚、停用、删除后正文与资源不可恢复测试；
5. Skill 加载失败时无 Skill 回退、候选不发送消息和不写入长期资料测试。

当前实现已完成本设计的管理接口、辅助资源持久化和资源运行时读取；架构文档记录的约束不代表
实现范围之外的能力，网络安装、脚本执行和跨 Owner 共享仍不在初版范围内。

## 10. 不在本轮范围

- 原始教学视频在项目内的转写、清洗和标注流水线；
- Style Sample 的保存范围和权重调整；
- Skill 脚本执行、Tool 扩展、网络运行时资源和跨 Owner 共享；
- 候选回复自动发送；
- 用候选采纳结果自动改写、启用或发布 Skill。
