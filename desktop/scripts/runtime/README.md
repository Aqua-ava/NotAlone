# 独立本机运行时构建

构建机使用 macOS 15+ arm64、现有 Node 开发环境与系统 Xcode Command Line Tools 的 clang/make。产物的后台不依赖构建机 Python、Conda、Homebrew 或仓库路径。固定来源、版本、摘要分别见 `component-sources.lock.json`、`python-wheels.lock.json`、`requirements.lock`；构建专用 setuptools 独立锁定。

从 `desktop/` 执行：

```sh
npm run prepare:runtime -- --output-directory /absolute/build/notalone-runtime
npm run verify:runtime -- --runtime-directory /absolute/build/notalone-runtime --report-directory /absolute/new-report
npm run package -- --runtime-directory /absolute/build/notalone-runtime --with-probe --output-directory /absolute/new-package --electron-zip-directory /absolute/electron-cache
```

`--source-cache /absolute/cache` 可复用经过逐文件摘要复核的归档与 wheel；未命中只从锁定的官方 HTTPS 地址下载，摘要不符立即停止。输出必须不存在。构建先使用包内 Python 构建普通 backend wheel，再用离线、完整摘要锁安装依赖，删除 pip、setuptools、生成的入口脚本和开发缓存。产品以包内 Python 的 `-I -B -m` 运行已安装模块。

PostgreSQL 从固定官方 16.15 源码构建，关闭额外可选库，固定参数、工具链记录与随包重建入口见 [源码构建](POSTGRESQL-BUILD.md)。运行时只带核心工具、动态库闭包、初始化资料、plpgsql、编码转换和默认词典；不宣称支持额外扩展或程序语言。包含 `pg_dump`、`pg_restore`，供后续兼容更新任务使用。构建核验 arm64、非系统动态依赖及每个 Mach-O 签名；未签名组件在本机以 ad-hoc 签名，再生成完整文件摘要库存。打包阶段检查、复制为普通文件、复查库存，保持这些组件字节不变。

运行时与用户资料分开。运行时清单的 `paths` 仅为包内相对路径，所有普通文件与包内文件链接均被登记。拒绝包外或目录链接、漏项、替换、可执行权限变化、editable、`direct_url.json`、开发 `.env` 及执行型 `.pth`。该清单防止误用损坏组件，不替代正式发行者签名、公证与下载来源认证。

原始第三方许可随包保留在 `licenses/` 与 Python `.dist-info` 中。`attribution-sources.lock.json` 固定 294 份随包来源文件（291 份归档、3 份固定 Git 原文）、全部依赖 wheel 与 667 段原始通知，并保留 7 份与锁定 wheel 原字节一致的 SBOM 和一份 tiktoken native 观察证据；构建核对归档及每段文本的摘要，拒绝来源或文本被替换。许可与当前正式发行缺项见 [随包说明](THIRD-PARTY-SOURCES.md)。**当前产物只完成本机工程验证**：修改 psycopg 源码的狭窄工程探针已实际重建并验证，具体范围见[记录](PSYCOPG-VALIDATION.md)；完整对应构建材料、尚未确认的特定原生依赖材料、面向用户的替换交付及正式签名公证仍待验收，禁止据此声称可对外发行。不得用独立工具验证代替公开 App、真正没有开发环境的机器、微信授权或真实候选生成验收。

`verify:runtime` 把组件复制到含空格的新目录，以仅 `/usr/bin:/bin` 的 PATH 执行隔离导入、独立 SCRAM 数据库、59 次生产迁移、只读启动检查、真实备份恢复与合成值核对，最后停止自有数据库并清理凭据、合成资料和复制品。报告固定布尔结果，明确标记未覆盖的 App／干净机器／微信路径。这个脚本不读取开发 `.env`、不连接现有数据库、不执行微信或调用模型。

本轮源码构建的真实失败、修复、验证与未覆盖项见 [PostgreSQL 验证记录](POSTGRESQL-VALIDATION.md)。
