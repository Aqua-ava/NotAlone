# 04 联系人上下文独立合同核验

2026-10-23。仅做实施前核验；核验开始时03尚在实现／复审，本文不启动、认领或签收04。归档时03已在9f39d6c2验收，04实施由另一个目标会话承担。没有运行测试、数据库、App、模型或安装；没有 add／commit，由主会话审核提交。

## 证据固定点与阅读边界

- 业务源码及下面所有 Python／desktop 行号均固定于 `3c168296e9e8edaa43b8b323ff693e790e709069`，使用 `git show <commit>:<path>` 读取，不把并行 03 工作树变化当作成功基线。
- 02 证据固定于 `fc8dcf50` 的 `backend-ts/README.md:1-39`、`src/plugin.ts:7-35`、`src/business.ts:4-25`、`src/service.ts:10-40`；同时查阅 `runtime-validation/progress.md:5-43`。14/14 是02记录的历史结果，本轮未复跑。
- 已读工作流、工程、领域、issue-tracker、spec、04及05/09/14/17/18/24边界；领域按关键词定位 `CONTEXT.md`、现行 domain-data/core-flows/privacy-deletion、历史 agent-runtime 与 ADR-006/009/102。现行隔离见 `architecture/current/domain-data.md:12,50-58`；移交要求见 `architecture/adr/102-dsh-typescript-backend-migration.md:20-22`。
- 下文 `B/` = `backend/src/notalone/`，`D/` = `desktop/src/`，`BT/` = `backend/tests/`，`DT/` = `desktop/tests/`；简写 `app.py` = `B/server/app.py`。这是源码证据，不是集成可用声明。

## 锁定 DSH 官方合同

- 版本 `@deepseek-ai/dsh@0.2.1-rc.2`，官方提交 [687f282e8625c6b8d11ff58211a90524be2e4317](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317)。实际阅读本地官方导出 `/tmp/notalone-dsh-official-687f282`；该目录没有 `.git`，不能用本地 `rev-parse` 独立证明提交，版本链沿用02固定tag／制品及 `interface-crosscheck.json`，不宣称可复现构建证明。
- `packages/boot/app-boot/src/profile.ts:740-773,809-819`：按 manifest 的 bundles 读取各层与 profile patch，在空配置上合成；`apps/cli/src/profile-boot.ts:202-235` 再组合 home／调用覆盖层。继续使用官方专用 profile 与薄插件，不能继承默认 Shell／日志等无关能力。
- `apps/cli/src/profile-boot.ts:44-64,295-345`：`appReady.onReady` 是启动成功后一次通知；boot完成、fiber ACTIVE且loader存在才commit，取消监听只移除监听。它不证明PG资料有效、业务授权有效或某功能已完成责任移交；插件仍须完成自己的服务就绪检查。
- 同文件 `:283-310` 负责 fiber dispose／代理清理和信号；`apps/cli/src/process-shutdown.ts:4,52-76` 给整个进程约5秒强制退出边界。不能把进程退出或工具注销当作业务租约已收尾。
- 官方示例 `packages/core/tools/README.md:30-61,83-109` 以及 `src/index.ts:1065-1149`：`register` 返回注销函数，agent scope局部注册；`restrict` 限制全局继承工具，`guard` 是同步单调拒绝，可局部绑定。scope是框架调用范围，不是 `owner_id + contact_id` 授权；业务闭包必须固定身份，并在异步读取后／提交前复核当前来源与授权。
- 02 的 `lookup_source` 是合成内存范围，不是产品来源读取；`backend-ts/src/plugin.ts:18-22` 的 `/semantic|/loop|/cancel|/revoke` 也不是产品HTTP合同。04联系人SQL／DTO无直接DSH接口依赖，只通过宿主装配与生命周期交互；不需要为读联系人新增模型工具，不以模型参数决定范围。

## HTTP、身份与分页合同

