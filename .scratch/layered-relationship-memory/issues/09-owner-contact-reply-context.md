# 09：本人背景与当前联系人回复组合

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 05, 08

## 规格与范围

[正式规格](../spec.md)、[已确认拆分](../ticket-proposal.md)、[任务索引](../planning.md)。实现前读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)与[ADR-067](../../../architecture/adr/067-layered-scenario-and-profile-context.md)，再按领域路由补齐现行约束和相关 ADR。

本票承接规格 S1、S5–S7；I2、I3、I5、I7–I9；T1、T2。 编号不代表前置已完成，也不代表质量获准或功能已经可用。

## What to build（交付行为）

两种范围分区且独立加载，本人原来源不授权跨关系补查；本人变更清理实际受影响的准备和使用副本。

本票是可独立演示的窄完整行为，包含所需数据、应用、HTTP、当前界面与验证，不交付孤立存储表或接口。测试及生产调用跨规格约定的同一 Interface。

## Blocked by（真实前置）

[05](./05-owner-layered-organization.md)、[08](./08-scenario-read-tool.md)；前置实际完成后才可领取。

## Acceptance criteria（验收标准）

- [x] 本人与联系人 L3／L2 目录按真实 scope 分区，独立设置与预算；工具仅可读本次两类目录中的冻结版本。
- [x] 本人原来源联系人只参与后端证明，不成为跨关系原话读取入口；资料缺失时各自回退，不挤占另一侧 L1。
- [x] 本人资料更正、删除、停用及重新开启能失效全部实际受影响的跨联系人准备、工具结果及回复使用副本；无关内容不被整账户清除。
- [x] 来源未知、旧准备协议和重连不补证明，不把当前画像写回旧回复依据。
- [x] 新增内容只使用合法范围与已准入实际版本；来源、时间状态、人工决定和原有 L1／Skill 合同保持，真实质量未获资格时不自动开放真实资料使用。
- [x] 本票新增正文、旧版、反馈、任务输入输出、目录／工具结果及使用副本从产生时就有完整参与依赖；删除、停用、更正与提交的两种顺序、迟到结果、重复和恢复不能复活无效内容。
- [x] 记录实际命令、结果、数据处理影响和未验范围；工程合成验证、实际模型质量与真实 App 分别报告，不提前勾选或标记完成。

## 验证与交付

以公开管理／回复 HTTP、隔离 PostgreSQL 与当前 React 用户操作为主要验收，注入受控提案及忠实度核验 Adapter、可控时钟和失败事件。测试与业务通过相同 Interface，不仅证明字段、内部调用或脚本输出存在。复用已确认的整理公开命令及 capture/read_scenario/validate；本票只增加完成本票行为必需的合同，后续保持兼容。

实现时按仓库工作流使用 TDD，先运行最小相关验证，再完成相关回归与 Standards／Spec 两轴审查。涉及桌面交互时按工程工作流实际操作 App，以合成资料和自有资源记录验证及清理；普通页面不冒充原生 App 通过。验证完成后据实写入 Answer、更新 State 与任务索引，并创建仅含本票变更的本地提交。

## 范围边界

本次发布只建立任务，不开始产品实现、业务资料整理、模型调用或迁移。执行时遵守已确认 scope、来源删除、质量资格和预算；不扩大自动采纳、读取权限、Skill 或外部发送能力。新外发用途、真实资料及远端操作沿仓库授权规则，不因任务发布自动获得授权。

底层记忆及来源保持权威；现有概览继续作为无正文导航投影，生成正文单独版本化。真实 App、模型、渠道及最终可用状态必须有各自证据，不以同一票的局部测试替代。

## Comments

- 2026-10-17：用户认可11项粒度与依赖后逐张发布；本票为 open，尚未领取、实现或验收。

- 2026-10-18：09 实现上下文从正式签收基线 `43ad53e` 领取，分支 `codex/layered-memory-09`；按已确认公开 HTTP／随机隔离 PostgreSQL／生产桌面协议执行 TDD，真实质量仍 closed。


## Answer

2026-10-18：已完成本人背景与当前联系人回复组合，固定工程候选 `78863520`；已含正式集成 `0be72a85`，05／08 的正式合同为前置。本人及联系人实际 L3／有限 L2 目录分别冻结、独立设置与预算，缺失／停用各自回到原 L1。工具只读取本次已提供目录中的冻结 ID 和范围，拒绝隐藏 collection、任意路径及模型自报身份；本人来源联系人仅作后端证明，不授权跨关系原话补查。

prepared 显式升级 codec8 并严格拒旧；actual schema3／scoped-v3 与 owner 三字段经生产保存 GET、Main／preload／parser 到 React 贯通，合法 contact 历史 v1／v2 仍可展示而不补新授权。两侧实际出站前后、独立 constraint_review 和最终同连接 writer 均复验；本人正文仅作为事实／说明，不授权当前意愿、义务或承诺。用户全文、contact L1 5条／600字、owner L1 3条／240字、pending 3条／300字、原话3calls／16消息／2048估算tokens、Skill最多1version均保持原合同；owner-only 省略后仍超容量的 prepare 已经公开 HTTP 真实 red→green 修复，冻结 prepared 不静默降级。

本人更正、替代、回退、删除、停用和重开按实际参与版本精确失效跨联系人的 prepared、工具、回复、编辑、carry 与后继副本，保留无关内容。queued 原来源在物理清理前即阻断历史 GET、编辑／carry／replay、下一次出站、独立 review 和 writer；来源通知用真实 GET 复验并撤下受影响缓存。删除与提交两种顺序、迟到／重复／恢复、ABA 和重连均不能复活；停用保留合法历史，来源删除清历史正文。

