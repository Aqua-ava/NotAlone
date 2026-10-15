# ADR-057：顶部局部变化提示优先触发正式前台观察

> 状态：已采纳设计；实现及合成验证不证明实际窗口裁剪、资源或速度，正式包实机另验
> 决策日期：2026-10-15
> 局部修订：ADR-050 的仅正式轮次采图约定，以及 ADR-053 对常驻辅助采集进程的排除；原正式观察单帧、身份和五秒时效保持。

AX 有限实机中七类注册通过，但没有覆盖用户实际微信内部切聊，不能将返回微信的激活通知冒充会话切换。用户已授权顶部区域变化检测作为后续来源。选择增加一个独立、有界、只作变化提示的本地辅助源，正常等待时可提前调用原认证 `/api/sync/foreground/observe`。事件不携带身份，不能直接选择联系人、延长旧名称时效或授予生成资格。

辅助源只在已确认同步总开关开启、连接代际和联系人目录范围有效、助手未获焦且最近正式观察确认微信在前台时启动。它先取得当前前台唯一微信窗口的一张内存帧，复用可拒绝布局定位；之后仅捕获该窗口内部的顶部名称矩形，以最多4Hz比较相邻局部亮度像素，不OCR、不保存帧、摘要、坐标或名称，不读取正文或其他App。初始布局帧和局部变化帧与正式观察分开计量，不能继续宣称整个运行过程只有正式观察的单帧。原正式观察仍各自取得一帧，经名称质量、唯一私聊及已有绑定验证。

Apple文档指出独立单窗口捕获忽略 `sourceRect`，因此禁止以 `desktopIndependentWindow` 加裁剪参数声称局部采集。改用 `SCContentFilter(display:including:[唯一目标窗口])`，排除桌面、Dock和其他窗口，并设置display stream的 `sourceRect`。首版仅支持窗口完整位于原点为(0,0)显示器的情况，不猜测多屏、跨屏或离屏坐标；尺寸异常、布局未知或上下文变化停止源，仍由原有周期观察尝试恢复。编译和合成坐标测试不能证明真实系统按预期裁剪，须正式包实机验证。

每个连接只持有一个自有辅助子进程。固定参数入口最长60秒，最多240次局部像素比较；宿主有独立生命周期兜底，终止后必须确认退出才能启动下一源。启动环境不继承秘密；JSONL只允许固定 `changed` / `paused` 枚举，拒绝迟到、未知和超限输出。正常到期可在新鲜正式观察仍满足启动条件后续租；失败或提前暂停在同一连续许可内锁住，不因每两秒复验循环重启、重复初始整窗截图。进入助手、失焦/上下文变化、关闭开始、状态未知、断连、范围变化和退出即停止并丢缓冲及待处理事件。

正常空等收到变化立即开始原观察；一轮在途最多合并一个待观察提示。真实技术失败或繁忙仍执行原4／8秒退避，事件风暴不能绕过。旧代际、暂停和停止清除合并提示。保留有限周期复验，以发现微信返回、漏提示和维护原五秒名称时效；不通过刷新旧时间戳伪造观察。代价是额外局部采集、初始布局帧和有限进程开销，收益须由同版正式包的真实延迟与资源记录证明，不预先承诺亚秒或低耗。

一手接口依据：Apple [`sourceRect`](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/sourcerect)、[`minimumFrameInterval`](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/minimumframeinterval)、[`SCContentFilter(display:including:)`](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(display:including:)) 与本机macOS15.5 SDK `SCStream.h`。Context7当前没有可调用工具，直接核对官方Markdown与锁定SDK；文档只证明接口约定。
