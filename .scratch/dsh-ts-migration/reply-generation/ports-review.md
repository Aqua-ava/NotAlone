# 05 独立依赖端口审查与归档

- 范围：`reply-assistant-erasure.ts`、`reply-assistant-erasure-sql.ts`、`retrieval-casefold.ts`，及两组直接测试；不包括尚未完成的生成总装。
- 固定基线：`3c168296e9e8edaa43b8b323ff693e790e709069`。三个文件均为新增文件，按空文件到当前工作区全文审查。
- DSH固定版本：`0.2.1-rc.2`，官方源码SHA `687f282e8625c6b8d11ff58211a90524be2e4317`；本批为普通SQL删除适配与Unicode兼容数据，不调用DSH接口、Python运行时或远程模型。
- Standards独立审查：0项需整改。事务/owner锁、参数绑定、来源身份失败回滚及固定Unicode表符合本批约束；未发现需单列的Fowler smell。
- Spec独立审查：0项可确认发现。真实父边、编辑版本指纹、闭包及058准备副本清理与旧Python一致；未独立穷举跨码点NFKC组合序列，完整05链路不在本批结论内。
- 隔离验证：从当前HEAD归档到独立临时目录，仅加入本批三模块及直接测试，未带入其他未提交TS/Python/桌面改动；9/9通过（助手删除7、Unicode兼容2），三个模块strict TypeScript检查通过。
- 删除用例覆盖真实continuation、跨会话携入、捕获讨论/候选版本、损坏身份回滚、准备/恢复副本及当前指针清理；固定表用独立Python Unicode15全码点数据及Node NFKC差异核验。
- 当前工作区09真实默认接线另有3/3删除用例通过；该证据用于集成跟踪，不以此宣称本批包含09产品入口。
- 数据影响：仅合成隔离PG库与本机Unicode计算；每用例注册清库，未使用私人聊天、业务库、凭据或真实模型。
- 未运行App或打包，不涉及外部消息；只做本地提交，禁止push。完整05仍待公共HTTP/官方runtime总装与实际开发App验收。
