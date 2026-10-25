# 小 delta 复验

`DELTA_SNAPSHOT` 是本次新建的 0700 私有临时目录，`REPO` 是原仓库；不要读取实际 `.env` 或问题账本。按以下对象准备两份源码，给它们各自链接已核对的锁定 `backend-ts/node_modules`：

```sh
git archive ff45f2ec296c4cead326d2ab6f3cf7770c9396ab backend-ts/src backend-ts/package.json backend-ts/pnpm-lock.yaml backend-ts/tsconfig.json | tar -x -C "$DELTA_SNAPSHOT/base"
git archive 4f89bb976dd4086a02b7ae983fee2760d6e4ff64 backend-ts/src backend-ts/package.json backend-ts/pnpm-lock.yaml backend-ts/tsconfig.json | tar -x -C "$DELTA_SNAPSHOT/candidate"
```

对 base/candidate 均新建 `backend-ts/test`，把 `git show 4f89bb976dd4086a02b7ae983fee2760d6e4ff64:backend-ts/test/extraction-verification-quality-regression.test.mjs` 的内容写为其同名测试文件。base 的额外夹具不是 base 原始源码。

按核心 `commands.md` 的 PATH 前缀使用锁定 Node；分别在两个 `backend-ts` 目录运行：

```sh
node --test test/extraction-verification-quality-regression.test.mjs
```

candidate 预期 2 过；base 预期 1 过／1 失败，首例先在新提示断言失败。行为差分及默认 builder 对照另运行：

```sh
export NOTALONE_SPEC_DELTA_SOURCE="$DELTA_SNAPSHOT"
node "$REPO/.scratch/dsh-ts-migration/parallel-pure-ts-spec-review/delta-compatibility.mjs"
node "$REPO/.scratch/dsh-ts-migration/parallel-pure-ts-spec-review/delta-coverage-probe.mjs"
```

二者 stdout 分别保存为 `delta-compatibility.json`、`delta-coverage.json`；只使用合成 invoke，不装配 provider、宿主、PG、SQLite 或 App，不读取真实配置。测试结束核对所有源 SHA 与自有进程引用，只删除本次私有副本，保留原依赖和其他负责方资源。