| 入口 | 固定旧行为与精确证据 |
| --- | --- |
| 公共认证／owner | `app.py:745-748,3138-3152`：先核验 `Authorization: Bearer …`，无Bearer时取 `X-NotAlone-Token`，常量时间比较；失败401 `unauthorized`。owner来自宿主 `self._owner_id`；未初始化503 `owner_uninitialized`（`:820-828`），不接受模型提供owner。 |
| `GET /api/contacts` | 200 `{contacts:[{contact_id,display_name,data_status:{message_count,source_count}}]}`，不分页；500 `contact_list_unavailable`。`app.py:888-902,3566-3574`。原ID是 `contact.id`，不按昵称合并。 |
| `POST /api/contacts/{id}/manual-confirmation` | JSON必须 `{}`，200 `{confirmed:true}`；400 `contact_input_invalid`／409 `contact_operation_unavailable`（`app.py:879-886`）。`B/application/contact_directory.py:65-70`、`B/persistence/contact_directory.py:94-106` 仅确认已属owner的contact，不授予微信正文读取权。 |
| `GET /api/contacts/{id}/messages` | `limit` 默认50、允许1..100；`before` 为原message UUID；200 `{messages,next_cursor:UUID|null}`。坏contact UUID／不存在／跨owner→404 `contact_not_found`，非法limit或非UUID before→400 `invalid_message_query`，持久层异常→500 `message_stream_unavailable`。`app.py:1048-1110`；`B/application/message_stream.py:97-124`。 |
| 消息DTO／顺序 | `{message_id,speaker,message_type,text,media_placeholder,occurred_at,quoted}`，quoted为null或`{text,target_message_id}`；UTC时间保留亚秒（`app.py:3930-3955`）。SQL按`occurred_at DESC NULLS LAST,id DESC`、取limit+1，末条原ID作为下一页游标；引用联接同owner/contact（`B/persistence/message_stream.py:74-162`）。桌面请求limit=20并校验去重、speaker及类型（`D/main/reply/messages.ts:13-51`）。 |
| `GET /api/contacts/{id}/sources` | 不分页，仅source_document，状态为active/delete_requested/deleting/delete_failed/deleted；200 `{sources:[{source_id,file_name,record_count,status,task_id,task_status,step,error_code}]}`。400 `invalid_scope`、503 `sources_unavailable`；同handler有404 `not_found`、409 `legacy_deletion_unverified`、503 `source_state_unavailable`。成功no-store（`app.py:1650-1675`；`B/persistence/source_tasks.py:23-46`）。 |
| `GET /api/contacts/{id}/relationship-overview` | 200 `{overview}`；400 `overview_request_invalid`／404 `overview_not_found`／503 `overview_unavailable`／500 `overview_operation_failed`（`app.py:2162-2188`）。 |
| 概览DTO | `version=1,scope_kind,contact_id,projection_revision,memory_revision,built_at,entries`；entry=`memory,is_latest,current_leaf,provenance`，current_leaf含原memory_id/revision，provenance含kind及references的原source_id/source_kind/message_id/source_ref_id/locator；memory追加source_candidate_id。`B/server/memory_overview.py:11-40`，底层memory DTO见`app.py:4240`。不换DSH session ID，不重建业务ID。 |

## 持久化范围与真实差异

- `B/persistence/contact_directory.py:27-73`：目录过滤owner，按created_at/id排序；消息统计同时过滤owner/contact及有效来源；source_count为active文件来源加本范围观察数。应用层只做UUID类型门（`B/application/contact_directory.py:49-54`），不是渠道绑定证明。
- `B/persistence/message_stream.py:35-52,65-66,74-162`：contact存在性与分页分别开连接，消息本身必须带owner/contact及有效来源过滤；`B/persistence/message_sources.py:45-73` 的来源资格不能替代微信授权。
- **既有缺口**：格式合法但不存在／跨联系人before游标在 `B/persistence/message_stream.py:195-204` 抛持久层异常，HTTP实际500；来源列表无contact存在检查，不存在／跨owner联系人实际200空数组（`source_tasks.py:23-46`）。不能将这些写成已实现的400／404或“无权限与空记录已区分”；04须保留基线差异并明确验收处理，不能默改错误合同后声称完全等价。
- **读取有写副作用**：`B/persistence/memory_overview.py:145-152` 按contact→owner持锁；`:162-175` 校验contact与双键，`:185-188` 来源失效时跳过，`:201-218` revision变更会UPSERT `relationship_overview_projection`。04必须移交这项投影写入责任，不能以GET为由省略双写验证。
- 消息读取在范围检查后／返回前未见删除或授权世代复验；概览事务锁与有效来源过滤不等于HTTP迟到结果必然被阻止。GET联系人／消息未走统一no-store；来源显式no-store，概览等关系路径由 `app.py:714-726` 加no-store。上述均为旧状态，不是本轮新增缺陷或已修复项。

