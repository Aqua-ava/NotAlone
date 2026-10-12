# 最终 C 交付目录静态复核与归档（2026-10-13）

最终 C 的完整目录已归档，ZIP 的全部文件、Unix 权限和符号链接属性均与源目录一致；直接解压副本和还原归档链接权限后的副本分别通过主包及四个 helper 严格签名核验。固定 WCDB 的精确源码／构建输入和实际二进制许可覆盖仍缺，本记录不关闭 Mac20，不认证 Developer ID、公证、TCC 或现场功能。[来源缺项及已有有限官方核查](goal-mac-20261013-provenance.md)、[实际 C 场次另记](goal-final-c-acceptance-20261013.md)、[Mac20 原票](../mac-desktop-app/issues/20-mac-app-delivery.md)

## 产物及冻结范围

源目录为 `desktop/artifacts/goal-final-package-20261013-c/NotAlone-darwin-arm64/`。交付集合为完整 `NotAlone.app`、Electron `LICENSE`、`LICENSES.chromium.html` 和 `version`（44.7.0），共 **283 个普通文件、14 个符号链接、323 个目录（含根目录）**；其中 App 内 **280 个普通文件**逐项匹配 Root 首份 C 哈希清单。Finder 后来新增的顶层 `.DS_Store` 不属于上述集合，仅检查名称与元数据，不读内容、不删除源文件，也不将其纳入 ZIP。

最终归档：`desktop/artifacts/goal-mac-final-c-artifact-20261013/NotAlone-final-c-darwin-arm64-20261013.zip`。

- SHA-256：`66e3c9c214c87b021c91201fb0cb5a6b7051561d2ee176854e9eabfdd0ba92b4`
- 大小：**140,288,759 bytes**（133.789786 MiB），620 个 ZIP 条目；无 AppleDouble、`.DS_Store` 或交付根目录外条目。
- C ASAR：`bb68a80b9c5897ce78e128bf43377238f981fc411c1101a0cfb575afa6f1d685`。六份 dist 与读取时本机编译资源相同；相对 B 仅 Main 不同，Main 的完成回执调用位于 `inputBudget`／就绪发布前。B ASAR `25c3e21fd9a27d3b909c6448b03cf286c63e0817b21c78a1ec006d00038f1d6d` 不用于签 C 的运行结果。
- 构建计划基点为 `71f9b7e90dc01f1b9b6b5bf3d5e70ebf2bb02e1d`，加当时唯一 Main 源码变更；`session.ts` SHA-256 `ceab6b337a1399f059b68cdd2ae96961f926a49b1ffc065c627faba14cf229ca` 与已提交 `f27fa0393c8f88d072ab764638b1bd9593aa5b5d` 及读取时工作字节相同。计划列出的六份构建源文件逐一核对该提交 blob／当前字节，无差异。外置后端 `c370959be14c3e711090cea349bc26b09f30a0f3` 的两份 E/V 提示变更单独记录，不冒充 App 包输入。

## 四 helper、原生输入与九份许可材料

| 包内文件 | 字节数 | 实际 SHA-256／manifest 核对 |
| --- | ---: | --- |
| `wechat-cli` | 9,190,002 | `59de512a52d7960aef70da6b42d199358429662919f5b4baababc5132a660355`，相同 |
| `libWCDB.dylib` | 5,120,912 | `279ac6855ff2865caafa9718ae660e6e30a9667e4748ab064189ae633fd35fc3`，相同 |
| `libNotAloneSyncCore.dylib` | 657,984 | `f3828ded81a0f6b012ae3561109d28821863e1438ac06c883dc932c83d541b33`，相同 |
| `notalone-sync-probe` | 135,376 | `e10512d1c287986c4eda2690f2853248d042ac2cb4e1914f714952c109e7605c`，相同 |

探针 manifest 的十一份原生输入分别与 `f27fa039` blob／读取时源码相同，组合 digest 为 `b27d9cdf0954f927f67fba6a984db08fde6795c5fb4981d6371d4262953f5e06`。该检查证明随包探针记录的构建输入，不证明 WCDB 的上游构建来源。

第三方材料集合精确为八份原文和 `manifest.json`：WCDB、SQLCipher、ZSTD LICENSE／COPYING、OpenSSL、CLI LICENSE／THIRD-PARTY-NOTICES、README。无缺件或额外件，八份原文的字节数／SHA-256逐项匹配 manifest；manifest SHA-256 为 `cd393ffb38a6741b886e0bf524ef94e1451c6d954100a7426609cd5e816427bb`。根目录两份 Electron 许可也在归档中，SHA-256 分别为 `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d`、`3375e2a9bd7bc631738fde10be6548a76efe8cf5e4b8826b8140ba8b0c4d6353`。

`exactBuildSourceVerified=false`、`binaryLicenseCoverageVerified=false` 保持。现有材料不把新官方 WCDB 2.1.16／ZSTD OFF 链替换成当前固定 2.1.15 install name／含 ZSTD 导出库的证明；解除条件仍是绑定该固定库 SHA-256 的源树／子模块、补丁或未修改声明、编译器／SDK／crypto／链接输入、构建记录及实际组件 BOM／逐组件许可。没有重跑公开检索、换库、升级 CLI 或迁移数据。

## 签名及权限观察

