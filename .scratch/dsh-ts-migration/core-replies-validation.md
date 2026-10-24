# 回复与共享模型基础组件独立验证

2026-10-24。主协调以 `efc7f680` 的 Git 已提交文件创建临时干净源码树，仅叠加 05 冻结的 112 文件清单及测试必需的 `reply-remote-rejection.patch`，复用已锁定依赖。没有把当前工作区的其他未提交源码带入验收。

- 清单及逐文件 SHA：`reply-generation/core-component-candidate.json`、`core-component-commit-files.txt`；验证前后全部一致。
- 最小 claim 传递与真实每请求轮数限制：6/6。
- 清单内全部 reply/model 相关测试（`node --test --test-concurrency=2`）：167/167，零 skip，44.41 秒。包含真实官方 profile、Agent/Skill、私有 HTTP、合成 PG、许可与台账；本批未包含离线质量报告器及后续新增的独立 erasure 测试文件。
- 干净树 Python `test_reply_remote.py`：10/10，0.27 秒。历史安装器需要的精确 patch 同批提交，避免只能依靠未跟踪文件通过测试。
- 干净树全项目 `tsc --noEmit -p tsconfig.json`：退出 0。
- 临时树退出已清理。根日志为本机 `/tmp/notalone-core-root.log` 及分阶段日志，不作为代码运行依赖。
- 提交检查另发现 `reply-service-exploration.test.mjs:33` 空白行含尾空格，只移除这一个空格，并在清单记录前后 SHA。该单文件按 `backend-ts` 工作目录复跑 1/1；首次误从仓库根运行导致 fixture 相对路径错误，未据此修改产品或测试逻辑。

05 对该固定组件的独立 Standards 与 Spec 复核均为 0 finding；旧物理台账 unknown 重放修复、实际场景轮数收紧已包含。此前检索冻结对照证据没有在本轮重新执行，不能表述为重跑。测试只使用合成数据、随机 `_test` 数据库及本机 provider，没有真实模型或外部聊天发送。

该提交只保存可复现的基础组件。新的 Python 逐 HTTP hook、可信任务预算/恢复接线、主宿主生命周期、公开业务/App、近期窗口覆盖和预注册真实质量/性能/费用仍在执行；生产回复责任尚未转移，05 不因此完成。