## 桌面切换、删除和授权变化

- `D/main/contacts/directory.ts:8-40`：先读 `/api/setup/status` 核验runtime_owner_configured，再读目录，均核对连接generation；拒绝重复ID、空名称、坏UUID和非法计数。`contacts/session.ts:30-36,44-66,70-100` 用generation＋directoryRequest＋scopeRevision挡旧成功／失败，选择必须来自当前有效目录，不默认猜选同名联系人；成功刷新移除所选对象会清空选择。
- `D/main/sources/controller.ts:34-48,74-103`：Scope绑定generation/contactId/scopeRevision，切换abort展示读取并清来源；来源请求及后续 `/api/tasks/status?contact_id=…&task_id=…` 在publish前复核scope/request/generation。此处轮询上限30次，不等于删除一定成功。
- `D/main/sources/read.ts:7-35` 校验五种来源状态与删除任务ID/type；任务succeeded要求五步mark_deleted/delete_derived/delete_index/clear_cache/verify_not_retrievable全成功。`sources/tracking.ts:15-52` 删除绑定原联系人、独立于展示切换，接回执和成功各触发onSourceChanged；`D/main/index.ts:122-129` 接线各内容失效。DELETE回执不能替代最终删除证明。
- `D/main/reply/contact-content.ts:29-37,58-125,138-149` 恢复仅保留输入身份和用户编辑，再重读原消息、active输入、适用Skill和原会话完成turn；无效引用清派生理解，非当前联系人的候选编辑也检查。`reply/session.ts:792-823,874-888` 删除复验全部保留副本，404移除原会话，失败清依赖正文；`:170-192` 复验时隐藏候选／消息／讨论正文。
- `D/main/index.ts:108-121` 授权／绑定变化触发foreground reading-scope及生成资格刷新；`reply/session.ts:194-205` 阻断取消savedRead，解除时即使scopeRevision不变仍重读。**不能推断它会清所有已展示内容／已排队任务**；后端新请求、异步读取后及后续提交必须再次核验原范围和当前资格。
- 手动选择既有联系人≠授予微信同步；无绑定／改名／重名／模糊匹配不得自动选联系人，真实渠道核验仍留18/21。不要用更严格的“必须有微信绑定才能看已存资料”误伤既有手动使用合同。

## 04具名移交范围与后续票

| 归属 | 路由／行为边界 |
| --- | --- |
| 04最小完整范围 | `GET /api/contacts`、`GET /api/contacts/{id}/messages`、`GET /api/contacts/{id}/sources`、`GET /api/contacts/{id}/relationship-overview`及其投影写入、桌面切换／晚结果隔离。手动确认若为04调用链所需，独立移交 `POST …/manual-confirmation`，不能随联系人前缀默迁所有写入口。 |
| 03／18／21 | setup状态／宿主认证由03承接；微信账号、同步授权、绑定与工具准备归18，前台定位归21。旧`POST /api/contacts`仍存在（`app.py:860-877`、`persistence/contact_directory.py:75-92`），request_id即contact.id，但与现行“真实微信来源建联”有退役缺口；04不能顺带恢复独立创建UI或认作目标能力。 |
| 05／08 | 生成、检索、模型、物理调用仲裁及`GET …/replies/{request_id}/evidence`（`app.py:1677-1697`）归05；assistant-session讨论读写／恢复归08。04要保持旧端点可用及切换隔离，不能将回复证据错当source列表接管。 |
| 09／13／14 | `GET …/memories`、`…/memory-candidates`、`…/memories/{memory_id}/versions`（`app.py:2357-2387`），`…/owner-memories`及versions（`:2315-2335`）、记忆写操作和长期偏好归09；L2/L3整理及生成归13/14。04概览读取不等于这些链路已迁完。本人记忆是owner范围上下文投影（`B/application/memory_service.py:82-101`），不可复制成各contact事实。 |
| 16／17／22／24 | 导入写入归16；`DELETE /api/contacts/{id}/sources/{source_id}`及联系人／账户跨域删除归17；删除观察依赖的`GET /api/tasks/status`继续由旧实现服务直至具名移交（任务管理22）。24验全组合切换／回退，但04本次范围的停止接收、在途收尾及租约核验不能推迟至24。 |

