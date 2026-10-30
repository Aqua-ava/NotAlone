# 历史实现与测试

当前 `npm test` 使用 Node.js ≥24，运行现行 TypeScript 业务测试。旧 Python oracle、双执行器／旁车及旧页面夹具由 `historical-inventory.json` 登记，源码保存在固定 Git 提交中，已从当前工作树移除。

## 查看测试范围

在 `backend-ts/` 执行以下命令，只列出登记，不运行测试：

```bash
npm test -- --list
npm run test:historical -- --list
```

清单中的 `currentCoverage` 和 `protectedAssetCoverage` 指向当前承接入口，不表示旧断言已逐项等价覆盖；未运行的历史测试不能计作当前版本通过。

`nonreply-comparison-plan.test.mjs` 和 `nonreply-comparison-blind.test.mjs` 是固定旧树的迁移评测工具测试，原文件与全部断言保留在上述历史来源中。它们需要 Git 忽略的 `.scratch/dsh-ts-migration/resumed-nonreply-evaluation/` 执行器、`baseline/` 冻结材料及旧 Python 环境；仅导出 Git 树无法恢复这些前置。当前入口对这两项明确报告前置未满足，不隐式复制材料或安装环境。两项均未执行，不能称为历史评测通过；从默认入口移除的是两个因模块缺失而从未执行断言的失败模块，当前持久会话测试不替代旧 1056/1152 分母与盲评验证。

## 显式恢复历史验证

历史入口固定使用提交 `23a767330e4af8a024629a00c8740344be564259`，导出完整旧树，不从当前源码导入旧 Python 实现。该 runner 复用当前 Node 依赖目录；移除 `pg` 后，它不能运行仍依赖该驱动的历史组合。这类调查应在单独恢复的旧工作树安装对应依赖并执行，不能把缺失依赖的结果算作有效历史验证。

先在仓库外导出该固定树，按其中 `backend/uv.lock` 准备 Python 3.12 的独立 venv；历史环境由调用者明确提供，不由正常测试隐式安装。入口不接受 Conda 或系统 Python。临时 HOME 中的旧目录名及 `CONDA_*` 仅用于历史测试兼容。

每次选择单个已登记文件或明确的页面范围，例如：

```bash
NOTALONE_HISTORICAL_PYTHON=/绝对路径/独立venv/bin/python npm run test:historical -- backend schema-prepare.test.mjs --test-name-pattern=隔离Python迁移比较器
NOTALONE_HISTORICAL_PYTHON=/绝对路径/独立venv/bin/python npm run test:historical -- desktop-pages --case memory-reading --timeout-seconds 60
```

单次截止时间最长 600 秒。失败时保留本轮精确临时目录，原夹具负责清理自己创建的数据库和进程；不能清理未知测试库或据此修改现有用户资产。固定旧树也不包含当前未提交的修改。

历史 App 入口沿用旧参数和租约门禁，不构成发布或打包授权；日常桌面开发与验收仍只使用 `npm run dev`。历史执行结果与当前业务、实际 App、模型质量及发行验收分别记录。
