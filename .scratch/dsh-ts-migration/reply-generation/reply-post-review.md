# 05 修复后的双轴复审

2026-10-24。仅证明下述固定代码修复已复核，不证明05完整验收。审查均由独立子Agent只读执行；根运行测试，审查者没有把静态复核表述为重跑。

- 首轮全量：111文件，固定base `d409368f028cfe8a21e137902855b10f36ea4045`，快照 `notalone-05-review-4tld1_1f`。
- 回复修复：117文件中的21文件831行delta，快照 `notalone-05-post-review-agtx00a7`，完整路径/摘要见 `post-review-snapshot.json`。
- 元数据纠正：委派文字沿用旧HEAD c9cc31cb；不可变manifest实际HEAD为265bdd20。审查使用实际tree/diff及逐文件SHA，不以共享树HEAD推断内容。
- 新P1修复与fixture去重：固定快照 `notalone-05-ledger-fixed-hikx4rpn`，含delta和manifest；前置自然红证据在 `ledger-unknown-replay-audit/`。

## Standards

回复修复硬性违规0。前轮P1历史工具门禁、P2近期独立预算已闭合：预检和正式调用均停用排除状态下的历史工具；近期窗口独立限额，固定ID资格复验不裁剪。

原P3判断项 possible Duplicated Code：显选Skill测试宿主与普通service宿主90行仅插件路径不同。根已删除重复fixture，通用helper增加有真实第二调用者的pluginPath参数，显选用例复用后1/1。后续独立复审确认该判断项已闭合，无推测性扩展。

台账窄复核新增确认项0、仍存Fowler判断项0。reserve拒绝unknown/终态再次授权，pending保持原身份幂等；details保持unknown+pending=unknown，真实迟到结算和usage仍可细化。未发现scope校验或旧ledger投影被破坏。

8k估算已披露50条单字只入13条的质量影响；此静态结论不满足质量对照要求。

## Spec

回复修复新增缺陷0、范围扩张0。可信累计续写只在内部认证完整匹配时放行；官方HTTP/SSE超限回原provider_context_limit；排除消息时两阶段均不注册历史Tools。近期预算与固定ID全量复验符合core-flows:249。显选Skill通过真实registry预载，资源失败资格绑定真实运行态/同port，保存前在同事务复验。

台账窄复核新增问题0、未见范围扩张。对应05:20及spec:68–72，既有unknown与终态不再获得出站ACK；新attempt仍受unknown门禁和累计计数约束；真实迟到终态/usage可细化，旧pending/unknown不降级终态。owner/contact/request/permit与旧UUID事务投影保持。

共享host/110、Python实际SDK身份与恢复、公开桌面闭环、质量/性能和最终本地提交仍未完成；不得将两轴0作为完整05签收。

## 根的实际验证

- 回复整合：固定Node24 `node --test --test-concurrency=2 test/reply-*.test.mjs`，136/136，34.55秒。日志 `/tmp/notalone-reply-review-closed.log`。
- HTTP专项6/6：超限请求只发headers，验证正文尚未发送时已返回401/413；未吞网络错误或放宽生产限制。
- 新台账正式测试先自然红；修复后3分支加父用例4/4；模型关联 `node --test --test-concurrency=2 test/model-*.test.mjs` 32/32，2.70秒。
- fixture去重后显选Skill官方runtime/PG用例1/1；全项目 `tsc --noEmit -p backend-ts/tsconfig.json` 通过。
- 全部使用合成_test库/localhost provider，无真实模型、私人资料、App或外部发送。未操作共享索引、未提交或push。

本轮汇总：Standards确认问题0、遗留判断项0；Spec新增问题0。完整目标验收仍开放。
