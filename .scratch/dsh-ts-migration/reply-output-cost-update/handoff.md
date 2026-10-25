# 输出与费用评测交接

1. 交付状态：离线适配可审，未批准25/26；初测源码固定bcc6701ce67249d18b51625c07f4cad4e401ad04，最终集成pin待根核验。
2. 新策略：execution-policy.json；范围快照scope-snapshot.md；原primary、vendor-forward、old-arm及历史报告均未改。
3. 唯一控制变化：max_output_tokens 4096→393216；官方context=1048576、安全余量65536；其他冻结模型参数和材料/来源/oracle不变。
4. run-full.mjs新增--execution-policy；runner在私有冻结副本适配旧profile/counter与guard，新插件使用同一输出值，记录前后SHA。
5. normalize.mjs同flag：核policy/capture/旧profile/逐attempt原始wire、hash、实际max_tokens；不接受仅变量声明一致。
6. report-current.mjs：显式核规范化policy后传costWaiver；cost_status=waived_by_user，保留原测量/原阈值结论，不让费用阻塞overall。
7. 缺费用/价格为null/unknown；其他来源/配置/质量/失败率/延迟unknown或失败仍不能通过。未传policy的历史默认不变。
8. 自有修改限ticket25-final-run/{runner,run-full,execution-snapshot,normalize}.mjs、backend-ts/src/reply-comparison.ts及本目录。
9. 新8项行为测试分次定点绿；原报告器默认78/78；隔离源码typecheck与diff --check绿。未跑假96/真96或全量。
10. 最小成功pair：旧CC/新DSH Messages的wire均393216、各1请求、source verified、完整五阶段；actual配置其他等价仍未认证。
11. 503 pair：新臂1请求且failed，usage/cost=null、无保存；physical_limit24，未以耗尽模拟0重试。
12. 冻结guard探针：缺价格relay仍存usage/cost=null；ACK只读且无fresh reservation不能二次发送；无自动retry。
13. 原红及一次EEXIST证据保留，后续用唯一目录；原始日志/JSON仓库外0700/0600，公开仅占位路径/SHA。
14. 文件SHA、原件未变证明、adapter前后SHA、命令及结果见artifact-manifest.json和verification.json；完整说明见report.md。
15. strict未进入此回复链；此处普通Messages证据不声称来源核验strict实测。
16. 真实模型0、App/微信0、真实资料/账本/凭据0；合成库/profile/子进程已清理，自有闲置副本精确清理后留原始证据。
17. 主repo index/ref未修改，无add/commit/push/PR/打包；本地提交由根统一处理。
18. 下一步：根冻结最终pin并独立审查这5文件小delta，按需最小pair复验；正式96需既有许可/同一累计账本/0重试及同一policy。
