# 唯一实例分类与单次时钟锚点

日期：2026-10-16。依据[首v7分类场](app-context-stop-v7-20261016.md)和[快速切换场](app-fast-switch-v7-20261016.md)：`instances_ambiguous`不能区分同次实例查询为0或多个；快速场虽有1条changed和较短正式请求间隔，宿主elapsed没有墙钟锚点，不能与正式probe epoch作可靠关联。旧v7证据、结论和包字节保持，不回填因果。

## 最小范围与已授权接缝

1. 既有纯失败投影／原读取包装：同一`runningApplications`返回数组的count，仅将0映为固定`instances_zero`、大于1映为`instances_multiple`；恰好1不生成实例拒绝。未知旧错误仍兼容`instances_ambiguous`，不记录数量、PID或身份。RegionCalibration原guard、错误、OS读取次数和停止码不变。
2. 原native协议→宿主strict decoder／私有sink：新增两个固定reason仍只配六null／`------`，原32行／3840字节／120字节及未知拒绝保持。
3. 既有NativeHeaderChangeSource→诊断sink：仅显式sink开启时，在source构造时写一次固定`clock-anchor`，纯数值`elapsedMs`、`epochMs`、`sampleSpanMs`。用performance前后两次取值夹住Date.now，以其中点相对于原`diagnosticBegan`作为elapsed，跨度表示非原子采样不确定性。不能在sink创建时自造另一个elapsed基准。宿主每私有文件只接受一条有效锚点，仍计入512行／256KiB，未知字段、非有限／负时间及非安全整数epoch拒绝。

锚点仅支持下一包本机诊断近似对齐；墙钟可能变化，stdout交付也有延迟，不能单凭锚点证明OS变化瞬间或事件→HTTP因果。Date.now不参与新增调度、采样、重启或恢复。默认无sink不读额外时钟、不写记录；0600新文件／0700父目录、O_EXCL／NOFOLLOW及日志故障不影响产品门禁保持。

在没有墙钟调整的局部区间，可按`epochMs + (event.elapsedMs - anchor.elapsedMs)`近似投影宿主事件时间；`sampleSpanMs`仅界定锚点前后取样跨度，另有毫秒量化与事件交付延迟，不能据此给出精确OS时刻。锚点不含ordinal、scope或身份，额外字段拒绝；epoch必须为非负安全整数，elapsed／span必须有限非负，span的一半不得大于elapsed，以免投影取样落在原计时基准之前。每文件首次有效锚点才占用一次记录，非法值不占用首次机会，重复锚点忽略。

本片8文件：本文；native `HeaderChangeDiagnostics.swift`、`RegionCalibration.swift`、`HeaderChangeDiagnosticsTests.swift`；desktop `header-change-diagnostics.ts`、`native-change-source.ts`及同主题两份`.test.mjs`。没有新增Swift源、manifest成员、用户配置、main接入、采图、权限或通用trace平台。初始dirty的AutomaticSessionCapture及其测试、已有验收入口和所有模型闭账代码不改。

## TDD与验证

按一个RED→GREEN垂直片段推进：先固定0／多个／唯一值和旧错误兼容、原读取一次；再固定两个reason的strict解析及六null；再固定锚点白名单、默认off、一次性及共享限额；最后由真实合成子进程确认锚点与source elapsed同基准、wallclock跳变不改变失败锁／原续租门禁、诊断故障不影响stdout。时间边界可mock，禁止真实原生探针或App。

完成后运行相关Swift、宿主两模块、TypeScript及完整相关安全回归，保留红灯与绿灯日志；独立Standards／Spec复核后交主Agent打包。当前仅源码准备，不GUI、真实CLI、模型、消息或权限，不提交，不宣称后继包实机已通过。

## 离线结果

四个垂直片段均保留RED：native缺少实例投影方法；宿主拒绝新reason；私有sink拒绝clock-anchor；source构造尚未产生锚点。对应日志为`desktop/artifacts/instance-clock-red-count-20261016.log`、`instance-clock-red-host-count-20261016.log`、`instance-clock-red-anchor-sink-20261016.log`、`instance-clock-red-anchor-source-20261016.log`。先实现各片再推进下一片，没有通过强改旧行为制造红灯。

相关命令及最终结果：

- 仓库根`swift test --package-path native/macos`：102项、2项既有实验skip、0fail（100实际通过），20.769秒；日志`desktop/artifacts/instance-clock-native-full-20261016.log`。其中HeaderChangeDiagnosticsTests 8项通过，包含原读取一次、默认off与输出限额。
- `desktop/`下`node --test tests/header-change-diagnostics.test.mjs tests/header-change-source-process.test.mjs`：13／13、0skip／fail／cancel，2858.976ms；日志`artifacts/instance-clock-host-related-final-20261016.log`。涵盖重复／非法锚点、同elapsed基准、默认不读墙钟、合成子进程code1锁、墙钟前后跳变、新proof不解锁及原完整租期回归。
- `desktop/`下`npm run typecheck`通过，日志`artifacts/instance-clock-types-20261016.log`；`npm test`含类型与完整安全组70／70、0skip／fail／cancel，22268.597ms，日志`artifacts/instance-clock-safe-full-20261016.log`。安全组的构建／静态签名检查不执行真实探针或App。

原55／60／65秒边界、scope锁与stdout协议没有变更；新source代码仅构造单次诊断记录。固定基点`f3c430012611c3e4f657f1b7b938ee3bb0acbc85`的本片8文件经独立只读Standards／Spec审查，均0发现；Standards亦无剩余可能smell。差异空白及文档链接／个人路径检查通过。源码可交主Agent构建后继v8候选，不把本轮离线结果覆盖旧v7或当作v8实机验收。
