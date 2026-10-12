# 08 — 回复闭环

Type: task

**Triage:** ready-for-agent
**State:** resolved

**Status:** 原Answer限定的历史回复闭环已结清；逐项移除／补充上下文材料未交付，仍保留未勾选条目。2026-10-12的现行实现及承接核对见Comments。

**What to build:** 用户在主窗口右栏回复工作区完成候选回复全流程：选中一条联系人消息并填写表达方向，或提交自己的原句与改写要求；系统经已验证会话范围检查后生成候选回复，界面展示生成依据与本次使用的 Skill；候选可编辑、可复制到剪贴板，用户可显式选择一条历史候选继续生成。全程不存在任何外部发送能力。

**Blocked by:** 06（消息流展示与实时更新）、07（绑定确认界面化）

- [x] 两种输入形态（回复目标消息 + 表达方向、用户原句 + 改写要求）都能生成候选；请求按幂等键处理重放。
- [x] 生成前必须通过已验证会话范围检查；绑定缺失、未验证或范围不符时拒绝生成并给出原因。
- [ ] Skill 默认自动选择（至多一个），允许用户手动指定一个 active 版本；界面展示本次 Skill 使用摘要与回复上下文依据，材料可移除或补充。（依据展示与手动指定已实现；「材料移除/补充」需回复模块的上下文材料管理扩展，留待后续）
- [x] 候选可编辑与复制；改写要求与表达方向只约束本次生成，不静默成为长期偏好。
- [x] 基于历史候选的显式继续可用；系统不自动推断"最近未发送候选"。
- [x] 回复 API 与既有测试共用同一应用层候选回复流程；集成测试覆盖两种输入形态、范围校验与幂等。

## Answer

- 后端新增 `POST /api/reply/generate`：进程内契约测试钉住 JSON（两种输入形态、幂等键、范围校验、409 拒绝为何稳定码）；真实 HTTP 适配器读取请求体（复用 Confirm API 的 Content-Length 读取），无模型凭据或装配失败时 503 `reply_unavailable`。
- 新增 `application/reply_request.py`（请求体解析与契约校验）与 `application/reply_service.py`（ReplyService：绑定目录解析真实会话范围 → ConversationPort 验证 → ReplyGenerator 生成；任一环节失败关闭并给出稳定 reason，不触发外部发送）。
- 复用既有 `CandidateReplyFlow`/`ReplyGenerator`/`PostgresConversationPort` 的应用层语义，CLI 与后端共用同一回复流程；幂等键重放语义由既有 `ReplyStore` 保证。
- `notalone-server` 经 `server/reply_wiring.py` 装配真实回复服务（DeepSeek 模型、Postgres 技能库/存储/检索/出站台账）；无模型凭据时回复端点 503 失败关闭（真实 HTTP 冒烟验证）。
- Swift 主窗口右栏改为回复工作区：选中消息后可填表达方向生成候选；或提交原句+改写要求；展示本次 Skill 使用摘要、上下文依据数量与候选（正文、依据、风险提示）；候选可复制到剪贴板；「基于此继续生成」显式携带候选 id（系统不推断最近未发送候选）；可填写指定 Skill 版本 ID。
- 新能力：GenerateReply 支持 `UserSkillChoice`（用户手动指定 active 版本）；运行时锁定目录到该版本（不存在或超范围时失败关闭为空目录）；API 请求可带 `skill_version_id`。
- 验证：Python 全量 567 项通过（其中回复相关：ReplyService 单测 8 项、reply API 契约 10 项、Skill 目录锁定 3 项）；`swift build` 与探针 `swift test` 21 项通过；真实 HTTP 冒烟验证无凭据 503 失败关闭。
- 双轴 code-review（Standards + Spec）修复：生成阶段异常不再折叠为 409（基础设施故障回 5xx）；Swift 409 reason 解码展示（新增 `replyRejected(reason:)` 与原因标签映射）；改写默认不自动检索关系资料（ADR-012，UI 加「结合联系人背景资料」开关，默认关）；手动指定 Skill 版本补齐两种输入形态；删除生产不可达的 `binding_not_active` 分支（lookup 只返回 active）；删除死参数与双真相字段；Skill 目录锁定改为纯函数并补失败关闭测试。
- 数据影响：测试使用合成 UUID/`_test` 库；不触碰生产数据。
- 剩余风险：清单第 3 项「材料可移除或补充」未在本票交付（界面已展示 Skill 摘要与上下文依据数量；材料的按项移除/补充需要回复模块的上下文材料管理扩展，涉及检索扩展与独立 UI，记为后续工作）；真实模型候选的端到端冒烟依赖真实凭据环境（既有冒烟惯例）。

## Comments

- 来源规格：`.scratch/native-app-backend/spec.md`。架构依据：ADR-009、ADR-012、ADR-020。
- 出站台账经既有台账 port 写入，真实模型调用三态记录语义不变。

### 2026-10-12承接核对

- 手动Skill选择已在本票交付；当前公开输入继续通过[ReplyServiceRequest](../../../backend/src/notalone/application/reply_service.py)和[GenerateReply](../../../backend/src/notalone/reply/interface.py)表达手动版本或不使用Skill。实际依据展示由[Mac12](../../mac-desktop-app/issues/12-reply-evidence.md)承接，原票记录公开页面／HTTP九场依据验收；现行[ReplyEvidenceCommands](../../../desktop/src/shared/reply-evidence.ts)只提供读取、关闭及状态订阅。
- 「重新生成前逐项移除／补充上下文材料」仍未交付。已核对现行生成公开输入、回复依据桥接及全部202张任务，未找到承接该要求的独立票；[Mac规格](../../mac-desktop-app/spec.md)的Out of Scope也明确排除逐项生成前上下文编辑。
- [原规格用户故事15](../spec.md)和[现行核心流程](../../../architecture/current/core-flows.md)仍保留此要求。输入本次说明、查看依据、删除来源或关闭依据面板均不能替代逐项上下文编辑；本次不勾选该条、不删除要求、不实现新功能。
- 将此条作为冻结期间可见的规格差距保留在[总览承接表](../../unfinished-work/README.md#已关闭旧票中的验收条目承接)。后续先从原规格收束范围和公开接缝，再按工作流形成独立承接工作；当前没有承接票可宣称已完成。
- 核查基点`4e82176f`，本次只读代码与已有测试／Answer；未重新运行历史567项或启动旧Swift／新Electron，完整Mac20状态不变。
