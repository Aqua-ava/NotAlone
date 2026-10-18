# Runtime 集成交接

- 分支：`codex/memory-accuracy-integration-20261018`；工作树 `memory-bounded-runtime/NotAlone`。
- 当前产品提交9795f327；逐码点标尺v2、E2教学例和包装器修复已接入，67相关检查及两模块mypy通过。
- 原有bounded-runtime-v1/071接线已实现；本轮未重复建表或迁移业务库。
- 两次runtime15均首窗unknown：proof位置越界；V响应脱敏仅digest。RAW/FULL及七轴均0。
- 每场2次HTTP200、余28永久关闭；第二场原finish的closed=false保持，另有独立注册库closed=true核对。
- 自有来源13类及隔离库残留0、模型进程退出、临时.env删除；生产放行表为空。
- 指代nonthinking16完整safe14/general2；thinking在A15安全停，general3/bad_auto1，均未过。
- E2合同修订后主集16/16：general3、安全0、raw18/18/full16/18，未过；独立诊断6/8在bad_auto1处安全停。
- 新场43/48闭账，初始化拒绝场0/48关闭；不再无新机制开场，原16质量门不变。
- 指代最终5e09a433结果已合并（初版接入4b3e3617并同步最终链接）；未重复核心代码。
- 后续需先确定分类／纳入核验的可证伪机制，不能以V supported或pending替代完整字段质量。
- 核心私有6窗/4留出未覆盖；原03真实proof及七轴未通过；goal保持active，不签complete。
- 详细依据：agent-acceptance-20261018.md、runtime15-agent-result-20261018.md、../memory-extraction-accuracy/reference-agent-*-result-20261018.md。
- 不push/PR、不读新真实联系人、不发送聊天；不依据未知响应修解析器或重放旧预算。

- 新增第三场9578仅E1次200，V前请求绑定拒绝已修复；第四场1054两次200仍candidate区间错位，严格拒绝。
- 四场累计7次请求、113余额关闭，正式审核/七轴仍0；详见runtime-position-guide-20261018.md。
- 指代fewshot80ca闭账41/48，主集general3、安全0；诊断bad_auto1，结果已集成bafab10c，不开重复场。

- 核心验收资产盘点8d49fee8→376aac9f：四窗Gold尚未执行冻结，旧第四场用户停止且闭账，不能重启旧冻结。
- 候选Pro bounded15需新增封闭profile/登记/owned领取/凭据/SDK冻结；只做交付测试，不宣称模型优劣；暂无实现或调用。

- 指代官方模型查证已集成d1bbff6b；Pro仅候选交付配置，精确身份不符即停，不能用文档认证后端权重。

- Pro闭集90af01c2已验证90相关+15复查/五源码mypy/双审；18fcc800 closed2/30，首窗RAW/FULL1，一般1，basis0，后14unrun，资源/key清理。
- 当前正式七轴审查1窗但全部质量门未过；五场9请求、141余额闭账。
- reference从90af独立分支实现Pro reference16闭集；core沿原E2+legacyV/Flash双max适配私有6/4，均不借bounded15。
