# 助手 generation 生命周期组件冻结记录

本记录仅认证本组件的合成公开业务链路；不签收迁移票25／26。

## 实现与合同

- 新 TS writer 从公开 prepare 请求建立持久锚点与输入版本；无需 Python 或人工预置 anchor。
- 公开 replies、replace、interrupt、retry-interrupted、continue、preparation-format 与异步 prepare 均由新生命周期承接。
- 已确认探索经独立 bridge 进入同一 prepare/generate，返回原 prepared/generated 终态；中断后沿现成探索 reconfirm 创建新执行身份。
- 同 owner 事务保留原来源、授权、覆盖确认、输入 CAS、候选版本、累计要求、失效键和 Skill 资格；没有新模型层、发送 Tool、表或 ID／alias 变更。
- 同键在途现在立即返回处理中，避免先排队等模型许可、在首请求失败后无意再次执行；最终候选仍只有既有 C writer。

## 已运行验证

1. `cd backend-ts && node --test --test-concurrency=1 test/assistant-generation-errors.test.mjs test/assistant-generation-lifecycle.test.mjs test/assistant-generation-explored.test.mjs`：最终结果见下方冻结数据。
2. `cd backend-ts && node --test --test-concurrency=1 test/assistant-discussion-service.test.mjs test/reply-assistant-guards.test.mjs test/reply-assistant-erasure.test.mjs test/reply-discussion-context.test.mjs test/reply-preflight-prepared.test.mjs test/reply-exploration-guards.test.mjs`：31/31，通过，约17.0秒。
3. `cd backend-ts && npm run typecheck`：新组件阶段通过；最终全局检查状态见冻结数据。
4. 本次12份新源码／测试的公开扫描：0项；未读取真实配置或私人词典。根统一集成后仍须运行全历史检查。

新增测试包含两项无副作用的公开协议检查，以及10项官方runtime／真实PG业务检查。公开链路覆盖：prepare零供应商请求；TS创建原锚点；官方runtime候选保存与重放；同键异稿；未领取封键证明；替换／中断／重试；继续及要求冲突；job去重／范围隔离／取消迟到预检／短期句柄重启失效；格式兼容及损坏封键；零C重启裁定；并发同键；替换时真实C在途及旧候选迟到；manual与desktop并存；202返回后重入manual范围；历史pending／incomplete门禁；授权撤销；新消息采用继承；来源失效；active Skill准备后停用；探索prepared／generated／replay／重新确认执行身份。

原始失败保留：最初缺模块RED；异步测试在门暂停时的有界中断；不完整合成Skill工作目录；一次短期状态等待上限不足。均保留在端侧记录或对话执行记录，不作为最终通过证据。状态等待已给定单条6秒边界，不反复无限轮询。

## DSH 核验

锁定 `0.2.1-rc.2`／`687f282e8625c6b8d11ff58211a90524be2e4317`；核对官方[启动架构](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md)与[Agent接口](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/README.md)。本组件不直接调用新DSH接口：只注入现成回复／探索服务，取消和持久恢复保持业务库权威；模型执行仍由现有官方profile、Agent及scope机制承担。新增测试通过官方launcher运行，没有直接拼装替代框架核心。

## 数据与资源

- 只使用随机 `_test` PostgreSQL、本机假provider与合成文字；新增公开测试建库／迁移完全使用Node。
- 相关旧回归保留隔离Python建库夹具；不据此宣称纯TS产品宿主启动已验收。
- 未读取真实 `.env`、联系人、聊天、凭据或业务库；未调用外部模型、操作桌面、打包、暂存、提交、push或PR。
- 完成运行的合成库／临时目录由夹具清理。早期有界RED中断遗留的唯一库，已用自有profile、创建时间及精确合成状态核对，确认零连接后删除；未终止其他进程。
- 原始日志只在仓库外0700目录，文件0600；公开证据仅含相对路径、计数及哈希。

## 限制与集成责任

- `recover` 遇到仍为running的C，返回 `assistant_generation_recovery_unconfirmed`；宿主必须先沿原在途／租约规则取得唯一责任，不自动重放物理结果未知的模型调用。
- job句柄按原协议只在本实例短期保留；重启后status返回404。持久输入与锚点仍可读取，显式重试重新核验来源和身份。
- 本组件未操作真实App／微信，未进行真实模型质量或性能验收。正式宿主鉴权、SSE、启动／退出与最终独立验收由根统一集成后认证。
- 保留旧生产实现与依赖，不更新票面状态；本组件的通过不表示25已通过或26可删除。

## 冻结数据

- 新增公开组：12/12，0失败0跳过，33.87秒；现成相关组31/31，17.02秒。
- 最终全局类型检查通过。
- 最终自有合成宿主目录残留：0；早期RED遗留库的单独清理记录哈希 298db18a5440331f8b3c449c818d13e1737225a3f50355c444793054baeaf70b。
- 端侧日志／记录 lifecycle-final.log：SHA-256 22c6301b00700fae0813f441476633148d59a4aa66c82c54bba7da993761bc56。
- 端侧日志／记录 related-final.log：SHA-256 8e87c8944dad9b8223bf301fe3f71060c234fadf961235437701a053d94ad944。
- 端侧日志／记录 typecheck-final.log：SHA-256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855。
- 端侧日志／记录 cleanup-final.json：SHA-256 298db18a5440331f8b3c449c818d13e1737225a3f50355c444793054baeaf70b。
