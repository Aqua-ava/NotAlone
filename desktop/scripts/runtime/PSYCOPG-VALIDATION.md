# 修改 psycopg 源码后的重建与替换验证（2026-10-16）

本轮仅验证一个明确的工程路径：从随包完整 psycopg 3.3.6 源码修改可观察标记，真实重建两个编译扩展，替换新的运行时副本、重签并更新库存，验证本机数据库和公开 App 的有限行为。默认发行依赖、冻结原包及用户资料均未改写；未认证全部 LGPL 对应构建材料、全部通知闭包、正式分发、真正无开发环境机器或模型生成。

## 失败反馈与修正

开发入口 `rebuild-psycopg-runtime.mjs` 的来源门禁先在模块不存在时失败；实现后，伪造的上游归档在执行源码、创建构建目录或输出前被拒绝，回归通过。

第一次实际构建已经编译两个扩展，但 pip 安装 wheel 留下了包含构建来源的 `direct_url.json`，原运行时完整性检查以 `runtime_developer_configuration` 拒绝副本。随后清除这项开发安装元数据并同步 RECORD，在全新目录完整重跑；没有绕过门禁或把失败副本改为可用。

第二轮完成真实构建、重定位和签名，旧库存确实以 `runtime_inventory_mismatch` 拒绝修改副本，生成新库存后通过。第三轮为明确区分基础来源与修改产物，进一步加入 `replacement-receipt.json`、`base-*` 和有效 requirements／wheel 声明，再从原冻结包在新目录**完整重新编译**，不以理论说明替代实际构建。

额外的严格补丁复查发现，旧说明性 diff 的 hunk 写为第 14 行，实际版本宏在第 16 行；BSD `patch --dry-run --fuzz=0` 拒绝它。此前源码确实由字符串替换修改并编译，编译字节未受此材料问题影响。第四轮改用带完整上下文的补丁作为唯一修改入口，由真实 `patch --fuzz=0` 应用，再核对完整源码字节；实际构建和额外严格 dry-run 均通过，旧补丁失败记录保留。

## 最终第四轮构建与来源

- 官方完整源码摘要：`bfa3560402b8f8ac2bf9408c6354b5c8c951d64871629a14526f942361560836`。
- 本轮完整修改源码归档摘要：`9903cef053f224d329e8a34c3c9e2176ff57bc2e79236dd63eef4d01a04df4c4`。
- 重建 `psycopg_binary-3.3.6-cp312-cp312-macosx_15_0_arm64.whl` 摘要：`f8891be9e46b0944af3ee35d23fac4abc930fb13c4460e7ee05613ebf022dbfe`；基础 wheel 是另一份 `612382ac…` 来源，收据明确保留两者。
- 安装后 `_psycopg` 扩展摘要为 `d8229b76929735b2d228030c0c2f14eb05f22368089701eb38dfea48e4535b6a`；`pq` 扩展为 `bbe32a83fdf98e4e406f4c89f9b9c6ad8d8d0bb6ccc00323bd2d9502183cfaff`。
- 隔离导入读取到 `version=3.3.6`、`implementation=binary`、构建及运行 libpq 均为 `160015`、编译标记为 `notalone_source_rebuild_probe_20261016`。两个安装后扩展与第二轮逐字节一致；生成 C 文件的构建元数据和相应 RECORD 有差异，未声称整个运行时相同。
- 工具链为匹配的 PBS CPython 3.12.14、锁定 setuptools 83.0.0／Cython 3.1.5／wheel 0.45.1、Apple clang 17.0.0（clang-1700.0.13.5）、SDK 15.5、arm64、最低 macOS 15.0。PG 开发头文件及 libpq 从固定官方 16.15 源码在本次 DESTDIR 生成。

两个新扩展只动态依赖系统 libSystem 及包内 `@loader_path/../../../../../postgres/lib/libpq.5.dylib`；逐项重签并严格验证，安装后 RECORD 同步新字节。副本共核验 62 个 Mach-O 路径的 arm64、动态依赖和签名，构建工作目录不进入这两个扩展。原始来源 manifest 摘要始终为 `bc9bdadebbe8d02ec9b5652bdeff223ca01ecab2446557c06a3af855fa4e7363`，结束再次完整核验通过。

第四轮有效 requirements、wheel 清单、manifest component 与收据中的重建 wheel 摘要已交叉核对；安装后扩展摘要与库存也逐项一致。最终 runtime manifest 为 `e098d227f6055facdc999dd6583860eca6c6160b289d92031cabfc67003784bb`。基础归因库继续证明原始来源与通知，不能将它当作修改扩展的摘要。

## 数据库与 App 分项

