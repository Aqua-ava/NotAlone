# 10：新开、列出与选择旧会话

State: claimed
Triage: ready-for-agent
Blocked by: [assistant-session-context/07 默认会话的一次生成与可靠保存](07-default-session-persistence.md)

拆分标识：C04（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧04；Q3、Q5。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

同一联系人显式新开空会话、查看列表并选择旧会话；保留旧记录且不自动带候选或触发生成。

## Acceptance criteria

- [ ] 同一联系人能显式创建空会话、列出并选择旧会话，旧记录保持可查看；不自动搬入候选或临时要求。
- [ ] 新开、列表与选择均复验范围且模型调用数为零；闲置会话切换可独立验收，运行中归属由C09扩展。
- [ ] 无记录、读取失败和失效会话有明确结果；不能凭时间、昵称或复制动作自动选会话。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

闲置会话之间切换即可演示；运行中切换的后台归属由C09交付。所有列表、选择及新开操作核验范围。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

2026-10-11：独立实现上下文领取 C04。先在公开 HTTP → 隔离 PostgreSQL 接缝记录新开、列表及显式选择的 RED，并准备独立会话目录 helper；共享 store/service/server 及桌面接线由主 Agent 串行协调。仅使用合成数据，不运行真实 App、微信、OCR 或外部模型。

## Answer

2026-10-11 阶段记录：已取得三个公开 HTTP RED，仍处于 claimed；接口接线、GREEN、完整相关验证及两轴评审尚未完成，不能视为票交付。

- 接口约定：`POST /api/contacts/{contact_id}/assistant-sessions` 接受空对象并显式新开；同路径 `GET` 返回只含 `session_id/is_current` 的目录及 `current_session_id`；`POST /api/contacts/{contact_id}/assistant-sessions/{session_id}/select` 只按显式 ID 选择。列表不创建会话，不含正文、昵称或时间排序推断。
- 仅新增 `assistant_session_catalog.py` 与 `test_assistant_session_catalog.py`。目录 helper 复用 owner 事务锁与 active 绑定复验，`is_default` 作为唯一当前指针；新开原子解除旧指针并创建空会话，选择只改指针，均不修改旧输入、候选或使用痕迹。
- 实际命令：先 `source /Users/local-user/miniconda3/etc/profile.d/conda.sh` 与 `conda activate NotAlone`，再以 `PGPORT=55441 python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a-session tests.integration.server.test_assistant_session_catalog.AssistantSessionCatalogHttpTest.<单项名称>` 分别运行新开、空列表与显式选择。三个单项均在实际正式迁移的随机 `_test` 库运行，均以 HTTP 404 对期望 200 失败；每次清理确认自有测试库 remaining=0。最初两次入口尝试分别因 Conda shell 未初始化与沙箱 socket 权限失败，修正后才取得上述业务 RED。
- `python -m py_compile backend/src/notalone/persistence/assistant_session_catalog.py backend/tests/integration/server/test_assistant_session_catalog.py` 及票文件 `git diff --check` 通过。没有运行真实 App、微信、OCR、外部模型或页面；没有新增迁移，也未提交或 push。
- 数据影响与剩余项：只处理合成隔离数据。helper 暂未接到公开服务；旧记录保留、范围拒绝、绑定撤销、来源删除、操作失败以及页面闲置切换仍须后续真实 HTTP/GREEN 与主 Agent 串行页面验证。不提前实现运行中后台归属。

2026-10-11 阶段二：主 Agent 解除共享后端冻结后已接通公开接口；桌面接线及两轴评审仍待继续，保持 claimed。

