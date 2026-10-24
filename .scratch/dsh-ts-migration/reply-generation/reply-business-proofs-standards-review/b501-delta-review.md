# B5-01 cleanup-v2 窄 delta 审查

结论：冻结 v2 manifest `aaf05c47acbdae1755d620eb0f48a616c133e2350cc8d1d95cf925c7f1ecf2ac`、主测试 `e14cdf32`、delta `59009268` 尚有 2 项 P2，不签生命周期通过。原 B5-02/03 报告、B501冻结源/历史 graceful=false 与旧执行事实均未改写。

1. **[P2] 已释放的迟到响应在 after 再释放，正常业务也会清理失败。** `cleanup-fix-v2/candidate/reply-background-public.test.mjs:57` 新增 releasePending 调用；`:118` 已调用 releaseLate，而 `:51` 的闭包从未清空。正式 `backend-ts/test/reply-service-runtime-support.mjs:24` 的 sendEvents 会 setHeader 后 end。第二次设置已结束响应的 header 必然报 ERR_HTTP_HEADERS_SENT，使共享 helper 判失败、保留本应清理的 fixture。现14例只用计数 release 替身，未覆盖此顺序。应让实际 late release 一次性生效，覆盖业务／控制面／after 三处，保留其他真实错误。违反 `docs/agents/engineering.md:46` 的自有资源收尾规则。

2. **[P2] 连接数查询挂起时，自己的 PG client 不会 end。** 同文件 `:60` 在一个 closeClient 回调中先 await query 再 end；外层 deadline 仅放弃整个回调，不会执行后续 end。若 query 永不返回，清理虽有界失败，但自有客户端仍留着。现14例仅覆盖 query 立即抛错。应单独约束查询等待，保证 end 独立尝试，保留查询超时与 end 错误；未确认状态不得 dispose。依据同上。

实际验证：已有纯用例独立 **14/14，0skip**；日志 SHA `adfdfb09a385349ff1cec19e31f401d89ed9bc37adf582a04dbec0f94839942a`。两项新增最小复现均只用实际源与内存对象：实际 sendEvents／Node ServerResponse 无 socket，复现重复 release；VM 执行实际 after-hook并注入永不返回 query，确认 clientEndCalled=false。探针与日志 SHA见 `b501-input-sha256.json`；没有监听、网络请求、SDK、PG、App、微信或新业务 pair。

其余 delta：3目标与manifest、共享helper6a05逐字匹配；正式相对导入路径完整。默认0700 raw目录及显式配置逐字兼容均由既有纯用例覆盖。原业务断言差异未见变化，变更局限导入/raw初始化/control持有/after生命周期。未知Legacy、异常/强退不dispose，不新增杀未知PID，provider/control均独立尝试关闭、异常链保留。以上通过项不抵消两处已复现缺陷。原SDK/业务链未重跑，不签App、整05或25。
