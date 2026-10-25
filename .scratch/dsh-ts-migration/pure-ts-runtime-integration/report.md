# 纯 TS 产品运行路径工程交付

已完成独立可选的完整 TS 宿主装配。`NOTALONE_HOST_RUNTIME=typescript` 使用原官方 DSH CLI/profile，不启动 Legacy；默认 `legacy` 保留。自有 28 个生产／测试文件按 `source-manifest.json` 冻结，7 个既有文件的修改不包含其他聊天的改动。

公开服务继续使用原 owner/contact、绑定、来源、PG 事务、任务和删除链路。会话、回复、探索、分层管理、质量评估由同一 TS 服务承担，未增加第二套业务状态或运行时聊天发送能力。手动确认范围只在已核验请求／已授权异步作业中生效；回调结束后继承上下文失活，后台学习回到原身份规则。

启动在业务读写前持有同一受管 PG 寿命锁；ready 前完成资料门禁、Skill 和同步激活。关闭先停收，取消／排空维护、同步、任务、资料与模型，再关闭 PG 并释放寿命锁。恢复使用原持久状态；无法证明已结束的旧 C 不盲重放。

同步只覆盖原已授权范围。原 `message.created`、`sync.status_changed`、`task.progress` SSE DTO 保留，有界提示队列不另存聊天正文。分层自动维护以 PG 通知和到期计时唤醒同一管理器，只有管理器可创建原任务，已有暂停／失败任务不被自动恢复。

质量评估接同一已安装 provider、Unix 许可、PG authority、原问题预算及唯一 Store。冻结 source_ref 使用 Store helper，由 PG 对实际 case 与摘要核验；安装时 guardBound 只表示绑定成功，不表示额度。公开六阶段执行实际 8 次，与 provider 请求数、run 计数和原合成 SQLite `used` 一致；重开只读取原报告，未发布产品记忆。

桌面所需的会话分片使用实际 JSON 字节摘要、UTF-8 边界和 read_id CAS；候选版本按 through 锚点分页。候选历史不暴露内部 edit_key，保存继续使用原 receipt。

## 验证与失败轨迹

最终有界组合回归 **52/52**、0失败、0跳过，94.006秒；其中本片10项，原 host/model/handoff/Skill/contact/Discussion42项。`tsc --noEmit` 与精确范围 `git diff --check` 通过。精确命令、日志名与 SHA 见 `validation.json`，原始日志只留仓库外0700目录／0600文件。没有全后端、桌面全量或正式性能声明。

产品验证使用真正 `launchDsh`、官方 profile、随机合成 `_test` PG、本机假 provider 和绝对不存在的 Python 路径；纯 TS 分支的 OS 进程树零 Python。Legacy 回归仍在独立合成夹具启动原 Python，证明兼容臂保持可用。

开发中先复现无 ready、缺失公开链路／SSE 与绑定错误的 RED，再接线至 GREEN。Node 原生 strip-only 不支持的参数属性已改为显式字段；测试清理次序曾造成自有合成库被连接占用，已改为先关闭额外客户端再 drop，并仅清理精确自有库／目录。维护用例重复 pool.end 由夹具幂等关闭修正。

质量首轮只验证运输，不能算 SDK 资格通过；随后安装时 bound 与冻结来源门禁接入，最终同账本用例通过。另一次执行中 case/run 404 是默认自动维护依法改变组织世代、删除旧快照；质量夹具改为经公开 disable 隔离后冻结输入，产品默认维护没有关闭或绕过。

## 数据与范围

没有新表或结构迁移。原资料、规范化消息、候选／确认记忆的分层、来源和删除路径保持。公开适配器与维护唤醒不复制真实正文；质量输入和报告仍由既有 Store 保存并受原来源／代际守卫约束。测试全部使用合成资料；未读取真实 `.env`、数据库资料或预算，未调用实际供应商。

本片没有启动或操作 App／微信，没有外部发送、打包、共享 index 操作、本地提交、push 或 PR；根统一集成与提交。原用户三个测试文件未改动。协作依赖按各自 manifest 签收，见 `dependencies.json`。

`follow-smoke.last_valid_observation` 目前保留 null／unknown；不是正文读取证据。`sync/confirm` 与 `confirm-pending` 保留既有 scope 移交后的503，当前桌面走 cli-bindings/confirm。原始 response model／system_fingerprint 无官方 hook，仍为 unknown。真实模型质量、费用／120资格、1152协议、实际App／微信、正式性能、独立复审和 Ticket25／26 均未由本片签收；兼容分支待25通过后按26处理。

路由覆盖和第三方边界查证分别见 `route-matrix.md`、`dsh-verification.md`。本次冻结后仅按根的明确复现缺陷继续修复。