第二、第三、第四轮各自实际运行 `verify-runtime.mjs`，均复制到含空格路径，使用最小系统 PATH 与隔离 PBS，创建新的合成 SCRAM 集群和随机 loopback 端口，完成 59 次生产迁移、只读启动诊断、custom 备份、恢复到第二个空库，以及 `synthetic_runtime_2026` 和迁移账本核对。三轮结果的 `relocated`、`isolatedImport`、`migrations`、`backupRestore`、`stopped` 均为 true；`cleanMachine`、`app`、`wechat` 保持 false。最后正常停库并删除凭据、备份、数据库和搬动副本。

第二轮独立包使用 Electron 44.7.0 离线归档构建，通过 ad-hoc 签名。主 Agent 协调桌面释放后，Computer Use 在本轮空 userData 中点击公开“开始本机设置”，看到真实“已连接”；初始化合成本人、重连后看到“本次运行的本人身份已就绪”和“还没有联系人”，最后从公开系统菜单退出。初次 `typeText` 未留下输入，产生一次固定初始化未完成提示；改用 `setValue` 并核对字段后重试通过，不把它写成首击成功。App exit0，记录的自有后台、PG 及整个自有包路径进程均为零，握手和 postmaster 文件消失，随后删除合成 userData。

第三轮独立打包、严格签名并再次通过数据库工具回归，未做 Computer Use。最终第四轮同样完成独立打包及完整数据库回归，再在协调桌面时段实际完成公开首启、合成本人初始化、重连后的本人就绪／真实空联系人和系统公开菜单退出。一次 Computer Use 状态变化保护要求重新读取当前窗口再输入，重取状态后继续成功，未记为产品失败。最终第四轮的启动记录为 2026-10-16 23:57:37、退出记录为同日 23:59:04（Asia/Taipei），收据补记发生在 2026-10-17；目录中的 20261016 是任务标签。最终 App exit0，全部已记录自有 PID 及整个自有包路径进程为零，握手／postmaster 消失，随后删除合成 userData；包内 manifest 与最终 runtime 逐字节相同。最终手动输入版与旧资料更新的同版组合仍由对应任务继续集成。

## 实际入口及验证

从 `desktop/` 执行，路径均为本轮自建绝对目录，完整调用格式见[重建说明](PSYCOPG-REBUILD.md)：

```sh
node scripts/rebuild-psycopg-runtime.mjs --source-archive <上游归档绝对路径> --runtime-directory <冻结原包绝对路径> --output-directory <新目录/notalone-runtime> --work-directory <新构建目录> --source-cache <本次隔离缓存>
node scripts/verify-runtime.mjs --runtime-directory <新目录/notalone-runtime> --report-directory <新验证目录>
node scripts/package.mjs --runtime-directory <新目录/notalone-runtime> --electron-zip-directory <固定离线Electron归档目录> --output-directory <新App输出目录>
node --test tests/packaging/psycopg-rebuild.test.mjs tests/packaging/runtime-attribution.test.mjs tests/packaging/managed-runtime.test.mjs tests/packaging/postgres-source.test.mjs
npm test
```

桌面类型检查及完整安全回归 95/95 通过，最后补丁入口修正后的相关回归 10/10、实际完整构建／严格补丁应用／DB及App分项通过；它不运行实际 App，其结果与上面的 Computer Use 分开记录。新增两份原生库来源后，标准 `prepareRuntimeAttribution` 实际核验 81 份源和 260 段通知，具体来源与剩余闭包项见[逐 wheel 清单](NATIVE-WHEEL-NOTICES.md)。本次冻结输入和替换探针基于原 79 份源、257 段通知；新材料等待下一轮标准运行时重建，未反向改写冻结证据。

本轮不读取开发 `.env`、现有数据库或用户默认 userData，不访问微信、不调用外部模型、不设置密钥或修改系统权限。过期大副本清理前保留小型编译／失败日志与补丁；最终修改源码、wheel、receipt、工具锁和本机运行结果继续保留在仓库忽略的自有产物目录。正式签名、公证、完整 Rust／C 通知与全部对应构建材料仍分别待核验。

## 2026-10-17 仓库外工具包与原 App 新副本

本轮将此前缺失的接收者交付物落实为随包 `licenses/replacement-kit`，标准 `prepare-runtime` 自动生成，也可用公开 `prepareReplacementKit({sourceCache,licensesDirectory,outputDirectory,download?})` 单独刷新材料。普通生产依赖、后端、ASAR 和默认 App 行为不变。

