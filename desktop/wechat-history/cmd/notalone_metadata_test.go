package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func refreshNotaloneMetadataInspection(t *testing.T, f *notaloneSnapshotFixture) {
	t.Helper()
	session := newNotaloneHistorySession(f.server)
	session.selected = &f.selected
	var err error
	f.inspected, err = session.inspect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
}

func TestNotAloneMetadataExactUnverifiedAndSingleRecord(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 2)
	for _, writer := range f.writers {
		if err := writer.Exec("UPDATE " + quoteIdent(f.table) + " SET status=9223372036854775807,create_time=-9223372036854775808,message_content='BODY_SENTINEL',source='SOURCE_XML_MEDIA_SENTINEL'"); err != nil {
			t.Fatal(err)
		}
	}
	observed, err := observeNotaloneMessageMetadata(context.Background(), f.server, f.selected, f.inspected, "text")
	if err != nil || observed == nil {
		t.Fatalf("元数据观察失败：%v", err)
	}
	if observed.LocalID == nil || *observed.LocalID != "9007199254740993" || observed.ServerID == nil || *observed.ServerID != "9223372036854775807" || observed.OriginalType == nil || *observed.OriginalType != "1" || observed.Status == nil || *observed.Status != "9223372036854775807" || observed.CreateTime == nil || *observed.CreateTime != "-9223372036854775808" || observed.Sender != "contact" {
		t.Fatalf("精确元数据发生改变：%#v", observed)
	}
	if observed.StatusSemantics != "unverified" || observed.NormalHistory || observed.ObservationScope != "single-fixed-snapshot" {
		t.Fatal("事实观察不能升级状态或普通历史授权")
	}
	encoded, _ := json.Marshal(observed)
	for _, secret := range []string{"BODY_SENTINEL", "SOURCE_XML_MEDIA_SENTINEL", "other-secret", "friend-a", "synthetic-owner", "message_content", "records"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("元数据观察泄露额外资料：%s", secret)
		}
	}
	var fields map[string]any
	if json.Unmarshal(encoded, &fields) != nil || len(fields) != 11 {
		t.Fatal("必须只返回单条受限元数据及固定观察边界")
	}
	for _, key := range []string{"partition", "table", "localId", "serverId", "originalType", "status", "createTime", "sender", "statusSemantics", "normalHistory", "observationScope"} {
		if _, found := fields[key]; !found {
			t.Fatalf("缺少camelCase字段%s", key)
		}
	}
}

func TestNotAloneMetadataKindsWithoutBodyColumns(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	if err := f.writers[0].Exec("DROP TABLE " + quoteIdent(f.table) + ";CREATE TABLE " + quoteIdent(f.table) + "(local_id INTEGER PRIMARY KEY AUTOINCREMENT,server_id INTEGER,local_type INTEGER,real_sender_id INTEGER,create_time INTEGER,status INTEGER);INSERT INTO " + quoteIdent(f.table) + "(local_id,server_id,local_type,real_sender_id,create_time,status) VALUES(1,0,4294967297,1,1700000000,-7),(2,0,3,2,1700000000,-7),(3,0,34,3,1700000000,-7),(4,0,62,2,1700000000,-7),(5,0,49,2,1700000000,-7),(6,0,47,2,1700000000,-7),(7,0,1000,2,1700000000,-7)"); err != nil {
		t.Fatal(err)
	}
	refreshNotaloneMetadataInspection(t, &f)
	for _, sample := range []struct{ kind, originalType, sender string }{{"text", "4294967297", "owner"}, {"image", "3", "contact"}, {"voice", "34", "unknown"}, {"video", "62", "contact"}, {"file", "49", "contact"}, {"sticker", "47", "contact"}, {"other", "1000", "contact"}} {
		t.Run(sample.kind, func(t *testing.T) {
			observed, err := observeNotaloneMessageMetadata(context.Background(), f.server, f.selected, f.inspected, sample.kind)
			if err != nil || observed == nil || observed.OriginalType == nil || *observed.OriginalType != sample.originalType || observed.Sender != sample.sender || observed.Status == nil || *observed.Status != "-7" || observed.NormalHistory || observed.StatusSemantics != "unverified" {
				t.Fatalf("无正文列也应能观察指定类型元数据：%#v %v", observed, err)
			}
		})
	}
}

func TestNotAloneMetadataInvalidKindBeforeNativeIO(t *testing.T) {
	for _, kind := range []string{"", "TEXT", " image", "xml", "text;SELECT message_content"} {
		if validNotaloneMetadataKind(kind) {
			t.Fatalf("未知类型被接受：%q", kind)
		}
		// 连server/context都不存在时，未知kind仍必须先拒绝，不能进入配置或native读取。
		observed, err := observeNotaloneMessageMetadata(nil, nil, notaloneResolved{}, notaloneInspection{}, kind)
		if observed != nil || err == nil || err.Error() != "history_metadata_kind_invalid" {
			t.Fatalf("未知kind未在读取前拒绝：%#v %v", observed, err)
		}
	}
}

