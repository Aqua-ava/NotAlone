package main

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

func notaloneSenderFixture(t *testing.T, shards int, account string) notaloneSnapshotFixture {
	t.Helper()
	f := newNotaloneSnapshotFixture(t, shards)
	f.server.cfg.Wxid, f.selected.Account = account, account
	data, err := json.Marshal(f.server.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(os.Getenv("WECHAT_CLI_CONFIG"), data, 0600); err != nil {
		t.Fatal(err)
	}
	for _, writer := range f.writers {
		if err = writer.Exec("UPDATE " + quoteIdent(f.table) + " SET real_sender_id=1"); err != nil {
			t.Fatal(err)
		}
	}
	refreshNotaloneMetadataInspection(t, &f)
	return f
}

func TestNotAloneSenderDeviceSuffixKeepsScopeAndMapsThreeProjections(t *testing.T) {
	for _, projection := range []string{"page", "metadata", "test-metadata"} {
		t.Run(projection, func(t *testing.T) {
			f := notaloneSenderFixture(t, 1, "synthetic-owner_abcd")
			var sender string
			switch projection {
			case "page":
				snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(f.inspected.Tables), AllowedStatuses: []int64{0}})
				if err != nil {
					t.Fatal(err)
				}
				defer snapshot.Close()
				page, err := snapshot.Page(context.Background(), "")
				if err != nil || len(page.Records) != 1 {
					t.Fatalf("分页失败:%v", err)
				}
				sender = page.Records[0].Sender
			case "metadata":
				record, err := observeNotaloneMessageMetadata(context.Background(), f.server, f.selected, f.inspected, "text")
				if err != nil || record == nil {
					t.Fatalf("单条元数据失败:%v", err)
				}
				sender = record.Sender
			case "test-metadata":
				watch := newNotaloneTestMetadataWatch()
				defer watch.Close()
				if _, err := watch.observe(context.Background(), f.server, f.selected, f.inspected, "arm"); err != nil {
					t.Fatal(err)
				}
				if err := f.writers[0].Exec("INSERT INTO " + quoteIdent(f.table) + "(local_type,real_sender_id,status) VALUES(1,1,0)"); err != nil {
					t.Fatal(err)
				}
				report, err := watch.observe(context.Background(), f.server, f.selected, f.inspected, "next")
				if err != nil || report.LockedCount != 1 || len(report.Records) != 1 || report.Records[0] == nil {
					t.Fatalf("逐阶段元数据失败:%v", err)
				}
				sender = report.Records[0].Sender
			}
			if sender != "owner" || f.selected.Account != "synthetic-owner_abcd" || f.server.cfg.Wxid != f.selected.Account || f.inspected.ScopeDigest != notaloneHash(f.selected.Account, f.selected.Conversation) {
				t.Fatalf("sender需使用官方selfWxid，但完整scope不能改变:%q", sender)
			}
		})
	}
}

func TestNotAloneTestSenderPreflightRejectsUnprovenMappings(t *testing.T) {
	for _, sample := range []struct{ mode, account, code string }{
		{"missing-shard-owner", "synthetic-owner_abcd", "history_test_sender_unverified"},
		{"duplicate-owner", "synthetic-owner_abcd", "history_test_sender_ambiguous"},
		{"raw-conflict", "synthetic-owner_abcd", "history_test_sender_ambiguous"},
		{"contact-overlap", "friend-a", "history_test_sender_unverified"},
		{"invalid-owner", "invalid owner", "history_test_sender_unverified"},
		{"missing-pk", "synthetic-owner_abcd", "history_test_key_unverified"},
	} {
		t.Run(sample.mode, func(t *testing.T) {
			f := notaloneSenderFixture(t, 2, sample.account)
			var sql string
			switch sample.mode {
			case "missing-shard-owner":
				sql = "DELETE FROM Name2Id WHERE user_name='synthetic-owner'"
			case "duplicate-owner":
				sql = "INSERT INTO Name2Id(user_name) VALUES('synthetic-owner')"
			case "raw-conflict":
				sql = "INSERT INTO Name2Id(user_name) VALUES('synthetic-owner_abcd')"
			case "missing-pk":
				f.inspected.Tables[0].DeclaredPrimaryKey = nil
			}
			if sql != "" {
				if err := f.writers[1].Exec(sql); err != nil {
					t.Fatal(err)
				}
			}
			watch := newNotaloneTestMetadataWatch()
			defer watch.Close()
			report, err := watch.observe(context.Background(), f.server, f.selected, f.inspected, "arm")
			if err == nil || err.Error() != sample.code || !watch.closed || watch.baseline != nil || report.LockedCount != 0 {
				t.Fatalf("无法证明的sender/主键不能arm:%#v %v", report, err)
			}
			if _, err = watch.observe(context.Background(), f.server, f.selected, f.inspected, "arm"); err == nil {
				t.Fatal("失败preflight不能重新arm")
			}
			if watch.guard != nil && watch.guard.Check() == nil {
				t.Fatal("失败preflight必须释放长期guard")
			}
		})
	}
}

func TestNotAloneTestMetadataSafeCaptureReasons(t *testing.T) {
	for _, sample := range []struct{ mode, values, code string }{
		{"many", "(1,1),(1,1)", "history_test_new_rows_ambiguous"},
		{"contact", "(1,2)", "history_test_sender_unverified"},
		{"unknown", "(1,99)", "history_test_sender_unverified"},
		{"type", "(3,1)", "history_test_type_unverified"},
		{"null-type", "(NULL,1)", "history_test_type_unverified"},
	} {
		t.Run(sample.mode, func(t *testing.T) {
			f := notaloneSenderFixture(t, 1, "synthetic-owner_abcd")
			watch := newNotaloneTestMetadataWatch()
			defer watch.Close()
			if _, err := watch.observe(context.Background(), f.server, f.selected, f.inspected, "arm"); err != nil {
				t.Fatal(err)
			}
			if err := f.writers[0].Exec("INSERT INTO " + quoteIdent(f.table) + "(local_type,real_sender_id) VALUES" + sample.values); err != nil {
				t.Fatal(err)
			}
			report, err := watch.observe(context.Background(), f.server, f.selected, f.inspected, "next")
			if err == nil || err.Error() != sample.code || !watch.closed || len(watch.locked) != 0 || report.LockedCount != 0 {
				t.Fatalf("失败必须仅返回固定原因并终止:%#v %v", report, err)
			}
		})
	}
}
