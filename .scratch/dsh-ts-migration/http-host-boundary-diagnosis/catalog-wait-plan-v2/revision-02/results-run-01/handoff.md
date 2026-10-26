# v2失败交接（已清理并释放窗口）
1. revision-02原执行前manifest SHA779a1acd26d27797352f5d39960cf18a093e39f7c8020cf572e45dd6c747faf1不改。
2. 生产1e90、普通BEGIN/businessTransaction、原Q/两108参数未变。
3. 唯一流程7.391秒；首暖机index=-10在driver形状校验停止。
4. 40单位：0成功/1失败/39not_attempted；0计分观察。
5. 80计划目标执行中原Q1+EXPLAIN1均已返回，其余78未执行。
6. 错误unexpected_explain_shape，不是已证明的产品或PG执行失败。
7. probe.mjs把rowCount==1当必要条件；保存对象在校验后，保留顺序有缺陷。
8. 运行时rowCount/rows/计划均未存，Planning/Execution和cast/index信息无法恢复，保持unknown。
9. 已留存原Q envelope、warmup边界、错误及全部40计划行。
10. 不计算30样本统计，不减首轮HTTP，不作性能或根因宣称。
11. 最小待审修复：先存完整结果，再核rows/QUERY PLAN结构；当前未改冻结driver或重试。
12. 若要再执行需root另行明确授权，不自动扩展实验。
13. 自有库/会话/进程/源码及运行目录0，独立核对0，private权限违规0。
14. 窗口已归还；source/deps/input前后绑定和源码未变全部true。
15. 原始文件仅在自有私有子树；公开脱敏副本/dualSHA和保留缺口均明确。
16. 精确结果清单/SHA见manifest.json和SHA256SUMS；原计划/原7文件保持冻结。
17. 无产品/index/commit/模型/App/微信/正式矩阵，性能/25/26未批准。
