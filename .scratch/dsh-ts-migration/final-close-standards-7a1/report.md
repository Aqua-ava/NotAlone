# Standards 独立复核

**结论：request_changes，1 项 P2。** 固定基线 `283a609f5f48503657bef571c0ea9539d4ee7b76`，目标 `7a1f58a679245c6df84d88dfaafc3ff2c352c290`；只审六个产品文件和直接测试／单行 inventory。

## P2：同键重试的准备停止会先选中旧未知登记

出处：`desktop/src/main/reply/assistant-generation-jobs.ts:489–492`。新增 null 分支让 `.find()` 接受没有回执的旧登记，却没有优先选择当前仍在准备的作业。首次 prepare 响应丢失后，`finish()` 保留旧的 `transportEnded` 未知项；用户点击“重试同一次生成”时，原请求键会被重用。`states()` 按请求键覆盖，界面显示新作业的 preparing 和停止按钮，但停止实际选中 Map 中更早的旧项，立即报“本次准备的停止身份尚未确认。”。新 prepare 返回后继续发出生成 POST，之前的停止意图没有转交给它。

这条路径由生产 `ReplySession → installReplyBridge → preload` 独立复现，实际 `AssistantSessionPanel` 渲染也确认存在停止按钮。首次失败 `canRetry=true`；重试请求键严格相同；点击停止后、收尾前生成 POST 为 1，中断为 0。作业级独立反例得到同一错误并继续执行一次模型占位回调。模拟后端不调用真实模型，收尾另用真实回执停止自有悬挂请求。

建议在保留旧未知项、等待权威证明的同时，按可见当前在途登记接纳停止；不能简单删除旧未知项。回归需覆盖“准备响应丢失 → 同键重试仍在 preparing → null 停止 → 晚回执”。适用约束：`AGENTS.md` 的范围／运行证据规则、`docs/agents/engineering.md:5–7` 的职责分层，以及 ADR-102 的确定性业务契约和唯一执行责任。没有另行提出仅凭代码异味的主观修改要求。

## 原重入 P2 已关闭

同一独立合成 PG 对照在 283a 逸出原 Error，在 7a1 返回 `HostStorageError/database_unavailable`；原回调各一次、嵌套成功、全部本人写入回滚。owned-client `_pulseQueryQueue` 在原 submit／toPostgres 前观察原生 Query；WeakMap 去重有效，成功、服务端错误、排队超时均恢复原描述符并移除 end 监听。产品没有修改全局 pg 原型、配置、callback、参数、连接或 wire。安装源码 SHA 与作者 pg 8.16.3 pin 一致；该非公开观察点的升级依赖已明确保留。

## 实际验证与范围

- 重入基线／目标对照 3/3；独立 Query 去重／清理 3/3；原停止与新增准备停止直接用例 14/14；独立 IPC／未知／错回执／设置重载 4/4。
- 新同键重试反例：作业级 0/1，生产控制器／IPC 0/1，均确认同一 finding；没有扩大为第二项问题。首次 IPC 复现仅因 scratch 位置无法解析 esbuild 而启动失败，修正夹具依赖解析后才得到业务 RED，保留两份日志并明确区分。
- 未运行全量、类型检查、真实模型、实际 App 或微信；作者与 root 的通过数字不冒充本轮执行。退出竞态由 5 个新增直接用例中的停止／退出交错覆盖；设置重载和未知中断另有独立检查。
- 输入两份作者 manifest SHA 完全匹配委派记录；目标 6 个产品文件及直接测试均按 Git 字节核验。文件、命令、结果和 raw/public SHA 见 `source-pins.json`、各运行 JSON 与 `manifest.json`。
- 仅处理自有合成 PG 和本地替身；6 个自有库均不存在、夹具目录已清空。没有读项目 `.env`、真实资料、原账本或私有模型输出，没有产品修改、index、提交、push、PR 或新 Agent／聊天。原日志仓库外 0700／0600。

本报告只评价本次增量；不批准任务 25/26，不改写 deferred 记忆质量、费用输出豁免、旧失败或 unknown。真实 App 的准备停止复验仍归 root，且只允许 npm dev。
