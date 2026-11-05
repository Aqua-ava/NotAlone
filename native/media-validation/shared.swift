import Foundation

// 产品校验命令与合成夹具自测共用的最小基础类型。
struct Failure: Error {let code:String;init(_ code:String) {self.code=code}}
let maxBytes=32*1024*1024
