# 来源续证原型（仅合成数据）

问题：macOS 持久文件事件能否提供进程退出期间的来源变化线索？本原型不读取微信，不是产品实现或支持档认证。

以合成临时目录分别运行两个进程：第一个建立基线并关闭，期间修改或替换普通文件，第二个按同一设备事件 ID 回放。设备事件 UUID 一致；替换场景观测到创建、改名及修改事件。一次立即检查中，普通写入在 `HistoryDone` 到达时尚未出现；随后在运行循环短窗口内收到修改事件。因此历史结束标志不能单独作为完整交接屏障；此观察不证明事件一定丢失，也不建立可依赖的等待时长。事件丢失、日志清理、卷实例变化均应失证。

普通微信数据库写入也会表现为文件修改；只凭 FSEvents 无法区分正常提交和同一文件内部的表重建。任何真实续证方案还需要可证明的数据库实例与消息身份连续性、事件回放到实时守卫的无缺口交接和状态语义。若不能证明，必须停读；本原型不放宽真实支持档。

额外合成反例：同一 SQLite 文件分别执行普通 UPDATE 和删除后显式插入相同主键。两者文件 inode 和 schema_version 均未变，两者回放的事件类别均包含创建、删除和修改（不含改名）。这证明这些信号不足以区分这两种合成操作；不证明微信实际执行过后者。仅依据相同文件实例、结构版本和文件事件类别，不能认证消息身份跨进程连续。

调用示例：`clang -Wno-deprecated-declarations -framework CoreServices -framework CoreFoundation desktop/wechat-history/prototypes/fsevents-replay-prototype.c -o /tmp/notalone-fsevents-prototype`。仅对自行创建的临时合成目录运行，先执行 `capture <目录> 0`，在两次运行间更改合成文件，再以输出的事件 ID 执行 `replay <目录> <事件ID>`。输出含本机设备事件 UUID，仅供本机比较，不应提交或发布运行结果中的 UUID。

依据：[Apple FSEvents 持久事件与丢事件](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/UsingtheFSEventsFramework/UsingtheFSEventsFramework.html)、[设备事件 UUID](https://developer.apple.com/documentation/coreservices/1444453-fseventscopyuuidfordevice)、[SQLite data_version](https://sqlite.org/pragma.html#pragma_data_version)。
