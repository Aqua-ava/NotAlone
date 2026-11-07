# probe.test.mjs“仓库探针公开准备入口”既有失败定性调查

调查日期：2026-11-07。基线提交：`84c72f1d2`（main）。命令：`cd desktop && node --test tests/helpers/probe.test.mjs`。
背景：任务 04 与自检复审 B1（`self-verification-review-20261106.md` §B1）均记录该失败在 `6685e7d9c` 之前已存在；本任务只定性，不改代码。

## 结论

**测试过时，不是真缺陷。**
断言针对的是 `52ab1a6f7`（10-30“退役旧PostgreSQL启动路径与手动文件导入入口”）之前的启动装配形态：当时 `StartupDiagnostics.getPaths` 会沿资源目录解析包内探针并回填 `paths.syncProbePath`。该提交把 getPaths 改为只读取显式配置，包内探针解析整体上移到真实启动装配点（`desktop/src/main/backend/host.ts:281`，仍传 `resourcesDirectory`）；`desktop/tests/helpers/probe.test.mjs` 从 `3f9c1e74d`（10-19）起未再修改，未随装配迁移同步。

## 复现记录

- 4 个用例：3 通过 1 失败；失败用例“仓库探针公开准备入口仅构建搬运，现场隔离配置沿包内默认路径核验核心库”卡在首个启动装配断言：
  - `desktop/tests/helpers/probe.test.mjs:88`：`paths.syncProbePath` 实际 `''`，期望 `<隔离目录>/Resources/notalone-probe/notalone-sync-probe`。
- 该用例前半段（prepare 成功、manifest 20 个 buildSources、`signingIdentifier`、`buildSourceDigest` 格式，`:44-67`）全部通过，说明 `desktop/scripts/prepare-probe.mjs` 产物与清单本身无异常。
- 同源 `tests/helpers/runtime-cache.test.mjs` 2/2 通过（prepare + `verifyBundledRuntime` 有效；该用例注入 codesign 替身，真实码签见下）。

## 为什么为空（数据流）

1. 测试 runner（`probe.test.mjs:69-88`）以 esbuild 打包 `src` 后调用 `diagnostics.getPaths()`，输出 JSON 的 `paths.syncProbePath`。
2. `desktop/src/main/startup/diagnostics.ts:30`：`loadBackendConfiguration(this.userData)`——未传 `resourcesDirectory`。
3. `desktop/src/main/backend/config.ts:80`：`resolveSyncProbePath(undefined, 未配置值)`。
4. `desktop/src/main/backend/bundled-helpers.ts:35`：无显式配置时走 `bundledRuntime()`；`:23`：`verifyBundledRuntime` 遇 `!resourcesDirectory` 直接返回 `undefined`。
5. `config.ts:88`：回空串。即**只要没有 `backend-launch.json`/`NOTALONE_SYNC_PROBE` 显式配置，getPaths 必然空**；只有显式路径才透传（`bundled-helpers.ts:36-41`）。原预期“解析出包内探针”是旧行为。

## 历史对照（证据）

- `git show 52ab1a6f7 -- desktop/src/main/startup/diagnostics.ts` 中 getPaths 差异：
  - 删除行：`configurationPaths(await loadBackendConfiguration(this.userData, this.resourcesDirectory))`
  - 新增行：`configurationPaths(await loadBackendConfiguration(this.userData))`
- 测试文件最后一次变更为 `3f9c1e74d`（10-19 17:41，“复用原生观察进程…”）；`52ab1a6f7` 的 stat 不含该测试文件，行 88 断言前后逐字节一致。
- 经验包围圈（/tmp 只读 worktree + 符号链接 `desktop/node_modules`，不装依赖、不动用户工作树；worktree 已清理）：
  - `52ab1a6f7^`：**4/4 通过**——旧形态下 getPaths 解析包内探针成立，且全程使用真实 codesign（未注入替身），包内整组校验在当时真实可用。
  - `52ab1a6f7`：与当前 HEAD 完全相同的失败：行 88 实际 `''`。
  - 当前 HEAD：同样失败。失败起点精确夹逼在 `52ab1a6f7`。

