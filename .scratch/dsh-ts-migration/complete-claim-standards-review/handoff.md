# Standards 核心审查交接

1. 用户要求可见独立聊天；不用sub-agent，不派新聊天。由主协调会话集成。
2. 独占目录为本目录；仅审Standards，不读另一轴报告/聊天，不改prod或共享index。
3. 基点d4e7690bd9f57a2fae66b04d348219476c0cb497；核心bcc6701ce67249d18b51625c07f4cad4e401ad04。
4. manifest SHA 88b7c4844d766f1ded51fd877ec1dab6e6d374d6983212558a9bac9e2281990f；34路径见review-scope.json。
5. 核心request_changes，唯一P2见core-report.md：Flow149-150的prepare在try外，61条合法候选由invalid_output返回变为不可重试的直接抛错。
6. overflow-probe.mjs/json用固定base与candidate独立复现；已即时告根。自己未改prod。
7. standards-probes.mjs/log三组通过；prepared隔离/Unicode/失效/receipt，真实源码闭包9项扰动，SQL/TS25项及B策略读取。
8. SQL只在最小合成表应用116；不是全库迁移、完整租约或B写入验收。随机_test库已删除。
9. sourceStamp为2e36ada0f02a44d6cf709a0cd1255f5ffeb7f5a56491e2549b0de9ce274b1b64；690文件前后相同。
10. snapshot archive SHA4790e9e4df6b0848f7dc30ffe69c70e92f4f9815ca0ddb0bb55e0d6b8eaf28ce；细节见source-verification.json。
11. Node v24.19.0；锁SHA bfcf83f9f210d5014177c08dcae98b0cd50d9b9f8a3c481794018c1fc8a92798；无activate/安装。
12. 原日志0600、私有父目录0700；公开替换$TMP_ROOT/$REPO_ROOT/$USER_HOME，绑定见log-binding.json。
13. 无真实模型/资料/原账本/App/微信/打包/共享index/commit/push/PR；用户已有3个desktop测试未碰。
14. 桌面仅npm run dev且根独占；发布需用户明确发起，勿因原生权限等自行解除门禁。
15. 最新范围只读工作树acceptance-scope-update.md；输出4096/容量与费用1.10/预算均不作阻塞，质量/来源/取消/unknown等仍有效。
16. 不改写旧4096、96/98及修复日志身份；根7/7和TSC不是本审查执行证据。
17. 先向根交核心明确结论；后续根提供修复和输出增量pin，仅审bcc之后小delta并绑定最终候选。
18. 原bcc的request_changes证据保留；不能把未收到pin的工作树当候选，也不提前签收质量/App/25/26。
19. AGENTS、workflow、engineering、domain、issue-tracker、triage已读；同会话不整读第二次。
20. CONTEXT全文已读；spec及25/26读bcc版，最新范围读工作树；README/manifest/根两证据已读。
21. domain-data读1-49/64-130/138-177/240-280；core-flows读1-56/368-404；privacy读13-50/69-108/120-174。
22. ADR002/005/007/033/046/047/085/102/104及腾讯复用说明已读；引用后续只按关键词定位。
23. 本轮纯源码业务审查无新增DSH直接接口；未调用模型、Harness或外网，不据此认证运行可用。
24. 精确清理与日志保留见cleanup.json；下一轮建新pin的独立archive，勿复用旧源码证明新候选。
