# 07／08 嵌套建库归属证据补记

本记录补充已有的03默认测试库事故及04早期35个失败目录记录，三者不互相替代。07／08当前仍为 claimed；新轮通过不替旧轮认证资源退场，也不提前签收正式任务。

## 07：外层库登记没有覆盖所有 Core 建库

固定候选 `ebe5fa641e23e78d1295302e7e1fc675814c61e3` 的独立 Standards 审查确认：组合回归确实执行 `test_exploration_generation_preparation` 和 `test_exploration_preparation_rejection`。两者经 `FidelityHttpFixture` 调用 `CoreBusinessFlowFixture.setUpClass`，各自另建随机数据库；当时外层启动器只登记 bootstrap 库，没有为这些 Core 调用设置建库前 marker。

因此，原24个已知库的索引不能覆盖全部实际 CREATE。随后沿选中14模块的实际 setUpClass 链闭合检查：七个 overview 类、prepare／lifecycle HTTP、historical 继承链和 source-deletion 持久化组只连接显式外层库；两个 exploration 类各另建一个库。迁移子进程只执行迁移，没有额外 CREATE；本组选定路径未见独立 Cursor、Async 或 `Connection.connect` 建库。

完整旧轮范围为：prepare-http 35项（1失败）和 combined-http 111项（通过）两轮均执行两个 exploration 类，共四次嵌套 CREATE 未事前持久登记。主 Agent只读核对两份原始日志中的实际方法和轮次。通过日志及无类清理报错不能恢复这四个确切 UUID，也不能认证旧库不存在；未连接、扫描或清理任何可能的未知库。

原“只使用事前登记的自有合成库”声明需要收窄。新通用夹具的可选 hook 默认仍为 None；仅有外层显式双 URL，并不意味着嵌套 Core 复用该库或自动获得登记。

## 08：四次未持久登记的嵌套 CREATE

08首次相关组94项为86通过、7失败、1错误。外层双 URL 和 Core 的 before-create marker 没有覆盖独立的 session-delete 类库及三个 lifecycle 方法库；这四个旧 UUID 尚未从现有日志恢复。源码 finally 和日志未报清理错误均不等于逐名核销；旧轮残留保持未知。

随后有限恢复组18项为15通过、3次在 CREATE 前被63字节名称门拒绝；这三项不能记为业务通过。该恢复轮登记的 bootstrap 和 session-delete 两库已逐名确认不存在，不能用于补认前轮四库。生命周期旧69字节名称已在本任务夹具中缩短为56字节，未放宽名称门。

09实施前只读审计按实际 `self.name` 的ASCII前缀＋32位UUID十六进制＋`_test` 重新计数，主 Agent从两个固定 Git 对象独立复核。早前文字中的68／55均少算一个字符，以69／56为准；原始运行日志不修改，三次超过63字节而在建库前被拒绝的结论不变，不由长度复算恢复任何旧 UUID。

## 已执行的新轮保护及边界

主 Agent核阅并要求收紧后，08新启动器只在已枚举的连接及 `Connection.execute` 边界工作：导入项目／测试前绑定双 URL；显式本机 socket 与首次 admin 实例身份一致；建库前用 O_EXCL／O_NOFOLLOW、0600、flush/fsync 写 planned，成功后才记 created；DROP 仅限本轮确证创建的精确名称，随后逐名查询不存在。未知 query、带注释或多语句等不能完整识别的数据库 DDL、过长名称及实例漂移在执行前拒绝。

无数据库模拟与真实小批分别记录。真实小批4/4通过，5个已登记库逐名不存在。随后封闭8模块121/121通过，119.901秒，8个 marker 均为0600／drop_confirmed，精确索引8项均 absent=true；主 Agent只读核对原始日志及该索引、marker。这是新轮证据，不覆盖旧94项的身份缺口。

07另用专属守卫副本，将范围封闭为两个 exploration 模块9项、库数上限3，先无数据库模拟，再单轮9/9通过，18.822秒。实际外层1库、Core两库，三份0600 marker均为drop_confirmed，精确absence索引三项全true；主 Agent只读核对日志与索引。这是新的后续保护验证，不替旧两轮四个未知 UUID补证。

该守卫不宣称覆盖未枚举的独立 Cursor、Async、`Connection.connect` 或未来新增路径。所选模块的实际 CREATE 家族及迁移子进程需逐项静态核对；后来增加的测试不得自动沿用旧覆盖声明。后续 HTTP／页面入口另核导入前计划、实际建库 hook、模块与迁移前缀、子进程退出及逐名清理，不把这些层次混成一份推断证明。

旧35个目录现已全部恢复归属，但其数据库 UUID 仍为0；03的152项／65错误／1跳过及默认库身份、并发影响未知仍保留。没有连接或清理未知库，S分叉库继续保留，未合入 main、push、PR或部署。实际 App、微信与真实模型不由以上测试认证。