最小公开接缝先 RED 后 GREEN：离线输入被改字节时拒绝且无输出；安装目标通过目录别名重叠原包时拒绝；外部补丁越出源码根时拒绝。实际 NotAlone 复制另发现 `/tmp` 与 `/private/tmp` 的规范根错误，保留失败记录后以自写 C 小程序组成的签名 App 重现并修正。相关7项 Node 回归通过，合成 App 只做静态签名，没有启动 GUI。

外置工具包在仓库外实际读取锁定完整源码、应用接收者独立补丁并编译两个扩展。观察值为 `version=3.3.6`、`implementation=binary`、`libpq=160015`、`buildLibpq=160015`、`marker=notalone_recipient_patch_20261017`；`patch.kind=recipient-provided`。原固定标记不同，不能以默认内置探针冒充接收者修改。构建入口、其导入脚本与三个锁共9项和最终交付 kit 逐字节相同；最终 kit 相比初次编译目录仅修正复制安装的规范根，并补接收者说明与示例补丁。最终 kit 的 `install` 与 `verify` 已实际执行。

| 对象 | SHA256／结果 |
| --- | --- |
| 原始运行时 manifest | `807b49e317ea3e93b4c77ab404e12b26ed86f518d5726c3b254b1e8465cd430e` |
| 外部补丁 | `55df9faf17524314f8e6fb129e890feb36f415a53822559c8961f3a68bf35098` |
| 完整修改源码 | `6616606a57b197059066d106cc947515fd7baec4a4fec004da951c86fd261372` |
| 重建 wheel | `e3885d4f34e06f078bf93f69509799365dc80d439fada0b0664ab60e87eb7571` |
| 最终 kit 库存 | `37fe7c56a8f0db08b52de9a9ecb3b5d52b50a9d37f1268cd09458e9790b14606` |
| 输入 App 前后9,601项文件库存 | `b33633abc93ec23dc73c4d1f7ae694f3aaa77c16f262b9ec666689a4bf3c2c1f` |
| 原／新 ASAR | `3fd061a72d76278993307187e1c58b71bc69e120df494b7d779bc705dbde5221` |
| 副本安装 | 62个 Mach-O 架构／依赖／签名、286项非运行时资源核对、deep/strict通过；仅允许外层主执行文件签名槽改变 |
| 副本内运行时工具 | 搬动、隔离导入、60次迁移、真实 custom dump／第二空库 restore、恢复值核对及停服清理通过 |

最终 kit 为106文件、30,227,428字节，含固定 PBS 整包及三个完整开发 wheel。独立通知索引保存三个 wheel 的23份原文、PBS开发归档的43份原文、PBS完整发行元数据21文件（其中一份为 `PYTHON.json`）；不会用 setuptools75.8.2 的通知冒充83.0.0。这些开发材料和既有294来源／667通知的基础归因分别计数。没有模型 fixture、sitecustomize、测试 profile、私人配置或 npm 依赖。

接收者使用公开命令（各路径均替换为其绝对路径）：

```sh
node /absolute/replacement-kit/kit.mjs check
node /absolute/replacement-kit/kit.mjs rebuild \
  --runtime-directory /absolute/Original.app/Contents/Resources/notalone-runtime \
  --output-directory /absolute/modified-runtime \
  --work-directory /absolute/owned-build \
  --patch-file /absolute/recipient.patch
node /absolute/replacement-kit/kit.mjs install \
  --app-directory /absolute/Original.app \
  --runtime-directory /absolute/modified-runtime \
  --output-app /absolute/Modified-NotAlone.app \
  --receipt /absolute/install-receipt.json
node /absolute/replacement-kit/kit.mjs verify \
  --runtime-directory /absolute/Modified-NotAlone.app/Contents/Resources/notalone-runtime \
  --report-directory /absolute/verification
```

完整日志、原包和替换库存、真实补丁、wheel、源码及固定结果保留在端侧交付目录，不提交本机路径或合成数据库。测试 PG、凭据、备份和搬动副本均由工具收尾，构建者没有启动 GUI／读取用户资料；随后主 Agent 的独立公开验收另见下段。此证明关闭了脱离私有仓库重建及安装新副本的具体工程缺口，不认证所有修改的兼容性、原 PG18 wheel 字节复现、正式签名公证、干净 Mac 或全部法律义务。

主 Agent 随后独立运行本轮同一修改 App：以最小环境、独立空资料目录和根工作目录开始，Computer Use 从公开入口准备到真实已连接，填合成本人并初始化，重连后核对本人已就绪和真实空联系人；原生命令退出码0。App、PG、后台与握手均已退场，临时资料目录已移除且桌面租约不存在。未调用模型、微信或系统权限；现有用户和私人 App 均保留。此为本轮新副本独立实跑，不借用 v4 结果；合成公开首启与退出仍不等于干净 Mac 或正式发行认证。
