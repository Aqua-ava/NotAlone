# 最终 TS 新臂就绪与 25／26 顺序准备

检查提交：`a61a21407c9395c462e4e68bfeee4628e7e9b15c`。本次只读代码、任务与已固定官方资料，不修改生产文件、原采样器／原报告、任务状态或依赖。

**结论：当前不存在可直接开启的“完整产品纯 TS”配置。现有开关能把部分业务职责交给 TS，但产品宿主仍无条件启动 Python，并依赖它发布 ready、承接公开 HTTP／事件和同步控制。25／26 的发布图没有显式环；若同时要求 25 先签最终纯 TS 性能、又把一切运行脱钩都留给 26，才形成隐含顺序冲突。建议根先安排保留旧源码的 TS 运行脱钩切片，再签 25；26 保留删除旧实现／依赖／引用及退役后复验。此为待根协调方案，本会话未执行。**

## 1. 原合同与顺序的准确边界

- `issues/25-integrated-acceptance.md` 对应完整路径 `.scratch/dsh-ts-migration/issues/25-integrated-acceptance.md:6`：25 仅 Blocked by 24；`:19–24` 要求既有功能矩阵、同模型材料质量／耗时与实际桌面；没有独立写出“无 Python 进程”的逐字性能条款。
- `.scratch/dsh-ts-migration/issues/26-retire-python-frameworks.md:6` 明确 Blocked by 25；`:18–22` 明确仅在 25 通过后移除旧生产实现及所有启动／导入引用，正常开发不依赖 Conda／Python，保留有价值的隔离评测并在退役后复验。
- `.scratch/dsh-ts-migration/planning.md:33–34` 仍为 24→25→26；当前票状态为 24 resolved、25 claimed、26 open。本报告不变更它们。
- `.scratch/dsh-ts-migration/spec.md:52` 禁止把常驻 Python／DSH 双运行层当最终设计；`:98` 要求生产入口不再启动／导入 Python，允许评测隔离保留。这是终态约束。
- `.scratch/dsh-ts-migration/baseline/evaluation-protocol.md:59–65` 规定两臂启动、整个进程树 RSS、HTTP 的样本与阈值，**没有 Python 存在即自动不通过的单独阈值**。`host_statistics.py` 的完整路径 `.scratch/dsh-ts-migration/resumed-host-performance/host_statistics.py:161–166` 对含 Python 新臂保留未定，是此前委派要求“最终 TS 新臂”的资格保护；不能把它误说成预注册数值门槛。
- 因而目前可以把混合臂结果称为阶段性宿主观测，不能据此认证最终 TS 性能；也不能通过删掉该资格保护、忽略 Python RSS 或直接标 25 resolved 来消除顺序问题。

## 2. 当前为何一定有产品 Python

