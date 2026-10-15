# 当前v6单联系人菜单切换与辅助源结果

日期：2026-10-16。当前v6在真实微信中完成A→已知测试群→A，正式助手状态正确暂停群聊匹配并在返A后恢复已验证绑定。辅助源本场`changed=0`，以`context_changed`提前停止，不能认证事件提速。有限用例1／1、runner exit0只证明诊断生命周期正常收口，不是事件票整体验收通过。

## 本场范围与实际操作

沿用[此前v6](app-source-lifecycle-v6-20261016.md)同一签名包，ASAR SHA为`7ed7f0c34f5c059cc848c59e2e6e0bfffb72fd61680fc781be8f7a43d9c3cd27`，深度严格签名核验通过。使用现有`continuous-contact-follow-acceptance.spec.ts`的单A／manual模式，不修改该初始dirty文件；独立userData、随机隔离PG、合成CLI仅给A一条已确认绑定，正文为空。验证的是正式App对本场合成已确认绑定的跟随，不认证真实CLI账号／会话locator归属。真实名称只经端侧环境交给隔离夹具，未写入本报告或公开日志，临时夹具已回收。群只作未绑定、不支持的负对照，不算第二位真实联系人。

本轮门禁为18:03:14.393Z至18:07:14.393Z、最多1次App启动，实际约3.4分钟结束。明确设置`NOTALONE_CONTINUOUS_APP_ACCEPTANCE=1`、`NOTALONE_CONTINUOUS_MANUAL_ACCEPTANCE=1`、当前包绝对可执行路径、端侧`NOTALONE_FOLLOW_TEST_NAME_A`、私有协调目录与新`NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE`；B、visual和header-preview模式均未启用。runner的build仅生成桌面dist，未重建或修改该签名包，也未改活跃remaining8评测的73源冻结。

Computer Use端侧核对原A；打开并置顶正式助手后，通过微信原生菜单“隐藏其他”建立实际微信前台。A自动得到`verified-binding`，联系人选择及确认均匹配。随后由微信“显示→显示下一个会话”实际进入已知测试群，再由“显示→显示上一个会话”实际返回A，端侧截图分别确认；截图未持久化。没有点击确认新联系人、填写聊天输入框、复制、发送或触发生成。

群阶段正式助手AX内容为“群聊暂不支持，前台联系人匹配与新生成已暂停”，确认资格清除，原私聊内容保留；返回A后正式助手AX内容显示正确顶部名称、100%置信度及绑定确认。此前“隐藏其他”也隐藏了助手，故这里只认证正式状态与AX内容更新，不认证助手在屏幕上可见、实际绘制时间或用户体感延迟。

## 正式轮次与时间口径

393条约500ms间隔的匿名状态样本记录了A确认→群暂停→A确认：

| 动作 | 动作开始至第一个相应状态样本 | 实际结果 |
| --- | ---: | --- |
| 菜单A→测试群 | 2604ms | `paused`、微信前台、A仍被选择，但A未确认且无verified-binding |
| 菜单测试群→A | 1738ms | `confirmed`、A被选择且确认、verified-binding恢复 |

这是同机动作开始到首次轮询样本的观察上界，含调度和约500ms采样间隔；不是精确转换时刻、屏幕绘制延迟或事件收益。不能以两项数字宣称亚秒，亦不能在`changed=0`时归因于辅助事件。

正式测量65次probe-start与65次结束一一对应；全部要求single-frame，且每次capture request／completion／frame／header OCR均恰好1，测量complete与valid均为true。65条`native_status=recognized`仅表示原生返回成功且微信在前台，包含群聊，不代表65次高置信私聊身份通过。probe外层耗时中位475.830ms、P95 563.811ms、最大1545.230ms；native中位453.892ms，OCR中位216.340ms。辅助源的初始化整窗帧和局部流另计，不能把65当整个运行的总采图数；局部流实际帧数本场未记录。

## 辅助源停止与fresh proof

私有宿主诊断341行／105509字节，未到512行／256KiB上限。唯一源已完成初始布局、stream启动和合规首帧，native在50319.793ms记录`context_changed`，50321.468ms结束；宿主50330.141ms收到close，code1、signal none、paused=true、stopping=false、epochCurrent=true、renewalEligible=false。整场launch=1、changed=0，没有用周期观察冒充事件。

