# 辅助源额外帧的实际分账

日期：2026-10-16。来源为[当前v8报告](app-instance-clock-v8-20261016.md)：正式109轮均单帧，但辅助源只有阶段／租期，没有实际额外帧数；不得用4Hz、55秒或240上限推算实数。本片只准备后继v9的显式私有元数据，不改旧结果、采样频率、唯一实例门或失败锁。

## 最小实现与授权接缝

- 初始化整窗CGImage成功返回数：仅在既有`captureWindow`成功返回后记0→1；布局随后失败仍为1，调用失败为0。
- screen回调数：仅在既有`didOutputSampleBuffer`入口、类型为screen时记数，位于原active／valid／complete／节流门之前，包含本源收尾前已交付但未处理的回调。不称OS内部全部物理采帧，不把minimumFrameInterval当实际次数。
- 顶部处理帧数：直接读取原`frames`，0..240；它在合法buffer进入顶部像素处理时递增，包括初始detector基线帧，不是仅有变化的帧数，也不是两帧差比较次数。

计数仅由同次既有成功返回／回调递增，不新增OS查询、帧、OCR或数据内容访问。回调计数以UInt32饱和保护；实际超过其上界时固定`saturated`状态表示下界，禁止伪称精确。常规`final`状态表示本次计数未饱和。

新增一次最终stderr行：`notalone-header-counts-v1 <final|saturated> <initialImages> <screenCallbacks> <processedFrames> <elapsed-ms>`。只在原run收尾、已有stopCapture返回或抛错之后，于defer投影一次；硬退出或诊断限额不允许输出时保持缺证，不伪造0。新行与旧诊断共享32行／3840字节、每行120字节；默认关闭仍无输出，stdout changed／paused不变。

宿主strict decoder投影为`native-counts`，只有固定状态、上述三个有界整数、ordinal和耗时。initialImages为0或1，screenCallbacks为0..4294967295，processedFrames为0..240且不超过回调数；saturated只允许回调上界。额外键、身份、像素、名称、非有限或越界值拒绝。私有sink原0600／0700、独占创建、512行／256KiB保持；宿主达到cap后丢失最终计数必须如实报告。计数不参与调度、恢复或停止决策。

所有权限本plan、native HeaderChangeSource／HeaderChangeDiagnostics及HeaderChangeDiagnosticsTests、desktop header-change-diagnostics及两相关测试；native-change-source仅在类型转发确需时最小调整；权限记录追加本片边界。无新增Swift源或manifest成员，不动AutomaticSessionCapture初始dirty、已有验收入口、旧报告或模型冻结／闭账。

## TDD与交付

依次在已授权纯计数→固定协议、strict decoder→私有sink、真实合成子进程stdout／stderr接缝推进RED→GREEN。覆盖0初始化失败、成功1、未处理回调与处理数分离、240上界、饱和不溢出、非法范围、最终仅一次、默认off、共享限额、无敏感值、code1及同许可锁保持。

运行相关Swift、宿主／源协议、类型和完整安全组，独立Standards／Spec审查后交主Agent打包。无GUI、真实探针／CLI／模型、消息或权限；不提交，不将离线结果冒称v9实际分账已完成。

## 本轮离线结果

原生计数／最终投影首次RED为类型与countsLine尚不存在，日志`desktop/artifacts/header-frame-counts-red-native-20261016.log`；实现后相关10项通过。宿主strict解析首次RED为新固定行未被接受，日志`header-frame-counts-red-host-20261016.log`；实现后GREEN。真实合成子进程的kind转发由既有生产路径直接满足，新增组合回归一次通过，没有为该路径制造假红灯，也没有改native-change-source。

- 仓库根`swift test --package-path native/macos`：104项、2项既有实验skip、0fail（102实际通过），19.387秒，日志`desktop/artifacts/header-frame-counts-native-full-20261016.log`。
- `desktop/`下`node --test tests/header-change-diagnostics.test.mjs tests/header-change-source-process.test.mjs`：15／15、0skip／fail／cancel，3649.066ms，日志`artifacts/header-frame-counts-host-related-20261016.log`；覆盖严格计数、重复最终记录、越界／非有限／额外字段、饱和下界、code1／同许可新proof仍锁住和原租期。
- `desktop/`下`npm run typecheck`通过，日志`artifacts/header-frame-counts-types-20261016.log`；`npm test`含类型与完整安全71／71、0skip／fail／cancel，21017.924ms，日志`artifacts/header-frame-counts-safe-full-20261016.log`。安全组只构建／静态校验，不执行原生探针或App。

实际8文件为本文、HeaderChangeDiagnostics.swift、HeaderChangeSource.swift、HeaderChangeDiagnosticsTests.swift、desktop header-change-diagnostics.ts与两相关`.test.mjs`、权限记录。source仅7行元数据接入，没有改变既有frames、回调短路、stop／code／续租；18源集合保持。以`29e4f008446b9633580e4ffd746b5d6d74e581a1`为固定基点的独立Standards／Spec审查均0发现，可交主Agent打包v9候选。本片没有实际源执行／采样计数，旧v8结果不补填。
