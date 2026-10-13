# H场名称阶段失败分支诊断（2026-10-13）

## 范围与既有证据

承接原Mac18／20持续目标，仅给现有`--verify-minimal-region --json`校准结果桥接补安全诊断。已读取仓库AGENTS、工作流、领域路由、工程／任务规则及ADR-023／025／030；当前窗口恢复授权允许必要OCR修复，子Agent不操作桌面、不执行真实App或模型，不提交Git。

真实H固定结果位于忽略产物`desktop/artifacts/goal-resume-ocr-20261013-h/results/native-foreground-layout-公开校准后只以五处最小区域验证当前布局/layout-verification-result.json`：`state=failed`、`error=minimal_region_layout_changed`、`stage=names`，无`name_quality`。不读取error-context、聊天或截图；H整场76.800秒不能归为names耗时，不能认证低置信度。旧错误不补造分支。

## 反馈与分支预测

按现代码执行顺序列出可证伪预测：

1. 某名称小图采集前`contextMatches`不符，则新结果只标`context_before_capture`和当时name_slot。
2. 某小图capture返回后原`contextMatches`不符，则只标`context_after_capture`；不重新OS观察追认之前瞬间。
3. 原采集后上下文通过、CGImage输出尺寸不符，则只标`output_size_mismatch`，不改变points→pixels计算。
4. 三次名字采集／识别返回，首末顶部可空字符串不等，则标`repeated_header_mismatch`／`repeated_header`，只输出存在性与相等布尔。

其他异常或未区分的几何检查仍未知；原error/stage、0.90门、ASCII策略、RAM小帧、五处几何和前台限制保持。

## 约定接缝与验证边界

Root已指定纯接缝红→绿和Host严格字段负控。Swift纯失败guard接缝检验上述原检查点的错误类别和无原文JSON；Node验证现有结果保存接口的固定字段／组合、未知／注入拒绝、0600、过期不覆盖、不授予profile。只证明桥接，不证明H根因、真实质量、权限归属或产品全验收。

忽略证据目录`desktop/artifacts/goal-resume-ocr-branch-tool-20261013`为0700，最终证据文件0600；不保存名字、名字hash、帧或聊天。实际App／微信／Vision对照／CLI／模型HTTP／PG／密钥读取均0。

## 实现与实际验证

- 原生`Capture.image`在原采集前／后`contextMatches`已取得布尔处直接分类，OS查询次数和顺序保持；前台检查短路后仍不读取region或output尺寸。尺寸仍采用原points×scale整数输入与实际CGImage精确比较，不乘额外2倍，不改变sourceRect或capture配置。细条无name_slot仍抛原错误。
- 原生`Capture.names`在原三次名字路径标记header／row／repeated_header，在原首末`String?`相等比较处只保留存在性与相等三布尔；两次nil继续相等，由后续原`Names.validate`拒绝。四类wrapper在校准与session输出仍映射`minimal_region_layout_changed`，只在校准`stage=names`附诊断；其余异常输出两null，不追认原因。
- Host仅failed/names接收诊断；非空branch必须原`minimal_region_layout_changed`且无尚未完成的name_quality。四分支与三位置固定，复读分支必须repeated_header、三布尔完整、equal=false且至少一处present；空branch只允许空slot及不带复读布尔。严格拒绝额外字段／原文／名字hash／图帧、部分字段、非法类型和不可能组合；结果0600原子保存，过期不覆盖。旧H及不带分支的旧格式继续可读，不回填。

