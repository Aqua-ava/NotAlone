package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/r266-tech/wx-cli/v2/internal/config"
	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

type notaloneSnapshotFixture struct {
	server    *server
	selected  notaloneResolved
	inspected notaloneInspection
	writers   []*wcdb.DB
	table     string
}

func newNotaloneSnapshotFixture(t *testing.T, shards int) notaloneSnapshotFixture {
	t.Helper()
	if os.Getenv("NOTALONE_TEST_WCDB") == "" {
		t.Skip("需要显式合成WCDB制品")
	}
	root := t.TempDir()
	cfg := &config.Config{SchemaVersion: 2, Wxid: "synthetic-owner", DBRoot: root, Keys: map[string]string{}}
	table := "Msg_" + talkerHash("friend-a")
	f := notaloneSnapshotFixture{server: &server{cfg: cfg, ok: true, wcdbPath: os.Getenv("NOTALONE_TEST_WCDB")}, selected: notaloneResolved{Account: "synthetic-owner", Conversation: "friend-a", SourceGeneration: "synthetic-generation"}, table: table}
	for index := 0; index < shards; index++ {
		file := fmt.Sprintf("message_%d.db", index)
		notaloneTestDB(t, root, cfg, "message", file, `CREATE TABLE `+quoteIdent(table)+`(local_id INTEGER PRIMARY KEY AUTOINCREMENT,server_id INTEGER,local_type INTEGER,sort_seq INTEGER,real_sender_id INTEGER,create_time INTEGER,status INTEGER,message_content BLOB,source BLOB);CREATE TABLE Name2Id(user_name TEXT);INSERT INTO Name2Id(rowid,user_name) VALUES(1,'synthetic-owner'),(2,'friend-a'),(3,'other-person');CREATE TABLE Msg_other(message_content BLOB);INSERT INTO Msg_other VALUES('other-secret');`, fmt.Sprintf("%032x", index+1))
		writer, err := wcdb.OpenWithKeyMapWritable(filepath.Join(root, "db_storage", "message", file), cfg.Keys)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(writer.Close)
		if err = writer.Exec(`PRAGMA journal_mode=WAL;INSERT INTO ` + quoteIdent(table) + `(local_id,server_id,local_type,sort_seq,real_sender_id,create_time,status,message_content,source) VALUES(9007199254740993,9223372036854775807,1,99,2,1700000000,0,'合成正文','source-secret');`); err != nil {
			t.Fatal(err)
		}
		f.writers = append(f.writers, writer)
	}
	data, _ := json.Marshal(cfg)
	configFile := filepath.Join(root, "synthetic-config.json")
	if err := os.WriteFile(configFile, data, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WECHAT_CLI_CONFIG", configFile)
	session := newNotaloneHistorySession(f.server)
	session.selected = &f.selected
	var err error
	f.inspected, err = session.inspect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func TestNotAloneSnapshotFixedSelectedShards(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 2)
	snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(f.inspected.Tables), AllowedStatuses: []int64{0}})
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	target := snapshot.Target()
	if len(target.Partitions) != 2 || len(target.Tables) != 2 || target.Descriptor == "" {
		t.Fatalf("固定目标不完整：%#v", target)
	}
	page, err := snapshot.Page(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Records) != 2 || !page.Exhausted {
		t.Fatalf("完整合成目标未读完：%#v", page)
	}
	for _, record := range page.Records {
		if record.LocalID == nil || *record.LocalID != "9007199254740993" || record.ServerID == nil || *record.ServerID != "9223372036854775807" || record.Sender != "contact" || record.Text == nil || *record.Text != "合成正文" || record.OrderScheme != nil || record.OrderKey != nil {
			t.Fatalf("身份或正文投影错误：%#v", record)
		}
	}
	encoded, _ := json.Marshal(page)
	for _, secret := range []string{"source-secret", "other-secret", "other-person"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("泄露范围外或source：%s", secret)
		}
	}
}

