# 窗口恢复与观察预算修复验收

2026-10-15，Agent直接使用Computer Use操作真实微信及隔离正式包。结论：本票移动／缩放恢复、繁忙分类与有界超时修复完成；原持续跟随18/06的双联系人、真实CLI及候选归属等完整范围没有据此关闭。

## 根因与修复

1. 认证观察接口在后台同步持锁时返回409 `foreground_observation_busy`，原桌面端压成`observation_unavailable`并打开永久人工门。只对可信客户端的响应类型、409及精确繁忙码保留可重试分类；当轮清名、撤销生成资格，下一轮重新验证可靠已有绑定。此前低分、歧义、真实超时等人工门不解除。
2. 原探针900ms、后端1.3秒、UI1.5秒预算会截断有效慢单帧或传输交付。修订为2.5／3.2／3.5秒；五秒采集新鲜度、单轮在途、锁200ms及CLI元数据250ms不变。真实挂起仍终止并进入人工门。
3. 复验中发现小屏窄窗的正文气泡边缘覆盖聊天区过半，旧亮度中位数错误竞争顶部边界。改用21点下四分位，至少16点支持；45–110pt内仍要求唯一边界，名称裁剪保持12–48pt，不OCR正文，不宽免未知布局失败。

决策与边界见[ADR-056](../../architecture/adr/056-foreground-busy-and-observation-budget.md)。

## 实机场次与结果

全部UI动作使用`cua_repl`；runner只启动正式包、提供隔离真实HTTP/PG和合成CLI，以及被动记录匿名状态。未使用脚本控制微信，未发送消息或调用模型。Computer Use画面只在端侧查看，未另存或提交截图、私人名称或正文。

- 初版仅增加预算的现场约8.8分钟：捕获到409繁忙后永久人工门，后续后端已返回confirmed但桌面仍manual-required，确定分类缺陷；正常退出及清理。
- 第二版一场约2.9分钟后App关闭，采样抛错，runner退出2并保留租约；该场不计整体验收通过。没有证据确定退出原因。核对已知App／worker／后端均缺席、userData删除、随机库删除确认后精确释放本轮租约。随后改进测试夹具：立即处理采样拒绝，并将匿名诊断保留到本轮协调目录。CUA状态查询在实例退场后曾启动额外未配置窗口，均通过公开菜单退出，没有连接业务库。
- 第二版重跑约12.1分钟：繁忙及窗口上下文变化后均重新恢复绑定；一次带草稿的409到confirmed约5.2秒。随后在较小屏幕的真实窄窗持续出现`automatic_layout_header_boundary`，没有放开人工门，正常结束失败现场并补布局修复。
- 最终第三版约19:35–19:45，1次启动，10.7分钟，正常退出。重验同一先前失败的小屏窄窗、右侧平铺、原生缩放及还原、居中移动、助手暂停／返回微信，以及合成草稿保留，均通过，未点“确认本次联系人”。

| 最终包实际操作 | 结果 |
| --- | --- |
| 保持先前失败的小屏窄窗 | 正式名称100%，唯一已有绑定自动确认，无布局失败 |
| 输入15字合成草稿后右侧平铺 | confirmed、选中与确认均为测试A、草稿完全一致 |
| 原生缩放窗口、再还原 | 均自动恢复已有绑定及生成资格，草稿一致 |
| 居中移动 | 新鲜绑定恢复，草稿一致；变化帧仍拒绝 |
| 打开正式助手、隐藏后回微信 | 助手获焦暂停，返回后识别恢复；最后在助手逐字核对草稿 |

最终场被动样本1014份：confirmed531、paused465、unavailable18，无manual-required；其中425份同时处于confirmed、A归属一致且草稿一致。208次后端观察中，技术失败仅有1次采集上下文变化及1次409繁忙，无布局失败或探针超时；最大完整接口耗时约649ms。上下文变化后约5.2秒重新取得可靠绑定。末尾409后进入助手／非微信暂停并结束，未把该次算作繁忙后再次绑定；繁忙恢复证据来自第二版相同ASAR及真实HTTP回归。样本和状态更新次数不是独立场景次数。

