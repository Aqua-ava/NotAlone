# 手动输入首版的组合验收

状态：本机内部手动试用包、已知来源／通知及离线修改工具的随包交付已完成并实际验证。真实模型、真正无开发环境的 Mac及 Developer ID／公证未完成，不宣称已可正式对外分发。任务01与05保留未完成门槛，微信任务02／03继续延期。

## 固定产物

本轮产品功能代码冻结于 `adce30538e2ca1cb2a0ee79ed5680401bed71e97`，工作树为独立集成分支。后续材料、可选修改工具及本记录的提交不表示重新构建产品功能代码。

本轮功能验收与用户试用的普通 App（v1）位于集成工作树的 `desktop/artifacts/final-manual-package-20261017/NotAlone-darwin-arm64/NotAlone.app`。平台为 Apple Silicon、macOS 15.0及以上；App 的最低系统声明与 PostgreSQL 编译目标一致。本机严格 ad-hoc 签名通过，不等于 Developer ID 或公证。

| 对象 | SHA256 |
| --- | --- |
| 普通 App ASAR | `3fd061a72d76278993307187e1c58b71bc69e120df494b7d779bc705dbde5221` |
| 普通运行时 manifest | `d78598d019db2ecc88837b2943a65774b9de11a473449f07bf0f7eac73b138b3` |
| 普通后端 wheel | `bc45a1be06a982884b86888f34fb475491b3be4eadeb60018108b6d66e82c689` |
| 原始 PBS Python 入口 | `efa4aeb5a88a656d28f5da5317d5b990f56ef0acd5cdbfe300f8fc435f31c49b` |
| Electron 官方 ZIP | `e04e411b58a0a14375dd21b0ab4a378fd38930a702e4e20e322fee4849404c0b` |

普通 builder 从固定来源缓存完整重建，不借用已安装 Python、数据库或 editable 项目；源码 PostgreSQL 16.15、普通后端 wheel 和固定依赖随包。v1实际核对276份来源归档、631份原始许可通知、70个 Mach-O 依赖与签名、9259项运行时文件。前端与 Electron 原始许可位于 App 内，不依赖外面的同级文件。后续实际发现的tiktoken版本映射／原始通知已由下述v2补齐；不把无法精确还原所有target/features当作材料缺项或强制重新构建门槛。具体证据边界见 `desktop/scripts/runtime/NATIVE-WHEEL-NOTICES.md`。

普通包不含 sitecustomize、合成模型入口、网络测试 profile、未完成微信初始化或可执行的微信工具。严格签名、最低系统、前端／Electron 通知及运行时库存均实际核验。

## 同版实际验证

- `prepare:runtime`：固定源码编译、离线安装、普通 wheel、隔离导入成功。
- `verify:runtime`：运行时实际搬动后隔离导入、逐项对照全部60个正式迁移、真实 pg_dump／pg_restore及恢复后读取、停服清理通过。它不是干净机器或 App 认证。
- 主 Agent Computer Use 空目录首启：公开“开始本机设置”→真实连接→明确初始化合成本人→公开创建联系人→保持未自动选择→明确选择→打开手动输入→区分对方文字和本人草稿→未填方向禁止生成→填写方向→缺模型的实际恢复入口→原生命令正常退出。App、PG和握手消失，独立资料目录清理。未填写模型密钥、未调用真实模型。
- 主 Agent Computer Use 旧资料更新：旧开发 Python／项目确实不存在，公开单击备份更新→实际恢复校验→迁移重连→查看记忆、候选与来源引用→访达备份入口→正常退出→同资料重开→本人／模型状态及联系人保留、仍需重新选择→再次正常退出。生命周期夹具1/1通过，2.4分钟；业务操作由主 Agent 执行。
- 旧资料只读投影：原库仍55项迁移，受管副本60项；两边均保留1联系人、1消息、1来源、1已采纳记忆、1绑定，开关 false、补齐 paused，本人一致。迁移本身另做全部旧字段摘要核验。没有操作用户当前私人资料库。
- 完整合成公开流程：与普通包 ASAR及后端 wheel 完全相同的专用测试副本1/1通过，43.2秒（runner45.5秒）。覆盖公开本人／模型设置、甲乙联系人明确选择、粘贴方向、重复点击、两候选／依据与编辑、范围隔离、保存输入来源、删除助手讨论、合成503和同请求重试、搬动重开、旧模型预算停止、重新确认官方接收方及新合成密钥、恢复生成与两次正常退出。
- 普通包恢复组合4/4通过，1.8分钟：受控Main崩溃后本次后台／PG自然退场、同资料重开保留本人；公开首启、合成密钥保存及中文空格路径搬动重开；取消后确认真实停止再继续；组件缺损显示恢复入口、恢复原字节后继续。全部使用临时副本，未修改冻结原包，未作模型调用。

