package wcdb

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

var boundedBootstrap struct {
	sync.Mutex
	path              string
	interrupt         func(uintptr)
	extendedErrorCode func(uintptr) int32
}

const notaloneBoundedCellByteLimit = 8 << 20

// BootstrapBounded 必须作为进程首个 Bootstrap 串行调用，避免把另一引擎的
// interrupt 用于既有连接；普通 Bootstrap 已初始化而无法核对时保持不可用。
func BootstrapBounded(library string) (err error) {
	boundedBootstrap.Lock()
	defer boundedBootstrap.Unlock()
	if !filepath.IsAbs(library) {
		return errors.New("bounded_bootstrap_path_invalid")
	}
	library = filepath.Clean(library)
	if boundedBootstrap.interrupt != nil {
		if boundedBootstrap.path != library {
			return errors.New("bounded_bootstrap_library_changed")
		}
		return nil
	}
	mu.Lock()
	alreadyLoaded := loaded
	mu.Unlock()
	if alreadyLoaded {
		return errors.New("bounded_bootstrap_prior_library_unverified")
	}
	// Bootstrap 的上游报错含库路径，符号注册也可能 panic，均转为固定错误。
	defer func() {
		if recover() != nil {
			err = errors.New("bounded_bootstrap_failed")
		}
	}()
	handle, loadErr := loadLibrary(library)
	if loadErr != nil {
		return errors.New("bounded_bootstrap_failed")
	}
	defer purego.Dlclose(handle)
	symbol, symbolErr := purego.Dlsym(handle, "sqlite3_interrupt")
	if symbolErr != nil {
		return errors.New("bounded_bootstrap_interrupt_unavailable")
	}
	extendedSymbol, symbolErr := purego.Dlsym(handle, "sqlite3_extended_errcode")
	if symbolErr != nil {
		return errors.New("bounded_bootstrap_error_code_unavailable")
	}
	if Bootstrap(library) != nil {
		return errors.New("bounded_bootstrap_failed")
	}
	var interrupt func(uintptr)
	purego.RegisterFunc(&interrupt, symbol)
	var extendedErrorCode func(uintptr) int32
	purego.RegisterFunc(&extendedErrorCode, extendedSymbol)
	boundedBootstrap.path = library
	boundedBootstrap.interrupt = interrupt
	boundedBootstrap.extendedErrorCode = extendedErrorCode
	return nil
}

// QueryBounded 复用上游参数绑定，整数始终保持 int64，单个 cell 最多 8 MiB。
// 调用方独占此 DB，必须等本方法返回后才 Close 或执行下一查询。
// 返回前先回收取消协程，再 finalize，防止迟到 interrupt 影响后续操作。
func (d *DB) QueryBounded(ctx context.Context, maxRows int, sql string, args ...any) ([]Row, error) {
	if ctx == nil || maxRows < 1 || d == nil || d.handle == 0 {
		return nil, errors.New("bounded_query_invalid")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	boundedBootstrap.Lock()
	interrupt := boundedBootstrap.interrupt
	boundedBootstrap.Unlock()
	if interrupt == nil {
		return nil, errors.New("bounded_query_not_initialized")
	}
	handle := d.handle
	stop := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		select {
		case <-ctx.Done():
			interrupt(handle)
		case <-stop:
		}
	}()
	var stmt uintptr
	defer func() {
		close(stop)
		<-stopped
		if stmt != 0 {
			sqlite3_finalize(stmt)
		}
	}()
	if rc := sqlite3_prepare_v2(handle, sql, -1, &stmt, nil); rc != SQLITE_OK {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := notaloneSQLiteSourceReadError(handle, rc); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("bounded_query_prepare_failed:%d", rc)
	}
	if err := bindArgs(stmt, args); err != nil {
		return nil, errors.New("bounded_query_bind_failed")
	}
	ncol := sqlite3_column_count(stmt)
	names := make([]string, ncol)
	for i := int32(0); i < ncol; i++ {
		names[i] = readCString(sqlite3_column_name(stmt, i))
	}
	rows := []Row{}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		rc := sqlite3_step(stmt)
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if rc == SQLITE_DONE {
			return rows, nil
		}
		if rc != SQLITE_ROW {
			if err := notaloneSQLiteSourceReadError(handle, rc); err != nil {
				return nil, err
			}
			return nil, fmt.Errorf("bounded_query_step_failed:%d", rc)
		}
		if len(rows) == maxRows {
			return nil, errors.New("bounded_query_row_limit")
		}
		row := make(Row, ncol)
		for i := int32(0); i < ncol; i++ {
			value, err := readNotaloneBoundedColumn(stmt, i)
			if err != nil {
				return nil, err
			}
			row[names[i]] = value
		}
		rows = append(rows, row)
	}
}

func readNotaloneBoundedColumn(stmt uintptr, i int32) (any, error) {
	kind := sqlite3_column_type(stmt, i)
	switch kind {
	case COL_INT:
		return sqlite3_column_int64(stmt, i), nil
	case COL_FLOAT:
		return sqlite3_column_double(stmt, i), nil
	case COL_NULL:
		return nil, nil
	case COL_TEXT, COL_BLOB:
		var p unsafe.Pointer
		if kind == COL_TEXT {
			p = sqlite3_column_text(stmt, i)
		} else {
			p = sqlite3_column_blob(stmt, i)
		}
		// TEXT 也必须按字节数复制，C 字符串会丢掉内嵌 NUL 及其后的损坏字节。
		n := sqlite3_column_bytes(stmt, i)
		if n < 0 || (n > 0 && p == nil) {
			return nil, errors.New("bounded_query_cell_invalid")
		}
		if n > notaloneBoundedCellByteLimit {
			return nil, errors.New("bounded_query_cell_limit")
		}
		if kind == COL_TEXT {
			return string(unsafe.Slice((*byte)(p), int(n))), nil
		}
		value := make([]byte, int(n))
		copy(value, unsafe.Slice((*byte)(p), int(n)))
		return value, nil
	default:
		return nil, errors.New("bounded_query_cell_invalid")
	}
}