func TestNotAloneSnapshotPagesHoldCutWhileWriterContinues(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	if err := f.writers[0].Exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<205) INSERT INTO ` + quoteIdent(f.table) + `(local_id,server_id,local_type,sort_seq,real_sender_id,create_time,status,message_content) SELECT x,0,1,206-x,2,1700000000,0,'合成分页' FROM n;`); err != nil {
		t.Fatal(err)
	}
	snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(f.inspected.Tables), AllowedStatuses: []int64{0}})
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	if err = f.writers[0].Exec(`INSERT INTO ` + quoteIdent(f.table) + `(local_id,server_id,local_type,sort_seq,real_sender_id,create_time,status,message_content) VALUES(206,0,1,0,2,1700000000,0,'快照后新行');UPDATE ` + quoteIdent(f.table) + ` SET message_content='快照后改文' WHERE local_id=2;`); err != nil {
		t.Fatalf("固定reader不得阻塞正常WAL写入：%v", err)
	}
	if err = snapshot.Check(); err != nil {
		t.Fatalf("正常提交不得误认来源换代：%v", err)
	}
	cursor := ""
	seen := map[string]bool{}
	pages := 0
	for {
		page, e := snapshot.Page(context.Background(), cursor)
		if e != nil {
			t.Fatal(e)
		}
		pages++
		if pages == 1 {
			if e := f.writers[0].Exec(`INSERT INTO ` + quoteIdent(f.table) + `(local_id,server_id,local_type,real_sender_id,create_time,status,message_content) VALUES(207,0,1,2,1700000000,0,'快照后第二次提交');UPDATE ` + quoteIdent(f.table) + ` SET message_content='快照后再次改文' WHERE local_id=3;`); e != nil {
				t.Fatalf("跨页期间正常写入失败：%v", e)
			}
		}
		if len(page.Records) > 100 {
			t.Fatal("超出每页预算")
		}
		if pages == 1 && page.CursorIn != nil {
			t.Fatal("初始游标应为null")
		}
		if pages > 1 && (page.CursorIn == nil || *page.CursorIn != cursor) {
			t.Fatal("续读游标不匹配")
		}
		for _, record := range page.Records {
			if record.LocalID == nil || seen[*record.LocalID] {
				t.Fatal("身份遗漏或重复")
			}
			seen[*record.LocalID] = true
			if record.Text != nil && strings.Contains(*record.Text, "快照后") {
				t.Fatal("B后变化混入原目标")
			}
			if record.OrderKey != nil || record.OrderScheme != nil {
				t.Fatal("同秒乱序不能伪造先后")
			}
		}
		if page.Exhausted {
			if page.CursorOut != nil || len(page.CompletedPartitions) != 1 {
				t.Fatal("终页覆盖错误")
			}
			break
		}
		if page.CursorOut == nil {
			t.Fatal("缺少可靠续读")
		}
		cursor = *page.CursorOut
	}
	if pages != 3 || len(seen) != 206 || seen["206"] || seen["207"] {
		t.Fatalf("固定目标不完整：pages=%d count=%d", pages, len(seen))
	}
}

func TestNotAloneSnapshotNonTextUnknownSenderAndOpaqueState(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	if err := f.writers[0].Exec(`INSERT INTO ` + quoteIdent(f.table) + `(local_id,server_id,local_type,real_sender_id,create_time,status,message_content) VALUES(1,0,34,2,1700000000,987,'非文字正文不得读取'),(2,0,1,3,1700000000,987,'其他发送人正文不得读取'),(3,0,4294967297,1,1700000000,987,'低32位文字');`); err != nil {
		t.Fatal(err)
	}
	snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(f.inspected.Tables), OpaqueStatusPolicy: "snapshot-opaque-v1"})
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	page, err := snapshot.Page(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range page.Records {
		switch *record.LocalID {
		case "1":
			if record.Kind != "voice" || record.Text != nil || record.ServerID == nil || *record.ServerID != "0" {
				t.Fatal("非文字占位错误")
			}
		case "2":
			if record.Sender != "unknown" || record.Text != nil {
				t.Fatal("未知发送者不应读取正文")
			}
		case "3":
			if record.Kind != "text" || record.Sender != "owner" || record.Text == nil || *record.Text != "低32位文字" {
				t.Fatal("复合type映射错误")
			}
		}
		if *record.LocalID != "9007199254740993" && (record.Status == nil || *record.Status != "987") {
			t.Fatal("opaque状态没有原样保留")
		}
	}
	encoded, _ := json.Marshal(page)
	if strings.Contains(string(encoded), "非文字正文不得读取") || strings.Contains(string(encoded), "其他发送人正文不得读取") {
		t.Fatal("不合格正文进入页结果")
	}
}

func TestNotAloneSnapshotProfileRejectsUnknownStateBeforeBody(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	if _, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, notaloneReadProfile{}); err == nil {
		t.Fatal("空profile不得放行")
	}
	if err := f.writers[0].Exec(`UPDATE ` + quoteIdent(f.table) + ` SET status=99;`); err != nil {
		t.Fatal(err)
	}
	snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(f.inspected.Tables), AllowedStatuses: []int64{0}})
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	if _, err = snapshot.Page(context.Background(), ""); err == nil || err.Error() != "history_message_state_unverified" {
		t.Fatalf("未知状态不得读取正文：%v", err)
	}
}

func TestNotAloneSnapshotRejectsReplayOtherTargetAndCancelledPage(t *testing.T) {
	for _, mode := range []string{"replay", "other", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			f := newNotaloneSnapshotFixture(t, 1)
			if err := f.writers[0].Exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<101) INSERT INTO ` + quoteIdent(f.table) + `(local_id,server_id,local_type,real_sender_id,create_time,status,message_content) SELECT x,0,1,2,1700000000,0,'合成' FROM n;`); err != nil {
				t.Fatal(err)
			}
			snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(f.inspected.Tables), AllowedStatuses: []int64{0}})
			if err != nil {
				t.Fatal(err)
			}
			defer snapshot.Close()
			page, err := snapshot.Page(context.Background(), "")
			if err != nil || page.CursorOut == nil {
				t.Fatalf("缺续读：%v", err)
			}
			cursor := ""
			ctx := context.Background()
			if mode == "other" {
				cursor = "other-target.other-nonce"
			}
			if mode == "cancel" {
				cancelled, cancel := context.WithCancel(context.Background())
				cancel()
				ctx = cancelled
				cursor = *page.CursorOut
			}
			if _, err = snapshot.Page(ctx, cursor); err == nil {
				t.Fatal("重放、其他scope或取消不得继续")
			}
			if err = snapshot.Close(); err != nil {
				t.Fatal(err)
			}
			result, err := f.writers[0].QueryBounded(context.Background(), 1, "PRAGMA wal_checkpoint(TRUNCATE)")
			if err != nil || len(result) != 1 || rowInt64(result[0], "busy") != 0 {
				t.Fatalf("reader未释放：%#v %v", result, err)
			}
		})
	}
}

