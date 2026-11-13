# 01 单张图片请求失败的复现与根因取证

Triage: ready-for-agent
State: resolved
Type: research

- 范围：不改产品代码，用离线脚本回答"为什么 TRANSPORT 失败"。
- 做法：见 spec 阶段 0。对同一张失败图对照原 PNG／JPEG 85／长边 1536／1024，以及同一请求带 1/2/3 张；记录是否 TRANSPORT、失败耗时、底层 cause；验证 keep-alive 复用假设。
- 前置：用户授权使用模型密钥，把该图内容发给模型服务一次（外部连接须有明确范围）。
- 依据与约束：先按 `docs/agents/dsh-development.md` 核对 DSH 版本与源码（`lib/index.js:2156` 附近的 TRANSPORT 映射）；不臆造 API。
- 完成条件（`## Answer`）：根因三选一（内容／尺寸、体积、连接层）及各变体的实测表；给出阶段 1 的参数建议。
- 阻塞：issue 02、03 依赖本结论。

## Comments

## Answer

根因三选一：**体积触发，发生于本地重编码后单张超预算**。授权图原始 2,043,188B，整改前 `ModelImageAttachments.withImages` 重编码附件为 3,131,712B；`readImageRequest` 再缩放到 1124×1498 PNG，仍为 2,832,863B，超过官方目标 2,097,152B。该处普通 Error 被锁定 DSH 的 `lib/index.js:2156` 包装为 TRANSPORT，尚未发送 HTTP。

已运行 `node .scratch/image-model-input-reliability/scratchpad/repro-local-image-budget.mjs`，使用纯合成图、真实 `ModelImageAttachments` 与官方 `DeepSeekAdapter`，断言 TRANSPORT、cause 为 `extraction_model_image_budget_exceeded`、fetchCount=0、prepareExtensionsCount=0，全部通过；没有外部调用。独立 Agent 已复核因果链。

已运行 `node --experimental-strip-types .scratch/image-model-input-reliability/scratchpad/stage0.mts`，真实等价 Messages 请求绑定同一私有诊断总账，8次预留、8次发送、无自动重试。仅使用指定图及其变体/重复副本；固定短指令、max_tokens=32、thinking=disabled，不发送聊天正文。下表均为 HTTP 200 且收到完整 message_stop；无 TRANSPORT 或底层 cause。

| 版本 | 张数 | 连接 | 尺寸 | 单图字节 | 请求字节 | 耗时ms |
| --- | --- | --- | --- | --- | --- | --- |
| 原 PNG | 1 | 新进程 fetch | 1280×1706 | 2,043,188 | 2,724,563 | 5794 |
| 原 PNG | 1 | 新 TLS | 1280×1706 | 2,043,188 | 2,724,563 | 5438 |
| JPEG85 | 1 | fetch | 1280×1706 | 228,605 | 305,120 | 1812 |
| PNG1536 | 1 | fetch | 1152×1536 | 2,947,715 | 3,930,599 | 9993 |
| PNG1024 | 1 | fetch | 768×1024 | 1,477,360 | 1,970,127 | 5314 |
| JPEG85 | 1 | 新 TLS | 1280×1706 | 228,605 | 305,120 | 1838 |
| 原 PNG | 2 | fetch | 1280×1706 | 2,043,188 | 5,448,894 | 9410 |
| 原 PNG | 3 | fetch | 1280×1706 | 2,043,188 | 8,173,225 | 15596 |

新 TLS 对照使用 `https.request({agent:false})`，实测 reusedSocket=false、secureConnect=true。稳定故障已在发送前纯本地复现，不依赖 keep-alive；本轮没有支持旧 socket 复用为根因的证据。直接 HTTP 成功不能代替正式提取验收，正式 prompt、schema、输出预算仍有差异。

参数依据：JPEG quality=85 实测缩至228,605B且真实服务接受；长边1536/1024已覆盖。阶段1采用 JPEG85/1536 正常版本、JPEG85/1024 单张降级版本，单张硬上限沿官方2MiB，8张/32MiB收敛并按最终字节复核。仅缩放到1536的PNG反而变大，必须同时消除适配层二次强制PNG。规范化只在内存，来源仍用原图file_id/sha256。

声明、pnpm锁及安装制品均为 `@deepseek-ai/dsh-llm-deepseek@0.2.1-rc.2`；源码参考固定commit `687f282e8625c6b8d11ff58211a90524be2e4317`，相邻DSH工作树HEAD不同，未切换。未做整包可复现构建比对。

阶段0在原问题账本实际使用8次，并保留当时的unknown诊断结案事实；后续用户将同一账本授权扩至累计96次/120分钟，保留已用8次，未重建或清零。实际图片与中间版本未落盘，仅保存脱敏元数据。

后续验证已沿正式提取路径完成：同尺寸近体积合成PNG被真实模型接受，样本14张图片有成功证明（9本轮新处理、5既有）；原失败图E/V发送1134×1512 JPEG207,252B，原sha256匹配且success/settled，支持体积整改。真实L2 gen3已published/succeeded；L3 gen4/gen5及a25dc2a8c修后最后一次gen6仍未发布，最后两次为document_profile_unverified，不能把图片问题改善写成完整阶段6通过。最终同一账本46次预留、parent96/执行硬cap46，限定续作三次已用尽；active0、finally auto0、sample unknown0、其他unknown4不变、foreign/unproven0，不再调用模型或放宽guard。本issue原resolved保持，L3后续质量调查由issue05跟踪。

最终集成与清理：main已快进到7d3ab2227，原3项WIP内容SHA完全保留；4份验收TEMP逐项与HEAD校验后还原，controller CAS clean。工作树.env软链接已删、main.env未改，工作树tracked clean，main status仅原3项WIP。backend与desktop typecheck均退出0；最终公开历史扫描覆盖3532 commits/26047 blobs/2061当前files、issues0，diffcheck0。已恢复main普通pnpm run dev（无acceptance/budget/manual/UI临时环境），HTTP与Computer Use均确认总开关关闭，CUA已正常结束。验收私有临时空间仅保留权限600的budget.sqlite，无图片或用户库副本；工具/备份目录、工作树自有.dev/app均清理。不再调用模型。