| 位置 | 已核验行为 | 需要脱钩的边界 |
| --- | --- | --- |
| `backend-ts/src/host-plugin.ts:479–487` | 无条件 `LegacyBackend.start(...)`，随后创建联系人与记忆交接对象。与 reply／extraction／history 开关无关。 | 增加完整 TS 装配路径；保留旧实现时也须允许此路径不启动它。 |
| `backend-ts/src/legacy-backend.ts:29–41` | 缺 Python 路径报 `LEGACY_UNCONFIGURED`；实际 spawn `python -m notalone.server.command`，记录身份并等待握手。 | 把解释器设空或不存在会启动失败，不会变成纯 TS。 |
| `backend-ts/src/host-plugin.ts:491–503` | ready 前调用 Python 的 contact configure、foreground stop，再交接联系人／记忆／Skill，最后发布认证握手。 | 替代初始 TS 激活流程；不能仅跳过 spawn 却保留这些必经调用。 |
| `backend-ts/src/skill-host.ts:56–73` | TS Skill 激活依赖 Python stop／status／activate ACK。 | TS 初始独占资格与必要恢复核验。 |
| `backend-ts/src/host-plugin.ts:135–164` | TS 增量提交后仍向 Python 发布事件；撤销、状态读取仍走 Python control。 | Node 事件发布、下游唤醒、撤销 drain 与同步控制。 |
| `backend-ts/src/host-plugin.ts:198–209`、`:350`、`:431` | TS 讨论等先注册为私有入口；公开剩余入口仍要求 Legacy，并落入 `legacyRoute`／proxy。 | 复用已有 TS 业务服务补公开 HTTP／SSE 运输适配，保留鉴权与错误语义。 |
| `backend-ts/src/legacy-backend.ts:135–137`、`backend/src/notalone/server/app.py:3353` | 兜底代理覆盖 contacts／reply／sync／tasks／events 等；Python 实际承担事件订阅。 | 不能以私有 TS 端点能调用代替完整公开业务链路。 |
| `desktop/src/main/backend/process.ts:24–35`、`desktop/src/main/backend/config.ts:78`、`:145–153` | 选 DSH 前仍核验 Python 可执行文件及 `backend/src/notalone/server/command.py`。 | DSH 路径独立的 Node／项目校验，旧 Python 分支先保留。 |
| `desktop/src/main/startup/diagnostics.ts:122`、`:154`、`:182–197` | 普通 DSH 只读诊断已用 Node；早期配置仍要求 Python，schema prepare 仍选择 Python。 | 保留已有 TS 只读诊断，补首次准备／更新写入的 TS 生命周期。 |
| `desktop/src/main/startup/managed-runtime.ts:159` | 首次受管数据库准备运行 Python `notalone.startup_database`。 | Node 迁移准备；单纯后台空闲树无 Python 还不足以证明产品无 Python 依赖。 |
| `desktop/scripts/prepare-runtime.mjs:148`、`desktop/scripts/verify-runtime.mjs:22` | 组件准备／核验仍要求 Python、旧后端及旧框架可导入。 | 26 清理构建与验证入口；本任务没有执行这些发布相关脚本。 |

这里的 `LegacyBackend` 是**新臂后台根进程的真实子进程**，不是采样器父进程，也不是仅为旧臂启动的解释器。业务职责字符串变成 `typescript` 不能推导该进程消失。`backend-ts/src/model-host.ts:80` 的 `pythonEnvironment`、兼容 Python 数值规则的注释本身则不是 spawn 证据，不应按文本命中机械判定残留。

## 3. 现有 TS 开关可做什么

以下值确实存在，但**不是当前可运行的纯 TS 命令**：

```text
NOTALONE_REPLY_RUNTIME=typescript
NOTALONE_EXTRACTION_RUNTIME=typescript
NOTALONE_HISTORY_RUNTIME=typescript
```

`backend-ts/src/host-model-runtime.ts:38–50` 选择回复／提取职责；提取 TS 要求回复 TS。`:109–118` 的 TS 模式仍专门生成给 Python 的私有 remote／permit 环境。`backend-ts/src/history-runtime.ts:8–13` 选择历史执行方；三项默认均为 Python。`backend-ts/test/host-model-unconfigured-skill.test.mjs:14–20` 已说明“公开状态宣称 TS 职责”可以与上述实际 Legacy 生命周期并存，不需要重跑已完成短集证明这一点。

官方 profile 也没有一个可单独删除的 Legacy 插件行：`backend-ts/profile/host.patch.yml:25–26` 只挂载整个 `notalone-host`，Legacy spawn 在它的业务装配内部。产品 `launchDsh` 固定生成此 profile 并调用官方 `--profile notalone`（`backend-ts/src/launch.ts:146–162`）。移掉整个业务插件会失去业务 ready，并非完成迁移。

固定 DSH `0.2.1-rc.2`／`687f282e8625c6b8d11ff58211a90524be2e4317` 的官方 `packages/boot/app-boot/src/profile.ts:1–22` 与 `docs/architecture.md:15–45` 只承诺 profile／bundle／patch 组成；没有提供可消除业务插件任意副作用的全局“禁 Python”配置。本次沿用已读固定源码与本仓测试，不猜新 SDK 开关，不直接挂私有 Context，也不把 02 最小实验 profile 当产品入口。

## 4. 评测 Python 应保留，夹具仍需一个前置修正

