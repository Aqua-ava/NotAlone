# 06 只读端口验证（2026-10-24）

本轮仅修改 `skill-port.ts`、`skill-source-*.ts` 和 `test/skill-port.test.mjs`；普通业务 TS，未修改 DSH 核心。运行时官方版本仍为 `0.2.1-rc.2`，commit `687f282e8625c6b8d11ff58211a90524be2e4317`；官方 registry/runtime 集成证据由独立运行时子任务提供，此文不将 PG 端口测试当作官方运行验收。

## 已实现端口

- `new PostgresSkillPort({read}, root, {requireDiscussionDependencies?})`；`read`应接主宿主 `businessReadTransaction`，每次回复独占一个实例，结束后 `dispose()`。
- `captureUse(scope,entry,revision,metadata?,signal?)`返回原 `SkillUse`全部 snake_case 字段，包含版本序号、范围和 `execution_view`；只有实际已读正文与资源才可生成凭证。
- `validateUseInTransaction(client,scope,revision,use|null,signal?)`与候选保存共用 client、owner 锁；不另开事务。复验确认联系人、目录修订、版本、来源、方法政策、工作目录未同步变化和实际资源冻结摘要。
- `checkSkillDirectory(client,owner,files)`仅返回是否有待同步变化，不写文件、目录、版本或修订。
- 联系人资格允许有效 `conversation_binding`或 `manual_contact_confirmation`，不将昵称当身份；审核发布原取材仍保留旧学习规则的有效绑定要求。
- `SkillDiscussionValidator=(client,owner,contact,requestId)=>Promise<readonly string[]>`必须按原 C 协议核验并返回实际依赖，普通来源循环展开这些依赖，再核验新出现的讨论请求。缺失仍拒绝 `skill_discussion_proof_unavailable`，失败不会被当作普通来源成功。
- 管理来源核验 `requireVersionSources(client,owner,version,contact?,validator?)`同样接受此依赖，递归父版本共用核验上下文。

## 实际测试

Node 固定 `$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`；Python 固定 `$HOME/miniconda3/envs/NotAlone/bin/python`。每例经真实旧迁移创建随机 `notalone_ts_host_*_test` PG 库，结束 DROP；文件只使用合成临时目录。

执行 `node --test backend-ts/test/skill-port.test.mjs`：**11/11 通过**。覆盖确认资格及撤销、完整 DTO/伪造资源拒绝、同 client 资源变化、未同步工作目录变化、伪造执行视图、v1/v2/v3 来源证明、本人/联系人导航、祖先方法停用与政策修改、资源与清单同时替换、C 缺实现与核验失败。

真实 Python 对照直接调用原 `capture_generation`、`capture_review_sources`、`PostgresSkillPort.load_version`；不手写预计摘要、不用假数据库。v1/v2/v3 proof、本人和联系人导航 proof、方法筛选 execution_view 与原结果相等。

实际 TDD 红→绿：未确认联系人 Missing expected rejection；captureUse 方法缺失；资源变更 Missing expected rejection；工作目录编辑 Missing expected rejection；validateUse 方法缺失；本人导航摘要不等；资源和清单同时替换 Missing expected rejection。本人导航红灯定位为 PG JSONB将 confidence=1.0投影成1，以及本人手录根在 direct snapshot遗漏，均修复后对照通过。环境 PG 未运行和共享108迁移清单更新导致的失败未计入业务红灯。

全项目 `tsc --noEmit -p backend-ts/tsconfig.json`最新运行被并行 `model-provider.ts` 缺 `@deepseek-ai/dsh-llm-deepseek`依赖及request隐式any阻塞；输出没有 Skill 模块诊断。此前model-input-budget错误已消失，后续由父任务统一复跑。

复用文件层 `matchesSkillPackage`统一工作包匹配；`SkillPackageReadError`归入暂时读失败保留目录状态，与原check_only一致。复跑端口仍11/11。

## 未完成边界

C 协议真实适配仍由05/主任务提供；拒绝与注入传播测试不证明C功能等价。未运行真实模型、未占用App或微信、未读真实.env/私人Skill/聊天库，未add/commit/push。公开HTTP、官方profile、开发App及双轴审查由父任务完成后方可宣布整票验收。
