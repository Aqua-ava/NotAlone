# 14：资料补充、修正与撤销

Type: task
State: resolved
Triage: ready-for-agent
Blocked by: 13
Spec: ../spec.md

## 交付行为

手动补充或修正资料，删除单条资料或撤销自动采纳，并立即核对结果。

覆盖规格用户故事：40。

## 验收条件

- [x] 联系人沿用已有记忆公共接口及版本规则；本人资料补齐已确认的原子修正，区分归属并保留来源和 manual/auto 语义。
- [x] 本人修正一次事务创建新 ID 的 manual 版本、引用旧版并使旧版退出检索；失败保留旧版有效，另一 owner/联系人与历史回复依据快照不受影响。
- [x] 修改、单条删除或撤销后更新当前页面和可用上下文，不污染另一联系人。
- [x] 失败不显示成功；按最新已确认接缝，公开普通页面操作加真实隔离 HTTP 回归核验可撤销及可修正行为，原生 App 集成交付留待任务 20。

## 测试与范围

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 本人修正只补必要的后端操作与现有本人资料表的最小版本字段，不新增业务表、不重写检索/生成/提取。自动迁移只用于隔离测试库；现有业务库升级另行取得用户确认。不能把前端先新增再删除的非原子流程称作修正。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。
- 2026-10-08：已核验本人资料的各后端层次与 schema 均没有修正接口或版本字段。用户明确批准补齐原子修正方案：manual 新版本保留来源、旧版退出检索，仅补最小后端操作与字段；现有业务库升级另行确认。实现仍待任务 13 完成后进入，验收接缝不变。
- 2026-10-09：任务 13 已完成普通页面与真实隔离 HTTP/PG 验收，本任务领取至 `codex/mac-app-14-memory-editing`。遵循最新测试决定，仅使用真实隔离 HTTP/PG 与单实例非 Electron 无头 Chrome 的公开页面；原生 App、系统输入、剪贴板及真实渠道不在本轮范围。运行资源交接前仅准备本人原子修正的首个公开 HTTP 失败测试及合成场景，不启动后端、数据库或浏览器，不提前实现。
- 2026-10-09：首片准备位于 `desktop/tests/fixtures/memory_editing_http_check.py` 与 `desktop/tests/memory-editing-page-scenarios.ts`，分别通过认证 HTTP 和公开页面控件核验本人新 manual 版本、旧版本引用、来源时间保留与当前列表更新。仅通过 Conda `NotAlone` 的 `py_compile`、桌面类型检查和 `git diff --check`；本轮 HTTP/PG/浏览器尚未运行，没有 red/green 结果。当前工作树复用集成树已有 `node_modules`，未安装或下载依赖；共享运行器和生产代码未改动。
- 2026-10-09：运行资源正式交接后，首个真实 HTTP 测试先因本人 correct 缺失返回 `400 / memory_request_invalid` 得到 red；补齐 `037_owner_memory_versioning.sql` 及模型、端口、应用层、仓储与 HTTP 后，同一测试 1/1 green。一次事务创建新 ID 的 manual/revision 2、旧版引用并退出现行列表，保留直接来源和来源时间，新版有独立保存时间。测试适配使用官方 Python 3.12 `ProxyHandler({})` 禁代理、禁止重定向、固定自有 PID 和 `127.0.0.1` 握手，关闭全部三项 tracing；两轮均确认认证停读、子进程 exit 0、精确本轮测试库残留 0。迁移仅用于随机新库，未升级业务库、未启动浏览器或 App；其余验收继续推进。
- 2026-10-09：真实 HTTP 追加核验：新版本 INSERT 的合成故障返回 `500 / memory_operation_failed`，旧版保持有效且故障解除后可再次修正；跨 owner 请求被拒绝，当前两位联系人及另一 owner 的资料保持；候选重复 confirm 返回同一旧 invalidated 版本、不恢复旧版也不产生第二份本人资料，新版 `source_candidate_id` 为空并经旧版引用回溯。回滚单片 1/1、隔离单片 1/1、最终重放及隔离组 2/2 通过，每次自有后端均认证停读、exit 0，精确本轮测试库残留 0。重放测试初次因新增方法插入位置错误出现 `NameError`，已修正；这是测试编写错误，不记录为业务 red。用户要求完整工作迁移到新会话，本任务停止继续启动测试或实现，仍 claimed、未勾验收、未评审；旧回复依据、完整相关回归与页面编辑仍未完成。
- 2026-10-09：新会话恢复后补齐真实 HTTP 依据回归 1/1：沿用正式后端 command、PG 检索/持久化与 LangChain 流程，仅外部模型边界返回合成结果。修正后旧回复依据正文及时间快照完全保留，新生成引用新 manual 版本且不再引用旧 ID。测试初次字段误写 request_id，随后误假设上下文仅一条本人资料，均是测试断言错误，未记为产品 red。补充失效/过期/未生效/删除版本拒绝、同旧版并发修正仅一份新版本、迁移重复运行与只读待迁移诊断 3/3，以及直接来源正在删除时写入保护 1/1；来源夹具初次违反删除凭证约束，调整为合法 deleting 安排后通过。每轮均认证 stopped、exit 0、精确本轮库残留 0、cleanup_confirmed true；无浏览器或原生运行，仍未完成页面及评审。
- 2026-10-09：合入任务 11 集成 tip `1c8825b` 后，本人修正公开页面首片实际 red 为缺少“修正资料”按钮；补齐仅管理页可调用的具名 correct、范围/版本检查、原子 HTTP 提交及当前列表重新核对，最小 `memory-editing-owner` 1/1 green（deadline 120、exit 0）。来源、manual、新版本、旧版引用及真实 HTTP 当前列表均由公开控件验收，typecheck 与 diff 检查通过。单实例无头 Chrome，quiet active/window 0、cleanupConfirmed true，两种租约 absent；原生 App 未运行，剩余 CRUD、迟到/失败回归及两轴评审仍未完成。
- 2026-10-09：已合入任务 12 首片 `87fa1ee` 并保留 claimed/原 case。手动补充公开首 red 为没有入口，接入两归属具名 add、现有 manual 接口与受影响列表/来源目录核对；补充页面 1/1 green（双组 CLI 中另一组联系人修正缺按钮 red，整体 exit 1，不误记整体 green）。补充测试曾误把表单文字作为保存结果并提前读取 HTTP，已改为等待实际资料卡；一次相对路径编辑失败导致旧断言再跑、一次新 case 未进 allowlist 被 CLI 拒绝，均不计业务 red。联系人修正随后独立最小 1/1 green、exit 0，核对新 ID/manual/版本递增、来源与来源时间保留、旧版退出列表及另一联系人/本人列表保持。各普通页面 CLI 单 Chrome、quiet active/window 0、cleanupConfirmed true；末轮两 leases absent。类型与 diff 检查通过；原生未运行、其他 CRUD/完整相关回归/评审仍待。
- 2026-10-09：复制任务首 red 正常收尾后恢复运行资源。单条删除/自动撤销公开首 red 为缺少撤销按钮；补齐仅管理页 remove、当前资料/版本校验、明确确认及两归属现有 delete 接口，最小 `memory-editing-removal` 1/1 green、exit 0。当前联系人自动/手动资料及本人单条删除后真实列表已更新，来源、待确认候选及另一联系人保持。首片适配函数曾遗漏闭合括号导致构建失败（没有浏览器启动，不计业务 red），修正后类型检查通过。最终单 Chrome、quiet active/window 0、cleanupConfirmed true，两 leases absent；仍无原生运行或完整相关组/评审结果。
- 2026-10-09：候选确认公开首 red 为缺少“确认并保存”按钮；补齐当前 pending 检查、仅管理页具名 confirmCandidate、原主体路由及 pending+目标列表核对，三主体 self/contact/shared 最小场景 1/1 green、exit 0（self 到本人，其余到联系人，均 manual 并保留直接来源）。测试初次误要求既有联系人 DTO 中不存在的 source_candidate_id，改按已公开的本轮唯一正文和直接来源核对，self 继续核对公开候选链；未扩展联系人接口，不计测试契约错误为产品 red。末轮单 Chrome、quiet active/window 0、cleanupConfirmed true，两 leases absent；完整相关组及评审仍待。
- 2026-10-09：候选丢弃公开首 red 为缺少丢弃按钮；增加仅管理页 discardCandidate、当前 pending 与 scope 核对、用户明确确认，沿用既有 discard 指纹规则。self/contact/shared 丢弃最小场景 1/1 green、exit 0，真实 pending 已清空，联系人/本人资料及来源列表保持。末轮单 Chrome、quiet active/window 0、cleanupConfirmed true，两 leases absent；完整相关组与评审仍待。
- 2026-10-09：写入与提交后核对失败公开回归 `memory-editing-failures` 1/1 green、exit 0：故障 POST 保留输入与原资料，故障 GET 不显示成功，恢复后刷新显示真实新版本及来源链。现有失败保护直接通过，未虚构产品 red。typecheck 通过，单 Chrome、quiet active/window 0、cleanupConfirmed true，两 leases absent；原生未运行，迟到/参数及最终相关组待验证。
- 2026-10-09：写操作具名参数/管理页角色最小回归 1/1 green：十种越界/旧范围/错误版本/额外字段拒绝、助手页五种写操作拒绝，真实代理记录无 POST，当前资料/pending 保持。类型检查通过、cleanupConfirmed true；随后迟到测试安排误把断言读取也挂起，未取得业务 red/green，等待受限 CLI deadline 正常收尾。后续安排已静态修正，四种迟到与最终 12 场登记尚未验证；原生未运行。
- 2026-10-09：迟到测试因 fixture GET 自身挂起到 deadline，CLI exit 2/cleanup_unconfirmed 且保留租约（不是产品 red，无场景通过）。本轮 owned recovery 证据匹配 runner 18556、child group 18567、后端 18617、当前树与独立 OMq6TW 握手目录；原后端 loopback 认证 shutdown=stopped，三个 PID 与原组均退出，精确本轮随机测试库已 DROP 并核缺席，不处理其他进程/库。为 MemoryFixture HTTP 增加 5 秒 AbortSignal 超时，避免断言读取阻断 finally；typecheck 通过，租约释放仍由主协调核验后处理，尚未新运行。
- 2026-10-09：主协调依据固定租约身份、private UID/mode/inode/dev、已退出 PID/组、当前 headless/profile/quiet 进程与临时 profile 缺席核验后安全释放旧租约（历史 Chrome 精确 PID 未恢复，原 CLI 仍 exit 2/cleanup_unconfirmed，不改记通过）。源 `3a9be09c2a81037dc8db39d52c0b4a07a537b136` 上修正迟到最小组 4/4 green；最终 `memory-editing-full` 12/12 和主协调授权的 `candidate-copy` 2/2 一次 CLI 通过，受影响读取 9/9 与迟到 6/6 一次 CLI 通过。各 CLI 最多两组/deadline<=240、单 Chrome、quiet active/window 0、cleanupConfirmed true，两 leases absent；每轮 resources/owned-identities 与日志保留于交接 context。原实现保护直接通过新增失败/迟到回归，不虚构产品 red。
- 2026-10-09：页面回收后串行运行最后相关后端 12 模块，实际 123/123、外层 1/1 green、exit 0；外层正式后端认证 stopped/exit 0、精确随机库缺席/cleanup_confirmed true。保留任务 12/08/16/10 聚合源与各 claimed 状态；更新桌面能力说明但不称原生或完整闭环可用。完整相关页面 27/27 已完成，仍未勾验收、没有 Answer，交主协调对最终候选作 Standards/Spec 两轴评审。

