# 109 严格门禁联合应用准备

状态：草案已验证，产品仍为108，不能据此标记迁移或19已完成。

- 根按已有锁定DSH宿主接线继续，只修改业务结构资格门禁；DSH接口依据见incremental-sync/dsh-evidence.md和auto-read-deletion/dsh-verification.md。
- prepare.py生成六文件严格门禁/当前夹具patch，base.json记录应用前内容摘要。保留107→108旧升级测试和108中间缺口测试语义。
- validate.py在随机合成PG和临时项目执行；旧宿主先红（109文件被拒），草案15/15通过、零跳过。后补非空来源/消息/引用/拒绝候选/两代失效人工记忆，再次15/15通过，5.38秒。
- 新测试验证108→109既有合成行及UUID/来源/版本关系原样保留，新抑制表为空、不猜测回填；历史缺口、尾缺失、未知文件、超前账本、缺列拒绝及联系人级联。
- 独立Standards及Spec均0 finding，新增非空种子Spec复核亦0。仅验证列明合成资料和结构门禁，不代表全量真实资料或备份回退已验收。
- 复验命令：`"$HOME/miniconda3/envs/NotAlone/bin/python" .scratch/dsh-ts-migration/schema109-integration/validate.py`；无真实数据、模型或App。
- 联合应用须等待前置Python history_checkpoint及19 cli_sync接受计数窄修闭环，再同时落109/Python/TS/门禁；不能单边运行。使用19最终修订TS patch，不叠加前置旧TS草案。
- TS最终无损字符串时间补丁c091a734e8d1991c7244a8cfe05fe5aec87597c2befafbd9d0e188b2a31f1cf9，根独立Standards窄复核0；正式测试草案76a6726185dddeb19a3938a90cebbc1a1a0bd561c288d80351f93e38755bf5db。
