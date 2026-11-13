# 上下文停止的最小元数据诊断

日期：2026-10-16。来源为[当前v6实际切换](app-session-switch-v6-20261016.md)：唯一辅助源`context_changed/code1`，同连续许可失败锁符合ADR-057；具体OS子原因未知。本片仅为下一包的有限实机准备诊断，不将新鲜proof改为失败重启，不重新运行GUI。

## 已授权接缝

1. 原生纯投影：既有`CalibrationContext.resolve`一次查询所得的失败分类，或原有前后上下文比较，投影为固定拒绝分类／六个字段匹配布尔。用于区分不可读与PID、window、origin、size、version、build不等，不证明OS具体行为。
2. 既有原生诊断序列化及宿主strict decoder／私有sink：固定行可跨chunk解析，非法reason、原值、字段或组合拒绝，默认off及32行／3840字节、每行120字节上限不变。
3. 真实合成子进程公开协议：附加诊断不会变成stdout事件、code1仍保持同许可锁，新observation不解锁，完整55秒／退出／默认零诊断保持原合同。它不是微信实机验收。

上述接缝由本轮实现指令明确指定。按TDD一次一个垂直片段，不修改初始dirty的`AutomaticSessionCapture.swift`及其测试，也不改后台v3、ADR-058或architecture索引。

## 最小接口

保留旧`notalone-header-change-v1 <stage> <reason> <elapsed-ms>`；新增仅stderr的`notalone-header-context-v1 <reason> <matches> <elapsed-ms>`。`matches`为按process／window／origin／size／version／build排序的六个0或1；不可读时固定`------`。身份不等至少有一位0；不会输出PID、窗口ID、坐标、版本原文、路径、名称、画面、正文或原始错误。

固定reason为：`instances_ambiguous`、`foreground_unknown`、`not_wechat_foreground`、`version_unsupported`、`window_list_unavailable`、`window_not_visible`、`windows_ambiguous`、`window_geometry_invalid`、`context_unavailable`、`identity_mismatch`。前九种只允许`------`，末项只允许六个布尔且至少一位false。诊断只在原有读取失败或比较不等时产生一次附加行，不为正常复验新增行或OS轮询。

`windows_ambiguous`沿原窗口选择器的失败分类，仍包括多个候选或无法排除的未知尺寸，并非具体窗口计数；不据该枚举单独确定OS原因。`not_wechat_foreground`只说明既有前台PID比较失败，不输出其他App身份。

`RegionCalibration`继续对原调用者抛原错误；仅在原resolve查询内给辅助源保留固定拒绝分类。辅助源各原有读取点替换为返回相同context／nil的诊断包装，不增加调用次数，active短路、初始化、布局、55秒正常结束、60秒兜底和stdout changed／paused保持。原始对象只在既有端侧内存比较，投影不控制决策。

宿主只在既有私有sink开启时读取子stderr，沿原decoder接受新固定前缀，落地`native-context`记录及六个nullable布尔。新旧行共享原32行／3840字节预算，私有sink仍O_EXCL／NOFOLLOW、0600、0700父、512行／256KiB；任何诊断故障仍不改变采集门禁。`native-change-source`仅需按typed诊断种类写入记录，原source锁与续租不改。

本片保留现有Swift源集合，无新源文件／manifest成员，不修改CLI、签名identifier、权限、Info.plist或用户错误。候选hash会自然变化，正式包与实机由主Agent下一步另行构建。

## 验证与交付

先RED固定分类／布尔投影及无敏感值序列化，再实现；随后RED→GREEN宿主新行strict解析及私有sink；再用真实合成子进程核code1／同scope新proof仍锁定。运行相关Swift完整测试、宿主诊断／源协议回归、TypeScript，按当前改动运行完整安全组，保留红灯日志。完成Standards／Spec独立复核才交付可打包源；本片不GUI、不真实CLI／模型、不读凭据、不提交，不认证下一包已工作。

本轮实现9文件：本文；`HeaderChangeDiagnostics.swift`、`HeaderChangeSource.swift`、`RegionCalibration.swift`及`HeaderChangeDiagnosticsTests.swift`；桌面`header-change-diagnostics.ts`、`native-change-source.ts`与同主题两份`.test.mjs`。宿主source仅调整诊断record的typed kind拼接，未改许可、停止或续租分支。没有新增Swift文件，原18源manifest集合保持。

离线结果：Swift完整101项、2个既有实验skip、0fail（99实际通过），20.588秒；宿主相关9／9，2931.152ms；`npm test`包含类型及完整安全组68／68、0skip／fail，23259.385ms。日志为`desktop/artifacts/context-stop-diagnostic-native-full-20261016.log`、`context-stop-diagnostic-host-related-20261016.log`、`context-stop-diagnostic-safe-full-20261016.log`。纯投影、读取一次、host decoder均保留RED→GREEN日志；首次类型检查的union cast失败也保留，修正后的`context-stop-diagnostic-types-v2-20261016.log`通过。Standards与Spec独立只读审查均0发现；当前没有此诊断候选的真实App或原生辅助源实测结果。
