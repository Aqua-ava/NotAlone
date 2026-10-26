# TypeScript 与 DSH 后台

生产后台由官方 DSH `0.2.1-rc.2` profile 启动，薄插件装配普通 TypeScript 业务模块。联系人、导入、消息、记忆、检索、候选、Skill、同步、后台任务及删除各有唯一写入责任；正常路径没有 Python旁车、旧框架或逐请求回退。DSH固定源码依据为 `687f282e8625c6b8d11ff58211a90524be2e4317`；安装锁见 `package.json`、`pnpm-lock.yaml`。

开发环境为 Node.js ≥24。日常从 `../desktop` 先运行 `npm run dev:status`，复用当前项目实例；没有实例才 `npm run dev`。它沿用原 `.env`、PostgreSQL、owner/contact/channel身份和资料目录，无需 runtime选择标记、Python路径或Conda。旧 `pythonExecutable` 配置被兼容忽略。

```bash
npm run typecheck
npm test
```

默认测试仅执行当前 Node 业务与生命周期覆盖；迁移阶段双实现 oracle、Python页面或旧组件验证在 `test/historical-inventory.json` 显式登记，完整旧树仍固定于 Git，不代表当前测试通过。

```bash
npm run test:historical -- --list
# 只有显式历史环境才运行单个已登记文件；独立venv必须由调用者指定
NOTALONE_HISTORICAL_PYTHON=/absolute/venv/bin/python npm run test:historical -- backend FILE.test.mjs
```

Node结构入口从仓库根目录运行：

```bash
node backend-ts/src/schema-prepare-cli.ts --migrations backend/database/migrations
node backend-ts/src/schema-prepare-cli.ts --prepare --migrations backend/database/migrations
```

原116份SQL、账本摘要、未知结构停写、旧NULL/v1政策、来源和删除决定保持。正常运行不会自动下载向量模型；显式准备使用 `node scripts/prepare_memory_embedding.mjs`，`--offline` 验证原固定缓存。

回复始终绑定已确认联系人。临时DSH执行状态不成为长期关系资料；来源、权限、预算、事务和调度由业务模块控制。外部聊天发送不属于Tool，最终消息由用户手动发送。关闭同步或退出时停读，取消和迟到结果不得写入已失效范围。

本轮迁移采集96/96成功、96物理调用、0重试；回复盲评及启动/RSS重复对照按用户要求跳过，不能称为质量或性能验收通过。开发实际App、合成HTTP/PG、模型和发行验收分别记录，未执行打包。