04的交接必须以“新请求拒收→旧在途完成或安全失效→核验相关运行／投影事务及持久租约→唯一责任方启用→兼容回退复核”为可观察证据。旧 `app.py:813-819` 有全局runtime_stopping门，`:676-690` 有宿主收尾，但不等于已具备按功能切换门；来源删除还有运行集合与worker（`B/application/source_service.py:37-73`）。无持久租约的短读取也须证明确无在途投影写；有跨票租约则核对未迁移责任方，不能随切换重新领取。禁止请求级旧实现自动兜底、恢复旧库或仅靠静态ownership表宣称安全。

## 可复跑选择器与合成反例（本轮均未执行）

- Python单元：`cd backend && PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" python -m unittest tests.unit.application.test_message_stream.MessageStreamGateTest -v`。源码 `BT/unit/application/test_message_stream.py:37,45,54,66` 覆盖不存在contact、limit、UUID类型及范围委派。
- 联系人HTTP：同目录同PATH运行 `python -m unittest tests.integration.server.test_app.BackendServiceAppTest.test_contacts_requires_token tests.integration.server.test_app.BackendServiceAppTest.test_contacts_rejects_wrong_token_without_echoing_it tests.integration.server.test_app.BackendServiceAppTest.test_contacts_returns_only_current_owner_with_data_status tests.integration.server.test_app.BackendServiceAppTest.test_contacts_data_status_counts_only_active_sources -v`（`BT/integration/server/test_app.py:75-128`）。
- 消息／概览模块：同目录同PATH运行 `python -m unittest tests.integration.server.test_message_api.MessageStreamApiTest tests.integration.server.test_contact_relationship_overview.ContactRelationshipOverviewHttpTest -v`；源码前者`:219-283,347,409,480,530-669`，后者`:76,98,134`。包含认证、范围、DTO、失效来源、分页／引用、来源世代及删除后独立手工资料保留；运行前核验独立合成测试库，禁止借真实DB。
- 桌面纯控制器证据：`DT/contact-stale.spec.ts:14,36`；公开HTTP恢复证据：`DT/contact-content-restore-http.test.mjs:157,191,208,279,409,452,482`；作业隔离：`DT/contact-generation-jobs-http.test.mjs:104,143,257`。旧`contact-session.spec.ts:24`标题不代表新版完整草稿恢复行为。
- 桌面合成选择器：`cd desktop && CONDA_DEFAULT_ENV=NotAlone CONDA_PREFIX="$HOME/miniconda3/envs/NotAlone" PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" node --test --test-name-pattern='迟到的甲|同名联系人|删除检查|来源删除与切回|甲删除复验' tests/contact-content-restore-http.test.mjs`；夹具 `DT/fixtures/assistant-budget-public.mjs:10-38` 会启动隔离后端／DB，因此本轮不执行。后续测试输出统一tail -60并保留真实退出码。
- 反例A：owner甲/乙各建同名contact，保留原UUID；交换contact、message游标、source ID；合法空contact与未知contact分开验证，先记录上述旧错误差异。
- 反例B：甲请求暂停→切乙／换连接→放行甲成功或失败；另做同scopeRevision撤权→恢复授权→放行旧请求，旧结果不得publish，须重读。
- 反例C：消息存在性检查后删除来源／联系人；概览投影事务暂停时删除或移交；离开甲视图后删除完成再切回甲，原会话／候选／正文不得复活。对手动保留资料及乙资料验证不误删。
- 反例D：旧端已接收读取／投影写时开始迁移，验证停收、排空或失效、租约责任、重启及显式回退；新旧不得双写，失败不得自动转旧端，回退保留期间新增／修改／撤销／删除。

## 结论与交付限制

已完成固定源码合同核验，本报告不包含04实现。关键阻塞证据是：已有错误语义差异、消息返回前复验缺口、概览GET投影写责任，以及待验证的功能交接。本文不给03或04通过结论，也不以02合成结果替代PG／桌面／真实渠道验收。
本轮实际命令仅只读 `git show/status`、`rg`、`sed/nl`、文件文本读取及本报告写入／静态检查；首次`python`不可用后改用`python3`做文本检查；未读.env、私人聊天或真实DB。只新增本文，不改产品代码／票状态、不提交；无进程或构建产物需清理。后续实际App唯一开发入口仍是 `npm run dev`，本轮没有启动。
