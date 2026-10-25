# 完整依赖覆盖最小切片验证

基线：ff45f2ec296c4cead326d2ab6f3cf7770c9396ab。

- `cd backend-ts && node --test test/extraction-verification-quality-regression.test.mjs`：修复前稳定 RED，修复后缺依赖拒绝、两个明确正向场景保留；审计保留模型 supported 与原 any 标记。
- `cd backend-ts && node --test test/extraction-verification-quality-regression.test.mjs test/extraction-flow.test.mjs test/extraction-protocol-contract.test.mjs`：7/7，通过原 Python 协议逐字段对照。
- `cd backend-ts && perl -e 'alarm 300; exec @ARGV' -- node --test --test-concurrency=2 test/extraction-*.test.mjs test/tencent-memory-source-integration.test.mjs`：83/83，0失败0跳过，约29秒。
- `cd backend-ts && npm run typecheck`：通过；`git diff --check`：通过。
- Node/Python 均使用工程规定的 NotAlone 环境路径；没有新依赖、真实模型调用、桌面操作、原库读取或写入。
- 原始 E/V 响应私有离线回放由迁移主会话执行；本切片尚不代表真实质量通过。P3 单源语义错误继续保留。
- 未暂存、未提交；共享 Git 和独立复审由迁移主会话收口。
