# 04合法历史回复集成验证

日期：2026-10-16。产品基底保持M2=`08c4d48e719353492f37620f4fb2aabd8710efc6`，来源保持S=`54e482a6ccfa8ca1ccc7e9dc34b0bfaf27fb1616`。本记录签收正式04，不认证整批15票、真实模型质量、实际App/微信或生产资料升级。

## 固定候选与独立审查

04定向复用 `2b5e0a76→c0ae2c1a`；最终候选 `df553fcc7c3eb1fd3d65e3fb4c68ceef10985121` 同步已签收03的根 `5bf3d3ac69794dd59ff6ee7e5b81cb2b6c693506`。独立merger在根树核对clean状态和分支身份，以 `e9d9dd6c9ff619db81ccb2e8b366ba2ae273e12e` 本地no-ff无冲突合入 `codex/memory-skill-integration`，未合入main。

| 审查范围 | 结果与定向处理 |
| --- | --- |
| 原候选 `e7c528c5` Standards | 硬违规0、possible smell 1（P3）；`f26d3b0c` 移除两层冗余历史参数，严格当前讨论CAS和writer复验保持 |
| 原候选及增量Spec | 两项P2：嵌套测试透传旧参数由 `5d3eeb9b` 修复；完成回读丢失依据提醒由 `5f50fa8e` 修复 |
| 两个独立增量复审 | Standards与Spec均确认0发现 |
| `5bf3d3ac→df553fcc` 的03／04组合复审 | 11个显式共同修改文件及8个自动合并共同路径；Standards硬违规0、possible issue 0，Spec 0发现 |

组合保留03事件、手录版本来源链与捕获正文复验，04历史合法门禁、严格当前writer、codec `version=2/schema_revision=2` 及提醒时序修复。本票无新DDL，正式060来自已签收03。两轴是代码审查结论，不能据此抹去执行隔离疏漏或未知资源归属。

## 实施阶段的实际验证

