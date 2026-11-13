# 07：默认会话的一次生成与可靠保存

State: resolved
Triage: ready-for-agent
Blocked by: None (can start immediately)

拆分标识：C01（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧01；Q1、Q10安全基础。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。依赖是完整交付的前置，不代表这些前置已完成；实际交付与未执行项见本票 Answer。

## What to build

确认联系人后创建默认助手会话，提交一次已有回复输入，并可通过公开入口读取同一轮讨论及候选。

## Acceptance criteria

- [x] 已确认联系人可通过公开入口创建或继续默认会话，提交一次既有回复输入后再读到同一轮讨论及候选；不按昵称归并历史请求。
- [x] 同键同输入重试不新增会话记录或候选；同键异输入冲突及保存失败可见，未可靠保存不宣称可恢复。
- [x] 来源或联系人删除从本票即覆盖新增讨论、快照、候选和恢复副本；来源失效后旧生成不能提交，保留无关内容及无正文占位。
- [x] 会话/请求/输入版本及来源依赖使用稳定身份；新开自动恢复、用户删除入口与多轮输入不在本票提前实现。
- [x] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [x] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

重试不重复、保存失败不伪报成功；新记录从第一天接入来源/联系人删除及失效提交检查。暂不做跨启动自动恢复或会话删除按钮。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。


## Answer

2026-10-11：本票自动部分完成，人工部分未执行。默认会话保存、公开重读、幂等及来源清除已实现并验证；本票没有原生 App 验收条件，状态 resolved 只表示上述自动交付完成，不表示 19 或整体持续会话已经验收。

### 实际交付与接口

- 新增 048 正式迁移及 `assistant_session` / `assistant_session_turn`。身份使用稳定 UUID，按 owner/contact 隔离并级联联系人删除。默认会话通过已确认绑定创建，不按昵称或历史请求推断；讨论只持输入、依赖与既有回复关联，候选正文沿用原权威表。
- 公开入口为 `POST /api/contacts/{contact_id}/assistant-session/default`、`GET /api/contacts/{contact_id}/assistant-sessions/{session_id}` 及其 `POST /replies`。生成响应保留既有候选字段，并附 session/turn/input_version；保存关联失败明确返回 503，原请求键重试可复用已落库候选。
- 相同键相同输入复用原讨论与候选；不同输入冲突，并发同键返回进行中。新建自动恢复、会话删除入口及连续输入仍交后续票。
- 原候选事务持 owner 锁复验会话、绑定和全部捕获依赖。来源 pending/inactive 时重放与读取拒绝正文，投影为 unavailable；实际清除后为 redacted 无正文占位。旧候选延续继承当时依赖，不追加后挂消息来源。
- 桌面提供“查看已保存讨论”，可靠保存失败有明确提示。失效输入版本同时清除当前及暂存候选，取消依据核验，迟到的真实 HTTP 200 不会恢复编辑器。只提供候选查看与用户编辑，没有聊天发送能力。
- 兼容合法手工本人记忆的 owner 伪引用，仍依赖具体记忆身份；自动记忆不能冒称该伪引用。本人记忆删除在同锁事务内核验实际对象并清除依赖讨论、候选、快照及使用记录，保留原指纹和无关运行租约。共用清理支持 dict/tuple 事务行；错误来源 UUID 不能冒充记忆触发清理。

### TDD 与实际验证

仅使用合成资料、可控模型、真实 HTTP、Unix socket 55441 的隔离 PG；没有私人聊天、外部模型或业务库迁移。后端命令先激活 Conda NotAlone，使用 `NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src NOTALONE_TEST_DATABASE_URL='postgresql:///notalone_a_session_test?host=/tmp&port=55441' PGPORT=55441`。

```bash
python -m unittest tests.integration.server.test_assistant_session_api tests.integration.persistence.test_postgres_owner_memory tests.integration.server.test_memory_integration tests.integration.persistence.test_postgres_reply_store tests.integration.persistence.test_source_reply_deletion tests.integration.persistence.test_observation_reply_deletion tests.integration.server.test_reply_api -q
```

最终 75 tests / 13.844s，OK（其中会话 HTTP 20 项）。覆盖可靠保存、重试、真实 PG 触发器保存失败、绑定撤销、源 pending/删除及提交竞态、同名联系人隔离、联系人级联、前序候选传递依赖、手工本人记忆删除、伪 auto 和错误对象拒绝、无关运行草稿保留。

- `python -m unittest tests.integration.persistence.test_database_migrations -q`：10 tests / 4.118s，OK。包括空库、重复、失败、并发锁及中断；连接沿用显式隔离实例，只切换随机专属库名，001–047 校验和未改。
- 初次完整相关后端组（迁移、来源删除、回复整链、依据 API、应用服务及本票 HTTP）：55 tests / 11.391s，OK；审查后 HTTP 16 项及最终新增本人记忆组分别重新验证，未把不同批次简单累计。
- `npm test`：类型检查与安全调度 40/40，OK；不运行页面、浏览器、Electron 或探针二进制。第一次因 sandbox/共享租约失败，已协调空档并用授权沙箱升级重跑通过。
- 总协调按 `PGPORT=55441 PGHOST=/tmp npm run test:pages -- --case assistant-session-persistence --timeout-seconds 180` 执行真实页面 → HTTP → PG，三场最终 green：默认保存/同键重放；来源 pending 遮挡并保留无关讨论；迟到依据不复活。单浏览器串行，cleanupConfirmed=true，Electron/nativeAcceptance=false，20 个静默样本 active/onscreen 均零。
- 已保存真实 red：缺少公开读取入口；来源读取/重放泄露、提交竞态、错误来源继承；暂存候选在失效 GET 后被迟到 200 复活；合法本人记忆保存失败、删除后副本未清；错误记忆 ID 清错来源。竞态与错误对象的旧实现复现使用临时源码快照，工作树守卫未移除，快照及合成 owner 自动回收。
- 发生过测试安排失败：草稿关系检索未实际命中、夹具把 deleted receipt 更新为 pending、跨页面渲染提前假通过。均修正并保留原结果，不算业务 red。最终顺序等公开读取 Promise 完成、确认真实响应，再检验公共权威状态及 DOM，不靠增加超时通过。
- `compileall`、`npm run typecheck`、`git diff --check` 通过。Standards/Spec 独立复审最终均无剩余 finding；审查提出的来源竞态、缓存复活及错对象清理已修复并补回归。

