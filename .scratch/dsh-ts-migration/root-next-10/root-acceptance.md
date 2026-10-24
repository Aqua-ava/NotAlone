# 票 10 根验收

日期：2026-10-25（Asia/Taipei）

## 结论

票 10 的提取、核验与恢复实现切片通过根验收。主树 fast-forward 接收
`1195aff8`、`a6dd5623`、`4c936d1e`、`d00a01a2`，最终 HEAD
`d00a01a2ca0d8c4007a40e5108e4a4d3eeb3b921`。当前 Python `TaskHost` 仍是
唯一生产领取者，TS `ExtractionWorker` 没有挂到生产 host effect。

## 根复验

- `backend-ts/test/extraction-*.test.mjs`：52/52 通过，0 failed/skipped。
- `tsc --noEmit`：exit 0。
- `git diff --check`：exit 0。
- 公开扫描：4472 当前文件、15117 历史 blob、2244 提交，issues 0。
- 首次 resume 提交曾对所有 POST 预读正文；`a6dd5623` 已改成精确恢复路径读取，
  并以原设置入口正文完整到达的 host 回归覆盖。
- bounded 集成测试修复了冻结来源缺少顶层 `message_type` 的真实接线缺陷。
- 合成物理调用 2、receipt 2、ledger 2、trace call 2；重复恢复不增长，外发 0。

## 边界

- B 段裁决、采纳、trace、watermark 与 index/verify 分别由票 11/12 完成。
- 停旧 Worker、排空、租约复验和 TS Worker 生产启用由票 24 完成。
- 实际 App/微信及真实模型质量、费用由票 25 验收；本票不宣称这些已通过。
- 测试只用合成 PG/目录和固定 Python oracle；未读真实资料、未调用真实模型或微信。
- 未 push、建 PR、打包或发送外部消息。