func TestNotAloneSnapshotMissingShardOrKeyDoesNotAcceptPartial(t *testing.T) {
	for _, mode := range []string{"missing", "key"} {
		t.Run(mode, func(t *testing.T) {
			f := newNotaloneSnapshotFixture(t, 2)
			if mode == "missing" {
				if err := os.Remove(filepath.Join(f.server.cfg.DBRoot, "db_storage", "message", "message_1.db")); err != nil {
					t.Fatal(err)
				}
			} else {
				delete(f.server.cfg.Keys, fmt.Sprintf("%032x", 2))
			}
			snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(f.inspected.Tables), AllowedStatuses: []int64{0}})
			if err == nil {
				snapshot.Close()
				t.Fatal("部分打开不能成为完整快照")
			}
		})
	}
}

func TestNotAloneSnapshotCloseCancelsInflightNativeBeforeClosingConnection(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	// 合成慢查询只用于证明在途native调用完成前不会关闭句柄；不查询真实资料。
	if err := f.writers[0].Exec(`DROP TABLE Name2Id;CREATE VIEW Name2Id AS WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT 2 AS rowid,CASE WHEN sum(x)>0 THEN 'friend-a' END AS user_name FROM n;`); err != nil {
		t.Fatal(err)
	}
	// 此处DDL是反例准备的一部分；新结构必须先重新检查，再测试在途取消。
	session := newNotaloneHistorySession(f.server)
	session.selected = &f.selected
	var inspectErr error
	f.inspected, inspectErr = session.inspect(context.Background())
	if inspectErr != nil {
		t.Fatal(inspectErr)
	}
	snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(f.inspected.Tables), AllowedStatuses: []int64{0}})
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	closed := make(chan error, 1)
	timer := time.AfterFunc(20*time.Millisecond, func() { closed <- snapshot.Close() })
	defer timer.Stop()
	started := time.Now()
	page, err := snapshot.Page(context.Background(), "")
	if err == nil || len(page.Records) != 0 {
		t.Fatal("取消在途页不得返回任何部分正文")
	}
	if time.Since(started) > 2*time.Second {
		t.Fatal("在途native查询未有界取消")
	}
	if err = <-closed; err != nil {
		t.Fatal(err)
	}
	result, err := f.writers[0].QueryBounded(context.Background(), 1, "PRAGMA wal_checkpoint(TRUNCATE)")
	if err != nil || len(result) != 1 || rowInt64(result[0], "busy") != 0 {
		t.Fatalf("并发Close未释放固定reader：%#v %v", result, err)
	}
}

