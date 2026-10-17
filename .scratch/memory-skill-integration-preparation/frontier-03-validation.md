# 03事件与原子版本集成验证

日期：2026-10-16。产品基底保持M2=`08c4d48e719353492f37620f4fb2aabd8710efc6`，来源保持S=`54e482a6ccfa8ca1ccc7e9dc34b0bfaf27fb1616`。本记录签收正式03，不认证整批15票、真实模型质量或实际App/微信。

## 固定来源与独立审查

产品提交`946a0ea04a1175cf161776177a858f1984e1bb6c`、验证补记`6ce21e04`、同步事故记录`b42aac85`及退出归属夹具修正`b50315a836e4ad9a931d805268a484f316a7c1d9`构成最终来源。候选已包含集成根`ca61349d7fc5236b095e66580d1371335ee78468`，本轮使用本地no-ff合并，无内容冲突，不引入04产品或后续票实现。

主Agent委派的两轮独立审查：

| 范围 | Standards产品代码/夹具结论 | Spec结论 |
| --- | --- | --- |
| `3e6ac12b→6ce21e04`的03候选 | 硬违规0、possible issue 0 | 0发现 |
| `6ce21e04→b50315a8`的严格060退出归属夹具增量 | 0发现 | 0发现 |

这些是代码审查结论。[旧持久化测试的隔离违规](reports/test-database-isolation-incident.md)仍然成立，不能改写为Standards全过程从未违规，也不能据后续通过证明共享库未受影响。

## 实施阶段实际结果

以下按实际轮次列出，存在覆盖重叠，不累加为总数或一次全量通过；具体命令、首红及输入修正见[03 Answer](issues/03-event-version-grounded-adapter.md#answer)。

| 实际轮次 | 结果与边界 |
| --- | --- |
| 最终完整后端unit | 同轮1336/1336，通过；含新增独立事件V合同 |
| 最终迁移/035、02 Grounded、样本、current-status、03 Grounded组合 | 精确断言的新随机自有库同轮84/84，通过，112.544秒；含实际生产builder事件闭环 |
| legacy记忆写入、本人记忆、来源/回复删除、提取追踪 | 显式双URL、精确随机自有库名断言后，同轮89/89，通过 |
| 事件公开HTTP及Grounded定向组 | 独立阶段59与31，记录90/90通过；不与84或unit相加 |
| 事件业务Node | 16/16，通过 |
| React控制器、HTTP/PG及旧状态 | 4/4，通过；三份HTTP夹具报告自有库和子进程清理确认 |
| 普通页面 | `npm run test:pages -- --case memory-event-updates --timeout-seconds 180`：单Chrome的两场景通过，`cleanupConfirmed=true`；覆盖自动历史/撤销/删除和默认pending/人工更新/删除 |
| 最后退出归属HTTP修正 | 仅`受控退出等待迟到实际prepare及interrupt确认才关闭Host`单例1/1，通过；实际到达prepare、interrupt及Host退出断言，模型0次。并未重跑退出组全部34项 |

最后单例实际命令为：

```sh
node --test --test-name-pattern='^受控退出等待迟到实际prepare及interrupt确认才关闭Host' tests/assistant-generation-quit-http.test.mjs
```

该夹具日志确认`migration actual=60, repeat=0`，instance/class清理成功且`database_remaining=false`。上述Python命令均先激活Conda `NotAlone`，禁用dotenv；显式隔离轮使用新随机、长度不超过63字符且以`_test`结尾的自有库，导入旧夹具前断言`current_database()`精确等于本轮生成值，finally只删除该确切库并核对其消失。

## 原失败与未认证事项

两组旧持久化回归遗漏显式`NOTALONE_TEST_DATABASE_URL`，原始轮次为94项中31错误、1跳过，以及58项中34错误，共152项、65错误、1跳过。65个错误用例已经写入随机owner等合成夹具。保存日志缺有效连接配置和`current_database()`，只能确认默认回退路径，不能独立认证实际库身份、最终残留或其他会话影响。没有再次连接、检查、清理或修复该默认路径。后续自有库89/89不覆盖这项未知，完整证据保留于[事故记录](reports/test-database-isolation-incident.md)。

迁移/035首轮39项中38通过、1项因`adoption_writers_present`失败，当时占用来源未捕获；精确单例重跑1/1通过。后续最终组合84/84不将原39轮改写成全绿，也不证明此前未知占用无影响。提取追踪原输入、Grounded事件标签和三例合成time输入的首红/修正继续保留在票据Answer。

本票页面结束时interactive/headless租约均absent；执行者未清理其他租约。实际App、Electron、微信及原生探针未运行，页面通过仅覆盖普通React与合成HTTP/PG。默认npm65项只属于已记录的测试基底候选，本票没有据此声称重新执行。

## 合并后的最小复验

独立merger在集成树实际执行`npm run typecheck`、`git diff --check`和`git diff --cached --check`，均通过；随后以标准库读取本地文件与固定Git blob进行字节/合同核对，没有连接数据库：

- M2原001–058共58份迁移字节保持不变，正式059相对合并前集成根字节不变，并与固定S058一致。
- canonical060与固定S059字节一致，SHA256=`ed641686c45c7e35b262208f2da3126895f611b6d9d326cb6b221e74a6236b2f`；当前迁移精确为001–060，共60份。
- `assistant-budget-backend.py`、`assistant-budget-public.mjs`、`assistant-generation-ownership.py`均保留精确60、实际账本/文件名及重复0守卫，未放宽为下界。合并时仅把public夹具清理日志的001–059文字同步为001–060，不改断言、统计或产品行为。
- CLI、Worker、服务三个生产builder仍默认`GroundedExtractionRuntime`；prepared codec相对合并前字节不变，保持`version=2/schema_revision=1`，未增加冻结事件字段。

本轮merger没有重复单元、PG、HTTP或浏览器，不新建数据库、进程或桌面租约。签收后为01、02、03、14共4 resolved，04为1 claimed，其余10 open；AC总数23已勾、68未勾，05未领取。

## 数据影响与剩余边界

事件及原始版本依据沿owner/contact保存，并接入原子替代、合法撤销和来源删除；旧NULL不回填，当前来源和独立V不代替真实语义质量资格。main三个Grounded默认、原文保真及默认空质量放行保持。S分叉库没有连接、迁移、账本改写或清理；没有访问业务库或改变其他会话文件，本任务测试隔离事故的未知影响按上节保留。

未合入main、push、PR或部署。本票签收不包含概览、历史回复继续、资料升级、Skill生命周期、最终全批组合、业务数据升级或真实App/微信验收。