源PID相邻ps样本分别在实际“下一个会话”点击开始前493ms和前2ms；前者仍在、后者未见。采样及CUA调用不是原子观测，2ms低于该方法的精度，不能据此断定精确退出瞬间。它提示菜单打开／准备阶段也可能触及上下文门；本场没有记录具体OS子原因，不能认定会话名称变化或菜单本身就是原因。

close后至退出前有89次`permit_present`更新带`freshProof=true`、90条`scope_blocked`；这是更新次数，不是89份独立proof。最后一次blocked距close为111507.561ms；这段没有permit缺口，首个`permit_absent`直到退出才出现。诊断的freshProof仅表示与本源启动时的observation不同；实际年龄未保存。控制器只有在正式观察年龄小于5000ms等条件满足时才生成permit，不能把布尔值解释为某个精确年龄。

现有分支与[ADR-057](../../architecture/adr/057-header-change-triggered-foreground-observation.md)一致，尚无证据证明此处违反恢复合同：

- `HeaderChangeSource.swift:143–146`在每次上下文复验不等／不可读时停止并清detector；同文件116–125行只有完整55秒到期返回true。
- `RegionCalibration.swift:123–159`的上下文只含PID、窗口ID、frame、版本与build，不含会话名称。`read`将唯一实例、前台、版本、可见唯一窗口等resolve失败统一为nil，当前固定原因不足以区分是哪一项变化。
- `native-change-source.ts:168–174`只允许同epoch、code0、paused、未主动stop且满55秒续租；本轮code1且不足55秒，必写blockedScope。
- 同文件75–80行先检查scope_blocked，再检查proof_reused；因此新鲜正式proof不会解除同一连续scope的失败锁。46–55行只有scope发生变化（含permit消失后再出现）才清锁。
- `controller.ts:78–88`的scope是连接代际与联系人目录scopeRevision，不是当前会话名称；群阶段微信仍在前台且正式观察新鲜，未形成许可缺口。故返回A本身不承诺重启失败辅助源，周期正式观察继续，且本场确实恢复A绑定。

针对该既有合同另跑`node --test --test-name-pattern='连续失败锁' tests/header-change-source-process.test.mjs`，1／1、0skip／fail、858.606ms：真实合成子进程异常退出后，同scope新observation仍保留失败锁。该离线检查支持分支解释，不证明微信OS子原因。未松门、未加新采集／诊断、未再次启动App；若后续要定位原因，应先单独评审仅固定失败分类／匹配布尔的最小元数据诊断，不能直接改为有fresh proof就无限重启。

## 资源及收尾

独立ps共180样本、跨度89.725秒，范围如下；仅App主进程，未汇总renderer等其他进程：

| 对象 | 命中样本／PID | RSS范围（KiB） | ps CPU样本范围 |
| --- | --- | ---: | ---: |
| App主进程 | 180／1 | 128512–134640 | 0–4.3% |
| 辅助源 | 21／1 | 20416–20480 | 0.7–2.5% |
| 正式短探针 | 27／27 | 1344–19888 | 0–7.5% |

辅助源命中区间只有10.025秒，未覆盖初始化及全部50秒；正式短探针也仅命中65轮的一部分。ps百分比不是整场平均CPU，RSS不是完整峰值，不能据此宣称低耗或硬资源上界。

Agent实际点击NotAlone公开“退出 NotAlone”菜单，App正常退出；夹具认证`app-http-response`已stopped、backend exit0、databaseDropped=true、unconfirmedResources为空。独立核对精确测试库不存在、App临时userData消失，App／后端／runner／worker／采样器及采到的原生PID共34个均gone，共享租约absent；退出点击后无新probe-start。未删除或终止未知资源。微信保留在原A，系统录屏授权未新增／修改，没有输入密码。

脱敏数值原件位于忽略的`desktop/artifacts/event-follow-v6-live-20261016-3ce7ff0d-2c51-466f-8efc-fc79e6bd5f26/`：`run.log`、`host-lifecycle.jsonl`、`resource-samples.jsonl`、`run-summary.json`、动作时间、`owned-closure.json`和Playwright匿名状态／正式测量。只新增本报告；不改初始dirty、现有票据、活跃评测冻结、模型输入或生产门禁，不提交。

本场补齐真实菜单切群和单A恢复的可行性，保留辅助事件未覆盖的负结果。双真实联系人、真实来信、屏幕可见显示延迟、新TCC责任身份、总资源峰值及事件提速均未认证，事件票仍claimed。
