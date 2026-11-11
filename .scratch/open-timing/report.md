# SQLite 普通打开计时与退出残留验证

- 日期：2026-11-11；分支：`perf/open-timing`；main 基线：`f5317da93`。
- 当前 Worker 对照 `1607cd607^`（`f14eb194f`）的原始 Worker；两者均使用当前 registry、客户端与依赖，不代表整套历史程序。
- Node `v24.22.2`，SQLite `3.53.4`；升级后副本 605,511,680 字节（577.46 MiB），不同于背景中的 1.1 GB 库。
- 真实库仅使用 `sqlite3 "file:…?mode=ro" ".backup …"`；所有后续操作限于仓库外 `mktemp -d` 副本。
- 副本的 managed、managed/sqlite 均为 0700，数据库为 0600；先由当前 main 客户端打开并正常 close，确认版本 50（含迁移 48），待应用迁移 0，冻结为基线。

## 计时口径与结果

计时从调用项目 `SqliteStorage.open()` 前，到客户端收到 Worker 首条 status；包含新 Worker 启动、模块加载和数据库初始化，不含复制、迁移与 close。
每个计时样本独立复制基线，各版本各 3 个冷样本和 3 个热样本；冷为该副本首次打开，热为先不计时打开并正常 close 后重开。版本顺序前后／后前／前后交错。
未清空系统文件缓存，复制本身会暖缓存，因此“冷”不表示物理冷缓存。计时版未增加检查探针；历史 Worker 的临时模块声明为 ESM，避免额外解析警告开销。

| 场景 | 改动前 3 次（ms） | 改动后 3 次（ms） | 前中位数 | 后中位数 | 降低 |
| --- | --- | --- | ---: | ---: | ---: |
| 冷：副本首次 | 708.155 / 692.572 / 677.426 | 86.605 / 99.074 / 84.942 | 692.572 ms | 86.605 ms | 87.50% |
| 热：正常关闭后重复 | 667.832 / 934.785 / 684.408 | 81.509 / 93.150 / 85.069 | 684.408 ms | 85.069 ms | 87.57% |

## priorExitResidue 与关闭行为

- 18 次计时／预热的正常关闭全部无 WAL/SHM 残留；另做 3 轮诊断打开→close，含 1 轮附属只读 Worker 整体关闭，结果一致。
- 3 轮诊断打开时 WAL 4,152 字节、SHM 32,768 字节；每次 close 返回后两文件均不存在。各轮 priorExitResidue=false，quick／integrity／FK 检查次数均为 0，第二次和第三次打开未误触发。
- SIGKILL 持有项目客户端连接的子进程后，WAL 4,152 字节、SHM 32,768 字节残留；重开 658.956 ms，priorExitResidue=true，quick_check 与 foreign_key_check 各执行 1 次。
- 恢复后正常 close 删除两文件；再开 85.892 ms，priorExitResidue=false，所有全库检查计数为 0。探针仅在临时 Worker 中增加聚合计数，不读取业务行或改动判定条件。
- 实测与 [SQLite WAL 官方说明](https://www.sqlite.org/wal.html#the_wal_file)一致：最后一个连接正常关闭时 checkpoint 并删除旁路文件，未正常关闭则可能保留。
- 结论：本次正常退出不误触发；既有优化有效，无需修改生产代码或新增修复测试。

## 验证、清理与限制

- 已执行 `pnpm install`、`node --check .scratch/open-timing/measure.mjs`、`node --disable-warning=ExperimentalWarning .scratch/open-timing/measure.mjs`，最终脚本成功。
- 存储相关 5 文件共 37/37 测试通过，无跳过（76.93 秒），含普通重开跳过检查和崩溃后 FK 损坏拒绝；命令：`cd backend-ts && perl -e 'alarm 600; exec @ARGV' -- node --test --test-concurrency=1 test/sqlite-storage.test.mjs test/sqlite-storage-timing.test.mjs test/sqlite-storage-identity.test.mjs test/sqlite-readonly.test.mjs test/sqlite-statement-cache.test.mjs`。
- 已运行 `node scripts/check_public_history.mjs --ref HEAD --working-tree`，当前历史与工作区检查均无命中。
- 真实资料未输出、上传或提交；只保留本报告与计时脚本。所有数据库副本、旧 Worker、诊断变体及临时目录均已删除；未启动桌面 App、打包或修改真实资料目录。
- 限制：每组仅 3 样本、共享主机有负载波动；未测物理冷缓存、桌面退出 UI、断电、损坏库或额外外部连接；当前 Worker 还包含迁移 50 的 TEMP 触发器安装，与旧版存在该固定差异。
- 范围外：领域阅读入口引用的 `architecture/README.md` 与 `architecture/current/privacy-deletion.md` 在当前基线缺失，未修改。
