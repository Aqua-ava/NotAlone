# PostgreSQL 官方源码构建验证（2026-10-16）

本轮仅验证独立本机运行时的数据库构建，不认证公开 App、真正无开发环境机器、微信或候选生成。测试仅使用随机隔离数据库及合成值，没有读取开发 `.env` 或连接已有业务数据库。

## 来源与构建

从 PostgreSQL 官方下载 16.15 完整源码，并独立读取官方 `.sha256`：归档摘要为 `c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed`，与构建锁、随包原始归档一致。没有运行 EDB 安装器或使用其二进制。源码构建参数及重建入口见 [构建说明](POSTGRESQL-BUILD.md)。

最高构建接口先捕获失败：新增回归在构建模块不存在时失败；实现后，替换归档在执行源码前被拒绝，且不创建构建及输出目录。新默认来源及完整归因映射由该回归核对。

实际编译还捕获两项真实失败并修正：

- 初轮只识别 `.so` 模块，macOS 源码产物使用 `.dylib`，真实 `initdb` 因缺少 `dict_snowball` 失败。现从固定官方源码目录枚举全部 24 个编码转换模块，同时要求 PL/pgSQL 和默认词典存在，再支持对应平台后缀。
- PostgreSQL 的 VPATH 强制绝对源码路径，二进制携带构建工作树；新增字节检查以 `runtime_postgres_build_path_leak` 拒绝第二轮产物并清理暂存目录。最终改为源码内构建，原始下载归档保持不变；最终 36 个 PostgreSQL Mach-O 均通过依赖、签名与构建路径检查。

最终本机构建记录：Apple clang 17.0.0（clang-1700.0.13.5）、GNU Make 3.81、SDK 15.5、arm64、最低 macOS 15.0。本轮正在运行的最终构建实际使用 `make -j4`；考虑共用机器资源，后续默认降为 `-j2`，未为此重复编译。未声称逐字节复现。最终完整运行时核验 70 个 Mach-O、8662 个库存文件，保留 79 份源归档与 257 段原始通知。

## 实际命令与结果

从 `desktop/` 执行的正式接口如下，路径以本轮各自新建的绝对目录提供：

```sh
node scripts/prepare-runtime.mjs --source-cache /absolute/source-cache --output-directory /absolute/source-runtime-v3/notalone-runtime
node scripts/verify-runtime.mjs --runtime-directory /absolute/source-runtime-v3/notalone-runtime --report-directory /absolute/source-runtime-v3/verification
node --test tests/packaging/postgres-source.test.mjs tests/packaging/runtime-attribution.test.mjs tests/packaging/managed-runtime.test.mjs
npm test
```

构建隔离导入通过。`verify-runtime` 复制到 `relocated runtime` 含空格路径，使用仅 `/usr/bin:/bin` 的 PATH；真实 SCRAM 集群依次完成 59 次生产迁移、只读启动诊断、custom 格式备份、恢复到第二个空数据库，以及 `synthetic_runtime_2026` 合成值与完整迁移账本核对。最后通过自有 `pg_ctl` 正常停止，删除凭据、合成数据库、备份及搬动副本，报告目录仅留下固定布尔结果。结果中 `relocated`、`isolatedImport`、`migrations`、`backupRestore`、`stopped` 均为 `true`；`cleanMachine`、`app`、`wechat` 均为 `false`。

相关 Node 回归 7/7 通过，完整安全检查 84/84 通过、TypeScript 通过。没有运行真实 App 或探针。本轮完整运行时仍基于本分支既有后端；主 Agent 的新守护模块与 App 复验须由后续集成版本另验，不能拼接认证。

## 边界

PostgreSQL 子树的非系统动态依赖只指向包内 libpq，没有额外 ICU、Readline/libedit、OpenSSL、libiconv 或压缩库。服务保留 SCRAM，本次仅监听 loopback；没有 TLS、额外扩展、ICU collation 或压缩备份支持。当前 App 创建的受管集群使用 C locale，旧资料更新仍须单独验证现有版本、扩展、collation 和备份格式兼容性，不能只凭主版本相同静默打开未知资料。

Python/Rust wheel 的静态通知、psycopg 对应构建材料与修改替换、正式签名公证和真正干净机器仍待各自完成。此处保存客观来源与运行证据，不作完整发行义务已履行的结论。
