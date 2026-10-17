# PostgreSQL 16.15 源码构建

新运行时使用 PostgreSQL 官方 16.15 源码，SHA256 为 `c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed`。完整上游归档随包保存为 `licenses/attribution/sources/source-postgresql-16.15.tar.bz2`，根 `COPYRIGHT` 原文在 `postgres/COPYRIGHT` 与 `licenses/postgresql-COPYRIGHT`，源码文件中的原始通知保留在归档中。

构建机使用 macOS 15+ arm64、Node.js、系统 Xcode Command Line Tools 的 clang 和 GNU make；用户运行 App 不需要安装这些工具。最低系统唯一声明为 `runtime/component-sources.lock.json` 的 `minimumMacOS`；编译／链接参数、`MACOSX_DEPLOYMENT_TARGET` 与 App 的 `LSMinimumSystemVersion` 均读取并验证该值。构建仅使用 `/usr/bin:/bin:/usr/sbin:/sbin`，不继承 Homebrew、Conda、用户编译参数或动态库搜索路径。构建记录位于 `postgres/build-info.json`，包含实际编译器、make、SDK 版本、固定配置参数与每个产物的动态依赖。

固定 prefix 为 `/notalone-postgresql`，`make install DESTDIR=<构建暂存目录>` 不写系统目录。关闭 ICU、Readline/libedit、OpenSSL、zlib、lz4、zstd、NLS 和绝对 RPATH。保留九个核心工具、libpq、PL/pgSQL、编码转换和默认词典；不构建 contrib 或其他程序语言。SCRAM 由 PostgreSQL 内部实现保留；此服务仅供本机 loopback 使用，不提供 TLS 或远端数据库服务。custom 格式备份可使用不压缩的归档，不支持读取要求已关闭压缩算法的备份。

系统 `install_name_tool` 将安装前缀中的 libpq 引用改为实际加载者的 `@loader_path` 相对位置。每个 Mach-O 都核验 arm64、仅系统动态库或包内相对依赖，并重新作 ad-hoc 签名；完整 App 签名、公证另行完成。此构建没有改变 PostgreSQL 主版本或默认数据库块大小。

从源码重新构建到**新的**目录（不要覆盖运行中的组件）：在随包 `licenses/postgresql-build/` 目录中执行以下 Node 调用，并把三个路径换为绝对路径；`build-postgres.mjs`、`runtime-platform.mjs` 与 `runtime/component-sources.lock.json` 随包保留。

```js
import { buildPostgresRuntime } from './build-postgres.mjs';
await buildPostgresRuntime({
  archive: '/absolute/notalone-runtime/licenses/attribution/sources/source-postgresql-16.15.tar.bz2',
  directory: '/absolute/new-output/postgres',
  workDirectory: '/absolute/new-work'
});
```

可通过 `node --input-type=module` 从标准输入执行；构建及输出目录必须不存在。修改源代码时需形成新的受审查来源归档和摘要锁，然后重建，不能把修改后的归档冒充原官方字节。仓库 `prepare-runtime.mjs` 将此构建结果加入运行时库存，`verify-runtime.mjs` 验证含空格搬动、SCRAM 初始化、59 次生产迁移与真实备份恢复。这里提供相同来源和配方的重建路径，未声称跨工具链逐字节复现；旧 EDB 产物不会被本次构建改写。

配置参数与安装约定参考 [PostgreSQL 16 官方源码安装文档](https://www.postgresql.org/docs/16/install-make.html)；官方归档摘要来自 [16.15 SHA256](https://ftp.postgresql.org/pub/source/v16.15/postgresql-16.15.tar.bz2.sha256)。Python wheel 内部静态依赖通知与正式发行剩余工作仍分别记录在上一级 `README.md`，本模块的源码构建证据不能代替它们。