func TestNotAloneMetadataNoMatchAndMissingShard(t *testing.T) {
	for _, mode := range []string{"no-match", "missing-shard", "stale-schema"} {
		t.Run(mode, func(t *testing.T) {
			f := newNotaloneSnapshotFixture(t, 2)
			if mode == "missing-shard" {
				if err := os.Rename(filepath.Join(f.server.cfg.DBRoot, "db_storage", "message", "message_1.db"), filepath.Join(f.server.cfg.DBRoot, "held-away.db")); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "stale-schema" {
				if err := f.writers[1].Exec("CREATE INDEX metadata_schema_changed ON " + quoteIdent(f.table) + "(status)"); err != nil {
					t.Fatal(err)
				}
			}
			observed, err := observeNotaloneMessageMetadata(context.Background(), f.server, f.selected, f.inspected, "voice")
			if observed != nil || (mode == "no-match" && err != nil) || (mode != "no-match" && err == nil) {
				t.Fatalf("空匹配必须为nil且缺shard/过期DDL不能当作成功：%#v %v", observed, err)
			}
		})
	}
}

func TestNotAloneMetadataAllShardsFixedAndReleased(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 2)
	if err := f.writers[1].Exec("INSERT INTO " + quoteIdent(f.table) + "(local_id,local_type,real_sender_id,status) VALUES(1,3,2,999)"); err != nil {
		t.Fatal(err)
	}
	snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(f.inspected.Tables), OpaqueStatusPolicy: "snapshot-opaque-v1"})
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	for _, writer := range f.writers {
		if err = writer.Exec("INSERT INTO " + quoteIdent(f.table) + "(local_id,local_type,status) VALUES(0,3,777)"); err != nil {
			t.Fatal(err)
		}
	}
	observed, err := snapshot.observeMetadata(context.Background(), "image")
	if err != nil || observed == nil || observed.LocalID == nil || *observed.LocalID != "1" || observed.Partition != snapshot.shards[1].partition || observed.Table != snapshot.shards[1].instance {
		t.Fatalf("所有shard必须先固定，后写入不能混入本次观察：%#v %v", observed, err)
	}
	if err = snapshot.Close(); err != nil {
		t.Fatal(err)
	}
	for index, shard := range snapshot.shards {
		if shard.reader != nil || shard.observer != nil {
			t.Fatal("未关闭reader或observer")
		}
		result, err := f.writers[index].QueryBounded(context.Background(), 1, "PRAGMA wal_checkpoint(TRUNCATE)")
		if err != nil || len(result) != 1 || rowInt64(result[0], "busy") != 0 {
			t.Fatalf("观察后仍有固定reader：%#v %v", result, err)
		}
	}
}

func TestNotAloneMetadataGuardChangeAndConcurrentClose(t *testing.T) {
	for _, mode := range []string{"guard-change", "concurrent-close", "context-cancel"} {
		t.Run(mode, func(t *testing.T) {
			f := newNotaloneSnapshotFixture(t, 1)
			if mode != "guard-change" {
				if err := f.writers[0].Exec("DROP TABLE Name2Id;CREATE VIEW Name2Id AS WITH RECURSIVE slow(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM slow WHERE n<1000000000) SELECT 2 AS rowid,'friend-a' AS user_name FROM slow WHERE n=1000000000"); err != nil {
					t.Fatal(err)
				}
				refreshNotaloneMetadataInspection(t, &f)
			}
			snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(f.inspected.Tables), OpaqueStatusPolicy: "snapshot-opaque-v1"})
			if err != nil {
				t.Fatal(err)
			}
			defer snapshot.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			closed := make(chan error, 1)
			if mode == "guard-change" {
				if err = os.Rename(filepath.Join(f.server.cfg.DBRoot, "db_storage", "message", "message_0.db"), filepath.Join(f.server.cfg.DBRoot, "moved.db")); err != nil {
					t.Fatal(err)
				}
			} else {
				timer := time.AfterFunc(20*time.Millisecond, func() {
					if mode == "context-cancel" {
						cancel()
					} else {
						closed <- snapshot.Close()
					}
				})
				defer timer.Stop()
			}
			started := time.Now()
			observed, err := snapshot.observeMetadata(ctx, "text")
			if observed != nil || err == nil || time.Since(started) > 2*time.Second {
				t.Fatalf("来源变化或取消必须拒绝整条观察且有界排空：%#v %v", observed, err)
			}
			if mode == "concurrent-close" {
				if err = <-closed; err != nil {
					t.Fatal(err)
				}
			}
			if err = snapshot.Close(); err != nil {
				t.Fatal(err)
			}
			if mode != "guard-change" {
				result, err := f.writers[0].QueryBounded(context.Background(), 1, "PRAGMA wal_checkpoint(TRUNCATE)")
				if err != nil || len(result) != 1 || rowInt64(result[0], "busy") != 0 {
					t.Fatalf("取消后未释放真实reader：%#v %v", result, err)
				}
			}
		})
	}
}

func TestNotAloneMetadataCancellationClosesReaders(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	if err := f.writers[0].Exec("DROP TABLE Name2Id;CREATE VIEW Name2Id AS WITH RECURSIVE slow(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM slow WHERE n<1000000000) SELECT 2 AS rowid,'friend-a' AS user_name FROM slow WHERE n=1000000000"); err != nil {
		t.Fatal(err)
	}
	refreshNotaloneMetadataInspection(t, &f)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	started := time.Now()
	observed, err := observeNotaloneMessageMetadata(ctx, f.server, f.selected, f.inspected, "text")
	if observed != nil || err == nil || time.Since(started) > 2*time.Second {
		t.Fatalf("取消观察必须有界返回且没有部分结果：%#v %v", observed, err)
	}
	result, err := f.writers[0].QueryBounded(context.Background(), 1, "PRAGMA wal_checkpoint(TRUNCATE)")
	if err != nil || len(result) != 1 || rowInt64(result[0], "busy") != 0 {
		t.Fatalf("函数取消返回时必须已经释放真实reader：%#v %v", result, err)
	}
}
