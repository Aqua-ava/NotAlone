# 业务事务错误合同交接

1. 基点 e60074b5946b8d1c990fcb75ba13bd58f789b2fb；源合同修复完成，由 root 提交，未动 index/commit。
2. 独占源码 backend-ts/src/host-storage.ts:18、:186；仅 +30/-2。
3. 新测试 backend-ts/test/business-transaction-errors.test.mjs，最终 12/12。
4. 源码 SHA：a0b61732130987ce1f2a5cbad028b7180c144ed915a9e24ec6ab1965b3968203。
5. 测试 SHA：c8481e3b6dcbd02d100c0b4b92dee7679ba60602a39abfbc7b3a62f5cea10ccc。
6. fix.patch 精确包含上述两文件；反向 apply --check 和空白检查通过。
7. NotFound 保留原对象且前置写入全回滚；按 query 抛错来源维持数据库边界，无 message 分类。
8. Promise/回调/同步 query、只读、连接、提交失败、取消和关闭均覆盖。
9. localhost 公开审批经生产 Skill stores/HostStorage：缺失 comparison 返回 404/not_found。
10. 草稿仍 pending/revision1；冻结目标、启用 Skill v1、正文和版本数不变；未知错误仅 internal_error。
11. 合成 unknown 原记录不变；迟到 pending 不解除门禁，无重发授权或补造用量。
12. 基点同一 HTTP 测试 500≠404 RED；源码原字节和适配 SHA 见 baseline-repro.json。
13. 最终相关存储/Skill 28/28、相邻 HTTP 11/11，均 0 skip；typecheck 退出 0。
14. 最终组共 51 个测试；无全量；完整命令和原始日志 SHA 见 commands.json。
15. Standards/Spec 自审无发现；遵从不委派，非独立 Agent 审查。
16. 数据仅合成 PG/Skill/localhost；无真实配置、资料、供应商、App、微信或消息发送。
17. teardown 全通过；自有客户端/pool/server/随机数据库/临时目录已清理。
18. 原日志仓库外 0700/0600；复现链接和临时 harness 已清；公开证据脱敏。
19. Skill HTTP 真正数据库故障仍沿既有 500/internal_error，未越界改其他 HTTP 的 503 策略。
20. 协调期间 HEAD 已推进 dbc59a6b78dadbfd10e24d354e46c5ed665da0a4，其 host-storage 与输入基点相同。
21. root 下一步：仅提交本任务代码与所需证据，执行提交后公开历史检查，按需 pin 新提交复验原 driver。
22. 不据此签收 Ticket25；没有打包、push 或 PR。
