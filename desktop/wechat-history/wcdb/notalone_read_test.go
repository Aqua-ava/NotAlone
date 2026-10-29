package wcdb

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func boundedTestDB(t *testing.T) *DB {
	t.Helper()
	library := os.Getenv("NOTALONE_TEST_WCDB")
	if library == "" {
		t.Skip("未指定隔离测试使用的 WCDB 制品")
	}
	if err := BootstrapBounded(library); err != nil {
		t.Fatal(err)
	}
	db, err := OpenPlain(filepath.Join(t.TempDir(), "synthetic.db"), true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	return db
}

func TestNotAloneBoundedExactIntegerAndLimit(t *testing.T) {
	db := boundedTestDB(t)
	rows, err := db.QueryBounded(context.Background(), 1, "SELECT ? AS id, ? AS value", int64(9223372036854775807), "合成")
	if err != nil || len(rows) != 1 || rows[0]["id"] != int64(9223372036854775807) || rows[0]["value"] != "合成" {
		t.Fatalf("精确整数或参数绑定失败: rows=%#v err=%v", rows, err)
	}
	rows, err = db.QueryBounded(context.Background(), 1, "SELECT 1 AS id UNION ALL SELECT 2")
	if err == nil || rows != nil {
		t.Fatalf("超出预算必须丢弃部分结果: rows=%#v err=%v", rows, err)
	}
	rows, err = db.QueryBounded(context.Background(), 1, "SELECT 3 AS id")
	if err != nil || len(rows) != 1 || rows[0]["id"] != int64(3) {
		t.Fatalf("超行后连接不可用: rows=%#v err=%v", rows, err)
	}
}

func TestNotAloneBoundedCancelThenReuseAndClose(t *testing.T) {
	db := boundedTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	started := time.Now()
	rows, err := db.QueryBounded(ctx, 1, "WITH RECURSIVE numbers(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM numbers WHERE n<1000000000) SELECT sum(n) FROM numbers")
	if !errors.Is(err, context.DeadlineExceeded) || rows != nil {
		t.Fatalf("运行中的递归查询未取消: rows=%#v err=%v", rows, err)
	}
	if time.Since(started) > 2*time.Second {
		t.Fatal("查询取消未在有界时间内结束")
	}
	for i := 0; i < 20; i++ {
		rows, err = db.QueryBounded(context.Background(), 1, "SELECT 7 AS id")
		if err != nil || len(rows) != 1 || rows[0]["id"] != int64(7) {
			t.Fatalf("取消影响后续查询: rows=%#v err=%v", rows, err)
		}
	}
	db.Close()
	if _, err = db.QueryBounded(context.Background(), 1, "SELECT 1"); err == nil {
		t.Fatal("关闭连接后仍允许查询")
	}
}

func TestNotAloneBoundedErrorsAreRedacted(t *testing.T) {
	db := boundedTestDB(t)
	for _, query := range []string{"SELECT private_secret FROM missing_private_table", "SELECT ?"} {
		_, err := db.QueryBounded(context.Background(), 1, query, struct{ Secret string }{"private_secret"})
		if err == nil || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), query) || strings.Contains(err.Error(), db.path) {
			t.Fatalf("错误泄露查询内容: %v", err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := db.QueryBounded(ctx, 1, "SELECT 1"); !errors.Is(err, context.Canceled) {
		t.Fatalf("已取消请求未拒绝: %v", err)
	}
	if _, err := db.QueryBounded(context.Background(), 0, "SELECT 1"); err == nil {
		t.Fatal("未拒绝无效行预算")
	}
}

func TestNotAloneBoundedTextPreservesNULAndInvalidTail(t *testing.T) {
	db := boundedTestDB(t)
	rows, err := db.QueryBounded(context.Background(), 1, "SELECT CAST(x'610062' AS TEXT) AS valid,CAST(x'6100ff' AS TEXT) AS invalid,x'610062' AS blob,9223372036854775807 AS exact,NULL AS absent")
	if err != nil || len(rows) != 1 {
		t.Fatalf("合成读取失败：%v", err)
	}
	if got, ok := rows[0]["valid"].(string); !ok || got != "a\x00b" {
		t.Fatalf("TEXT内NUL被截断：%#v", rows[0]["valid"])
	}
	if got, ok := rows[0]["invalid"].(string); !ok || got != string([]byte{'a', 0, 0xff}) {
		t.Fatalf("损坏尾部被静默丢弃：%x", []byte(got))
	}
	if got, ok := rows[0]["blob"].([]byte); !ok || string(got) != "a\x00b" {
		t.Fatal("BLOB类型或内容改变")
	}
	if rows[0]["exact"] != int64(9223372036854775807) || rows[0]["absent"] != nil {
		t.Fatal("整数或NULL类型改变")
	}
}

func TestNotAloneBoundedCellLimitRejectsWholeQuery(t *testing.T) {
	db := boundedTestDB(t)
	const limit = 8 << 20
	rows, err := db.QueryBounded(context.Background(), 1, "SELECT CAST(zeroblob(?) AS TEXT) AS text,zeroblob(?) AS blob", int64(limit), int64(limit))
	if err != nil || len(rows) != 1 {
		t.Fatalf("边界cell应完整可读：%v", err)
	}
	if len(rows[0]["text"].(string)) != limit || len(rows[0]["blob"].([]byte)) != limit {
		t.Fatal("边界cell被截断")
	}
	for _, query := range []string{"SELECT 'prefix' AS content UNION ALL SELECT CAST(zeroblob(?) AS TEXT)", "SELECT x'61' AS content UNION ALL SELECT zeroblob(?)"} {
		rows, err = db.QueryBounded(context.Background(), 2, query, int64(limit+1))
		if err == nil || err.Error() != "bounded_query_cell_limit" || rows != nil {
			t.Fatalf("超限cell必须拒绝整页且不能保留前缀行：rows=%d err=%v", len(rows), err)
		}
	}
	rows, err = db.QueryBounded(context.Background(), 1, "SELECT 7 AS value")
	if err != nil || len(rows) != 1 || rows[0]["value"] != int64(7) {
		t.Fatalf("拒绝后连接未可安全复用：%v", err)
	}
}
