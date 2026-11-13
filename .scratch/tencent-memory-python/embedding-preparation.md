# 本地向量准备

参考腾讯混合召回机制，Python 自行实现词法与本地语义排序；不接入腾讯引擎或外部 embedding 服务。

- FastEmbed 0.9.0；BAAI/bge-small-zh-v1.5，512维。
- 固定公开权重仓库 Qdrant/bge-small-zh-v1.5，revision 46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59。
- 准备：`python scripts/prepare_memory_embedding.py`；离线复验加 `--offline`。命令只读取公开模型权重，不读取业务环境或聊天。
- 运行时使用固定 snapshot 与 local_files_only；缺文件明确报模型不可用，不联网下载，不以词法伪装语义检索。
- 本机离线向量自检通过。模型缓存不包含聊天，业务向量不跨联系人缓存。
- 官方接口依据：https://qdrant.github.io/fastembed/examples/Supported_Models/ 与 https://github.com/qdrant/fastembed/blob/main/fastembed/common/model_management.py 。
