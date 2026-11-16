package main

import (
	"errors"

	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

var notaloneSourceTemporarilyUnavailable = errors.New("history_source_temporarily_unavailable")

// 只有读取器保留的 SQLite 技术错误可以降为暂不可读；身份、结构、结果形状
// 和来源守卫失败仍返回调用点原有错误，不以重试绕过来源核验。
func notaloneReadFailure(cause error, fallback string) error {
	if notaloneIsTemporaryReadFailure(cause) {
		return notaloneSourceTemporarilyUnavailable
	}
	return notaloneFailure(fallback)
}

func notaloneIsTemporaryReadFailure(cause error) bool {
	return errors.Is(cause, notaloneSourceTemporarilyUnavailable) || wcdb.IsSourceTemporarilyUnavailable(cause)
}
