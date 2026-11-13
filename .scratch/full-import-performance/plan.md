# 执行与取证

用户已批准两路并行及现有公开 Seam。01 与 02 无阻塞边；两者完成后由根负责人集成、双轴审查、统一基准及桌面验证。

- 01 负责 postgres_repository、新迁移和相关导入/overview 测试，不修改追踪表示。
- 02 负责 source_processing、reader/preview 及相关测试，不修改 postgres_repository 和迁移。
- 根负责人负责基准脚本、spec、验收记录、合并和最终 main。
- 桌面仅根负责人使用。只运行 npm run dev，先检查并复用实例；禁止打包、push 和 PR。
- 基线 7e0b086960f82320216ad983235f01dcdfb394de；固定同一基准、输入、PostgreSQL/Python 环境。100/1000/10000 条，计时与计数、内存分离；独立基准期间避免其他重负载。
