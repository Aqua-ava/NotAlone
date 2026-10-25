# 分层记忆管理交接

- 状态：本切片已冻结；9 个生产／测试路径的逐文件 SHA-256 见 `manifest.json`。
- 最终验证：52/52、0失败0跳过；`npm run typecheck` 通过，原日志 SHA 见 `verification.json`。
- 新管理13项＋原 L2/L3/Worker 39项，同一冻结源码执行；没有全后端或桌面全量。
- 入口与注入签名见 `interface.md`；全部管理动作优先于旧 handler，认证仍由宿主先完成。
- `qualityInput(client,scope,versions)` 只接同期质量服务的唯一插入接口；独立质量 routes 不由本模块处理。
- `runMaintenance(signal)` 已提交后自行调用 wake/cancel；返回 `{enqueued,nextDueAt,nextDelayMs}`。
- 后台负责唯一 LISTEN／Timer 生命周期、退出 abort/drain、原 Worker 绑定；本模块不建立常驻资源。
- 两个既有 L2/L3 service 经根批准窄改，调用来源排除及原目标选择；四腾讯算法和模型层不变。
- 多批继续的 `l2_scenario_receipt_stale` 已自然复现并修复；21 条原目标可分两轮完成。
- 新增 L1 不混入原 job；变更集合继续返回409，刷新另建目标。未知调用不能换 target 绕过。
- 停用保留合法历史，删除清除派生正文及使用副本；纠错保护跨停用保留，删除开启新周期。
- 待修旧叶排除，修正后新合法叶及同范围其他资料仍可整理；有效期生效／过期持久调度。
- 管理合成库剩余0；测试进程已结束；私有日志0700/0600，没有真实库／配置／App／模型操作。
- 没有 Git 暂存、提交、push、PR 或打包；根统一集成与提交。
- Ticket25/26状态未改；宿主、质量整轮、实际App/微信、真实模型及独立审查由根统一验收。
- 超过原输入或调用上限仍失败关闭，不自动加额或自动继续暂停／失败任务。
