# 真实微信开发验收与原生限制

代码固定在 `a268f20603477dcc22e88f30f3c0688c88c58ff6`，复用已创建、源文件干净的隔离工作树，只运行 `npm run dev`。官方 DSH 为 `0.2.1-rc.2`／`687f282e8625c6b8d11ff58211a90524be2e4317`；没有替换为假 Harness 或修改核心。

## 本轮范围与数据

用户明确指定一个测试私聊，仅授权后的新消息、本机验证、不调用外部模型、不发送消息。真实名称、账号与稳定渠道身份只在本机临时范围文件及随机 `_test` 数据库使用，未写入本记录。没有读取正式关系资料库或项目真实 `.env`。

真实 CLI 的固定构建身份与元数据查询边界见[审计](foreground-location/real-cli-read-boundary-audit.md)。当前工具版本／commit 及 SHA 已实际核对；只读名单得到唯一匹配，随后通过 `BindingService` 在新测试库确认绑定，写本次 baseline。初态为一个联系人、一个 active 绑定、selected、无旧 cursor、历史授权零、同步关闭。

App 子环境仅继承必要系统字段，使用新建测试配置与数据库，未继承模型凭据。正式 UI 中明确选择「暂不读取」，数据库决定为 `declined`，绑定级历史授权始终为零。

## 自动与实际 App 证据

- 时间边界窄修 `a268f206`：微秒／毫秒反例先红后绿；隔离 PG 29/29、零跳过、类型检查通过。随后在该提交上运行官方 profile 增量焦点：1/1、零跳过、3676ms，隔离类型检查通过。详见[时间边界](incremental-sync/new-only-boundary-validation.md)。
- Computer Use 打开实际管理后台：联系人一个、消息零、同步暂停；同步页确认 selected 与历史关闭，再开启。公开状态返回 active、一个绑定、无同步错误。
- Python 会启用 TS 的全局会话变化流。该流扫描账号会话的元数据，正文仍由有效绑定限定；不能表述为「只看目标会话的元数据」。固定源码与补丁的无摘要／无正文闭包见[follow 审计](incremental-sync/real-follow-read-boundary-audit.md)。实际稳定流子进程的父进程是 TS，参数含严格只读，不含历史。
- 微信不在前台时，后台同步仍为 active。关闭总开关后，UI 与公开状态均为 disabled，流不活动；实际 TS／Python 子进程下未发现 CLI 读进程。关闭状态的正式前台观察返回 `paused/sync_disabled`，联系人及绑定均为 null。
- 再开启后正常退出：UI 先显示「正在停读」，npm 退出 0；原宿主、Python、npm 进程组均消失，握手和生命周期锁消失。退出停止进程，但保留用户已开启的设置。
- 复用同一库及用户目录重启：原绑定 UUID、原 baseline、selected、declined 均不变；原开关为开启，因此恢复该范围的后台同步。Computer Use 再关闭，读进程消失；再次正常退出，npm 退出 0，重启进程组消失。

状态阶段原始脱敏字段见[结构化证据](real-wechat-state-evidence.json)。操作脚本为[主夹具](real-wechat-app-session.mjs)、[同库重启](restart-real-wechat-app.mjs)、[脱敏状态检查](real-wechat-state-probe.mjs)。主夹具在删除前检查实际 Electron 及自有进程组、握手和锁；未知运行状态保留现场，既有元数据不归本轮删除。

## 尚未通过的项目

**真实新消息入库尚未观察到。** 本轮测试期间没有新消息，最终消息数零；范围外消息、baseline 前消息、回复请求、外发调用均为零。这能证明本轮状态、停读和隔离结果，不能冒充真实新消息从微信到数据库的正向验收。已有合成官方 profile 与实际 App 的正向消息证据仍单独保留。

**首次历史提示曾有状态回执缺口。** 实际 UI 在 decline 后立即 enable 的一次观察重新显示历史询问，之后刷新恢复 declined；数据库一直 declined、历史授权零。已在全新合成官方 profile 自然复现，并以 `c9cc31cb` 修复旧缓存回执；根复核专项 2/2 及相关 16 例通过。后续以合成资料运行真实开发 App，Computer Use 复验拒绝、立即开启、刷新、关闭均保留拒绝状态，见[独立验证](history-status-validation.md)。没有通过点击允许或改写库隐藏问题。

**真实原生 OCR 仍失败。** 仅在内存裁出 UI 顶部核对指定标题，未保存／输出正文画面。用户将窗口置前后，正式原生 worker ready 正常、采集约 0.12 秒完成，随后卡在 `headerOcrStarted`，2500ms 无回执并回收进程。纯合成名称图也失败；后台线程、HOME、TMPDIR 单变量均未解决。默认与设置 CPU 的采样进程堆栈均指向 Vision/TextRecognition 的 ANE 模型编译 XPC 等待；另一进程的 CPU 读回确认对照仍超时，但该进程未取堆栈。单次 30 秒合成诊断亦未返回；公开支持固定中英准确模式的 revision 2、3 对照也均超时。

此结果尚不能证明系统服务永久故障，也没有可通过的产品修复。没有重启／结束系统服务、改变权限、提高产品时间预算、降低识别质量或修改 DSH。详见[原生诊断](foreground-location/native-ocr-diagnosis-conclusion.md)及[实际原生反馈环](foreground-location/verify-real-native.py)。21 不据此签收。

## 清理

两轮开发实例均正常退出；主夹具退出 0。独立核对：测试库不存在、测试用户目录及夹具目录不存在、私有范围目录不存在、会话元数据不存在，`development-status` 为 stopped、PID 空。共享合成 PG 保留给其他迁移任务；受保护的隔离工作树保留，仅含已提交源码与开发缓存。未打包、推送或发送聊天。
