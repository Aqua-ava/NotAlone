# 持续目标：OCR定位诊断与现场交接（2026-10-13）

## 范围与当前结果

承接[原18票](../mac-desktop-app/issues/18-foreground-locator.md)和[现行规格](../mac-desktop-app/spec.md)。用户本轮解除OCR暂停，授权必要代码、测试和验收工具修复。主Agent串行执行真实桌面；此片仅核查源码、准备诊断并运行合成/纯逻辑回归，没有启动真实App、探针、浏览器或微信，没有读取凭据、真实聊天或视觉帧，也没有发送测试消息。

原18的三项验收全部未勾选。已有真实证据不重做：公开坐标选择已成功；2026-10-10 23:34越过context/capture-setup/sentinels-before；23:39在names返回session_name_confidence_low，完整单行、顶部复读相同与两名一致已通过，但三次最低分不足0.90。没有可信profile。该次静默屏幕权限预检通过不证明2026-10-13新包权限归属或稳定授权；不能从历史与纯逻辑通过结票。

本片补严格9数值的`name_quality`，保持原识别参数、0.90门槛、采集矩形与次数、仅前台可见、无全窗回退和端侧内存帧政策。顶部及复读分别保留置信度；生产session仍取两次最低值，不让诊断分项提高资格。结果只用于诊断，不进入profile、联系人匹配或自动采纳。

## 代码与证据索引

