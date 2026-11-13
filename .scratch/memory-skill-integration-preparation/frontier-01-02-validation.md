# 01、02 首批组合验证

日期：2026-10-15。产品基底固定为M2=`08c4d48e719353492f37620f4fb2aabd8710efc6`；来源S=`54e482a6ccfa8ca1ccc7e9dc34b0bfaf27fb1616`。本记录只覆盖01、02与已签收14形成的独立集成候选，不认证后续12票或整批可用。

## 固定候选与集成

- 02固定候选`1873defb624de25aeaff45b802af3fa011565fd9`经独立Standards/Spec两轴审查均0项发现，无冲突合入为`19ef933d3bce904b75e990c0ce5ba727b7f55a0b`。
- 01固定候选`9ef25e059429799fca7e4612ff9c92ac67a784c2`包含产品候选`a7c8c2b2bef7dac11489f5d4bd5d4efc3b246ba3`及单组普通页面证据。初轮Standards为0、Spec发现可靠expired终态仍无法重新准备的P2；真实受控时钟回归形成准确失败，修复后两轴均0项发现。原失败与页面范围详见[01 Answer](issues/01-current-status-and-prepared-format.md#answer)。
- main已由其他工作继续推进；本任务不改动main，不自动重基或将新main内容纳入固定M2候选。S分叉库继续保留，没有连接、迁移、账本改写或清理。

## 合并冲突与必要适配

01合并02后只有四个文件出现局部内容冲突，依据两票规格逐块保留两方语义，没有整文件使用ours/theirs：

| 文件 | 最终语义 |
| --- | --- |
| `desktop/scripts/test-pages.mjs` | 页面允许列表同时保留`memory-current-status`和`memory-correction-protection`，既有有限范围和截止校验保持 |
| `desktop/tests/headless/run.ts` | 两个页面的允许列表、导入和分发同时保留，不执行页面 |
| `desktop/src/main/memory/read.ts` | 保留纠错对照类型/解析，并加入当前核实状态读取 |
| `desktop/tests/memory-page-scenarios.ts` | 使用01逐卡片范围定位，同时保留02主动录入的`manual_source_name`与未知聊天时间断言，去掉重复变量声明 |

首轮业务Node实际为18方法中9通过、9失败。失败的9项HTTP夹具均在启动阶段拒绝：预算夹具仍硬编码58个迁移，加入正式059后不符合旧守卫。仅将`assistant-budget-backend.py`与`assistant-budget-public.mjs`明确同步为正式001–059、数量59、重复执行0；仍要求实际账本与仓库完整文件名列表一致，不放宽为`>=`，不修改产品行为或业务断言。后续新增060等迁移须由对应票显式更新此守卫。

## 最终实际运行

所有Python及受控HTTP命令均先激活Conda `NotAlone`；设置`NOTALONE_DISABLE_DOTENV=1`、`LANGCHAIN_TRACING_V2=false`、`LANGSMITH_TRACING=false`和`PYTHONPATH=.:src:..`。未读取业务`.env`，只使用合成脚本模型与生产应用装配。

| 不重叠测试组 | 单轮结果 |
| --- | --- |
| 完整后端unit | 1331/1331，0跳过，13.578秒 |
| 业务Node四文件 | 18/18，0跳过，31.184秒；含9项受控HTTP和9项纯业务检查 |
| 后端公开HTTP/PG及迁移八模块 | 141/141，0跳过，154.917秒 |
| 完整TypeScript检查 | 通过 |
| Git差异与迁移字节检查 | 通过 |

codec单模块另行复跑2/2通过，与完整unit重叠，不再加进1331。纯业务Node另轮9/9同样与18方法重叠，不累加；首轮9失败保留，最终18方法是完整重跑。

后端141方法的构成为prepare/lifecycle/replacement/rejection四组53、current-status20、纠错45、Grounded组合10、迁移13。命令在`backend/`运行：

```sh
python -m unittest discover -s tests/unit -t . -v
python -m unittest tests.unit.reply.test_prepared_context_codec -v
python "$TASK_ISOLATED_RUNNER"
```

有限端侧runner显式设置两个数据库环境键为新建随机`notalone_merge0102_<UUID>_test`库（名称56字节），调用正式迁移模块应用001–059并确认再次执行为空，再以`unittest`加载：

```text
tests.integration.server.test_assistant_generation_prepare
tests.integration.server.test_assistant_generation_lifecycle
tests.integration.server.test_assistant_generation_replacement
tests.integration.server.test_assistant_prepare_rejection
tests.integration.server.test_memory_current_status
tests.integration.server.test_memory_correction_protection
tests.integration.server.test_memory_correction_grounded
tests.integration.persistence.test_database_migrations
```

runner的finally只删除自己确切创建的随机库，随后查询该确切名称不存在，输出`ISOLATED_CLEANUP_CONFIRMED`。五个Core HTTP夹具自建的随机库也逐一在自身清理后复查不存在；迁移13例由各自用例创建/清理自己的随机库。没有扫描后删除未知库。

`desktop/`实际命令：

```sh
npm run typecheck
node --test tests/memory-correction/controller.test.mjs \
  tests/memory-current-status.test.mjs \
  tests/prepared-format-http.test.mjs \
  tests/explicit-generation-context-http.test.mjs
```

最终Node运行的9个HTTP夹具均报告`001–059 repeat=0 owned_database_remaining=0`，退出后精确库核对为`database_remaining=false`。未运行Electron、页面、App、微信、实际探针、共享租约调度CLI或长期后台服务；没有触碰其他会话的桌面占用。

逐份以Git blob与本地文件散列比对，M2原001–058均保持字节不变；canonical059与固定S的058内容相同。`git diff --check`、`git diff --cached --check`与两个调整的JavaScript语法检查通过。原失败不计为通过，准备命令的路径/循环变量失误也未计作验证。

## 数据影响与未验边界

新增纠错结构只实际迁移到本轮随机合成库，均按精确归属清理；S分叉库、业务资料、凭据及其他会话文件/进程保持原样。01当前状态只读取时派生，不回写源事实或质量门。没有调用真实模型、放行维度、push、PR、部署或合入main。真实语义质量、原生App/微信、业务升级，以及03–13/15的组合行为仍未验。

四处冲突与两处迁移夹具适配由主集成另做独立两轴复审；最终签收结论随主集成记录补齐。

## 组合独立复审

固定候选`f9b911444ba749bac176222db53b711ca1f93c2e`，按`git show --cc`及两父核对共同装配、4处手工冲突、2个059夹具和状态收口。Standards和Spec两轴均为0发现；未复跑运行环境，不把基底npm65项当作组合重跑。01初轮expired P2已由`a7c8c2b2`修复并经两轴增量复审关闭。
