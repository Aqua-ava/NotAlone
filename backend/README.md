# 数据库与合成夹具

生产后端已迁移到 [backend-ts](../backend-ts/README.md)。本目录只保留数据库与合成夹具；旧 Python 后台、测试、基准脚本及本地编译缓存已清理，历史实现通过固定 Git 树追溯。

- `database/`：原116份 SQL 与数据库操作说明，当前 Node 安装和结构准备仍使用，不能随历史后台删除。
- `tests/fixtures/`：导入及回复评测的 JSON／JSONL 合成材料。仍保留原路径和原始字节，兼容现行测试与冻结评测清单中的来源路径、摘要，不表示 Python 测试仍在执行。
- `tests/integration/server/fixtures/`：历史批量更新的合成重放材料，作为证据保留，不是可运行的 Python 测试入口。

正常开发运行 `cd ../desktop && npm run dev`，无需 Python 或 Conda；原 `.env`、PostgreSQL 和资料位置不变。结构补齐由 Node `backend-ts/src/schema-prepare-cli.ts` 执行，未知结构继续停写，不创建替代空库。

历史对照明确固定 Git `23a767330e4af8a024629a00c8740344be564259`，仅通过 `backend-ts` 的 `test:historical` 与显式独立 venv 执行，不作为当前产品兜底。用 `npm run test:historical -- --list` 查看登记；未执行的历史测试不标为通过。

向量模型使用 [Node准备命令](../scripts/prepare_memory_embedding.mjs) 和既有固定缓存。模型输入、来源、授权、删除与人工发送约束继续适用。
