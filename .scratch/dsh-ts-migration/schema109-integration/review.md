# 109 严格门禁联合应用准备

状态：109已由根在联合窗口应用到工作树，相关验证通过；不代表整个迁移或19已完成。

- 根按已有锁定DSH宿主接线继续，只修改业务结构资格门禁；DSH接口依据见incremental-sync/dsh-evidence.md和auto-read-deletion/dsh-verification.md。
- prepare.py生成六文件严格门禁/当前夹具patch，base.json记录应用前内容摘要。保留107→108旧升级测试和108中间缺口测试语义。
- validate.py在随机合成PG和临时项目执行；旧宿主先红（109文件被拒），草案15/15通过、零跳过。后补非空来源/消息/引用/拒绝候选/两代失效人工记忆，再次15/15通过，5.38秒。
- 新测试验证108→109既有合成行及UUID/来源/版本关系原样保留，新抑制表为空、不猜测回填；历史缺口、尾缺失、未知文件、超前账本、缺列拒绝及联系人级联。
- 独立Standards及Spec均0 finding，新增非空种子Spec复核亦0。仅验证列明合成资料和结构门禁，不代表全量真实资料或备份回退已验收。
- 复验命令：`"$HOME/miniconda3/envs/NotAlone/bin/python" .scratch/dsh-ts-migration/schema109-integration/validate.py`；无真实数据、模型或App。
- 联合应用须等待前置Python history_checkpoint及19 cli_sync接受计数窄修闭环，再同时落109/Python/TS/门禁；不能单边运行。使用19最终修订TS patch，不叠加前置旧TS草案。
- TS最终无损字符串时间补丁c091a734e8d1991c7244a8cfe05fe5aec87597c2befafbd9d0e188b2a31f1cf9，根独立Standards窄复核0；正式测试草案76a6726185dddeb19a3938a90cebbc1a1a0bd561c288d80351f93e38755bf5db。

## 正式工作树联合验证

- 六份冻结补丁（Python/隐私、TS消费、cli_sync计数、测试fake、根门禁）先核对SHA/基线并整体check，再统一应用；新增三份正式回归，未执行真实业务库迁移。
- 根：新升级/host-storage/read-transaction/原107→108，共16/16、0skip，6.23秒；两份桌面Python夹具语法通过，无App。
- 前置会话：历史计数单例1/1→新12+正式4共16/16→原存储/删除/受管备份50/50，均0skip；独立随机测试库及managed目录已清理。命令详auto-read-deletion/verification.md。
- 19：删除抑制5/5→store/engine/recovery23/23→tsc0→实际官方profile4/4，0skip；disable61ms、revoke92ms、shutdown674ms，无迟到保存。证据incremental-sync/schema109-validation.md。
- 提交边界：根只提交109/Python保护/门禁和独立计数差异；TS整个19模块及09桌面夹具仍由各所有者归档，工作树已统一109，不把他们其他改动夹入根提交。App验收及完整迁移尚待完成。
- 根额外导出完整Git暂存树到临时目录，仅该树执行Python12+4，16/16通过（0.735秒），证明不依赖19未提交移交代码。首次验证器漏建managed目录而被备份门禁正确拒绝；仅修正临时目录配置后通过，产品门禁未放宽。随机库及目录均清理。
