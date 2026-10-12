# 联系人选择前的公开UI准备条件（2026-10-13）

Root在本目标中明确批准仅测试侧两路径叶：现有[两个窗口联系人测试](../../desktop/tests/contact-session.spec.ts)和本文。本片新增两条有界公开DOM等待，沿原合成夹具与选择动作；不修改产品、C包、严格revision门、错误处理、已有断言或诊断。下述准备阶段快照早于末尾实际场，当时本片App、模型、真实CLI／微信／OCR与发送均0。Git index与提交由Root独占。

原[最终C场](goal-final-c-acceptance-20261013.md)在helper选B后管理页仍显示A，原因仍unknown，缺当次实际提交／Main版本和拒绝回执。原测试只等helper草稿恢复、管理页A按钮的aria-pressed，再选择B；管理页既有联系人数据不证明helper已渲染其最后焦点状态。此前单场通过也不证明间歇问题已修。

本片在原helper恢复、草稿值确认后等待前台定位region内确切段落“**小窗在前台，暂停新的前台定位；已确认范围的后台同步独立运行。**”可见；保留关闭管理页、打开管理页及原A按钮断言后，在原B选择前等待同一段落的DOM计数为0。新增一个惰性locator和恰好两条await，均使用[原Playwright配置](../../desktop/playwright.config.ts)的5000ms expect期限，不覆盖场次总deadline。不使用toBeHidden把窗口隐藏当作状态完成，也不等待通用“前台定位已暂停”消失：它还可能由sync-disabled等phase产生，原状态允许继续存在。

依据：[ForegroundPanel](../../desktop/src/renderer/ForegroundPanel.tsx)第40行只按suspendedByHelperFocus显示该段落；[页面App](../../desktop/src/renderer/index.tsx)第31、42、49行让picker和定位段使用同一个foreground状态。DOM变化见证该次页面render已反映该布尔值，不认证React数字提交版本或Main最新revision。窗口show／focus和helper生命周期仍沿[AppWindows](../../desktop/src/main/windows.ts)第54–56、161–164行，原[确认控制器](../../desktop/src/main/foreground/controller.ts)第57–62行继续严格拒绝旧版本。等待后仍可能发生新的生命周期或版本变化；原B选择若被拒绝或原断言失败，继续报告失败，不catch、重选、自动retry或绕guard。等待本身超时也是失败，不能增加场次来追求通过。

精确修改前源码8950字节、SHA256 `a0fd0d14a6776e2da565cbcb665807ab60ea69fdd3b81b7c5181380e60462775`；修改后9283字节、SHA256 `3de434031284281d697d296796ecd31aa22f5ca800c50b15052ca5712c34762b`。从修改后精确移除新增locator声明与两条await，整文件与before逐字节相等，原全部测试动作、断言、state诊断与finally保持。固定的12个相关源码输入和原gap的4个测试源码另留SHA；不以本片未写C包冒充重新进行了完整包核验。

最小实际验证：在desktop执行`./node_modules/.bin/tsc --noEmit`，第一次exit0、monotonic **0.371680292秒**，无signal／spawn error。这个类型初绿不是产品red→green，不证明新UI等待实际通过。没有写镜像测试或运行App／页面／HTTP；原[公开React传输控制](goal-contact-render-gap-20261013.md)已有独立实跑，旧render精确拒绝后新的显式选择被接受，原共享7参数／3旧版本／角色／生成拒绝均通过。该历史接缝证据不代替本片真实C回归，也不证明原C根因；其首次quiet失败和两场边界继续保留，本片未重跑gap。

本片仅处理仓库公开合成测试源码、固定文字与数字摘要；未读取私人联系人／聊天／帧、凭据或供应商正文，未上传、修改业务资料或放行表。原诊断和资源清理由既有受限App入口负责，准备阶段没有创建App／浏览器、测试库或租约。新真实场由Root另行预注册，在test:app入口限定C、不启用额外Inspector见证、max1及有限时段；Playwright原有控制仍保留。该场未运行前不认证焦点、最新Main版本、稳定性、原C复现或原18／20／04验收完成。

证据根为`desktop/artifacts/goal-contact-picker-readiness-20261013-i6wbh5/`（0700），before／after源码快照、精确diff、`source-proof.json`、`typecheck.txt`及`typecheck-status.json`为0600。本文及测试源码完成后的固定两路径评审metadata将在该目录保留；准备快照时独立Spec／Standards尚待本次增审，不能沿用其他主题的0结论。Root取得两轴证据后独占本地提交，实际场次证据另附，不改历史失败或未运行记录。

## 实际C回归

准备源码经过mac Standards与Root独立Spec各0后，Root只运行一个原测试。固定场次台北2026-10-13 **07:01:23.693632–07:06:23.693632**，`test:app`、main-agent、max1，sole exec85883／coordinator PID98583。实际 **1pass／1次App、driver单调7.078829959秒、exit0**；测试6.0秒／报告6.3秒分别保留。两条公开DOM等待与原隐藏恢复、A→B→A、跨联系人清草稿、同联系人保留、最终人工确认和生成门均实际通过，没有catch后重选或额外Inspector见证。

选择后公开收据为合成index1／scope3、foreground14、manual-confirmed、suspendedByHelperFocus=false，原确认失效文案不在DOM；它是选择后的正式状态，不认证实际提交或当时Main最新数字revision。submittedReactRevisionCertified=false、原C原因unknown；一次通过不证明间歇风险消失，不代签原18／20／04完整验收。

本场C包280个regular file与14个symlink的字节、模式及目标before／after相同，deep strict签名0；60个当前模型源场前场后SHA相同，相关12输入和4个gap源也未改。App累计从283增加至**284**，普通页面Chrome2另列。没有真实模型HTTP、微信CLI／会话操作、OCR或测试消息发送，目标真实HTTP仍43、发送8、来信0、OCR0。

Root独立确认已记录App PID98638、coordinator98583与本场Python父进程均gone，唯一userData gone；新鲜`test:app:status`为absent。observed_PID_coverage_complete=false、whole_backend_PID_database_receipt_coverage=false、individual_exact_database_receipts=0，不能用入口exit0补造未记录的后端／库覆盖；未知资源未操作。首次收尾读取误把根目录相对路径用于desktop cwd而失败，正确绝对路径已核，错误不抹除，也不当产品失败。

正式证据根 `desktop/artifacts/goal-contact-picker-ready-real-20261013-c/` 为0700、文件0600：`session-plan.json`、`runner-{owned,terminal}.json`、`runner.log`、`package-{before,after}.json`、`immediate-terminal-check.json`、`root-owned-resource-check.json`及原结果下的owned／selection／合成截图。资源收据SHA `8bfc6aacdd9ceb90c74cb70e12278ab6d12bebf3c71bd889b70e7519cabd09d9`；原三源短冻结已在真正终态后解除。实际结果文案尚须本次独立增审后按两路径本地提交，保留准备快照与全部失败边界，不再启动此片App。
