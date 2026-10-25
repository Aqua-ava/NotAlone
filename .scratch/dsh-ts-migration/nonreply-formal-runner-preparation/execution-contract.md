# 非回复执行适配与发送接缝

本目录只支持 `dry-run` 和 `fake`。`real` 及任何 real/key/credential 开关直接拒绝。模块不读取真实密钥、项目 `.env`、真实库或既有问题账本，也不创建真实预算。`syntheticBudget` 是有时限的内存测试替身，不是正式 ProblemBudget。

按用户最新[输出与费用决定](output-cost-scope-update.md)，正式执行不以固定4096、输出容量、费用余额或1.10费用比准入、停止或验收；输出按实际需要配置，费用/用量仍完整记录。本目录既有4096仅保留为已完成假provider夹具配置，不能继承为正式上限；已冻结探针不重跑。

## 根注入接口

`createOfflineAdapter({plan, directory, budget, permission})` 在创建 PG 或启动 profile 之前要求两个端口。`createSendGuard` 额外要求：

- `budget.problemId`：根持有的同问题标识；`deadline`：有限绝对毫秒截止时间。
- `budget.reserve(input)`：对整组双臂和全部物理尝试共用、原子预留的接口；返回 `reservation_id`、`assertCurrent(input)`、`markSent(input)`、`settle(result)`。
- `permission.assertAllowed(input)`：根的授权与范围复验，预留前和发送前都必须明确返回 `true`。
- `input` 绑定 owner/contact、旧/新臂、完整源码 pin、候选 pin、run ID、case SHA、请求 SHA 与取消信号。失败、取消和已预留但未发的尝试均保留，接口不退款。

真实执行器仍须把根持久问题账本和真实供应商发送边界连上；本目录没有可开启的真实传输。这里的发送端口只演示 loopback 传输，并在 adapter 建立之前拒绝缺物理尝试记录端口或许可的调用；不要求费用余额或输出容量额度。真实计费记录、旧 Python 外层物理尝试记录桥及完整生产宿主真实发送许可均须由根另行完成，不能用本地替身证明它们已具备。

Node 进程和 DSH profile 用 `network-guard.mjs` 在 Socket 连接前拒绝外部地址；旧 Python 子进程原有 socket 限制只允许 localhost 与本机 PG。guard 的实现不进入产品代码。DSH 仍经固定官方 profile 启动，薄评测插件只装配既有公开业务服务，不增加模型 Tool。

## 输入与事件

`material-adapter.mjs` 不修改原材料或 oracle。所有36例保留 `as_of`、原来源 ID、版本、状态、观察时间、既有投影和 Skill。说话人由冻结文本中的明确作者前缀推得，与事实 `subject` 分开；歧义保留 `unknown`。

L2/L3 的公开服务和旧 Store clock 采用冻结 `2026-10-23T04:00:00.000Z`。Skill 保留原观察时间与普通/修正来源，产品没有独立 `as_of` 参数，不能声称注入了统一学习时钟。提取原材料没有 `as_of`；沿用原适配器的 `2026-09-15` 消息锚点，正式时间类质量仍需根确认适配资格。

三份取消例先开始实际业务任务，在假供应商收到请求后，通过新臂公开 HTTP 或旧臂公开命令持久取消，再返回冻结 `synthetic_late_result.text` 对应的 write 或待审核 draft 提案。事件不作为模型操作指令发送。L3 例沿真实 L2→L3 共用任务，在首个请求处注入；没有认证每一个 L3 内部提交点。

冻结 L2/L3 `existing_projection` 全部是 `null`，因此明确记录不存在既有投影，不伪造旧版本。Skill 通过公开库导入后映射到当前联系人的已启用 v1，并核对学习前后的完整版本状态。初始删除来源只建无正文删除回执，不重建消息或派生记忆；这不是额外执行一次产品删除操作。

## 复现

从 `$REPO_ROOT` 使用已约定 PATH，不 activate、不安装依赖：

```sh
node .scratch/dsh-ts-migration/nonreply-formal-runner-preparation/probe.mjs dry-run --label NEW_PLAN
node .scratch/dsh-ts-migration/nonreply-formal-runner-preparation/probe.mjs fake --confirm-synthetic --label NEW_PROBE --case-ids '["l2_scenario-11","l3_profile-11","skill_learning-11"]'
node .scratch/dsh-ts-migration/nonreply-formal-runner-preparation/trace-packets.mjs extraction-ev-ledger NEW_BLIND_LABEL
node --test .scratch/dsh-ts-migration/nonreply-formal-runner-preparation/{send-guard,material-adapter,neutral-trace,network-guard,evidence-contract}.test.mjs
```

输出 label 必须全新且不能含路径。`probe.mjs` 把源码导出到仓库外0700专用目录，链接既有依赖；不使用漂移 working tree 代替 pin。子进程最多300秒，模型替身无重试。原始 journal、响应、捕获和 harness 副本为仓库外0600，公开仅保存元数据、失败摘要和 SHA。所有派生报告保留1056非回复/1152统一分母；测试退出0不是正式质量通过。