## 边界确认（不被产品能力放走风险）

1. 真实启动链完整：`host.ts:281` `loadBackendConfiguration(userData, resourcesDirectory)` → 同一 config 交 `diagnostics.ensureReady`（`index.ts:97`），`process.ts:25` 把解析出的 `syncProbePath` 注入后台环境变量 `NOTALONE_SYNC_PROBE`。getPaths 仅服务启动设置页展示（`startup/bridge.ts:37`、`StartupSettings.tsx:142`）。
2. 包内整组校验在当前 HEAD 真实有效：以与测试同款受限环境（`PATH=/usr/bin:/bin`）的 `spawnSync` 方式调 prepare 成功后，对两个可执行文件以 `/usr/bin/codesign --verify --strict` 与 `--display` 核验，`Identifier=com.notalone.sync-probe.cli` 与 `com.notalone.sync-probe.header-change` 均匹配。即 `verifyBundledRuntime`（`bundled-helpers.ts:57-127`）传入资源目录时正常返回 probe+helper。
3. B1 简化无关：`99e891c84`（11-07 11:36）仅把 `validRepositoryBuild`（`bundled-helpers.ts:131-139`）放宽为摘要自一致与 sha256 格式；失败起点 10-30，早于 B1 一周以上。

## 定性：过时断言清单与影响

- 断言“getPaths 反映包内探针解析结果”的用例全部过时：`:88`、`:149`（旧两文件包）、`:176`（原 17 源）、`:201`（签名现场用例）、`:205`（save 回读）、`:215`（恢复后回读）。
- 负面拦截断言失守但仍恒成立（不具拦截力）：`:115/:119/:158/:164/:170/:209/:211/:213`——无显式配置时 getPaths 恒空，这些“整组停用”校验结果现在只体现在 runner 的 `probe`/`headerChange` 字段（对应 `config.ts:118-125`、`bundled-helpers.ts:57-127`），getPaths 层永远拿到 ''。
- 产品行为本身连贯：无显式探针配置时后台仍自动使用包内 `Resources/notalone-probe`（host 层解析），启动设置页探针字段标注“可稍后配置”（`StartupSettings.tsx:182`）语义未破坏；无启动/分发可用性风险。唯一可见差异是启动设置页探针字段在“未显式配置”时显示为空（10-30 前显示解析出的包内路径）——是否需要 UI 展示“包内默认已就绪”属产品语义，待用户裁决，不属于本用例缺陷。

## 建议修复方向（等待裁决，本任务未改码）

- 若维持现行产品语义（getPaths 只反映显式配置）：把该用例对包内探针解析结果的断言从 `paths.syncProbePath` 迁移到 runner 的 `probe` 字段（`:81`，即 `backendEnvironment(loadBackendConfiguration(userData, resources), userData).NOTALONE_SYNC_PROBE`，其语义与旧 `paths` 等价：整组校验失败落到 `unconfigured-probe`，外部显式探针透传，包内默认解析 probe）；`:88` 改断言 `''`（无显式配置）；save 场景改用显式 syncProbePath 值构造。
- 若希望恢复“getPaths 同样报告包内解析”产品形态：属产品语义变更，另立任务评估（启动设置页展示与 `helperWarnings` 链路相应核对）。

## 不确定项

- `52ab1a6f7` 提交说明未点名 getPaths 语义收窄，只述“退役旧 PostgreSQL 启动路径”“同步更新启动/导入相关桌面测试”；是否属有意迁移无铁证，属审阅判断（代码证据支持：`host.ts:281` 保留传参、同轮其他启动测试同步更新而非本文件断言更新）。
- 未逐条重跑整史核验（如 `packaging/command.test.mjs:80` 对 `loadBackendConfiguration` 资源路径调用形态的断言）；其结构与本定性一致，未见冲突。
