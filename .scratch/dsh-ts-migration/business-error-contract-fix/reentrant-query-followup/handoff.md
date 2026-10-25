# 重入查询交接

1. 基点 283a609f5f48503657bef571c0ea9539d4ee7b76；原独立对照和新单例均先 RED。
2. toPostgres 重入排入正常查询，原调用后队尾推断遗漏活动 Query。
3. 现只在 owned client 的 _pulseQueryQueue 原分发/submit 前观察全部待运行 Query，不再猜队尾。
4. 每次入队都经过该点，含 ready=false 的排队查询；WeakMap 去重，错误/end 恢复并清理。
5. 不复制配置、不包callback、不改参数/连接/队列顺序或条目引用/submit/wire，也不改全局pg原型。
6. 已核验锁定pg8.16.3源码；非公共实现观察点依赖已在报告声明，升级需重验。
7. 新增唯一反例：原回调1次、嵌套成功1次、受控错误不等于原驱动Error、写入全回滚。
8. 原模块33/33（原32+1），独立对照3/3，均0 skip；TSC退出0，无全量。
9. 源码SHA：7f63954a3cc1ab9450316b4e8021df9f4a8e6422354dbaf817e3c788c5d09259。
10. 测试SHA：8edeee1266b72b1340e5337f727ee452916d586c260b6fdbf2984342f2799ab5。
11. 精确fix.patch、manifest、命令/原始日志SHA、pg源码pin及探针适配SHA均在本目录。
12. 原探针仅替换不存在的baseline import为私有a102原字节文件，未改目标或任何断言。
13. 原核心/微信/Query/配置原型证据、原finding及日志保持；原1491全量记录不改写。
14. fixture全收尾；原日志仓库外0700/0600，依赖链接已移除；0真实资料/模型/App/消息。
15. 不碰desktop/IPC/控制器/DTO/预算/真实账本/三用户文件；未动index或提交。
16. 源码测试已冻结，不新增验证；交root统一集成及必要复核。
