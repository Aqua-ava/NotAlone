# psycopg 3.3.6 修改源码与副本替换

接收者从随包 [replacement-kit/README.md](replacement-kit/README.md) 开始：整个工具包复制到 App 外，即可离线修改、编译并安装到原 App 的新副本，不需要私有仓库、dist、npm 模块、共享缓存或 Conda。它是可选开发工具，普通用户双击 App 无需 Node／clang。

默认生产 wheel、原 App 和用户资料不改变。此路径证明从完整源码修改、真正编译扩展、在新运行时副本中替换、重签并通过完整性和本机数据库回归；不作全部法律义务或正式发行认证。

## 固定来源及修改

上游完整源码为随包 `source-psycopg-3.3.6-upstream.tar.gz`，SHA256 `bfa3560402b8f8ac2bf9408c6354b5c8c951d64871629a14526f942361560836`。默认样例在新解包目录的 `psycopg_c/psycopg_c/pq.pyx` 增加 `_notalone_rebuild_marker = "notalone_source_rebuild_probe_20261016"`；接收者可提供自己的外部补丁。可观察标记进入编译扩展，不能用新增纯 Python 模块冒充重建。

构建使用固定 PBS CPython 3.12.14 的开发头文件及解释器，在独立目录离线安装 `psycopg-build-wheels.lock.json` 中的 setuptools 83.0.0、Cython 3.1.5、wheel 0.45.1。三个 wheel 的官方地址与 SHA256 固定，完整 wheel 和原始通知随工具包保留。不会使用或修改共享 Conda／Homebrew 的开发库。

PG16.15 对应头文件和开发库由 `build-postgres.mjs` 在独立 DESTDIR 内重建，不写 `/notalone-postgresql` 或系统目录。之后运行随包官方 `tools/ci/copy_to_binary.py`，再从修改后的 Cython 源码编译两个 `psycopg_binary` 扩展。官方区分 binary 与本地编译安装的约定见 [psycopg 安装文档](https://www.psycopg.org/psycopg3/docs/basic/install.html)，具体接口以随包3.3.6源码为准。

默认 wheel 的客户端 libpq 为18.6；样例两个扩展改链接副本内 PG16.15 的 `postgres/lib/libpq.5.dylib`，构建／运行客户端版本均为160015。它验证本机 SCRAM、迁移和备份路径，未认证 TLS、LDAP、Kerberos、PG18 新特性或默认 wheel 的所有行为；不静默推广为生产依赖，也不声称原 PG18 wheel 逐字节复现。

## 接收者重跑入口

构建机要求 macOS15+ arm64、Node.js22.12+、Xcode Command Line Tools 的 clang/make/SDK。工具包携带匹配 PBS 开发解释器、头文件、pip 与三个开发 wheel；构建子进程使用独立 HOME／TMPDIR 和最小系统 PATH。原始来源从输入 App 内读取，离线输入逐项核对 SHA256，没有仓库或 Conda 路径依赖。

将整个工具包复制到 App 外。把 `example.patch` 另复制成自己的补丁并编辑，运行工具包 README 中的 `check → rebuild --patch-file ... → install → verify`。外部统一补丁只修改源码根内的相对文件，以 `patch --batch --forward --fuzz=0` 真正应用；错误上下文或越界路径立即失败。省略补丁时仍可重跑默认样例。输出、构建目录与新 App 必须不存在且与输入互不包含，目录别名也按规范路径核对。

`install` 不调用 `package.mjs`：只复制原 App，保留 ASAR、其它资源及签名 identifier／entitlements／flags，替换兼容运行时后重做新副本外层本地 ad-hoc 签名，执行完整库存、全部 Mach-O 依赖／签名及 deep/strict 核验。原 App 前后库存摘要、ASAR 摘要与替换清单记录在收据。新副本主执行文件的签名槽可能改变；原 App 不写入，也不读取默认 userData。无需 Developer ID 或私钥。

每次重建都编译真实源码。失败不把副本标为可用，日志和无效副本留待诊断；完整性检查先真实拒绝修改后的旧库存，在重定位、签名、原生审核及导入成功后重建有效库存，不能手工绕过。

`verify` 使用新的合成 SCRAM 集群、随机 loopback 端口和私有凭据，执行当前随包全部生产迁移（本轮60次）、启动诊断、custom 格式备份与第二个空库恢复，核对合成值与迁移账本。最后停止本次 PG，删除库、凭据、备份和搬动副本，仅保留结果。这个工具验证不代替修改后实际 App 用户路径；历史 v4 界面证据不移用为新副本通过。

仓库维护者生成交付物的入口为 `prepare-replacement-kit.mjs`，公开导出 `prepareReplacementKit({sourceCache,licensesDirectory,outputDirectory,download?})`；标准 `prepare-runtime.mjs` 自动放入 `licenses/replacement-kit`。这些是构建者路径，不是接收者前提。

## 收据与字节角色

新运行时的 `licenses/psycopg-replacement/` 保存完整修改源码归档、真实应用的补丁、重建 wheel、构建锁与工具链记录。`replacement-receipt.json` 区分三层：

1. `base` 是基础上游 wheel 和原运行时来源，原 requirements／wheel 清单保存为 `base-*`。基础归因库证明原始来源与通知，不冒充修改扩展摘要。
2. `replacement` 是修改源码生成的 wheel、源码和补丁摘要；`licenses/requirements.lock` 与 `python-wheels.json` 声明重建 wheel。这个原始 wheel 尚含构建 prefix，不单独作为重定位安装包。
3. `installed` 是将 libpq 改为包内相对依赖、ad-hoc 重签并同步 RECORD 后的扩展；最终摘要在收据和 manifest 中，完整性检查按安装后字节核验。

编译日志保留在本次构建目录，原生记录包括编译器、SDK、参数和全部 Mach-O 动态表，不声称跨工具链逐字节复现。匹配 PBS 与工具 wheel 已随工具包携带；原始通知有独立索引，不能借用旧 setuptools75.8.2 的通知。

本轮与历史验证分开记在[实际验证](PSYCOPG-VALIDATION.md)。来源材料及上游构建图证据边界见[逐 wheel 核验](NATIVE-WHEEL-NOTICES.md)。