完整合成场只替换测试 Python 入口和模型 HTTP 传输；其 manifest 为 `79769fd840c812068aa55f64bd401a31b66b2b4c86c5a9a07cbb014a099993a9`。每次启动前都在同包执行真实 SDK MockTransport 哨兵；另以 `-I -S` 排除 Python fixture，独立证明 OS 限制拒绝外部连接、允许本地动态回环。它不认证供应商可用性或真实回复质量。早期模型隔离失败的401与修正保留在[手动输入记录](manual-input-validation.md)，不由本次通过覆盖。

## 独立审查与配置修复

固定 `f4ad7bc7..eb844b46` 的两轴审查分别发现官方配置恢复的一条问题：正式读取接受 `export KEY=...`、`KEY = ...`，写入却仅替换裸 `KEY=`，重启可能形成旧接收方配新密钥。Standards按接收方授权判P1，Spec按恢复入口失效判P2；两轴分别记录，不混作两项缺陷。

修复 `0e759e50` 复用正式解析器、一次清除全部旧合法赋值并原子保存三键，普通密钥与本人写入同样走统一入口。先取得5处失败，再通过19项定向回归，包含清空环境的新子进程真实重载、其它配置保留、0600与替换失败保持原文件／进程环境。独立 Standards和Spec复核均新增0。上轮恢复点复用及删除时快照清理两项问题已独立确认闭合。

组合基线 `eb844b46` 的桌面类型和safe102项、手动HTTP7项、连接切换门及两轮更新／重连接缝各1项、后端定向54项通过；最后配置修复合入 `adce3053` 后19项和类型检查通过。不会将此前旧共享测试库或既有差分失败写成全后端通过，细节保留在分项记录。

## 分发材料补齐后的v2

材料提交 `5b3a7375` 经独立 Standards／Spec复核均新增0，无冲突集成于 `400bc0de`。新增tiktoken扩展实际观察的10个crate版本、rustc-hash major2五版本保守集合和Rust固定提交根三份原文；保留原SBOM与未引用来源拒绝门，新增固定扩展摘要、版本路径、编译器commit和许可等同校验。没有改写默认wheel、后端或界面。精确解析版本与缺失上游provenance如实保留，保守集合不伪装已链接清单。

实际提取与库存为 **294来源文件（291归档、3 Git原文）、667段原始通知、7 SBOM、1 native证据、969项归因文件**。作者相关回归14/14，两位审查者分别独立6/6；Spec还逐项读取了全部来源与通知、三Git原文及扩展版本证据。

在全新运行时克隆内仅刷新`licenses/`并生成库存：新增54文件、修改3文件、没有删除；**8311个非licenses文件逐项完全相同，组件清单也相同**。v2运行时共9313项文件，manifest SHA256为 `807b49e317ea3e93b4c77ab404e12b26ed86f518d5726c3b254b1e8465cd430e`。没有重编库、PG或改写v1／用户试用实例。

v2普通App为 `desktop/artifacts/final-manual-package-materials-20261017/NotAlone-darwin-arm64/NotAlone.app`。实际再次核对官方Electron归档、前端／Electron原始许可、受管库存、严格ad-hoc签名及最低系统15.0；ASAR仍为上表`3fd061a7…de5221`，后端wheel仍为`bc45a1be…2c689`，不含模型测试替换。新运行时再通过搬动／隔离导入、正式60迁移、真实备份恢复及停服清理。

v2随后由主Agent Computer Use补测一项：独立空userData从公开首启进入“已连接”，同一资料目录第二次启动正常exit0，原Main、后台及PG的PID保持不变，原窗口仍连接；原生命令退出后四个已记录PID、握手均消失，合成资料目录移除。没有填写本人或模型、操作微信、系统权限及用户试用空间。它只认证本项v2首启／重复打开／退出，不把v1其余整包结果补签给v2；上述8311功能文件相同证明另行保留。当前用户试用继续使用已实测的v1。

v2内部ZIP位于 `desktop/artifacts/final-manual-delivery-materials-20261017/`，SHA256为 `7e172b730a71f07bffbf084e8892af34b6271cd03e2d3074b8880337f130de4f`；CRC、ASAR／manifest、包内294来源／667通知与测试替换缺席均实际核验。收据分别为`license-refresh-receipt.json`、`materials-package-receipt.json`、`materials-archive-receipt.json`。合成模型旧生成物已确认退场、保留ASAR／manifest／签名收据后回收，证据在`retained-model-package/`，已提交的测试fixture可重建；不再把其旧生成物路径当作仍存在的包。

