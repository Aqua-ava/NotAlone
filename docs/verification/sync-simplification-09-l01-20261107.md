# 同步减负 09：16:45 L01 取证

## 结论

**事发时的原生触发原因未复现。** 现有证据不能断言真实来源变化，也不能断言当时只是微信暂不可用。已复现的是旧后台把 `history_source_unverified` 升格为持久围栏的行为；该分类已由任务 02 的 `7b5def9bb` 修正，本任务没有新增产品代码或放宽拦截。

## 已确认的事实

- 本机诊断只有一条：2026-11-07 16:45:47.557（UTC+8），`history.markContinuityLost` / `L01` / `history_source_unverified`，联系人 `27ab43c0`。
- 事发前后各五分钟没有新 `read_goal`；有两条成功 `sync_capture`，分别在 16:40:48.194、16:45:17.434，均 `accepted`、无错误。最后一页距围栏约 30.1 秒。失败在页接纳前出现时不会留下失败页收据，不能据此推断原生调用位置。
- 迁移 46 前备份中该联系人已经有围栏、守卫为 `lost`。当前来源证明为 `needs_confirmation`、`checked_at` 为空；账号、会话、来源代次、分片和表实例与最后一个成功目标一致。此比较只证明保存的事实一致，不证明当时的外部文件和进程未变化。
- 迁移前备份的 `database_instance.epoch` 为 1232，当前为 1233；epoch 是运行实例代次，缺少事发前后的逐时记录，不能将其当作微信物理来源发生变化的证据。
- 事件发生时 02 尚未合并：旧版本 `64376743d` 的 `history/sqlite/continuity.ts` 将该码列入 `lostCodes`。当前 `ea9304870` 不再将其视为已证实来源变化。
- 现有开发宿主在 18:30 启动，实际读取器仍为已验收的 `fence-guard-registration-20261107-v1`；二进制 SHA-256 为 `b925d805a79f3102f1b8d2a7c5b76a3592ce9ea321d91fc2b79619836c39c795`。当前微信进程在 17:41 启动，均不能反证 16:45 的状态。本次没有重启或切换读取器。

## 分支与错误码

`actions.ts` 的 `history.markContinuityLost` 先要求原绑定仍为 verified，再要求保存的会话和来源代次与 token 相符，然后由 L01 写停读状态。此入口本身不重新取证原生来源。旧服务的守卫 loss 回调、读取 catch、关闭状态处理及增量恢复均可能调用它；只有 L01 和错误码不能区分具体调用点。

实际制品源码 `local-tools/wx-cli/.notalone-builds/fence-guard-registration-20261107-v1/source/cmd/wechat-cli/` 中：

| 位置 | `history_source_unverified` 的条件 |
| --- | --- |
| `notalone_protocol.go:189–213` | 来源进程提供器、进程核验、目录守卫、monitor、进程监听、启动或首次 Check 失败 |
| `notalone_protocol.go:352` | inspect 建立来源守卫失败 |
| `notalone_snapshot.go:318` | 快照守卫建立失败 |
| `notalone_account_metadata.go:153` | 会话／联系人目录守卫创建失败 |
| `notalone_protocol.go:1179` | 启动别名文件核验失败 |

`notalone_process_darwin.go:46–85` 要求恰有一个微信主进程，并核对可执行文件和启动时间。未运行、多进程及瞬时无法核验都可能折叠为该码。日志没有细分条件，不能补写推测根因。既有守卫登记修复仍在制品中，没有再次修改它的证据。

## 旧红／当前绿验证

在额外隔离工作树固定旧生产代码 `64376743d`，仅复制当前已有的 `sqlite-history-in-place-recovery.test.mjs`，运行同一个公开服务用例：

```sh
node --test --test-name-pattern='来源暂不可核验时五次重启' test/sync-09-source-replay.test.mjs
```

旧代码 1/1 失败，断言 `fences.length` 实际 1、期望 0（第一轮即新增围栏）。当前工作树运行：

```sh
node --test backend-ts/test/sqlite-history-in-place-recovery.test.mjs
```

16/16 通过，失败／取消／跳过均为 0，约 5.1 秒。覆盖五次不可核验重启不新增围栏、恢复后仅续读新 localId，以及账号、会话、代次、分片、表实例、文件身份、锚点改写和缺失仍拒绝。该反馈环复现了旧错误分类，**不等于复现历史原生故障**。没有新修复需要伪造一次新的 red→green；复用 02 的既有修复和回归。

未改变代码、依赖或测试条件，全量基线复用任务 04 最终同源结果（见 `sync-simplification-04-test-coverage-20261107.md`）：新增失败 0，既有失败仍存在；本任务不宣称全量全绿。

## 数据影响与边界

真实库与迁移前备份仅只读查询，未读聊天正文，未写库、授权或同步开关。测试只写合成临时库，无模型请求、微信消息、打包或远端操作。原始数据库、身份映射和日志不提交；报告仅保留编号、计数及固定错误码。

03 可以继续使用已合并的原地恢复，但须先备份、逐步检查绑定／消息与新围栏；若实际核验失败应保持停读。历史原生细分原因无法补证是本任务的剩余限制。
