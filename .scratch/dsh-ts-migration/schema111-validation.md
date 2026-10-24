# 111与可信模型调用授权验证

2026-10-24。仅新增原任务租约的授权事实并装配可供主宿主使用的业务工厂，主宿主模型所有权尚未切换；05不据此签收。

## 规格与数据

原任务的五字段 claim、当前 worker／generation／有效租约、原来源和确定请求身份由 PG 核对，不信任调用方提供的额度。提取请求由原任务及窗口 batch_key 反算 UUIDv5；学习请求由原任务及持久 last_attempt_key 反算。升级／整理沿原任务和 job 额度，同事务扣计及写 receipt；本人整理不制造联系人。晚到的原预约结算不要求仍持有当前 claim。

111只保存 owner/contact/request/task/step/worker/generation/attempt 等授权元数据，不含正文或凭据。任务／步骤清理只级联授权槽，原调用 receipt 保留；联系人／本人删除沿原 scope 清除。旧110原字节未改，SHA256仍为 `50a26e310a7ef8c38f2f4ee1615d1007748b2e53d481198f736eb856e22e54ed`。

独立审查在初稿发现同 claim 换批次可再获额度：旧 Worker 每次 claim 只执行一次学习 proposal，合法新批会重新领取并增加 generation。根以实际 PG 先复现 `Missing expected rejection`，随后将学习唯一键和查找均改为 `(step_id, lease_generation)`，并比对持久 request。新 claim 的正常批次、三次已知失败及显式恢复第四次保持，累计 receipt 不清零；pending/unknown仍拒绝重放。最终 SQL SHA256为 `98ecb83f54fa0302e3cbb9c37398041d37e0985013ade6a4b66ad8757e64d079`，不沿用旧草案095ec的签审。

HostStorage严格核对111账本、新表列类型／可空性、PK／唯一键／scope FK／CASCADE／CHECK及两个原表候选键；未知版本和残缺结构关闭业务资格。两个已跟踪的桌面夹具仅提交版本hunk，既有getattr变更不属于本次。未跟踪的旧桌面脚本只更新本地计数，不整文件提交。

DSH固定 `0.2.1-rc.2 / 687f282e8625c6b8d11ff58211a90524be2e4317`；这是业务SQL/PG授权，没有新增DSH API或修改框架核心。真实官方 profile 仍作为宿主整合验证入口。

## 根实际验证与独立审查

- 新边界先红后绿；修后最小学习案例及非空110→111共11/11。
- 六个相关文件59/59、零跳过：学习工厂9，正式升级及HostStorage／只读事务／108抑制／109 receipt升级50。逐表比较既有非空业务资料、原UUID／来源／记忆版本和unknown NULL用量。
- 实际官方host-http 8/8、零跳过；严格TypeScript退出0。
- 两个独立轴分别在隔离临时树复核修后授权9/9、结构10/10及严格类型，0剩余发现；另补迁移中途失败完整回滚、任务删除保留unknown receipt、可延迟约束关闭门禁。

在 `backend-ts` 使用固定Node运行：

```sh
node --test --test-concurrency=1 test/host-model-accounting.test.mjs test/model-call-learning-claim-migration.test.mjs test/host-storage.test.mjs test/host-read-transaction.test.mjs test/auto-read-suppression-migration.test.mjs test/model-call-receipt-migration.test.mjs
node --test --test-concurrency=1 test/host-http.test.mjs
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --esModuleInterop --allowImportingTsExtensions --skipLibCheck src/host-storage.ts src/host-model-accounting.ts
```

只用随机合成 `_test` 库，退出后清理；未操作正式资料、真实模型、App／微信、打包或推送。物理Python业务接线、完整宿主恢复与生产质量门禁仍独立验收；本工厂未接入主宿主，不以组件测试冒充产品切换。
