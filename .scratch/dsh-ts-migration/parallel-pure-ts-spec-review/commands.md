# 复验命令与边界

所有命令均在固定对象的私有快照内执行。`REPO` 是原检出目录，`FIXED_SNAPSHOT` 是新建的 0700 私有临时目录；日志使用 0600。不要把正在变化的 checkout 当候选源码。

```sh
git archive ff45f2ec296c4cead326d2ab6f3cf7770c9396ab \
  backend-ts/src backend-ts/test backend-ts/profile backend-ts/package.json \
  backend-ts/pnpm-lock.yaml backend-ts/tsconfig.json backend/database/migrations \
  | tar -x -C "$FIXED_SNAPSHOT"
ln -s "$REPO/backend-ts/node_modules" "$FIXED_SNAPSHOT/backend-ts/node_modules"
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$HOME/miniconda3/envs/NotAlone/bin:$PATH"
export NOTALONE_SPEC_REVIEW_SOURCE="$FIXED_SNAPSHOT"
cd "$FIXED_SNAPSHOT/backend-ts"
```

三条新增公开入口探针分别执行，均为正式产品 launcher，不需要 Python 路径、App 或真实配置：

```sh
node --test "$REPO/.scratch/dsh-ts-migration/parallel-pure-ts-spec-review/public-cross-module.test.mjs"
node --test "$REPO/.scratch/dsh-ts-migration/parallel-pure-ts-spec-review/public-layered.test.mjs"
node --test "$REPO/.scratch/dsh-ts-migration/parallel-pure-ts-spec-review/public-quality-guards.test.mjs"
```

只选择必要的既有用例，没有重跑整套：

```sh
node --test --test-name-pattern='质量冻结source_ref|最终HTTP实体按Unicode|有效质量预约ACK丢失|质量case错误scope|六phase同run累计8' test/quality-model-caller.test.mjs
node --test --test-name-pattern='结果未知的覆盖任务|有效期边界持久调度' test/layered-memory-management.test.mjs
node --test test/pure-ts-quality.test.mjs
```

可选设置 `NOTALONE_SPEC_REVIEW_RESULT` 为私有 JSON 路径以记录新增探针的元数据。不要指向真实账本、配置或资料。临时 PG fixture 经 Node 应用原 SQL，在随机 `_test` 数据库执行并自行删除；不运行服务端真实迁移。依赖、正式 launcher 和原 provider 均来自固定快照，供应商网络由测试专用 preload 仅导向本机 fake server。

逐组日志为 `public-cross-module.tap`、`public-layered.tap`、`public-quality-guards.tap`、`targeted-caller.tap`、`targeted-layered.tap`、`public-six-phase.tap`。自编探针三份结果 JSON 保存通过的行为断言；`verification.json` 记录源码复核、实际依赖版本和清理。
