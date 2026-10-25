# L3 内容时间与租约时间分离修复

基点：`e60074b5946b8d1c990fcb75ba13bd58f789b2fb`。

原始最小复现先由 L3 `prepare` 和 `requireCurrent` 通过，再被真实 PG 模型预约以 `model_accounting_work_ambiguous` 拒绝；诊断明确无运行中的 L2 批次，L3 租约对真实时间过期、对内容时间有效。单例重复得到相同结果。随后分三个垂直切片完成 RED→GREEN：创建租约、过期校验、过期重新领取。

## 修改

生产只修改 `backend-ts/src/l3-profile-service.ts`，增加私有真实时间函数 `operationalNow`：工作租约创建与重新领取、当前批次期限校验、已有批次是否仍被占用都使用它。公开 options 不增加字段，默认真实时间、300秒默认租期、900秒上限及两次尝试上限保持既有行为。既有后台步骤租约继续由 PG `clock_timestamp()` 校验。

逐一核验原有17处 `this.now()`：原当前批次期限校验改为 operational；其余16处内容用途保留，包括3处记忆有效期过滤，以及资料、代次与状态的创建／更新时间（其中 prepare 局部 now 同时用于多个资料写入）。不修改 ModelHost、物理预算、数据库时钟、全局 Date、HTTP、环境配置或产品界面。

新增 `backend-ts/test/l3-operational-clock.test.mjs`，通过公开 L3 与真实 HostModelAccounting 接口覆盖：过去／未来内容时间、真实租约过期、重新领取与旧token失效、任务取消、步骤过期、claim／settings／organization代次变化、停用；完整提案、独立核验、模型预约结算及发布后，资料仍按固定 `as_of` 过滤且公开发布时间保持同值；未注入内容时间时默认真实时间。

## 验证

- 最小原始 RED 1项失败；创建时间修复后同一用例1项通过。
- 过期期限 RED 1项失败；校验修复后同一用例1项通过。
- 过期重新领取 RED 1项失败；重入检查修复后同一用例1项通过。
- 新测试12/12通过；相关L3、记账、ModelHost与Worker模块共71/71通过，0跳过。
- TypeScript `--noEmit` 通过；精确命令、退出码、输出及原始SHA见 `verification.json` 与 `redacted-evidence.log`。
- Standards与Spec两轴串行自查均无发现；按任务“不委派”约束，未启动独立审查Agent。

## 数据与清理

仅随机合成PG库及既有测试的临时合成配置；未读根 `.env` 或真实资料，无真实供应商请求、外部消息、实际App／微信操作。没有全量测试、打包或远端操作。

本任务专用 `notalone_l3_clock_*_test` 库剩余0，测试退出钩子删除本轮合成库与临时目录；没有常驻服务。原始日志与基线源码留在仓库外端侧目录，目录0700、全部文件0600；公开日志移除仓库与个人目录绝对路径并保留原始SHA。没有生成App、运行时副本或emit编译缓存。仓库原有及其他协作改动保持独立，Git index及commit留给主协调。

本证据只认证该Bug的合成行为；实际App、微信、真实模型和Ticket25整体验收保持原有边界。