## 离线修改工具与v3普通试用包

工具与证据`f5eb5d08`集成于`e439c4c1`。标准builder自动随带`licenses/replacement-kit/`：106文件、30,227,428字节，含固定PBS开发包、三个构建wheel、脚本／锁、外部补丁及新App副本安装入口。基础294来源／667通知保留，kit另有开发wheel原始通知23份、PBS开发包原文43份及PBS元数据／许可文件21份。普通使用不需要Node或编译工具；它们仅供主动修改开源组件的开发者使用。

仓库外真实应用接收者独立补丁并编译，观察到`notalone_recipient_patch_20261017`。最终kit九项重建代码／锁与实际执行所用字节相同，后续安装修复及说明差异单列。真实安装先抓到`/tmp`别名根误判，公开签名微型App回归先失败再通过；最终kit实际安装保留原App9,601项库存，核对286项非运行时资源及相同ASAR，62个Mach-O和deep／strict通过。新App内运行时60迁移、真实dump／restore及清理通过。样例使用libpq160015，不认证原18.6 wheel字节复现或全部特性。完整来源、失败及范围见[修改库验证](../../desktop/scripts/runtime/PSYCOPG-VALIDATION.md)。

Standards首轮1项P3签名台账缺失，补记后闭合、无新增；Spec两轮均0。两位审查者各独立7/7通过，最终GUI补记只读复核均0；作者相关14/14通过。示例unified patch的三个空白上下文行保留格式，其diff尾空格不作源码问题，其余差异检查通过。主Agent随后在同一修改App上Computer Use完成公开首启、真实连接、合成本人初始化、重连空联系人与原生命令退出，自己的进程、握手及临时资料全部收尾，没有模型／微信／系统权限操作，不借用旧v4结论。

v3由v2全新克隆仅补kit和说明：新增106文件、修改3说明、删除0；**8311个非licenses文件和组件清单完全相同**，生产扩展没有重建标记。普通运行时共9419项，再通过搬动／隔离导入、全部60正式迁移、真实备份恢复和停服清理。主Agent端侧校验脚本曾因导入顺序及工作目录分别失败，日志保留；修正后才记录成功，两次都未启动App或数据库，不算产品缺陷或通过证据。

| v3对象 | SHA256 |
| --- | --- |
| 普通运行时manifest | `0c87ee866cd744197035cb951c3a02cac82e702b1896b18b5d6055d014fd3e13` |
| 随包kit库存 | `37fe7c56a8f0db08b52de9a9ecb3b5d52b50a9d37f1268cd09458e9790b14606` |
| 内部App ZIP | `8a14ad91faf5961429d32ab868f527e2c216d1c3e1d3eb5599793297b1974b72` |
| 单独开发kit tar.gz | `84bbc243f6b3b65b908d8c08dd64a253230dc8fa0646ad1e8b51b77f147d19b4` |

v3普通App为`desktop/artifacts/final-manual-package-kit-20261017/NotAlone-darwin-arm64/NotAlone.app`，ASAR／后端wheel仍为上表v1相同摘要；严格ad-hoc、最低系统15.0、arm64、ICNS与前端／Electron通知实际核对，随包kit在根工作目录独立`check`通过且库存与仓库外交付版相同。主Agent另在v3普通包Computer Use空目录开始并确认已连接；同资料第二实例正常exit0，原Main／PG／后台PID不变、原窗口仍连接；原生命令退出后四PID／握手消失、资料目录移除。该场未填本人或模型，仅认证本轮首启／重复打开／退出，v1其它整包组合边界继续保留。

**当前内部ZIP**为`desktop/artifacts/final-manual-delivery-kit-20261017/NotAlone-0.1.0-arm64-internal.zip`，501,392,585字节；CRC、包内294来源／667通知／106工具文件、三项库存摘要及无模型测试替换实际核验。同目录保留单独开发kit归档及普通试用说明，两个归档都不是正式签名公证产物。更换版本说明提醒先从应用菜单退出旧版，避免单实例机制只唤回仍运行的旧窗口；本轮没有代用户退出旧实例。

证据为`kit-refresh-receipt.json`、`kit-package-receipt.json`、`kit-archive-receipt.json`、两份`cua-kit-*-receipt.json`及`final-manual-kit-report-20261017/result.json`。接收者编译、安装失败与成功、等同收据、补丁、完整修改源码和wheel保留于证据目录`retained-kit-proof/`；大编译目录在保存日志与确认退场后回收。v1用户试用和旧私人App保持原状。

