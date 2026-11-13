# v9 Tab30 与自然 tail 的一次时窗对照计划

2026-10-16，仅完成只读调度核对与本计划；未恢复依赖、创建 scope／租约、启动 App 或运行测试。先等当前记忆场及 `b251dacd-ca34-49e2-9cfb-510f070b508f` cap1 实际场均结束、资源关闭，再由 Root 另行明确授权唯一新场。不得自动启动或失败后另开场次。

[前次 Tab 对照](../foreground-contact-follow/real-cli-visual-v9-tab-control-20261016.md)与[Tab40 对照](../foreground-contact-follow/real-cli-visual-v9-tab40-20261016.md)在各自原实例均未发出 Tab；后者实际工具拒绝 `durationMs:40000`，给出上限 `30000`。旧失败、额外实例及各自收尾证据保留。本计划只尝试一次尚未执行的同 call `Tab30000`，不保证按键能维持原生焦点。

## 调度依据与限制

- [BindingFixture](../../desktop/tests/binding-backend-fixture.ts#L48)实际以 `--sync-interval 60` 启动后端。[SyncHost](../../backend/src/notalone/server/sync_host.py#L473)在上一 cycle 收尾后等待60秒再取锁；不是固定墙钟的每60秒一次。当前视觉用例只开启普通同步，没有开启将心跳改成0.25秒的 follow-smoke。
- [后台引擎](../../backend/src/notalone/front_sync/cli_sync.py#L825)初始化后按队列／事件及15秒安全对账门限决定是否读取；优先联系人3秒门限和全局流 `poll_interval="3s"` 都不会独立唤醒这个60秒宿主。单联系人、同步保持开启且无额外控制时，下一自然 cycle 有再次 tail 的合理机会，仍可能因错误、暂停、锁或持久化状态跳过。
- [范围守卫](../../desktop/tests/fixtures/real-sync-python.py#L266)在真实 tail 返回、freshness及授权内容核验后写 `accepted`，随后才返回后台引擎继续处理。其审计没有事件时间戳，`accepted`不等于 cycle 已结束；后续DB／状态缓存、锁等待和下一真实CLI耗时均未定，CLI本身还有30秒上限。因此不能从一次 accepted 推导下一次精确开始／结束时间。

只读首次看见一个新自然 tail accepted 的本地时刻记为 `t0`。理想低延迟下，下一个自然 tail 约在 `t0+60秒+本轮剩余处理`，Root约 `t0+45秒`开始一次菜单／AX／Tab30操作，可提供约45–75秒附近的机会窗口。实际窗口还受观察延迟、CUA菜单／AX耗时及CLI耗时影响，**仅为预期重叠，不保证下一tail完整落入，也不保证首次原生获焦早于该tail开始**。

## 获另行授权后的唯一操作

1. 使用同冻结v9、现有 `real-sync-visual-independence-acceptance.spec.ts` 和原单联系人 immutable fields；新8分钟／max1、新鲜baseline、incoming=false／longrunning=false、独立userData／随机测试库。Conda及禁dotenv，重核包ASAR／strict、默认目录前值、占用与租约；如需外置pair，只在该次授权后按原已核官方字节另立归属账恢复。现在不创建这些资源。
2. 微信正向仍由原25秒门决定。进入 `waiting-trigger/helper` 后固定当前自有CLI审计行边界，只读等待随后一个新 `tail` 的完整 `started(实际正PID)→finished(同PID、returncode0)→accepted`；reserved无PID不计。只记录首次观察的本地时间、行边界和固定元数据，不读取CLI输出正文或私有scope字段。`t0`不补作实际CLI事件时间，不使用已存在的accepted或文件mtime代替它。
3. 不调用立即检查、follow-smoke/start、任何额外产品API，不制造来信或发送，不变更同步／绑定，也不修改fixture调度。只有一个`t0`，不因错过窗口反复择点。若没有新完整自然tail、归属／append证据不明，或余时不足以覆盖45秒等待、原helper70秒、Finder70秒及15秒收尾，则停止本次尝试并如实记缺口，不延长租约或另启场次。
4. 约`t0+45秒`，Root先核同runId／App PID存活、当前stage仍为helper、租约与scope尚有效，再以现有协议写 `helper.trigger`：内容为该coordinator runId、无换行，不能误用leaseId。此信号只协调操作，不认证前台或焦点。Root紧接同一次CUA调用动态读取公开菜单，点击“窗口→输入小窗”，读取同小窗AX，然后 `pressKey('Tab', {durationMs:30000})`。该次 `mcp__cua_repl.js` 显式设置 `timeout_ms:60000`，覆盖菜单／AX及30秒按键的整次工具调用；不延长Tab30、原helper70秒、scope或租约预算。Tab只导航，不按Enter／Space，不编辑、生成、发送或重做物理快捷键。
5. CUA调用末尾不再AX／getApp。先由控制侧只读原PID与既有stage／runner结果；原实例已退出就停止GUI，不以刷新工具重启。如出现明确仍存活的自有额外实例，先单列exact可执行路径／PID／启动时间，再由Root正常菜单退出，不接回原case。仅原实例仍存活且原用例实际到达Finder阶段时，才沿既有Finder操作继续。

[原helper gate](../../desktop/tests/real-sync-visual-independence-acceptance.spec.ts#L93)不改：首次实际 `isFocused()`固定边界及CLI行checkpoint，70秒总窗仍从trigger收到时计算；固定后任何新正式probe即原判失败，失焦不重置。只有原生focus、边界后完整新tail及末次focus等原条件都通过才继续。Tab完成、AX focused、零采集、旧tail或本地观察文件都不能单独签通过；最坏仍保留原失败，无自动后继。

结束核原App／backend／CLI／runner、准确随机PG、userData、fixture、租约、自有空Finder与依赖pair，正常菜单退出和失败fixture回收分账。原始私有产物不提交；报告不存联系人身份、locator、聊天、key、token或截图。没有模型、新权限、第二联系人或来信扩权。

## 只读源码基线

冻结v9 ASAR仍以 `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021` 为未来启动前核验值；本计划不重包、换签或认证整个live源码等同v9。以下六份当前源码仅计算SHA，均无本计划改动；原阶段边界spec与已审`5880e115`相同。后续任一摘要不符即停并重新核准备，不临时回退；不编辑当前记忆93份冻结源。

| 文件 | SHA256 |
| --- | --- |
| `desktop/tests/real-sync-visual-independence-acceptance.spec.ts` | `bf8b98c232a7aaf375be9a705f8504a8186991bec4824d0b5f2972ff97738de8` |
| `desktop/tests/real-sync-quit-fixture.ts` | `4ff433443b35f58e5a696d191986110ff7ac5ea52a53c8aa52d9503ea60fb076` |
| `desktop/tests/binding-backend-fixture.ts` | `c6ddcf5ec2c99e31ff7251dc3886138a09fd6503bed0b4d1d00d7c97470d43c4` |
| `desktop/tests/fixtures/real-sync-python.py` | `f7fd4904964ea442993d19180367de604c3c2f1a85621defdc5fa9e4abbba657` |
| `backend/src/notalone/server/sync_host.py` | `da37a8c517e97d341d53398b0a4f16c621b7f168af7d3f18c1be2c020892cc6f` |
| `backend/src/notalone/front_sync/cli_sync.py` | `92fbaf896ff2590debf221d2956bea17ce81f563acc76c2aac166572f069f4f9` |