实际验证及证据根目录为 `/tmp/notalone-layered-memory-1792230874218`：

- 公开 HTTP／随机隔离 PG／受控 Adapter 按 TDD 最小 red→green 后回归：09 完整22＋source-generation1＋overview-lifecycle3 共26/26，102.585s，`B-09-final-isolated-http.log`；历史／编辑／carry 独立31/31，41.376s，`B-09-legacy-isolated.log`。由 `B-09-run.py` 白名单环境执行，每个随机测试库 finally 清理。
- 串行、有界600s执行 `python -m unittest discover -s backend/tests/unit -t backend -v`：1883/1883，48.527s，`B-09-full-unit.log`。pureNode 真实保存 GET→生产 parser／Main／preload／React 及 foreign 来源通知／迟到／合法历史30/30；runner flags3/3；`npm run typecheck`、`git diff --check`通过。原样双scope保存 GET 及本人成功工具回执为 `B-09-actual-saved-evidence.json`，SHA256 `d058c34d9331b01ed3855415c299dbeefe0968f28f4ae8ddb425f487e6114c52`。
- 固定6dea正式 `npm run test:pages -- --case layered-reply --timeout-seconds 249`：exit0／整例 PASS，`B-09-headless-retry/runner.log`、`result.json`、`cleanup-parent.json`；只证明生产页面／HTTP／PG，Electron未运行。正式判据是生成完成态＋新reply身份＋实际session GET完成候选与UI一致，按生产25s执行合同有界等待。788相对6dea仅修改native测试期限和注释，正式页面与产品代码不变。
- 固定788新一轮 `npm run test:app -- --interactive --coordinator B09-agent --from 2026-10-17T20:15:47.443291+00:00 --until 2026-10-17T20:35:47.443291+00:00 --max-launches 1 --output artifacts/b09-layered-reply-cua-v2 -- tests/layered-reply-native.spec.ts`：父Agent按D授权实际 CUA 全16项重新核验，runner 1 passed（6.5m）／exit0。新nonce `8d5d5f22-78a8-4f55-84b1-6f4895e403d2` 的 ready／done 同实例且16项全true，未拼旧收据；`B-09-app-v2/{ready,done,runtime-proof,result,normal-quit-proof,cleanup-parent}.json`。已实际核全关系语境关闭新生成、双侧独立回退、冻结历史、来源删除及底层本人删除跨联系人缓存撤下／刷新不复活；公用 super+q 实际退出 App 后 PID 不存在。受控回复模型9次、外部真实model0。
- 原生父清理证明：10个已登记自有PID含supervisor全无，userData无，唯一库 `notalone_core_flow_a8eea24f15044ba28deb7b987af55915_test` catalog0，两lease均无且桌面owner已精确归还。作者36个随机库清单／proof／hash另存 `B-09-db-catalog.json`，catalog_count0；父各官方轮次资源按各自精确cleanup收据核验，不混作作者清理。
- 固定788父两轴 Standards hard0／heuristic0、Spec0。早先aac3正式页面5s pending超时、instrument启动失败、diagnostic-only、首轮native14/16 deadline FAIL及无done均原样保留；新轮全16独立重做才计PASS。旧106不是最终回归；53混组4个setUp污染失败已用独立31／26重验；helper违规185不计合规页面／原生验收，缺失记录不补造。

数据处理仅限合成资料、随机*_test PG、loopback HTTP和受控模型；未读取业务数据库、.env或私聊，未发送外部消息，未push／PR，无新增迁移。**真实整理质量与真实回复读取质量资格均仍closed**；工程合成通过与实际 App 的合成验收不产生真实模型／渠道资格，不开放外部发送或自动使用真实资料，最终签名分发包不在本票已验范围。

06／09后落地票必须合另一最新正式产品，实证本人 L2／L3 反馈／事实更正→跨contact prepared／tool／history／reply／edit／carry／后继精确失效并保留无关内容，不留给11。09现已先以`105aa8ea`独立集成签收，06仍未签，不追06 WIP；06作为后落地方合入正式09后承担该真实合同交叉验收，完成后再freeze。

### D 独立工程签收（2026-10-18）

最终结票候选`3d5463f5`经新的独立集成者验证，以`105aa8ea841293348af1b1eeae46fb032aef83f5`本地合并；双亲正确、整树与固定候选完全一致。独立真实HTTP最小8/8、完整26/26、历史／编辑／携带31/31，原样保存GET到生产桌面合同纯Node33/33、codec7/7及typecheck通过。首个外部Node路径和codec导入主树旧schema的命令错误已保留，显式实际集成源码复核后通过，无产品改动。

正式页面6dea、原生788的新nonce16/16和正常退出证据保持各自范围，独立核27个实际加载模块hash均等候选；原生旧失败不改写。D又核四个精确测试库catalog0及六个自有PID不存在；原生10PID／userData／库／双租约的独立清理另有证明。公开历史检查仍exit1，完整位置多重集合与既存12条完全一致，新增0，不称全绿。证据为仓库外`D-09-merge.md/json`与`D-09-signoff-check.json`。

本票仅工程签收；真实整理和回复读取资格仍closed，06联合纠错、10真实质量及11完整交付继续按依赖验收，无远端操作。
