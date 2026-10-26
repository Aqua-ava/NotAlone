# catalog机制诊断最终入口

revision-03/results-run-01/report.md为新运行结果；40/40事务、80目标执行完成并清理0。revision-02/results-run-01/failure-report.md保留旧运行0成功/1失败/39未执行及缺失计划unknown。两者分母不替换。

revision-03/results-run-01/analysis.json保留30计分边界；plan-facts.json保留40实际计划事实。原始command/rowCount/rows逐文件私有保存，公开聚合/section SHA映射在raw-public-bindings.json。原计划及两次执行前manifest冻结不改；早期状态不代表当前运行状态。

精确公开候选以final-public-manifest.json为准，FINAL-SHA256SUMS覆盖全部payload及该manifest。root持有index/commit；本会话无Git写入，不批准性能或25/26。