- `native/macos/Sources/NotAloneSyncCore/MinimalSessionCapture.swift`：`verifySelection`在names阶段保留三次置信度、两处实际CGImage宽高、pixel_scale、names_duration_ms，失败也返回安全数字；`Capture.image`使用仅包含已选微信窗口的display filter，sourceRect逐区，前后重验context，显示器单一；音频/麦克风关闭，CGImage不保存。重复顶部与初次不同直接安全暂停。
- `native/macos/Sources/NotAloneSyncCore/MinimalRegionLayout.swift`：0600/当前owner/非链接profile，版本4.0.6/29387、PID/windowID/尺寸、五区域和三摘要严格核对；未知与未验证profile在OS动作前拒绝。
- `backend/src/notalone/front_sync/probe_adapter.py`：`qualified_evidence`要求已验证布局、minimal-region-v1、两份必要置信度至少0.90、两名字一致；非法数值/字段拒绝。session的display_name_confidence已包含顶部复读最低分。
- `backend/src/notalone/front_sync/foreground_locator.py`：新观察只查全类型元数据与当前owner/channel/account active绑定，无tail或正文写入。全类型同名项包括未绑定私聊和群聊，51项即拒绝唯一性；改名、失效、模糊和查询失败均无自动身份。
- `desktop/src/main/foreground/controller.ts`：可信show前一次新观察、1500ms；helper focused暂停、连接/联系人/编辑/生命周期变动使旧结果失效，已有编辑保留并要求确认。`desktop/src/main/backend/config.ts`将本轮userData的profile传给实际后端，不用历史sync/status作为当前身份。
- `desktop/src/main/foreground/calibration-profile.ts`：9字段精确集合、有限数值、[0,1]置信度、整数像素/毫秒、每图<=160000像素、scale[1,3]和耗时<=400000ms；未知正文/图像/扩展字段拒绝。结果0600独占临时文件与原子rename，current失效不写。
- [权限记录新增节](../../docs/macos-app-permissions-and-errors.md#2026-10-13-ocr质量分项诊断准备)：不改TCC或签名策略，不新增权限请求；实际helper路径、父进程、identifier、签名与权限归属仍由Root实测。

API证据只支持接口，不认证实机。Context7目录无工具；Apple搜索返回的[SCStreamConfiguration.sourceRect](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/sourcerect?language=objc)说明display源区域，单window模式忽略该参数；此源码使用display filter包含单一窗口，保持逐区限制。本机Xcode SDK `SCStream.h`也注明display逻辑点坐标。[VNRecognizedText.confidence](https://developer.apple.com/documentation/vision/vnrecognizedtext/confidence?language=objc)约定[0,1]置信度；实际图像/识别质量仍须测试。官方页面直开仅JS占位、Markdown接口失败和curl TLS失败均保留，不借失败抓取推断新API行为。

## 已执行验证与未运行

固定代码基点`0ddc93175d8225243084de7e499cf776b4e5ee8e`。没有使用模型预算。

1. 基线`swift test --package-path native/macos --filter 'MinimalRegionLayoutTests|SessionCaptureSafetyTests'`：10/10，构建1.93秒，纯测试0.011秒。
2. `cd desktop && node --test tests/helpers/calibration-progress.test.mjs`新增安全诊断先红：原结果缺name_quality，2通过/1失败。最小生产保存后同命令3/3，102.5ms；非法字段/数值、无profile授权与过期不覆盖均有负控制，不将它们称首次红。
3. 新原生重复顶部诊断测试首红为缺少repeatedHeader/pixelSize编译接缝，不是低置信度实机症状的复现。实现后同纯Swift相关组11/11，构建2.37秒，测试0.012秒；重复顶部0.89仍失败，诊断只含数值而不含合成名称。
4. `cd desktop && npm test`：类型及安全调度47/47，安全组10.772秒；只构建/签名自有合成C与仓库探针快照，不执行这些二进制，不运行App/普通页面/浏览器/微信。
5. `source /Users/local-user/miniconda3/etc/profile.d/conda.sh && conda activate NotAlone`，在backend运行`NOTALONE_DISABLE_DOTENV=1 python -m unittest tests.unit.front_sync.test_probe_adapter tests.unit.server.test_sync_host -v`：39/39，0.380秒；真实OS、CLI、数据库和模型均由合成边界隔离。
6. `cd desktop && npm run build`通过，Vite构建149ms。`git diff --check`通过。两轴：mac_provenance独立Standards硬违反0/Fowler判断0；memory_diagnosis独立Spec代码0，发现旧spec只允许固定阶段/错误码，已同步9个数值诊断及不授予资格；spec、18票、权限台账与本记录最终复核未解决0。真实联通仍待Root实测。

此片真实App运行时长0、真实模型HTTP0、外部发送0、原始帧0、业务库/迁移0。合成回归自有临时目录由测试finally删除。完整联通与资源清理结果必须由下一场实际test:app收据补记。

## 下一轮预注册诊断

原低置信度症状尚无本轮实机反馈回路；不能声称根因已修复。按以下顺序用新数字区分，不改变门槛，也不靠无限重跑取得通过：

1. 若选中行采样不足，则row置信度会稳定低于顶部与复读，实际row像素高宽可定位是否满足预期Retina采样；仅在这个预测得到证据后考虑最小采样修正。
2. 若顶部短名称评分偏低，则header及repeat都会低，row较高；先用固定公开合成名称和相同像素尺寸复现，再决定识别适配。未知分数不能支持更换OCR算法或降低0.90。
3. 若新观察预算不够，则仅names阶段耗时已接近/超过0.9秒，或整次新观察返回observation_timeout。新观察当前0.9秒探针预算内需要9个小帧和3次Vision，实际可达性缺证据；1500ms宿主约束保持，不能通过放宽总预算掩盖。

本轮原生校验成功也只证明布局/质量profile；联系人自动采用、低置信/重名消歧、改名/解绑失效、helper焦点保护和CLI独立性须随后在已明确授权的测试联系人范围做真实组合。

## Root最小真实入口与检查点

先从本片最终提交构建带`--with-probe`的新签名候选包，保留源码清单digest与完整helper签名，不使用旧包冒充新诊断。下列是入口模板，具体起止与包绝对路径由Root在本轮已授权连续有限场次中提前写入目标台账；不是本子Agent已运行的命令。

```bash
cd /Users/local-user/learn/NotAlone/desktop
NOTALONE_FOREGROUND_LAYOUT_ACCEPTANCE=1 \
NOTALONE_TEST_APP_EXECUTABLE='<新候选包>/Contents/MacOS/NotAlone' \
npm run test:app -- --interactive --coordinator main-agent \
  --from '<带UTC+8偏移的本场开始ISO>' --until '<本场截止ISO>' \
  --max-launches 1 --output artifacts/goal-ocr-20261013-<run> \
  -- tests/native-foreground-layout.spec.ts
```

检查点：租约有效且只Root操作；按实际微信窗口确认已授权会话与可见区域；通过公开校准表单填写五处；pending保存后关闭说明、公开菜单校验并把微信置前；记录固定阶段、错误、9数字及有无profile，不保存名称/图帧。profile若成功检查0600/五区域/三摘要，不把它当联系人身份。任何失败保留本场失败，结束菜单退出，核对App/runner/自有probe/PID群、userData和租约；不清理未知进程。

如果返回screen_capture_permission_missing，由Root记录当前包identifier、实际helper可执行文件及父进程、触发动作和系统说明；必须用户处理的系统权限只补问该缺项，不重置TCC或自行接受。其他已授权独立任务继续。

后续原验收缺项：新包真实前台/最小区域与质量门、低置信/同名/改名/失效绑定的无生成保护、已有草稿保留/显式切换、helper获焦停视觉但CLI仍运行、最后退出停读，以及权限与签名归属。当前未认证任何一项全部完成；仅把OCR暂停条件移除，票仍claimed。
