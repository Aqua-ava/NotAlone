# probe.test.mjs 既有失败定性：测试过时还是真缺陷

修复已按用户批准方向 1 完成（提交 `c343b4ddb`，2026-11-07）。

Triage: ready-for-human
State: resolved
Type: task（只读调查；不写修复代码）

Blocked by: none

先读 [spec.md](../spec.md) 全文与任务 04/B1 的相关背景（`self-verification-review-20261106.md` B1 节），然后按 spec 执行五步调查。

要点回顾：失败用例"仓库探针公开准备入口…"；`paths.syncProbePath` 实际 `''`；任务 04 记录"更高层启动装配路径"、runtime-cache 同源用例通过；B1 收口都未混修。

产出：`docs/verification/probe-entry-failure-investigation-20261107.md` + 任务单 Answer 定性；`Triage: ready-for-human` 等 user 裁决；修复不写。

## Answer

**定性：测试过时，不是真缺陷。**
- probe.test.mjs:88 断言旧装配形态：`52ab1a6f7`（10-30）将 desktop/src/main/startup/diagnostics.ts:30 的 getPaths 改为不传资源目录（原 `loadBackendConfiguration(this.userData, this.resourcesDirectory)`），getPaths 语义收窄为“仅显式配置值”；包内探针解析上移到 desktop/src/main/backend/host.ts:281（仍传参，真实启动链完好）。测试文件自 `3f9c1e74d`（10-19）未同步。
- 经验包围圈：`52ab1a6f7^` 4/4 通过；`52ab1a6f7` 起与 HEAD 同样在行 88 失败（实际 `''`）。runtime-cache.test.mjs 2/2 通过，且当前 HEAD 真实 codesign 复核 prepare 产物通过；与 B1 简化（`99e891c84`，11-07）无关。
- 报告：docs/verification/probe-entry-failure-investigation-20261107.md。修复（断言迁移到 runner `probe` 字段 / 或产品恢复 getPaths 解析）等用户裁决，未改码。

## 修复结果

**修复已按用户批准方向 1 完成（`c343b4ddb`，2026-11-07），只改 `desktop/tests/helpers/probe.test.mjs`。**

- 正向迁移 6 处（原 `:88/:149/:176/:201/:205/:215`）到 runner 的 `probe`/`headerChange` 字段；`paths.syncProbePath` 只保留显式配置读写三族断言：无配置空（`:90`）、backend-launch.json 显式值（`:244`）、环境变量路径原样返回（`:234`）。
- 负向拦截重定位 5 处（原 `:115/:119/:209/:211/:213`）为篡改三重奏：每条同时断言篡改版否定（`runner.probe` 回退 `unconfigured` 占位、`headerChange` 为 undefined）与完好版肯定恢复。
- 删除恒真 3 条（原 `:158/:164/:170` 来源组合拦截）：`99e891c84` 后 `validRepositoryBuild` 只核验摘要自一致与 sha256 格式、组合改由构建期对齐；实证（每次独立目录规避 A3 缓存，真实 codesign）incomplete/orphan/unknown 与完好清单解析同值，不留恒真断言。
- 篡改维度：X 位、helper 文件缺失、清单 `$signingIdentifier` 换写、同签名短 probe 冒充（真实 codesign --display 标识不匹配）、dylib 字节篡改、包内环境变量绕过；均经每次启动独立进程现场核验，模块级缓存按资源目录键控且不跨进程，无缓存串扰。
- 验证：`node --test tests/helpers/probe.test.mjs` 4/4（原失败用例全绿）；`node --test tests/header-change-source-process.test.mjs tests/header-change-diagnostics.test.mjs` 16/16；`npm run typecheck` 通过；`check_public_history --ref HEAD --working-tree` issues=0。

## Comments
