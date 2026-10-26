# 历史 Python 测试

当前入口 `npm test` 使用 Node 24，保留普通 TS 业务测试。`historical-inventory.json` 逐项登记迁移阶段的 Python oracle、旧双执行器／旁车、旧页面与 Playwright 夹具；原测试保留，不按环境扩大 skip，不把未运行的历史资产计为通过。`currentCoverage` 指向现行业务入口，不声称每条旧断言逐项等价；本轮实际结果见退役交接。

历史比较固定在 Git 提交 `23a767330e4af8a024629a00c8740344be564259`。显式入口会导出该整树，复用相同锁定版本的 Node 模块，并只使用指定的独立 venv Python；不会从 HEAD 导入 `backend/src`，不需要 Conda。为了兼容旧测试中的固定路径与环境检查，临时 HOME 内的旧目录名指向该 venv，`CONDA_*` 只作为历史测试兼容字段，不激活或使用 Conda。

先在仓库外导出固定树，按其中 `backend/uv.lock` 准备 Python 3.12 的独立 venv。不要安装 HEAD 的旧生产包，也不要将本机现有 Conda 解释器传给历史入口。历史源和 venv 的准备独立进行，不由正常测试隐式安装。

```sh
cd backend-ts
npm test -- --list
npm run test:historical -- --list
NOTALONE_HISTORICAL_PYTHON=/绝对路径/独立venv/bin/python npm run test:historical -- backend schema-prepare.test.mjs --test-name-pattern=隔离Python迁移比较器
NOTALONE_HISTORICAL_PYTHON=/绝对路径/独立venv/bin/python npm run test:historical -- desktop-node tests/packaging/psycopg-rebuild.test.mjs
NOTALONE_HISTORICAL_PYTHON=/绝对路径/独立venv/bin/python npm run test:historical -- desktop-pages --case memory-reading --timeout-seconds 60
```

每次必须指定单个登记文件或明确的页面／App 范围，截止时间最长 600 秒。`desktop-app` 沿用旧 `scripts/test-app.mjs` 的原参数和租约门禁；该历史能力不是发布或打包授权。本轮未运行此固定旧树／独立 venv 历史命令，也未运行浏览器或 App。早期最小验证曾触发旧建库夹具及一个103序列化 Python oracle；这些合成执行记录保留，不计为最终 Node 入口验证。失败会保留本轮临时树，原夹具仍负责精确数据库和进程清理；不可清理未知测试库。

三个用户资产保持原位且不修改。固定 Git 旧树不包含这些文件当前未提交的用户修改；历史运行结果不能冒充当前用户资产已运行。受保护表达偏好夹具的 Node 业务承接见 `protectedAssetCoverage`，包括偏好范围、幂等、CAS、删除、来源失效以及公开记忆管理入口。原 SQL 116 份和固定合成材料由主协调保留。
