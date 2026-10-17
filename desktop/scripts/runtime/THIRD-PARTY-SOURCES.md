# 随包组件的许可、通知与来源

本目录保存运行时构建所用的原始第三方许可、版权及通知文本。`attribution/sources-and-notices.json` 将每段文本对应到固定上游归档、归档内路径及 SHA256；构建重新读取归档并核对摘要，许可名称字符串不能代替这些文本。Python 各包自身的 `.dist-info/licenses` 继续保留。PBS 发行元数据与许可在 `python/`；PostgreSQL 使用官方源码构建，原始 `COPYRIGHT` 在 `postgresql-COPYRIGHT`，实际工具链、参数及包内动态依赖在 `../postgres/build-info.json`。

`attribution/sources/` 随包保留 294 份公开来源文件（291 份归档、3 份固定 Git 原文）；包括 61 份已安装 Python 依赖的同版本 SDist、构建用 setuptools、CPython 与其库来源、psycopg 所含若干原生库、完整 psycopg 3.3.6 源码与 `psycopg_c` SDist，静态库对应的 OpenSSL 4.0.3 与 libyaml 0.2.5，以及固定 PBS 构建脚本及 PostgreSQL 官方源码。其中新增 194 份由固定 wheel SBOM 与同版本 SDist 锁共同核对的官方 crate 归档（177 required、17 excluded 构建材料），以及一份由 crate VCS commit 定位的 wit-bindgen 许可来源归档；8 个 local crate 继续引用已有完整 SDist。另补齐固定 tiktoken 扩展实际观察的 10 个 crate 版本、rustc-hash 五版本 major2 保守集合，以及固定 Rust 提交的三个根许可／版权原文；不将保守集合声明为实际链接版本。7 份原始 SBOM 另作来源证据保存，不计作许可文本；scope 不等于最终二进制编入范围。归档保持上游字节；PostgreSQL 的 configure/make 在构建机执行，其余归因归档仅作通知读取。归档的 `scope` 表明相关构建／分发范围；生产解释器中的 setuptools 已卸载；可选修改工具包另外携带未安装的开发 wheel，不改变生产依赖。

当前库存核对 667 段原始许可及通知，覆盖全部 62 个随包 wheel，并保存 setuptools 的通知。源码目录中也保留了上游额外的构建工具、测试和文档许可；出现一个许可文本不表示整个组件都改用该许可。完整 GNU GPLv3、LGPLv3、LGPLv2.1 文本分别随原始归档许可保存。保留测试夹具或构建工具的通知不代表这些程序在产品中运行。

## 源码与替换修改

NotAlone 对 LGPL 组件的使用不禁止为调试其修改而进行逆向工程。`psycopg`／`psycopg-binary` 按各自 LGPLv3 文本使用，certifi 的来源保留其 MPL 文本和同版本源码。其他组件分别遵循本目录的原始许可。

本机开发产物通过包内相对路径加载 Python 模块、扩展和动态库。完整性库存会拒绝直接修改后的字节。维护者需从对应源码重建，在独立副本替换组件，检查全部 Mach-O 依赖，重签并重建库存，再执行搬动、迁移、备份恢复与实际 App 回归；不能直接绕过检查或覆盖正在使用的 App。默认构建入口为仓库 `desktop/scripts/prepare-runtime.mjs` 与 `package.mjs`，PBS 的上游构建脚本归档及 psycopg 的 `tools/ci/` 随源保留。

随包 [开源组件修改工具包](replacement-kit/README.md) 提供独立离线脚本、固定 PBS 开发包、setuptools83.0.0／wheel0.45.1／Cython3.1.5 完整 wheel 与原始通知。接收者无需私有仓库、dist、npm 模块或共享缓存。标准构建自动携带，入口为工具包的 `kit.mjs check/rebuild/install/verify`。开发输入及通知有独立库存／来源索引，不混入上述294来源／667通知的基础归因计数。

仓库中的 `desktop/scripts/rebuild-psycopg-runtime.mjs`：已从完整 3.3.6 源码修改编译标记并真实重建两个扩展，在新副本中链接包内 PG16.15 libpq、重签并更新有效来源声明，实际通过迁移／备份恢复及有限公开 App 首启／退出分项。步骤、收据角色及各轮范围见[重建说明](PSYCOPG-REBUILD.md)和[实际验证](PSYCOPG-VALIDATION.md)。新工具包允许接收者提供外部源码补丁，生成完整修改来源和安装收据，将兼容修改运行时装入原 App 的新副本；保留 ASAR、其它资源与原包字节，执行原生审核和本地严格签名。此路径不改变默认依赖，不作全部法律义务认证。

数据库具体源码构建与重建步骤见 [PostgreSQL 构建说明](postgresql-build/README.md)（仓库源文件为 `POSTGRESQL-BUILD.md`）。

## 仍未完成的正式发行工作

此库存可验证归档和通知的来源及字节，不能认证完整法律义务已履行。此产物继续只用于本机工程验证，不得据此宣布可对外发行：

- PostgreSQL 的官方 16.15 源码、固定参数、构建代码和工具链记录已随包提供；新的 PostgreSQL 子树不含 EDB、额外 ICU/libedit/OpenSSL/libiconv。源码构建只证明该组件的工程路径，不能代替其他 wheel 的静态通知或对应构建材料核验。
- 六个 Rust wheel 的固定 SBOM、194 份 registry crate 与原始通知已核对，精确 target/features 未还原仅为证据边界，不单独作为当前材料缺项或重新构建门槛。tiktoken 已补可观察版本与原始通知，并明确 rustc-hash major2 保守集合；未提供的原始构建锁／provenance 继续如实记录，不伪造实际解析版本。具体证据和边界见 [逐 wheel 核验](NATIVE-WHEEL-NOTICES.md)。
- 对已锁定默认 psycopg wheel，完整 psycopg 源码、官方构建路由和已知 libpq／OpenSSL／Kerberos／OpenLDAP 来源及原始通知已保留；当前没有另一个已确认却缺失的默认依赖文件清单。独立修改工具包及 App 新副本安装入口补齐此前具体交付差距。PG16.15 样例验证兼容修改路径，不声称原 libpq18.6 wheel 的字节复现、全部上游参数或 TLS／LDAP／Kerberos／PG18 特性已认证。
- Developer ID、正式分发签名、公证、干净机器及用户完整路径验收另行完成。当前 ad-hoc 签名与来源库存不能替代它们。

官方约定可从 [GNU LGPLv3](https://www.gnu.org/licenses/lgpl-3.0.html)、[Psycopg 安装说明](https://www.psycopg.org/psycopg3/docs/basic/install.html)、[PBS 许可说明](https://github.com/astral-sh/python-build-standalone/blob/20260901/docs/running.rst)核对；实际分发以保留的对应版本许可文本及最终产物为准。
