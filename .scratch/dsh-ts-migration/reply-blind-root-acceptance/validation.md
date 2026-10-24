# 05 离线盲评工具根验收

在主树基线43ae208f接收冻结patch f0983fe6，manifest47193775；5个新增正式路径与3个已提交只读依赖逐字节核对通过，原核心4117dea6及机械迁移的独立双轴均0 finding。未复制scratch依赖，也未修改DSH核心、运行时插件树或生产回复路径。

根在实际正式路径执行最小SDK身份拒绝1/1，再执行 `node --test backend-ts/test/reply-blind-packet.test.mjs`，26/26。纯MJS离线工具不改TS实现，本轮没有重复全量后端/App矩阵。

实际CLI命令为 `node backend-ts/experiments/build-reply-blind-packet.mjs backend-ts/test/fixtures/reply-blind-packet-pilot.json backend/tests/fixtures/fidelity/synthetic-v1.json NEW_OUTPUT_DIRECTORY`。实产2项；根目录和private目录0700、私有绑定与来源清单0600；再次执行因EEXIST拒绝且4个原文件逐字节不变，缺参用法正确，临时树已删除。首轮根脚本将状态误断言为verified，CLI自身exit0；随后仅修验收断言为verified_internal_consistency_only，再完成全部CLI检查，产品源未改。

仅处理已有本机合成假供应商夹具。可见包保留全部候选、依据、风险、分段和引用原文；原DTO摘要、身份与别名只留私有绑定。没有实际语义评分、真实供应商格式支持或质量/性能资格；外部调用、DB、App和微信操作均0。05仍claimed，其他依赖票及最终切换不变。

精确源、命令/日志SHA与CLI证明见accepted-manifest.json、cli-verification.json；源fixture原始SHA2c3c8d89保持。失败/不完整记录不能静默缩减原报告分母。仅本地提交，不打包、不推送。

最终accepted-manifest SHA256：2dafb60854794789ba59cceb106b07fb189d16edb50f4252920c8a47465aefa2
