# L2/L3 具名 driver 交接
1. 仅本目录；旧 3c168296e9e8edaa43b8b323ff693e790e709069，新 e60074b5946b8d1c990fcb75ba13bd58f789b2fb，固定 archive，无 index/ref 操作。
2. business.mjs:16/17 导出 createL2ScenarioBusiness / createL3ProfileBusiness；返回 FormalExecutor business.open。
3. README.md 给根注入；snapshot.mjs 同时复验冻结生产源码、自有执行脚本和四份 persistent broker 字节。
4. 30 份相关生产依赖与 9b20 逐 SHA 同；reply-comparison 报告器已知 12+/4- 不在该依赖链。
5. 最终业务 MY7X4R：12 个工程运行，HTTP=outer used=journal physical=PG job32，余968。
6. 双域成功四臂各6HTTP、场景1/画像1，来源版本可回溯；不是 helper-only 返回。
7. 503 四臂各1HTTP且 failed；取消四臂各1HTTP，真实 late write 返回后场景0/画像0。
8. SDK/business retry=0，没用耗尽预算模拟；journal responded28/failed4/unknown0。
9. 新臂 outbound ledger16/model receipts16；旧普通 transport 二者0，仅旧 PG job预约及真实 ModelHost 许可桥，未补造回执。
10. 最终守卫 eEN6ef：权限/来源/租约，两域双臂12项，HTTP0/outer0；failed8/unknown4全部保留。
11. 权限拒绝前保守 PG预约可能已加1；不能冒充HTTP，计数不匹配失败不删除。
12. clock-eWqacL：过去as_of创建新过期profile lease，真实PG live=false；新3HTTP失败、画像0。
13. 旧同probe6HTTP画像1，但其内部lease也过期，只按内容clock判断；旧时间资格继续unknown。
14. time-qualification.json 给精确接线点；独立修复归主协调，不改本会话生产源码。
15. 64943d17483723ce66eef417728501c788d8cb84 最小固定as_of一对已过12HTTP；新PG lease live=true，内容日期保留，旧live=false。
16. 单测3/3、profile TypeScript检查通过；业务12项与guard12项检查通过。
17. 核心命令：node --test …/drivers.test.mjs；node …/probe.mjs --synthetic-only all / guards。
18. 只验证 -01/-03/-05/-11 指定用途；剩余材料和合法taskless idle的正式终态口径尚未签收，不伪造租约。
19. as_of/observed_at 保留来源；Date/PG时钟未伪造。五阶段/首token不完整，完整主宿主内容clock缺接线。
20. 正式质量0、独立语义审阅0；非回复1056/统一1152完整保留；25/26不批准。
21. 旧实际输出8192/新393216，不设容量或费用门槛；用量为localhost声明，费用unknown。
22. 历次16证据集、88工程观察、124 localhost HTTP均留账；不并入正式质量分母。
23. cleanup.json：88库已drop，86已知ModelHost socket已清理，raw权限0违规；原始日志0700/0600保留。
24. probe-history.json/private-evidence-index.json 保存raw/public SHA及原失败；artifact-manifest.json/SHA256SUMS为交付清单。
25. 没有App/微信/真实资料/原.env/原账本/真实供应商/外部消息/打包/提交/push；Git与后续集成归主协调。
26. 后续全部集成最终pin仅做固定archive依赖小差异复核；核心driver不变，原e600/RED证据未改。