- 2026-10-09：完整固定87f57a7…1d119ed评审：Standards hard0/possibleP3重复夹具生命周期1，Spec0。按2b604fd仅提取六入口共同生命周期后，固定1d119ed…2b604fd增量两轴均0（hard/possible与P0-P3均0）。聚合源60053895的必要memory-editing-owner回归1/1及复制4/4实际退出0，单Chrome、quiet25次active/window0、cleanupConfirmed=true、两租约absent；原场景与断言未变，未重复完整27场。

## Answer

管理页已支持本人和联系人资料补充、版本修正、单条删除、自动采纳撤销，以及三类主体的待确认候选确认与丢弃。所有操作从已确认范围和当前版本出发，写入后重新核对真实列表；提交或读回失败不显示成功，旧联系人或连接的迟到结果不发布。

本人资料修正由后端单事务创建新manual版本、引用旧ID并使旧版退出检索，保留来源及来源时间；失败回滚保持旧版有效。已核验另一owner/联系人隔离、旧回复依据不变、新生成使用新版本、来源删除期间保护、并发与重复确认。迁移037只在本轮随机新测试库执行，未升级现有业务库；该升级仍需单独确认。

真实验证：源3a9be09的memory-editing-full 12/12、memory-reading-full 9/9、memory-stale-full 6/6（受限test:pages，最多两组、单Chrome）；Conda NotAlone的memory_editing_http_check.py相关后端12模块123/123及外层HTTP1/1；类型、构建、完整差异与二十票字段/DAG检查通过。修复后的60053895沿test:pages运行memory-editing-owner与candidate-copy、deadline180，生命周期回归1/1通过。最终双轴hard0/possible0、Spec0。

正常轮次均确认认证停读、自有进程退出和精确测试库缺席；两租约absent。旧迟到安排超时轮仍保留exit2/cleanup_unconfirmed及独立恢复记录，没有改记通过。证据保留于/tmp/notalone-app-context.p9MPie/14-*日志、resources、owned-identities、恢复proof与双轴报告。

数据处理仅涉及合成资料、回环HTTP与随机隔离_test库。未读取私人资料、微信或真实剪贴板，未调用真实模型或外部tracing，未远端Git。当前完成普通页面及后端接缝；原生App、签名和完整桌面闭环在任务20验收。
