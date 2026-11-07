# 同步减负 02：认证测试的新旧契约对应

日期：2026-11-07。范围：五份认证相关测试及专用渠道夹具；与任务 02 的产品实现、历史存量保护和真实备份副本回放记录配套阅读。

## 接口与夹具

使用正式 `SqliteHistoryRecertifyService`、`SqliteHistoryService`、SQLite Worker、联系人授权与删除协调器；仅在原生渠道边界替换为合成读取器。专用 `test/fixtures/history/recertify-reader.mjs` 声明正常连续性与 `recoverFromLocalIds`，接收正式存储入口计算的位置，返回读取器签发的游标、实际末尾锚点和水位之后的消息。调用方不拼装 opaque cursor。

测试使用临时合成库。专用只读 snapshot 动作增加绑定、授权与隔离记录观测，不改写恢复结果。通用 `sqlite-clear-support.mjs` 未修改。候选聚合文件的五项既有测试保持原样并继续运行。

## 旧要求与新覆盖

| 旧测试关注点 | 新合同的等价覆盖 |
| --- | --- |
| 每次 Rotate 建新绑定、新授权并完整重读，旧来源和新来源分离 | 绑定与授权逐行不变、旧消息 ID 保留，只读取每表水位之后的新消息；同请求不增加渠道或消息，其他联系人不受影响 |
| preview 与 actual 两条连接及完整 manifest 反例 | 当前受控快照的账号、会话、代次、表实例、checked 文件集合均复验；真实变化停读，合法的已检查文件内加表通过增长证明；不要求为相同来源再开第二条连接 |
| 新绑定内引用写入、单条引用失败 | 原地新增消息使用普通引用写入路径，成功引文与单条引用失败均持久化；不为正常恢复创建旧认证专属 quote cap |
| Rotate 后删除代次变化 | 恢复计划到 `prepareRecoveredGuard` 原子接纳之间发起真实来源删除，旧 token 不得通过；接纳前删除、接纳竞争及正文读取中来源／联系人／账号删除仍排空 holder |
| Seal、Activate、Finalize 暂存／发布 | 受控边界改为 `prepareRecoveredGuard` 与 `recertifyResumeComplete`；原生关闭未完成仍为 running，最后提交前取消不得 completed，完成后迟到取消／Fail 不翻转成功 |
| 认证全量重读时旧终态、排除和清空不恢复 | 原绑定的终态、quarantine 和授权记录保持，隔离消息仍不可展示；来源排除、全局删除围栏及清空边界继续生效，不建立 `history_restore` 许可 |
| 新绑定的半成品页隐藏，失败留围栏 | 来源已核验后接纳的是同绑定的合法增量页；读取故障仍留围栏，无跨绑定副本。接纳一页后硬中断，重启保留该页、只读后续水位且无重复 |
| 取消早于接纳／精确取消／HTTP 响应未知 | 保留完整用例：取消意图持久化、重启不重放、旧 key 不停止新任务；HTTP 断开不取消已接纳操作，固定 GET/POST 合同及完整投影不变 |
| 成功通知及正常调度集成 | 仅原生和 holder 收尾后通知当前联系人一次；通知抛错不翻转 completed。真实 FirstHistory / Incremental 协调器恢复而不新建绑定或重排其他联系人 |
| 正常重启的来源元数据握手 | 六种完整清单／durable 能力组合均原地恢复；重启后重新核元数据，绑定仍一行，只读取新增 localId |
| 正常预检的交错及守卫失效 | 空／非空目标与 ResumeComplete 交错不重造围栏；瞬时 timeout 经两个明确正常调度节拍接上；真实 source_changed 同时持久改变表实例，两次调度仍围栏 |
| 失证后不供派生处理使用 | 用真实 `assertSourceEligibility` 拒绝旧来源，另验记忆启动只核元数据、不读正文，以及重验期间停读／关闭不恢复资格。本机聊天查看不冒充模型来源资格 |
| 旧代次映射及其删除闭包 | 保留在独立存量专用套件，由主 Agent 建立历史已存在的认证审计／映射夹具；不再让正常恢复服务继续承担旧 Rotate 协议，不删除这些保护 |

没有新增 skip，也没有以删除整份失败测试代替适配。旧“新绑定／两条连接／全量重读”的断言已被用户授权的新合同替换；不依赖这些旧实现细节的边界继续验证。

## 先失败后修复的证据

最小旧用例首先在新实现上失败（期望 completed，实际因旧夹具没有可靠恢复能力而 failed）。补齐正规能力／锚点夹具后，逐项替换冲突契约。

