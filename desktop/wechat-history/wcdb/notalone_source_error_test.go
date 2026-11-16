package wcdb

import (
	"context"
	"errors"
	"testing"
)

func TestNotAloneBoundedBusyReturnsRecoverableSourceFailure(t *testing.T) {
	writer := boundedTestDB(t)
	if err := writer.Exec("CREATE TABLE source_rows(value INTEGER); INSERT INTO source_rows VALUES(7)"); err != nil {
		t.Fatal(err)
	}
	reader, err := OpenPlain(writer.path, false)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if err = reader.Exec("PRAGMA busy_timeout=0"); err != nil {
		t.Fatal(err)
	}
	if err = writer.Exec("BEGIN EXCLUSIVE"); err != nil {
		t.Fatal(err)
	}
	rows, err := reader.QueryBounded(context.Background(), 1, "SELECT value FROM source_rows")
	var temporary interface{ Temporary() bool }
	if rows != nil || err == nil || !errors.As(err, &temporary) || !temporary.Temporary() {
		t.Fatalf("来源锁繁忙必须返回可恢复失败且不返回部分结果: rows=%v err=%v", rows, err)
	}
	if err = writer.Exec("ROLLBACK"); err != nil {
		t.Fatal(err)
	}
	rows, err = reader.QueryBounded(context.Background(), 1, "SELECT value FROM source_rows")
	if err != nil || len(rows) != 1 || rows[0]["value"] != int64(7) {
		t.Fatalf("来源恢复后无法重试: rows=%v err=%v", rows, err)
	}
}

func TestNotAloneBoundedSchemaFailureIsNotTemporary(t *testing.T) {
	db := boundedTestDB(t)
	rows, err := db.QueryBounded(context.Background(), 1, "SELECT value FROM missing_source_table")
	var temporary interface{ Temporary() bool }
	if rows != nil || err == nil || (errors.As(err, &temporary) && temporary.Temporary()) {
		t.Fatalf("真实结构错误不能作为可恢复来源失败: rows=%v err=%v", rows, err)
	}
}
