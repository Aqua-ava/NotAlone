# 腾讯记忆源码参考说明

本项目在现有 Python 后端自行实现自动记忆，参考 TencentDB-Agent-Memory 的提取、混合召回、批量裁决、场景文档和画像维护流程。参考版本：e9a82935b52741e0c798c75326e90b7144eb4d5f。

本项目不接入腾讯记忆服务，不包含 MemoryCore 运行时依赖。改写或参考的提示词和算法对应关系见任务记录；NotAlone 的联系人隔离、来源核验及版本事务是本项目适配。

以下保留参考项目许可证原文：

```text
Tencent is pleased to support the open source community by making TencentDB Agent Memory available. 

Copyright (C) 2026 Tencent.  All rights reserved. 

TencentDB Agent Memory is licensed under the MIT.


Terms of the MIT:
--------------------------------------------------------------------
Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