适配保留的保护又发现并由主 Agent 修复了三处实质问题：

1. 渠道 close 已 resolve，但保留真实来源故障码，错误地 completed；用例先 red，再验证拒绝并围栏。
2. 已进入正文读取后硬中断，持久状态仍为 metadata；在目标开始事务持久写入 history 阶段后 green。已知来源故障在提前清围栏的新流程中也须持久回写围栏，并由来源资格断言验证。
3. 关闭时反复抛已观察的瞬时 timeout，旧 guard 无法清理，后续调度持续 incomplete；区分已观察故障与关闭新增故障后恢复。

新测试中真实来源变化同时改变可核验元数据；只有错误码、而元数据仍完全相同的夹具不能冒充来源确实变化。两次正常调度为固定次数，用来覆盖首次恢复到增量接续，不轮询到成功。

## 实际命令与结果

均在 `backend-ts/` 执行：

```bash
node --test --test-timeout=10000 --test-name-pattern='重新认证保留旧消息但以新绑定隔离' test/sqlite-history-recertify.test.mjs
node --test --test-name-pattern='渠道close已resolve' test/sqlite-history-recertify-async.test.mjs
node --test --test-name-pattern='已持久记录guard故障' test/sqlite-history-recertify-async.test.mjs
node --test --test-name-pattern='正常读者预检期间守卫' test/sqlite-history-recertify-preflight.test.mjs
node --test --test-name-pattern='原地续读接受一页后硬中断' test/sqlite-history-recertify.test.mjs
node --test --test-timeout=20000 test/sqlite-history-recertify.test.mjs test/sqlite-history-recertify-async.test.mjs test/sqlite-history-recertify-candidates.test.mjs test/sqlite-history-recertify-preflight.test.mjs test/sqlite-history-recertify-restart.test.mjs
```

最终相关组：**55/55 通过，失败 0，取消 0，跳过 0**；约 8.95 秒。旧组适配过程中有死阶段 hook 的超时实验，已改为当前受控边界；本轮遗留的自有测试子进程已按精确 PID 清理，最终组正常自行退出。

## 数据影响与限制

只对临时合成库操作，包含真实事务、关闭和重启；没有打开真实业务库写连接、没有真实读取器／App 操作，也没有模型调用或外部聊天发送。本补充不证明真实备份回放、原生协议、真实 dev 界面或全量基线通过；这些由主 Agent 的独立验证记录报告。没有改生产代码、第三方依赖、全局测试时限或测试分类。

## 全量对照与审查补充

- 固定同源基线 `64376743d`：2157 例，2100 pass / 56 fail / 1 cancelled；纯 02 最终快照：2170 例，2120 pass / 49 fail / 1 cancelled。均以 `perl -e 'alarm 600; exec @ARGV' -- npm test -- --test-timeout=60000 --test-force-exit` 限时运行，按文件与用例名比较新增失败 0；没有把既有失败或本次未复现的 7 项标成全绿或已修复。
- 全量首轮新增失败已逐项回到最小用例：修正正常关闭返回瞬时状态时的释放、旧 v25/v26 注册表兼容，并按已授权新契约更新候选核对及空目标测试。新增 3 文件相关组 14/14；无 skip 或豁免。
- 独立 Standards 首次发现保留守卫分支跳过恢复锚点；公共 service 红例证实后统一 `prepareProof`，复核 0 遗留。Spec 0 项。最后的关闭、旧迁移与暂不可读分类由独立审查复核，22/22 与迁移 1/1 通过。
- 微信进程退出仅表示暂不可用：合成公共 service 五次重启均停读、不新增围栏，恢复后仅续读新 localId；guardCheck / acceptPage 两个阶段的失守会自动重试。真实账号、会话、代次、分片、表实例、文件身份与锚点改写仍保持围栏。
- 最终恢复与瞬时守卫相关组：22/22；候选/异步/重启等 55/55；存量副本删除与抑制 71/71；最小关闭/旧迁移 3/3；前述 guard/清空/排除相关组 62/62。具体外部条件与副本实际重启见同目录副本回放记录。

最后补查：配对脚本账号不一致的异常外逸先红后绿，完整入口合成隐私回归 1/1；原地恢复和故障补记新增围栏的实际入口加入固定诊断白名单，公共日志红→绿后，日志／恢复／隐私相关组 34/34。两处只影响诊断输出与白名单，复用此前有效的全量及正式副本证据。最终双轴审查无遗留发现。
