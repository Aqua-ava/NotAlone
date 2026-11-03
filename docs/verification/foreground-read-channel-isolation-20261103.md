# 前台识别读取通道隔离验收（2026-11-03）

## 范围与结果

按 [ADR-159](../../architecture/adr/159-foreground-read-channel-isolation.md)，前台账号／联系人快照改走独立只读 SQLite Worker，微信会话元数据使用独立窄协议 CLI；临时名单或绑定查询失败保留 OCR 预热模型。每轮仍采新帧，现有名称匹配、账号／来源／删除代次复验和超时规则保持。

前台数据只读，不增加正文读取或外部模型调用，不写身份确认或读取授权。附属读者复用主存储运行租约，不新增数据库、迁移或运行身份；由现有联系人元数据删除持有者及主存储关闭路径排空。

## 修改前后的相同负载对照

`sqlite-foreground-isolation.test.mjs` 通过生产 `ContactMetadataLifetime → SqliteForeground → ForegroundLocator` 调用，后台在原 SQLite Worker 执行八百万项递归求和 SQL。只有原生采帧和 CLI 名单是合成替身，数据库、快照、匹配及生命周期均为正式实现。

- 修改前：前台匹配 **643.4ms**，返回时后台已结束；断言“前台不应等待后台 SQL 结束”失败。
- 修改后：前台匹配 **0.9ms**，返回时后台仍在执行；同一 SQL 耗时 **611.2ms**。相关模块并行检查时前台 **1.9ms**、后台 **780.4ms**，结果仍通过。
- 删除回归：识别期间持久删除联系人并调用 `ActiveHolders.drain()`，旧结果被取消；旧名单及附属读者完成排空，其他联系人可以重新读取。

此对照验证排队隔离，不将合成采帧耗时作为实际 OCR 性能。

## 热更新开发 App 与真实渠道

执行 `cd desktop && pnpm run dev:status`，复用监督器管理的 `--notalone-dev` 宿主；未打包、未运行打包版。Computer Use 打开输入小窗，通过 Finder 激活已安装微信，核对当前私聊标题与助手自动选中的联系人一致，输入小窗显示“已按会话名称匹配到配置账号的已有联系人”。进入助手后按原规则暂停新视觉采集。

- 正式认证 HTTP 观察入口，真实局部 OCR、元数据 CLI 和 SQLite 快照：五次热态成功识别为 **247.4、253.6、254.1、254.4、264.3ms**，均返回 `confirmed`。
- 同时请求真实后台状态与正式前台观察：后台 `/api/sync/status` **5436.4ms**，前台完整观察 **247.4ms**、成功匹配，前台先返回。
- 微信非前台的另一组并发读取：后台状态 **10571.5／8772.9ms**，前台暂停结果 **16.4／5.7ms**；另一个后台状态样本在 12 秒诊断客户端期限处超时，前台仍在 **4.5ms** 返回暂停。后台统计本身仍慢，本次隔离不等同于所有后台性能问题已解决。
- 独立真实元数据 CLI 的三个新客户端首次读取 **144.3～180.0ms**，六次复用 **125.1～141.7ms**，全部在既有 **250ms** 预算内；每次校验账号前后及来源一致。未扩大预算。

桌面验收未发送消息、未触发候选生成或外部模型；未保存截图、姓名、身份标识、聊天正文或凭据到仓库。自有短期 CLI 均关闭，临时 Finder 窗口已关闭；正常开发实例及其前台／后台进程保留。未构建 App 或原生资源，可用空间检查约 97GiB，本次没有新增构建副本。

## 自动验证

- `cd backend-ts && node --test test/sqlite-readonly.test.mjs`：6/6。覆盖固定只读动作、物理禁写、租约／文件变化、WAL 事务外复验、父存储关闭／故障及在途关闭后的 checkpoint。
- `cd backend-ts && node --test test/sqlite-foreground-isolation.test.mjs test/sqlite-foreground.test.mjs test/sqlite-deletion-metadata.test.mjs test/sqlite-deletion-metadata-restart.test.mjs test/sqlite-history-hooks.test.mjs test/sqlite-storage.test.mjs`：30/30；补充删除 holder 路径后该单例通过。
- 前台及微信元数据相关四模块：63/63；补充账号／来源失效用例后的 `sqlite-foreground.test.mjs`：10/10。真实合成 Worker 回归先失败，再验证暂时查询故障后同一进程继续处理新帧；账号／来源变化仍回收。
- 官方 SQLite profile 选定的联系人、前台停用及关闭／重开用例：3/3；启动正式 DSH profile，渠道与模型使用明确合成边界，不启动真实模型。
- `cd backend-ts && pnpm run typecheck`、`cd desktop && pnpm run typecheck`：通过。
- `git diff --check`：通过。公开历史检查基线包含 3163 个提交、23408 个历史 blob，问题数 0；提交后检查结果随最终交付报告。

## 接口查证与限制

Node 实测版本为 24.22.1，`DatabaseSync({readOnly:true})`、`query_only`、短事务与 `setReadBigInts` 对照 [Node 24 官方 SQLite 文档](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)，并通过实际只读回归验证。

DSH 声明、锁和安装版本为 `0.2.1-rc.2`，Cordis 为 `4.0.5`；核对固定官方源码 `687f282e8625c6b8d11ff58211a90524be2e4317` 的生命周期说明及安装制品 `lib/types/fiber.d.ts` 中异步 disposer 合同。相邻源码工作树 HEAD 不同，不声称与 npm 制品逐字一致。本次沿用已有 `ctx.effect()` 关闭链，仅更改普通业务装配，未增加 DSH 接口或插件。

真实完整观察样本为单台本机、单个已有私聊的热态验收，不能推导所有布局、首次 OCR 冷启动或所有联系人切换的耗时上限。后台记忆调度重复全量扫描仍需独立优化；本次完成条件是前台不再等待这些任务的数据库或 CLI 队列。
