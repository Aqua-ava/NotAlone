# v2 revision-02：首个暖机失败，未重试

唯一获准流程墙钟7.391秒，在第一个暖机（index=-10）结束前由driver的 `unexpected_explain_shape` 断言停止。40计划单元保留为0成功、1失败、39未执行；80计划目标catalog执行中，原Q与EXPLAIN各返回1次，其余78未执行，没有计分观察。

这是探针的结果形状断言失败，不是已证实的产品/SQL失败。`probe.mjs` 将EXPLAIN的rowCount等于1作为必要条件；该条件不是可靠的结果数组行数合同。代码又在保存完整EXPLAIN返回对象前执行断言，导致此次实际计划、实际rowCount/rows形态、Planning/Execution与cast/index信息没有留存，不能事后猜值或伪造原件。原Q envelope、两次客户端边界和全部已记录失败保留在probe-result/result JSON中。

first warmup的实际事务设置与普通BEGIN选择一致；具体值和仅此暖机的边界在failure-summary.json，不能给它计算30样本中位数、通过率改分母或外推首轮HTTP。固定顺序及EXPLAIN不覆盖parse/rewrite/正常结果输出传输的限制仍有效。

最小待审修复范围只有probe.mjs的结果保存/校验顺序：先保留完整结果元信息和计划返回值，再以rows数组及QUERY PLAN结构核验，不用rowCount作为唯一行数合同。当前冻结文件未改，没有实现后重跑或另起实验；任何后续运行须新授权。

清理与独立只读核对均为自有库/会话/进程/私有源码及运行目录0，权限违规0，已明确释放窗口。所有source/deps/input前后绑定与私有源码未变通过。原v2-01和revision-02执行前冻结件均保留，不改产品或Git index。性能和25/26仍未批准。
