# 候选补丁双轴审查

## Standards
独立子Agent guard_standards_review 首轮指出：每页加载全部联系人抑制历史；并发测试未证明实际等锁。已改本页精确身份unnest JOIN及pg_stat_activity advisory等待。复核：未发现新增硬规则违规或阻塞性标准问题，created_message_ids保留原位置与事件发布对齐。仅静态审查，未运行测试。

## Spec
独立子Agent guard_spec_review 首轮指出：缺原始CLI行及独立processing_records、账户级联和备份门禁测试。已补11项本票PG用例，含原始capture、混合页事件ID/时间、来源引用、提取收据、账户级联和未知时间；privacy.patch明确升级与备份限制。复核未发现新增错误或规格遗漏。仅静态审查；TS最终实现由19签收。

## 真实验证
- 原代码3项红灯（新capture历史重读、排队删除、独立自动入口）；red.log已脱敏。
- 隔离候选Python：11/11通过；既有观察存储与来源删除40项通过。
- 原受管备份10项：首次受隔离目录推断/PATH环境影响，修正测试隔离布局并给Conda PG16工具PATH后，独立10/10通过（9.1秒），没有放宽产品门禁。
- TS消费建议在临时109副本最小重放通过，删除后游标opaque_b→opaque_a，新capture规范消息数0；不代替19最终消费验证。
- 命令：Conda Python `probe.py --draft`、`probe.py --draft --related`，PG16 PATH下 `probe.py --draft --backup`，`ts-probe-runner.py`。所有库随机_test，仅清理自建库，无真实资料/模型。
- 尚未产品落盘、升级门禁签收或本地提交；Mac锁定未运行桌面、不打包、不push。

最终窄复核：历史检查点仅replace当前页message_count，保留cursor/complete/non_text且仍在created事务分支；Spec轴通过。新增全过滤/混合历史累计0→1真实red→green，维护版12/12通过。