最后核对无进程使用、原摘要和签名一致后，回收主Agent自建的v2中间App、运行时克隆和ZIP，先保存ASAR、manifest、Info.plist、CodeResources与全部收据于`retained-v2-package/`。上文v2生成物路径只作历史指针，不再宣称文件仍存在；实际回收范围与零活跃匹配见`v2-retirement-receipt.json`。v3最终App、运行时、ZIP、开发kit和正在使用的v1窗口均保留，最新ZIP摘要在清理后再次核对不变。

## 命令与证据

Python命令均先激活 Conda `NotAlone`，使用对应工作树绝对 `PYTHONPATH` 和 `NOTALONE_DISABLE_DOTENV=1`，不改变共享 editable 安装。

```bash
npm run prepare:runtime -- --source-cache "$SOURCE_CACHE" --output-directory "$RUNTIME"
npm run verify:runtime -- --runtime-directory "$RUNTIME" --report-directory "$REPORT"
npm run package -- --runtime-directory "$RUNTIME" --output-directory "$PACKAGE" --electron-zip-directory "$OFFICIAL_ELECTRON_ZIP"
```

App通过 `test-app.mjs --interactive` 的互斥、明确范围与有限启动数调度；这些是 Agent 自行设置的测试参数，不是新增用户批准要求。实际文件分别为 `tests/cua-data-update.spec.ts`、`tests/manual-first-release.spec.ts`、`tests/managed-first-run.spec.ts`；首次Computer Use独立进程只负责空目录、启动和生命周期记账，全部界面操作由主 Agent 完成。未请求新增权限、操作微信或发送外部消息。

正常退出和崩溃场分别保留原断言；主Agent另外按本轮公开场8份所有权记录复核10个不同PID及5个userData目录均退场／移除，未查杀未知实例。Computer Use旧资料场四个App／PG PID及合成资料目录另行核对；首次Computer Use的App／PG及握手也已核退场。最终测试租约为absent。

端侧原始证据位于集成树 `desktop/artifacts/final-manual-evidence-20261017/`，含标准包收据、构建日志、Computer Use生命周期和只读投影；运行时验证为 `final-manual-runtime-report-20261017/result.json`。合成模型副本的差异与OS／SDK哨兵收据在手动输入实现树的 `desktop/artifacts/final-model-runtime-20261017/` 与 `final-model-package-20261017/`。这些端侧产物不提交仓库，不含用户私人资料。

v2重复启动的独立生命周期脚本及实际收据为上述证据目录中的`cua-singleton.mjs`与`cua-singleton-receipt.json`；脚本只负责隔离启动、PID核对及本轮临时资料清理，点击开始、查看已连接和原生命令退出均由主Agent Computer Use执行。最终租约仍为absent，原试用及旧App未退出或修改。

内部ZIP使用ditto保留完整App，CRC、App内许可、ASAR和manifest对应关系实际核验；摘要为 `8a814def80730bd8a5d6b35d06eb6f0d41bd1d05032e3ff1700a67ed5f2b5313`。端侧 `final-manual-delivery-20261017/` 同时提供普通用户试用说明，明确平台、接收方、资料保存方式及尚未正式分发。

交接时发现旧App仍连接已有资料，未继续查看或修改该实例。另开长期保留的独立试用空间，由主Agent点击公开首启按钮后实际显示“已连接”；本人和模型留空，交由用户亲自填写。该交接实例不属于已清理的合成测试资源，也不代表私人资料更新或真实模型通过。没有退出旧实例、复制旧资料或沿用旧密钥。

## 剩余交付门槛

- 真正没有开发环境的目标 Mac 和用户亲自输入自己模型密钥的真实生成尚未验证；当前开发机上的包内隔离与合成模型不能替代。
- 本机没有 Developer ID 证书，未执行正式签名、公证或外部发布；本地开发证书不替代它。
- 已知来源／通知及脱离开发仓库的修改／新副本安装工具均已具体闭合；精确上游重现、其它修改的兼容性仍保留证据边界，不以一般性“未认证法律义务”无限增加门槛。
- 微信自动首次接入继续延期；此前工具自动安全审查以“可能涉及网络安全风险”中止其初始化，用户明确接受手动输入首版，未重试被中止的路径。

没有读取用户模型密钥、迁移私人库、请求管理员授权或修改系统权限；未 push、创建PR或发布远端。正式交付仍需以上真实资源和授权条件完成。