| 命令／证据 | 实际结果 | 运行边界 |
| --- | --- | --- |
| `cd desktop && node --test tests/helpers/calibration-progress.test.mjs`；`node-first-red.log` | 6通过／1失败，144.43025ms；结果缺failure_branch/name_slot的断言红 | 实际保存边界红，不是H实机复现 |
| 同命令；`node-first-green.log` | 7/7，128.272583ms | 最小保存实现后 |
| 同命令；`node-bridge-red.log`→`node-bridge-green.log` | 缺生产桥接函数，7通过／1失败139.784583ms→8/8 195.622375ms | 原生结果解析接缝，非App |
| `swift test --package-path native/macos --filter 'MinimalRegionLayoutTests\|SessionCaptureSafetyTests'`；三个`swift-*-red.log` | context／output／repeated三次首次均缺新增符号而编译失败；外层7.198325375／1.27484075／1.173906959秒 | 如实记录编译红，非H根因回放 |
| 同Swift命令；三个`swift-*-green.log` | 14/14、15/15、16/16；外层5.739049666／2.834804167／3.049197292秒 | 纯检查guard、布局及参数 |
| `cd desktop && node --test tests/helpers/calibration-progress.test.mjs`；`node-final.log` | 9/9，873.048666ms | 22组非法字段／组合、错误／阶段关联、无profile、0600、过期和复制负控 |
| `cd desktop && npm run typecheck`；`typescript-final.log` | exit0，最终外层1.544518417秒 | TypeScript纯检查；无build/App |
| `swift test --package-path native/macos --filter 'MinimalRegionLayoutTests\|SessionCaptureSafetyTests\|VisionLanguageControlTests.testConditional'`；`swift-final.log` | 22/22，测试0.009秒；外层1.970620584秒 | 六个ASCII协议测试仅注入纯合成closure，未选中任何真实Vision对照 |
| 范围内`git diff --check` | exit0 | 只读检查，不提交、不索引、不远端 |

这些测试证明固定诊断桥接与原门禁仍在，不证明H原因已定位、profile可用、0.90实机达标、TCC归属、真实联系人采用或完整原18／20验收。两轴由Root针对冻结patch和源码SHA独立完成；尚未评审、打包或实测。

## 冻结与交接

本片只涉及七路径：原生源码／对应单测、Host校准／安全结果保存／纯Node单测、权限台账和本记录。`branch-tool.patch`包含该范围变更；`freeze.json`列七个当前源码文件SHA、H固定结果SHA及所有本片日志SHA。冻结后子Agent停止编辑，由Root两轴后按任务独立本地提交；没有Git写操作。

合成测试临时目录由finally回收；未创建运行中App／helper／CLI／模型或数据库，不需要杀未知进程。H旧失败／耗时不改，实际累积App、HTTP及消息计数由Root主台账保持，本片新增均0。下一次真实分支证据只能来自Root有限test:app新场，当场失败仍停止；本片不授权续跑H、旧Vision或旧模型实验。

## 初次冻结后的Spec P2修复

Root两轴发现初次冻结仍有Spec P2：`validatedNameFailureDiagnostics`会拒绝诊断对象里的额外字段，但生产`nameFailureDiagnosticsFromResult`先挑出已知键，再校验，因此新失败envelope根层的`name_hash`／`display_name`／`image`会被静默丢弃而非拒绝。原9/9未覆盖这条真实提取路径的根层注入，初次`freeze.json`／`branch-tool.patch`保留，不将其记成最终无问题版本。

最小修复只为已经带任一新诊断字段的envelope校验完整允许根键：`ok`、`error`、`verification_stage`、可选`name_quality`与固定五项诊断字段。其他根键直接拒绝；没有新诊断字段的旧格式仍先返回undefined，未改变旧读取合同。原生、原生单测及`calibration.ts`完全不改，三个文件SHA与初次冻结核同，不扩大产品范围或引入参数抽象。

新增生产提取函数负控：已知分支与两null分别注入五类额外根键均应抛错；旧格式五类根键仍返回undefined；两null与合法原9数值质量字段继续兼容。实际运行`cd desktop && node --test --test-name-pattern='原生名称失败桥接拒绝新失败envelope' tests/helpers/calibration-progress.test.mjs`，0通过／1失败、110.51125ms，错误为`Missing expected exception`，见`node-envelope-red.log`。加完整根键检查后运行整文件10/10、173.953833ms，见`node-envelope-final-green.log`；TypeScript exit0、外层0.474668167秒，见`typescript-v2.log`；范围diff检查exit0。未重跑Swift、真实Vision或App，沿三个SHA不变复用原22项纯Swift证据。

新`branch-tool-v2.patch`／`freeze-v2.json`记录七路径当前SHA、旧freeze与patch摘要、这次真实生产提取红绿和原生不变证明；初次Spec P2经本片最小代码修复，等待Root独立复核。目录0700、所有旧新证据0600。实际App／真实Vision／CLI／HTTP／PG／密钥／发送／打包／签名／Git写仍0。冻结v2后再次停止编辑；原H原因及18／20验收保持未完成。