Agent通过可视清单记录6项符合：名称、移动、缩放、助手暂停、回微信及草稿。最终包没有重新验收群聊、A/B切换或候选归属；前一版的群聊暂停／返回及既有群聊验收证据分别保留，不冒充最终包全功能通过。

## 构建与命令

最终包位于`desktop/artifacts/window-recovery-fix-20261015-v3/NotAlone-darwin-arm64/NotAlone.app`，构建与运行前后严格签名验证通过。ASAR与第二版相同；第三版更新原生核心库。

- ASAR SHA-256：`cc42e94e49cd3c85c45e72bb3ecbe771a9244a4c9d48051584ded74150e57c58`
- 探针 SHA-256：`0cc44130a6f6be42c284587402db4d12139e4127a0167bd8c6fe4dac2294d7ae`
- 核心库 SHA-256：`5175e91172f0cbe3122e90bd64d56d570be9923ef517665b1d3c9e80ff746626`

先激活Conda `NotAlone`，实际运行：

- `node --test --test-concurrency=1 tests/continuous-contact-follow-http.test.mjs tests/single-frame-foreground-http.test.mjs tests/group-foreground-pause-http.test.mjs tests/foreground-observation-budget-http.test.mjs`：13/13通过，生产控制器→认证HTTP→随机PG，仅探针／CLI进程边界合成；不运行实际App。
- `python -m unittest tests.unit.front_sync.test_probe_adapter tests.unit.server.test_sync_host -q`：44/44通过。中间误加不存在的`test_foreground_locator`模块曾失败，不计通过；正确模块重跑通过。
- `npm test`：类型及63/63安全检查通过；不运行实际App或微信。
- `swift test --package-path native/macos`：91项，89通过、2项条件跳过；新增负例后`--filter HeaderBannerLayoutTests`：4/4通过。
- `npm run package -- --with-probe --output-directory <上述版本输出目录> --electron-zip-directory <既有本机Electron缓存>`，三版独立输出，未覆盖旧包；`codesign --verify --deep --strict <最终App>`通过。
- `node scripts/test-app.mjs --interactive --coordinator cua-window-recovery --from <本轮ISO> --until <20分钟截止ISO> --max-launches 1 -- tests/foreground-window-recovery-acceptance.spec.ts --output artifacts/cua-window-recovery-20261015-v5`：1/1，10.7分钟，exit0。显式开关`NOTALONE_WINDOW_RECOVERY_ACCEPTANCE=1`，正式包由`NOTALONE_TEST_APP_EXECUTABLE`指定，协调目录为本轮私有临时目录。

新回归先后取得慢探针、旧UI交付预算及繁忙分类的red；修复后green。窄窗合成正例在四种明暗／缩放组合均先失败且未调用OCR，修复后通过；缺边、多个整宽边界及范围外边界仍不调用OCR。挂起5秒的合成探针仍有限超时，后续繁忙与可靠名称不能静默解除其人工门。

## Standards

独立审查：0项硬违例，0项需处理的判断性异味。新增窄窗和夹具异常收尾增量复核均0项问题；未将既有measurement改动归入本任务。

## Spec

独立审查：缺失／部分0、超范围0、实现错误0。窄窗增量保持唯一边界与顶部裁剪，未扩大自动恢复错误范围。两轴以固定基线`97c12ced`的本任务文件快照审查，后续增量单独复核；实机结论来自上述实际操作。

## 数据、清理与限制

没有新增权限、TCC修改、数据表、业务数据迁移、持久化视觉帧、外部连接或发送能力。构建包含工作区既有原生匿名measurement代码，未修改或提交其原有差异；其他任务的工作区改动保留。

最终App exit0、认证HTTP stopped、后端exit0；随机测试库删除确认，未确认资源为空。已知自有App／worker／后端均缺席，userData删除，runner exit0且租约absent。微信保留在测试私聊、缩放还原并居中，已执行“显示全部”恢复其他应用可见；本轮自有协调目录在保存匿名报告后精确清理。

本轮证明已测试窗口与单联系人恢复，不承诺所有窗口布局／版本均可用，也不认证真实CLI正文同步、双联系人切换、模型质量或完整18/06。真实超时和身份不确定时仍须人工确认。