- 三个原 HTTP 404 RED 已按新开、列表、显式选择逐项转为 GREEN。应用层增加 `AssistantSessionCatalogPort` 与无正文 `AssistantSessionSummary`，服务只委托；`create_app` 用同一数据库 URL 注入目录，不新增当前会话权威或迁移，也不改已有 `default/reserve`。
- 兼容政策经规格和代码核验后由主 Agent 确认：列表及选择旧会话属于查看/恢复，只核验 exact owner/contact/session；显式新开仍要求唯一 active 绑定。原 `read_session` 继续可在撤销后查看，实际 `reserve/generate` 的 active 绑定门禁保持有效。独立 PG 的列表/选择撤销场景先取得 `no_active_binding` RED，再逐项 GREEN。
- 实际命令沿用正式迁移隔离 runner：`PGPORT=55441 python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a-session tests.integration.persistence.test_assistant_session_catalog` 为 7/7；对应 `tests.integration.server.test_assistant_session_catalog` 为 11/11。每次随机 `_test` 库清理均 remaining=0。覆盖空会话当前输入 NULL、旧讨论/候选重连保留、目录零隐式创建、范围与未知 ID、撤销后生成拒绝、实际来源删除占位、已删会话失效、写入失败原子回滚及只含稳定分类的读取 503；目录操作无模型调用。
- 完整相关组合 `tests.integration.persistence.test_assistant_session_catalog`、`tests.integration.server.test_assistant_session_catalog`、`test_assistant_session_api`、`test_assistant_session_inputs`、`test_assistant_session_deletion`、`test_assistant_generation_replacement` 共 73 项：72 通过，1 项为其他票新增的替换生成完整讨论模型输入用例失败（`test_replacement_keeps_valid_discussion_and_old_user_requirements_in_the_measured_model_input`，line 445），已通知主 Agent 协调 12/14。自有测试库清理 remaining=0；不把此组合记为全 GREEN。
- 后端五文件 `py_compile` 和指定 diff 检查通过。目录 production 已停在可编译与真实 HTTP GREEN checkpoint，供主 Agent 串行 09 页面小窗使用；期间仅继续本票独立 PG/测试/记录，不改被冻结共享文件。没有 App、微信、OCR、外部模型、stage、commit 或 push。

2026-10-11 追加独立兼容反馈：只新增本票测试，未改冻结 production。真实隔离 runner 运行 PG 9 项与 HTTP 12 项，共 21/21 通过，remaining=0；新增并发两次显式新开均保持可恢复空会话与唯一 current，歧义 active 绑定拒绝新开和生成但允许显式查看旧记录。主 Agent 已确认 10 桌面阶段补齐 051 只读输入与当前 UUID 投影、纯讨论旧记录显示；等待 09 页面小窗 cleanup 后接线，不涉及 13 的意图解释或 16 的后台归属。

2026-10-11 后端 sourcecut：冻结期间仅新增旧纯讨论重连的真实 HTTP 用例，证明 current 输入 UUID 保持、无候选且模型调用零。为总协调先顺序消费正式 B 代码，已切出仅含 10 的四个自有文件与 service/app 精确接线补丁；基线为 `cc9609c45e8d9b2104ff0b5e0ac6ca842804bfb1`，排除并行 12/14 hunks。在该正式基线的独立源码快照执行本票 PG 9 项与 HTTP 13 项共 22/22 通过，正式迁移 001–053、自有随机 `_test` 库清理 remaining=0；snapshot 五文件 `py_compile` 通过。两轴正式审查材料已准备，尚未实际完成评审；桌面仍未接线，票不 resolved、不提交。

后端阶段提交前独立两轴：Standards硬规范0，判断性气味1（低优先级possible Duplicated Code：PG与HTTP合成故障触发器的安装／清理）。两层夹具各有独立数据库范围和收尾；当前保留便于独立验证的局部故障安排，不为两处测试引入通用业务抽象，未更改生产边界。Spec0；仅审查正式cc9609c导出的10切片，22／22实际生产001–053 HTTP／PG通过、自有库0。目录投影、旧051输入展示及公开页面仍待自主推进，整票claimed、人工部分未执行。

正式提交前再次用当前已正式C历史依赖／A预算回执基线导出仅暂存10六文件，22项HTTP／PG全部GREEN／8.767秒、实际001–053、自有库剩余0；无11版本路由、14替换或桌面working依赖。

总协调主树正式消费 `d89584f6e9c1a10cdb863c061212295bc5bf8884` 六文件，无冲突，不取 A 桌面／11／14 working。Conda `NotAlone`、关闭 dotenv／追踪、`PYTHONPATH=src:.` 环境运行 `python /private/tmp/notalone-coordinator-isolated-tests.py /Users/local-user/learn/NotAlone tests.integration.persistence.test_assistant_session_catalog tests.integration.server.test_assistant_session_catalog`：22 项真实 HTTP／正式 001–053 隔离 PG GREEN／9.994 秒，自有库残留 0。`python -m mypy --follow-imports=silent src/notalone/persistence/assistant_session_catalog.py src/notalone/application/assistant_session_service.py` 两源码通过，差异检查通过；限定最终 Standards 硬要求 0／重要气味 0、Spec 0，原低风险测试夹具重复建议及保留理由继续保留。

本次完成目录／新建／精确选择后端的主树集成；桌面目录、051 只读投影及公开页面仍由 A 持续实施，整票保持 claimed。目录只含稳定 ID 与当前标记，查看／选择不扩大生成授权；没有模型调用、正文复制、新迁移或外部发送，人工部分未执行。
