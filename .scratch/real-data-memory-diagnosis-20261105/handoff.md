# 记忆生成本地实测（2026-11-05）交接

## 现状
- 3 月后半段隔离副本跑完提取：run 917f1f6c… 327/327 成功（324 文字 + 3 图）。
- 产出 1 条 auto 记忆（memory 24961998，带图片依据 f188a8dc）。
- 18 candidate pending；run blocked（model_receipt_unknown）；adjudication 失败 19 次（provider TRANSPORT）。
- 已停止隔离后端；副本在 /private/tmp/claude-501/.../scratchpad/3m-userdata（1.9G），待删。

## 关键文件
- 3m-userdata/managed/sqlite/notalone.sqlite（副本库）
- 3m-backend.mjs、3m-node-wrapper.sh、3m-supervise3.sh（起后端/监控）
- 3m-result.md（本轮结果）
- 3m-fix-media.mjs（副本媒体身份重映射；真实库未动）

## 关键代码
- backend-ts/src/platform/models/model-provider.ts:195 provider TRANSPORT
- backend-ts/src/memory/extraction/model.ts: 调用许可/unknown receipt
- backend-ts/src/memory/sqlite/control.ts: applyControl continue
- backend-ts/src/memory/sqlite/management/adjudication-service.ts: publishRun 仅 run settle 时触发

## 下一步
- 若继续：需要一个“重试 adjudication”的小工具（不可用 HTTP）；或等产品修复。
- 验证环境：真实库只读，正常 dev 实例在跑（不要动）。