以下存在覆盖重叠，不合计为一个总数或一次全量成绩；命令、首红和详细反例保存在[04 Answer](issues/04-historical-reply-continuation.md#answer)。模型均为脚本化合成。

| 轮次 | 实际结果与范围 |
| --- | --- |
| 初始历史HTTP、prepare、replacement、lifecycle | 同轮69/69、0 skip；82.748秒。含旧格式回执、退出/替换归属、删除先于GET即清prepared、准备后二次修正拒绝且零新增模型调用 |
| legacy版本／携入／样本6模块 | 首轮131项，130通过、1方法pending子场景失败；仅对齐NULL来源代际旧测试夹具到公开建候选合同后，该方法三类资料1/1恢复。131个唯一方法分阶段通过 |
| main业务Node五文件 | 首轮83项49通过、34在退出夹具旧58迁移守卫前失败；严格迁移守卫修复后退出文件42/42，另4文件41项此前通过，83个唯一方法分阶段通过 |
| 相关PG九模块 | 首轮93项85通过、5fail/3error；移除纯祖先ID查询误传参数并校准退出尾序后，原3模块24/24恢复，包含全部8个原失败目标；不与原69项累加 |
| P2最终提醒时序修复 | 公开历史HTTP6/6、0 skip、24.962秒；历史控制器与联系人独立作业归属30/30、0 skip、64.674秒。覆盖扣留POST后公开修正再回读、同键completed与明确继续；编辑和选择保留 |
| 同步03／060后最终PG组合 | 历史公开HTTP、中央讨论依赖、退出迁移与样本4模块同轮56/56、0 skip、45.067秒；含手录根→SELF候选apply-update→继续→真实来源删除、人工修正及同owner另一联系人来源重启execute |
| 同步03后完整unit | 同轮1337/1337、14.189秒 |
| 同步03后历史Node与HTTP | 同轮21/21、0 skip、23.224秒；六个HTTP夹具均报告exact owned database remaining=0 |
| 正式060最小退出／预算 | 退出1/1：模型0次、instance/class清理成功、database_remaining=false；预算联系人排队归属1/1：模型2次、repeat0、owned database remaining=0 |
| 较早React普通页面 | `npm run test:pages -- --case historical-reply-basis --timeout-seconds 180`，2场景、单Chrome、cleanupConfirmed=true；执行时尚未合入03。没有重跑当前03／04组合页面，不能称当前原生/App通过 |

过程中的cwd/PYTHONPATH设置错误、缺失源码helper、原131/83/93轮失败与各自恢复仍保留在Answer，不改写为全程全绿。嵌套测试旧参数红例为1项TypeError，修复后依赖模块19/19；公开完成回读三个红例在P2修复后的HTTP6项中恢复。

## 合并后的最小复验

merger实际执行 `npm run typecheck`、`git diff --check`，均通过；以 `git diff --quiet df553fcc HEAD -- backend desktop architecture` 确认产品、架构及测试字节与固定受审候选一致。随后使用Node标准库读取本地文件和固定Git blob，确认：

- 当前迁移精确001–060，共60份，全部相对合并前根 `5bf3d3ac` 字节不变；canonical060与固定S059字节一致，SHA256=`ed641686c45c7e35b262208f2da3126895f611b6d9d326cb6b221e74a6236b2f`。
- 退出所有权、预算、历史HTTP三个Python夹具以及预算public传输均保留精确60、实际文件/账本及重复0合同，没有改成下界；退出迁移尾序保留058prepared、059correction并追加060。
- codec保持 `version=2/schema_revision=2`；页面调度白名单与headless分发同时保留 `historical-reply-basis`、`memory-event-updates`。

首轮静态检查脚本误把历史夹具的直接 `migrate`／`applied` 合同当成另一夹具的 `recorded`／subprocess拼写，断言失败。读取实际实现并修正检查脚本后整项通过，没有为满足检查修改产品或夹具，也没有连接数据库。merger不重复unit、HTTP、PG或浏览器，不新增数据库、模型调用、进程或桌面租约。

## 资源归属与数据影响

正常HTTP/PG组逐名确认删除；本票 `na04_<16hex>_test` 命名库已只读聚合确认为空，成功HTTP夹具报告各自确切库消失。两个独立debug夹具按精确库名复核缺席后清理自有私有目录。有限页面完成时cleanupConfirmed=true，双租约随后absent；合03后的轮次只读确认租约，没有重新调度页面。

**未认证缺口继续保留：** 35个早期ready失败目录（34个原失败＋独立TAP 1个）的marker未记录库名，databaseName为NULL，35个childPid均已不存在；但Core测试库namespace仍非空，不能认证这些轮次数据库均无残留或查明归属。原目录保留，不连接或清理未知库，不以源码finally代替实际观察。新建库前ownership marker只防未来身份丢失，不为旧轮次倒填UUID。

该缺口与[03默认库隔离事故](reports/test-database-isolation-incident.md)是两件事。后者原两组共152项、65错误、1跳过，已存在合成夹具写入；实际库身份、最终残留和并发影响仍未认证。后续新库通过和本次代码审查0发现均不能证明未知路径无影响，不能概括本轮全程只访问自有库或全部资源已清。

04沿owner/contact保留仍合法的旧候选、编辑和历史依据，真实删除优先清理候选、版本、携入、输入及prepared副本；提醒仅传无正文变化。当前新证据仍严格复验，读取、刷新和恢复不自动生成或选择。本票无业务资料迁移；S分叉库没有连接、迁移、改账本或清理。merger未改变其他会话文件、进程或租约。

main在合并时只读引用为 `b8b30626edf5c523e47e8ec6f9eae7a8eb75db79`，相对交接 `950217b6` 又有 `46bed476`、`b8b30626` 两提交；仅核对提交/路径元数据，没有吸收，固定M2不变。签收后为5 resolved（01、02、03、04、14）、1 claimed（05）、9 open，AC29已勾/62未勾。未合入main、push、PR或部署；实际App/微信、真实模型及后续票仍需各自实际验收。