- `.scratch/dsh-ts-migration/resumed-host-performance/host_fixture.py:40` 从固定旧 commit 导出真实 Python 源码，用于旧臂；`:185–190` 只在旧臂直接运行该命令。旧基线解释器与依赖必须保留在隔离评测环境，不能为“去 Python”把旧臂换成 Node／替身。
- 同文件 `:165–183` 明确构造白名单合成环境，**没有加入上述三项 RUNTIME**。因此已完成 5/5 短集是采样器与当前混合宿主校验，不代表全部 TS 职责已开启；从外层 shell export 三项也不会自动穿透这个白名单。本次不改原 runner 或原报告。
- 新臂通过 `.scratch/dsh-ts-migration/resumed-host-performance/new-host.mjs:26–31` 调用真实产品 launcher。Python 采样器、psycopg、旧臂源码归档／PG 辅助是评测工具；它们位于新臂后台进程树之外，不应混入后台 RSS，也不属于产品常驻 Python。
- **26 后现有 `prepare` 不能直接假定继续可用**：`host_fixture.py:66` 把 `PYTHONPATH` 指到新树 `backend/src`，`:73–74` 从那里导入 Python `database_migrations`。删除新树 Python 后，需显式复用已核验的同一合成 dump，或将迁移器隔离固定为评测依赖；当前 CLI 没有现成的 `--snapshot` 参数，不能写一个不存在的命令冒充已支持。不能依赖共享 editable 安装碰巧仍指向旧源码。
- 后续正式 manifest 应只为**新臂**冻结实际 TS 职责配置，把它纳入配置摘要；旧臂继续固定旧行为，合成资料／owner／contact／工作负载仍保持一致。

## 5. 根可推进的最小顺序

1. 明确拆分“生产运行脱钩”和“删除旧实现”：建议把前者作为 24／25 的具名补全切片，保留旧源码与启动分支，不提前执行 26 删除；根确认归属后实施，本报告不改票。
2. 完成表中启动／ready、公开 HTTP／事件、同步与首用／更新边界的 TS 装配，复用已有 TS 领域服务与官方 profile，保持唯一写者、取消／删除世代与手动发送边界。不存在只加三个环境值即可完成的捷径。
3. 修正评测准备对将被删除的新树 Python 的依赖，并冻结新臂真实职责配置。只新增对应边界验证，不重复既有 5/5 小集。
4. **必要的新最小探针（当前未执行）**：同一合成快照、零模型凭据，产品 profile 启动→公开 ready／contacts／默认讨论持久写入及读回；核验 `legacyPid` 缺席和 OS 后台整树无 Python、模型台账零、关闭后进程与测试库归零。另经根的既有 `npm run dev` 路径确认不再因 Python／旧 `command.py` 缺失而失败。
5. 上述就绪且停止并行负载后，由根跑原 20×60 秒与 HTTP 10+30 门槛；25 满足既有质量、真实覆盖和性能条件后，26 再删旧源码／引用／依赖并复验受影响的最终路径。不得仅签阶段性混合臂后假称最终性能通过。

若根坚持把所有运行脱钩也留到 26，则须显式协调“25 验收与 26 最终回验”的闭合顺序；不能维持两者互等的解释。本报告只给出该需协调点，不替根重排、降低门槛或批准切换。

## 只读校验与数据影响

执行了 `rg`／定位 `sed`、`git rev-parse`／具名源码 `git diff --name-only`；关键源码没有未提交差异。只定位既有测试支持，没有重跑 5/5、没有新宿主探针、PG／模型／App／微信操作或长期采样。未读取真实资料或 `.env`，未创建预算、暂存、提交、push、PR 或包。输出仅本文件及不超过 40 行的交接。

关键来源 SHA-256：
- `backend-ts/src/host-plugin.ts`：`6437dda4d1d293d094d3c8f548b37265ecdbcf709fa19e517f7b9354b5b55713`
- `backend-ts/src/legacy-backend.ts`：`7add2d7578989794fa0d62a1776fd5332ddb1504121962c22152ded009ba1da2`
- `backend-ts/src/host-model-runtime.ts`：`dfc4614fc50429820c9b6383896292bd72fc60f2ec69e7303d7bdc5893bc145b`
- `desktop/src/main/backend/process.ts`：`10b878d4c5116fcc39860bdf2c061f76f11964531d40e400088e96359c15f416`
- `.scratch/dsh-ts-migration/resumed-host-performance/host_fixture.py`：`1fadedb85256f85535824a5a7d9619b70f01b8dd31daae164db56d3ef5f4788a`

静态引用校验：28 处具名来源路径／行号有效，五份关键源码哈希复核不变；未运行产品或评测进程。