### 数据影响与剩余边界

讨论及候选默认保留，依赖删除进入原事务清理，新输入不静默变为长期偏好。源失效时不返回正文，实际删除清除回复关联和恢复副本；本人记忆原有删除指纹语义保留。测试过程只生成随机合成 owner/contact，并按实际归属清理，不提交截图或数据库产物。

真实 App、微信/OCR、原生生命周期、外部模型语义及 19 未执行；原验收标准保留。初次交付时 C 的独立表达样本与公共原始来源快照尚未消费，后续已按下文集成；09/E06 及最终组合仍需分别验证，不把本票结果当作样本删除组合通过。没有 push、发布或部署；后续 08–18 继续执行，本票完成不是持续目标结束。

### 公共统一输入接口追加

2026-10-11：已消费 C049 公共原始来源事实、样本服务及 B050 主动目的契约；A051 正式迁移扩展会话输入版本。此段交付公共基础，不宣称后续讨论、并发或候选编辑任务已经完成。

- `assistant_session.current_input_version_id` 是单一当前输入指针。生成输入仅关联原 turn，不复制正文；回应理解和主动目的讨论保存已确认字段及服务端核验依赖，按 owner/contact/session 隔离。
- `POST /api/contacts/{contact_id}/assistant-sessions/{session_id}/inputs` 拒绝客户端来源声明，GET 在同一事务返回输入、当前指针及讨论；新请求校验 expected UUID，同键历史重放不回退当前版本。模型保存后、turn 完成前再次校验，迟到旧结果不能成为有效候选。
- 共享 `require_current_input(connection, scope, session_id, input_version_id)` 与 `record_discussion_input_in_transaction(connection, scope, session_id, content, expected_input_version_id=None, *, verified_dependencies=())` 使用调用方原事务。后者不提交、不改调用方 row factory，供 B 输入与操作键原子保存，不另建当前指针。
- 原始来源沿用 C 已捕获的事实，后来挂接的来源不补入旧候选；缺快照或来源失效仅遮挡受影响记录。关系记忆删除在软删前精准擦除关联讨论和父子回复，保留无关生成；联系人、本人与候选记忆按数据库时间重新核验有效期。

最终实际命令（工作目录 `backend/`，已激活 Conda `NotAlone`，自有隔离实例；升级用例另建随机专属库并使用正式迁移 runner）：

```bash
NOTALONE_DISABLE_DOTENV=1 NOTALONE_TEST_DATABASE_URL='postgresql:///notalone_a_session_test?host=/tmp&port=55441' PYTHONPATH=src python -m unittest tests.integration.server.test_assistant_session_inputs tests.integration.server.test_assistant_session_memory_dependencies tests.integration.server.test_assistant_session_api tests.integration.persistence.test_assistant_session_input_upgrade tests.integration.persistence.test_postgres_memory_store tests.integration.persistence.test_postgres_owner_memory.PostgresOwnerMemoryStoreTest.test_delete_is_soft_and_keeps_fingerprint tests.integration.persistence.test_source_deletion.PostgresSourceDeletionRepositoryTest.test_delete_source_cleans_confirmed_memory_and_index_projection tests.integration.persistence.test_source_deletion.PostgresSourceDeletionRepositoryTest.test_delete_source_keeps_memory_supported_by_another_source tests.integration.persistence.test_source_deletion.PostgresSourceDeletionRepositoryTest.test_delete_failure_is_recorded_without_losing_content -v
```

最终相关 72/72，28.899 秒，OK：输入 HTTP 10、记忆 HTTP/PG 4、既有会话 HTTP 24、真实升级及事务 14、MemoryStore 16、本人删除 1、来源清理 3。实际 red→green 包括删除后正文残留、八个记忆有效期子反例、来源快照缺失、save→complete 窗口，以及共享事务接口缺失；tuple/dict、已有 owner 锁不自锁、rollback/commit 均经真实 PG 验证。Standards 硬规范/气味均 0，Spec 复查剩余 0；原两项审查缺陷修复后才交付。

新增正文仍只保存在权威讨论记录，来源清除会擦正文及依赖，历史不可恢复；不保存原始视觉帧，不新增聊天发送或后台自治能力。真实 App、私人资料、外部模型、19、push 和部署均未执行。

### 本轮自主协调最终结果（2026-10-12）

默认会话通过原公开生成入口可靠保存；同键重放、不同输入冲突、保存失败与来源删除均有真实HTTP／PG证据。稳定身份按owner/contact隔离。

剩余：本票可自主范围已完成。真实模型语义、自然度、关系适配及用户相似度未知；本轮没有原生App、私人资料、微信／OCR、外部发送或远端操作。

证据：[29票逐项结果与实际命令](../../unfinished-work/round29-autonomous-results-20261011.md)、[固定源码、自动验证及清理回执](../../unfinished-work/round29-autonomous-verification-20261011.json)。各次不同来源的计量分列，未把静态审查、合成模型或受控宿主冒为原生／真人通过。原验收文本逐行对共同基线保留；只更新实际可验收的勾选和State。