func TestNotAloneSnapshotLifetimeContextClosesHeldReaders(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	life, cancel := context.WithCancel(context.Background())
	defer cancel()
	snapshot, err := newNotaloneSnapshot(life, f.server, f.selected, f.inspected, notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(f.inspected.Tables), AllowedStatuses: []int64{0}})
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	cancel()
	if err = snapshot.Check(); err == nil {
		t.Fatal("寿命取消后仍宣称连续")
	}
	result, err := f.writers[0].QueryBounded(context.Background(), 1, "PRAGMA wal_checkpoint(TRUNCATE)")
	if err != nil || len(result) != 1 || rowInt64(result[0], "busy") != 0 {
		t.Fatalf("寿命取消未释放reader：%#v %v", result, err)
	}
}

func TestNotAloneSnapshotSameShapeDDLRequiresFreshTableInstance(t *testing.T) {
	for _, mode := range []string{"same-table-recreated", "unrelated-schema-change"} {
		t.Run(mode, func(t *testing.T) {
			f := newNotaloneSnapshotFixture(t, 1)
			before := f.inspected.Tables[0]
			if before.SchemaVersion == "" || before.RootPage == "" {
				t.Fatal("结构检查缺少声明实例字段")
			}
			definitions, err := f.writers[0].QueryBounded(context.Background(), 1, "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", f.table)
			if err != nil || len(definitions) != 1 {
				t.Fatalf("合成结构不可用：%v", err)
			}
			if mode == "same-table-recreated" {
				err = f.writers[0].Exec("DROP TABLE " + quoteIdent(f.table) + ";" + rowString(definitions[0], "sql"))
			} else {
				err = f.writers[0].Exec("CREATE TABLE synthetic_other_schema(id INTEGER)")
			}
			if err != nil {
				t.Fatal(err)
			}
			after, err := inspectNotaloneTable(context.Background(), f.writers[0], f.table, before.Partition)
			if err != nil {
				t.Fatal(err)
			}
			if before.SQLFingerprint != after.SQLFingerprint || notaloneSnapshotShape([]notaloneTableSchema{before}) != notaloneSnapshotShape([]notaloneTableSchema{after}) {
				t.Fatal("反例必须保持目标表结构shape相同")
			}
			if before.SchemaVersion == after.SchemaVersion || before.Target == after.Target {
				t.Fatal("同shape的DDL没有改变完整实例证明")
			}
			profile := notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(f.inspected.Tables), AllowedStatuses: []int64{0}}
			stale, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, profile)
			if err == nil {
				stale.Close()
				t.Fatal("旧检查不能接受DDL后的新实例")
			}
			if err.Error() != "history_schema_changed" {
				t.Fatalf("旧实例应被明确拒绝：%v", err)
			}
			f.inspected.Tables[0] = after
			fresh, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, profile)
			if err != nil {
				t.Fatalf("同shape的新实例重新检查后应可正常固定：%v", err)
			}
			defer fresh.Close()
			if fresh.Target().Tables[0].Instance != after.Target {
				t.Fatal("目标没有使用最新的完整实例身份")
			}
		})
	}
}

func TestNotAloneSnapshotRejectsLegacyOrIncompleteTableProof(t *testing.T) {
	for _, mode := range []string{"legacy-hash", "missing-schema-version", "missing-root-page"} {
		t.Run(mode, func(t *testing.T) {
			f := newNotaloneSnapshotFixture(t, 1)
			proof := &f.inspected.Tables[0]
			switch mode {
			case "legacy-hash":
				proof.Target = notaloneHash(proof.Partition, f.table)
			case "missing-schema-version":
				proof.SchemaVersion = ""
			case "missing-root-page":
				proof.RootPage = ""
			}
			snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(f.inspected.Tables), AllowedStatuses: []int64{0}})
			if err == nil {
				snapshot.Close()
				t.Fatal("旧或不完整的实例证明不得放行")
			}
			if err.Error() != "history_identity_unverified" {
				t.Fatalf("身份错误分类不明确：%v", err)
			}
		})
	}
}
