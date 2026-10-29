package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestNotAloneTestMetadataLocksOnlyUniqueNewRows(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 2)
	w := newNotaloneTestMetadataWatch()
	defer w.Close()
	run := func(action string) notaloneTestMetadataReport {
		t.Helper()
		r, err := w.observe(context.Background(), f.server, f.selected, f.inspected, action)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	if r := run("arm"); r.LockedCount != 0 || len(r.Records) != 0 {
		t.Fatal(r)
	}
	if r := run("next"); r.LockedCount != 0 {
		t.Fatal("没有新行不能锁定")
	}
	for index := range f.writers {
		if err := f.writers[index].Exec("INSERT INTO " + quoteIdent(f.table) + "(local_type,real_sender_id,status) VALUES(1,1,2)"); err != nil {
			t.Fatal(err)
		}
		r := run("next")
		if r.LockedCount != index+1 || r.Records[index] == nil || r.Records[index].Sender != "owner" {
			t.Fatal(r)
		}
	}
	// 两个分片的local_id相同，但不能合并或互相顶替。
	r := run("current")
	if *r.Records[0].LocalID != *r.Records[1].LocalID || r.Records[0].Partition == r.Records[1].Partition {
		t.Fatal(r)
	}
	if err := f.writers[1].Exec("UPDATE " + quoteIdent(f.table) + " SET local_type=10000,status=4,real_sender_id=3 WHERE local_id=9007199254740994"); err != nil {
		t.Fatal(err)
	}
	r = run("current")
	if r.Records[1] == nil || *r.Records[1].OriginalType != "10000" || r.Records[1].Sender != "unknown" {
		t.Fatal("状态变化不能被原类型或sender过滤")
	}
	if err := f.writers[1].Exec("DELETE FROM " + quoteIdent(f.table) + " WHERE local_id=9007199254740994;INSERT INTO " + quoteIdent(f.table) + "(local_type,real_sender_id,status) VALUES(10000,1,4)"); err != nil {
		t.Fatal(err)
	}
	r = run("current")
	if r.Records[0] == nil || r.Records[1] != nil {
		t.Fatal("新系统行不能替换已锁行")
	}
}

func TestNotAloneTestMetadataRejectsAmbiguityBeforeCapture(t *testing.T) {
	for _, mode := range []string{"two-shards", "two-same-shard", "contact", "non-text", "schema", "replace"} {
		t.Run(mode, func(t *testing.T) {
			f := newNotaloneSnapshotFixture(t, 2)
			w := newNotaloneTestMetadataWatch()
			defer w.Close()
			if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "arm"); err != nil {
				t.Fatal(err)
			}
			sql := "INSERT INTO " + quoteIdent(f.table) + "(local_type,real_sender_id) VALUES(1,1)"
			switch mode {
			case "two-shards":
				for _, writer := range f.writers {
					if err := writer.Exec(sql); err != nil {
						t.Fatal(err)
					}
				}
			case "two-same-shard":
				if err := f.writers[0].Exec(sql + ";" + sql); err != nil {
					t.Fatal(err)
				}
			case "contact":
				if err := f.writers[0].Exec("INSERT INTO " + quoteIdent(f.table) + "(local_type,real_sender_id) VALUES(1,2)"); err != nil {
					t.Fatal(err)
				}
			case "non-text":
				if err := f.writers[0].Exec("INSERT INTO " + quoteIdent(f.table) + "(local_type,real_sender_id) VALUES(3,1)"); err != nil {
					t.Fatal(err)
				}
			case "schema":
				if err := f.writers[0].Exec("CREATE INDEX changed_test_metadata ON " + quoteIdent(f.table) + "(status)"); err != nil {
					t.Fatal(err)
				}
			case "replace":
				file := filepath.Join(f.server.cfg.DBRoot, "db_storage", "message", "message_0.db")
				if err := os.Rename(file, file+".held"); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "next"); err == nil || len(w.locked) != 0 {
				t.Fatalf("歧义/来源变化不能锁行: %v", err)
			}
			if !w.closed {
				t.Fatal("歧义后必须终止观察，不能删除干扰行后重试关联")
			}
			if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "current"); err == nil {
				t.Fatal("失败watch不能复活")
			}
		})
	}
}

func TestNotAloneTestMetadataRequiresArmAndFixedBudget(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	w := newNotaloneTestMetadataWatch()
	defer w.Close()
	if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "next"); err == nil {
		t.Fatal("未arm不可读取")
	}
	if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "arm"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "arm"); err == nil {
		t.Fatal("同session不能重设baseline")
	}
	w.calls = 20
	if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "current"); err == nil {
		t.Fatal("不能无限观察")
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "current"); err == nil {
		t.Fatal("close后不可读取")
	}
}

func TestNotAloneTestMetadataCloseCancelsAndDrains(t *testing.T) {
	for _, mode := range []string{"close", "context-cancel"} {
		t.Run(mode, func(t *testing.T) {
			f := newNotaloneSnapshotFixture(t, 1)
			w := newNotaloneTestMetadataWatch()
			defer w.Close()
			if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "arm"); err != nil {
				t.Fatal(err)
			}
			entered := make(chan struct{})
			w.beforeCapture = func(ctx context.Context, snapshot *notaloneSnapshot) error {
				close(entered)
				_, err := snapshot.shards[0].reader.QueryBounded(ctx, 1, "WITH RECURSIVE slow(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM slow WHERE n<1000000000) SELECT max(n) AS maximum FROM slow")
				return err
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			finished := make(chan error, 1)
			go func() { _, err := w.observe(ctx, f.server, f.selected, f.inspected, "next"); finished <- err }()
			<-entered
			// 明确的实例hook只替合成测试增加长QueryBounded，正常arm与preflight保持原路径。
			<-time.After(30 * time.Millisecond)
			closed := make(chan error, 1)
			if mode == "close" {
				go func() { closed <- w.Close() }()
			} else {
				cancel()
			}
			select {
			case err := <-finished:
				if err == nil {
					t.Fatal("取消后返回了部分观察")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("取消没有排空原生查询")
			}
			if mode == "close" {
				select {
				case err := <-closed:
					if err != nil {
						t.Fatal(err)
					}
				case <-time.After(time.Second):
					t.Fatal("Close没有等待实际读取结束")
				}
			}
			if err := w.Close(); err != nil {
				t.Fatal(err)
			}
			rows, err := f.writers[0].QueryBounded(context.Background(), 1, "PRAGMA wal_checkpoint(TRUNCATE)")
			if err != nil || len(rows) != 1 || rowInt64(rows[0], "busy") != 0 {
				t.Fatalf("关闭后reader未释放:%v %v", rows, err)
			}
		})
	}
}

func TestNotAloneTestMetadataEmptyMaximumDoesNotBecomeZero(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	if err := f.writers[0].Exec("DELETE FROM " + quoteIdent(f.table)); err != nil {
		t.Fatal(err)
	}
	w := newNotaloneTestMetadataWatch()
	defer w.Close()
	if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "arm"); err != nil {
		t.Fatal(err)
	}
	if err := f.writers[0].Exec("INSERT INTO " + quoteIdent(f.table) + "(local_id,local_type,real_sender_id) VALUES(-1,1,1)"); err != nil {
		t.Fatal(err)
	}
	r, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "next")
	if err != nil || r.LockedCount != 1 || *r.Records[0].LocalID != "-1" {
		t.Fatalf("空MAX不能使用0漏掉signed64行:%v %v", r, err)
	}
}
