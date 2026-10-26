# 数据库与历史材料

生产后端已迁移到 [backend-ts](../backend-ts/README.md)。本目录保留 `database/` 中的原116份 SQL、数据库操作说明，以及仍有价值的合成夹具与历史测试资产；旧 `src/notalone`、Python包安装入口及 LangChain／LangGraph／Deep Agents 运行依赖已退役。

正常开发运行 `cd ../desktop && npm run dev`，无需 Python 或 Conda；原 `.env`、PostgreSQL 和资料位置不变。结构补齐由 Node `backend-ts/src/schema-prepare-cli.ts` 执行，未知结构继续停写，不创建替代空库。

历史对照明确固定 Git `23a767330e4af8a024629a00c8740344be564259`，仅通过 `backend-ts` 的 `test:historical` 与显式独立 venv 执行，不作为当前产品兜底。用 `npm run test:historical -- --list` 查看登记；未执行的历史测试不标为通过。

向量模型使用 [Node准备命令](../scripts/prepare_memory_embedding.mjs) 和既有固定缓存。模型输入、来源、授权、删除与人工发送约束继续适用。