源 App、直接解压 App、按档内属性还原链接权限的 App 各执行一次 `codesign --verify --deep --strict`；对应四个 helper 各执行 `--verify --strict`，共 **15 次 verify，全部 exit0**。三组均读取签名详情与 entitlement，不执行这些二进制。

主包及四 helper 均为 arm64、ad-hoc、TeamIdentifier not set；CLI 另带 linker-signed。主包 identifier 为 `com.notalone.desktop`，仅 `com.apple.security.cs.allow-jit=true`；CLI／probe／core 无 entitlement。WCDB 自身有 allow-unsigned-executable-memory、debugger、disable-library-validation、get-task-allow，不将库签名字段当成主包 TCC 授权。Info.plist 为 `NSAllowsArbitraryLoads=false`，无 UsageDescription 字段；这些静态值不认证 Developer ID、公证、系统权限归属或 OCR 可采集。

## 实际归档、失败及回归

全部时刻为 Asia/Taipei，提前写有限计划，App／helper 启动上限均为 **0**。归档沿本机 `man ditto` 的 `-c -k --keepParent` 入口，使用已有 Mac20 归档修复所采用的 `--norsrc`，避免 AppleDouble 使 framework 签名失效；不保留 resource forks／xattrs／ACL／quarantine，不声称这些系统元数据已经复制。[已有打包元数据修复记录](../../docs/macos-app-permissions-and-errors.md)（361 行）

| 检查 | 预注册时段 | 实际结果 |
| --- | --- | --- |
| 首次集合核查 | 04:19:14.471–04:24:14.471 | 0.024292 秒，exit1，新增 `.DS_Store` 触发 `unexpected_top_entry`；未创建 ZIP 或临时复制 |
| 完整归档及第一次解压 | 04:21:25.710–04:26:25.710 | 13.956872 秒，exit1；四项交付集合经自有 staging 完整复制，ZIP／解压 exit0；严格快照因链接权限差异失败，记录保留 |
| 归档属性与还原回归 | 04:24:56.903–04:27:56.903 | 3.700689 秒，exit0；CRC、完整 Unix 属性、文件、目录、链接及两阶段签名全部通过 |

第二次的 ZIP 保存了全部原始权限，含十四个链接的 0700，但 `ditto -x -k --norsrc` 直接解压为 0755。普通文件的 SHA-256／字节数／权限、目录权限和所有链接目标此时已全部相同，直接解压签名也全部通过。第三次先独立核验全部 ZIP Unix 属性等于源，再只对自有解压目录的这十四个链接按档内 0700 执行 `os.lchmod`；完整快照和签名复核通过。原 ZIP 和源包均未改变，不把第一次严格比较的失败删掉或追写成通过。

归档命令实际 9.869090 秒，首次解压 1.500807 秒，再次解压 1.052962 秒；三轮入口合计 **17.681853 秒**。额外 ASAR 静态读取先因误用 `dist/main/index.js`、`dist/main.js` 两次 exit1；读取真实清单后定位 `dist/main/index.cjs`，六份 dist 核查 exit0／0.013558 秒。两次工具路径失败另存，不作为产品回归或红绿测试。

## 证据及收尾

忽略目录 `desktop/artifacts/goal-mac-final-c-artifact-20261013/` 保留 ZIP、两个验收工具与三轮证据，目录 0700、文件 0600；没有提交这些产物或私人资料。

- 根 `plan.json`／`static-report.json`：首轮失败及实际 0.024292 秒。
- `attempt-02/{plan,package-before,restored-package,static-report}.json`：四 helper／十一输入／九材料／签名／归档命令、失败差异与清理；报告 SHA-256 `050da29690622b1f81c3743b724b8fc4b7ae523e22238f29179cf26ff53e783c`。
- `attempt-03/{plan,zip-unix-attributes,direct-restored-package,restored-package,package-after,static-report}.json`：原 ZIP 属性、直接解压签名、档内链接权限还原、最终全量快照与签名；报告 SHA-256 `a2ec0416a1821b60c1d2c822cfb96a153394ca11eeb406612d4ea7d38cb78be0`。
- `attempt-03/asar-dist-{first-failure,second-failure,check}.json`：两次错误路径和六份实际静态资源；本记录的 280 基线来源为 `desktop/artifacts/goal-rewrite-failure-replay-20261013-c/package-before.json`。
- `verify_archive.py` SHA-256 `0e2cdd2754cfcd2c71a8c10c485028eb0165715d0e98a24b72e4c65faf8749a6`；`verify_restored_archive.py` SHA-256 `891b85cfeaaf15b9aca30c316bd90921c02f4e55383e5677bcc38b5d3df50896`。

两份自有临时目录均经 dev／ino／父目录／固定前缀核对后精确清理，所有自有 ditto 进程等待 exit0。源交付集合与原 283 文件／14 链接／目录快照相同，ZIP SHA-256／大小保持。未创建 App 租约、业务库、持续进程或后台任务；未操作桌面、读取微信、运行 CLI／probe／OCR、调用供应商、读取 `.env` 或新查上游，也未更改包内权限、签名、源码或默认放行。Root 各实际场次的资源清理与未明测试库单独记录，本静态归档不替代其验收或清理。

独立 Spec 和 Standards 最终未解决项均为 0；两个审查者只读静态元数据，没有重新运行 App／helper／模型、读取秘密或改写原证据。相对链接和差异检查后由 Root 按主题本地提交；静态归档不占用 App 租约，也不替代现场验收。
