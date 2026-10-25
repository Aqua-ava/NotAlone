# Spec 增量独立复核

结论：request_changes，1 项 P2。仅针对 `283a609f5f48503657bef571c0ea9539d4ee7b76` → `7a1f58a679245c6df84d88dfaafc3ff2c352c290` 的六个产品文件及直接测试；不认证票 25／26、整个迁移或真实 App。

**[P2] 准备响应未知后，同 key 重试的停止先命中旧登记。**

`desktop/src/main/reply/assistant-generation-jobs.ts:489–492` 用正序 `find`，而 `inputVersionId === null` 允许无回执旧登记。首次准备响应丢失后，旧作业按设计以 `transportEnded`／无 receipt 保留；同原 key 重试已有可见 `preparing` 时，Stop 会选中旧作业。旧 `preparationSettled` 已结束，因此在 `:517` 抛出“本次准备的停止身份尚未确认”；新准备没有收到停止意图，取得真实回执后仍派发生成。`session.ts:1632–1643` 保留同 key 重试，`:1829–1839` 每次重新登记，只有真实新回执在 `assistant-generation-jobs.ts:359–364` 才接管旧未知登记。

独立合成反例 `same-key-unknown-stop.test.mjs`：原请求首次准备响应丢失 → 原 key 重试停在 preparing → 点击空输入版本 Stop → 停止拒绝 → 放行真实回执；结果为 **1 次合成模型派发、0 次中断、最终 completed**，未执行真实模型。见 `same-key-followup-final.json` 及 `.public.log`。应将停止关联到当前可见的有效登记，并保持旧 unknown 的权威结算；不能仅因旧传输结束删除未知身份。

依据：`.scratch/dsh-ts-migration/spec.md:28` 要求“取消或切换任务后旧结果不再提交”，`:72` 要求每次物理模型请求受取消检查，`:95` 要求取消／晚结果生命周期验证；本轮明确要求 preparing 可见且可停止、真实回执中断确认前不派模型。该反例是新增 preparing／null 停止路径的缺口。

其余受查行为未发现本增量违约。`host-storage.ts:49–65` 在 owned client 分发前覆盖原生队列，锁定 pg 8.16.3；独立真实合成 PG 4 项验证重入 config、原生 Query、排队超时及同名业务异常，均通过。基线同一个重入 config 反例失败，另三项对照通过。`assistant-generation-jobs.ts:168–175,346–348` 主动通知 preparing 且 turn/input ID 为 null；`:107–110,467–475,503–541` 的真实回执、停止确认、退出与晚结果单作业边界通过。

最终验证：目标 **28 pass／1 fail／0 skip**。原停止及新增准备模块 14 项，独立生命周期 8 项，独立 PG 4 项，真实公开 PG→HTTP→BackendHost→IPC→preload→React 工作区 2 项通过；同 key 反例 1 项失败。原准备通知与重入超时的基线 RED 各复现一次。命令、源码和 raw／public SHA 均在 `verification.json` 及各运行 JSON；未跑全量或真实 App／微信，root 后续验收独立处理。

仅合成数据和 localhost／本机自有测试 PG；环境未继承模型凭据，未读取项目 `.env`、真实资料、原账本或私有模型输出。原日志在仓库外 0700 目录、0600 文件；仓库只保留脱敏证据。无产品修改、index 写入、commit、push、PR 或子 Agent。1056／120 与两条质量争议仍按用户决定 deferred，费用门槛豁免不改变取消合同。
