# E2 配对教学微例工程结果（2026-10-18）

本次只在 E2 system 提示追加八个合成微例，按第三人事实／本人参与、亲属主断言／背景下完成、消息维护／未来安排、事项未知／决定未知四组配对。示例只讲局部标签，不是完整工具输出或本次来源。独立 Gold 复核无阻断；原靠近 D04 的配送示例已在实施前替换为古文字课拓印计划，未新增评测样本或修改冻结 Gold。

例四不补雕刻者、不推断使用所赠工具，也不把背景作为不必要依赖。例五两分句均为 not_memory；例六按真实分句为 prefix＋plan，保留未来计划语义。Spec 审查建议把“未来约定”改为“未来计划／安排”，已采纳，避免暗示双方已经达成约定。

## 验证与审阅

- 新 SDK 隔离用例先红后绿；最终四模块 46 项通过（0.919 秒），使用本地 MockTransport，没有真实模型调用。
- 命令：使用 NotAlone Python 环境，在 backend 下执行 `PYTHONPATH=src python -m unittest tests.unit.memory_extraction.test_e2_stable_fact_guidance tests.unit.memory_extraction.test_core_semantics_contract tests.unit.memory_extraction.test_grounded_v3_runtime tests.unit.memory_extraction.test_grounded_v4_runtime -v`。
- 两种 E2 路径均收到教学 system；user 窗口、schema 与编译结果仍来自当前来源；伪造教学依赖和自由正文被拒绝。旧 v3/v4 提示及 schema 固定值保持。
- Standards 与 Spec 独立 Agent 双轴审查无阻塞，reviewer_kind=agent。最后措辞修订后重跑 46 项通过。
- E2 最终提示 SHA-256：`837344477304319f03f770e2d94571755d5cee8b445c6f3b3c7c1eeb63fa6a52`。

## 影响与限制

工程测试证明教学送达与来源隔离，不证明分类准确率提升。既有主 16／D8 的失败和闭账保持；新行为场由指代会话独立冻结，runtime 另做运行时验证。没有改变编译器、安全门、V、Gold、原分母、生产空放行表或原票 State/AC。

仅处理合成教学和本地测试数据；无新真实联系人资料、业务写入、模型 API、桌面读取、发送或远端 Git。最初用系统 Python 计算提示摘要因缺少 langchain_core 失败，改用项目既定环境完成；没有安装依赖。公开历史检查的既有工程文档用户名路径问题继续单独记录，不为本补丁改写历史。
