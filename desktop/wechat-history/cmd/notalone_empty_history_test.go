package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestNotAloneEmptyHistoryRequiresEveryPinnedAbsentPartition(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 8)
	for _, writer := range f.writers {
		if err := writer.Exec("DROP TABLE " + quoteIdent(f.table)); err != nil {
			t.Fatal(err)
		}
	}
	session := newNotaloneHistorySession(f.server)
	session.selected = &f.selected
	defer session.close()
	inspected, err := session.inspect(context.Background())
	if err != nil {
		t.Fatalf("全部来源缺表应能检查并进入固定快照证明：%v", err)
	}
	if len(inspected.Tables) != 0 || len(inspected.CheckedPartitions) != 8 || inspected.SchemaFingerprint == "" {
		t.Fatal("空目标检查必须覆盖全部分片")
	}
	program := notaloneProgramVersion{"4.0.6", "29387"}
	certification := certifyNotaloneProfile(program, inspected.Tables)
	if certification.ProfileID != "wechat-4.0.6-29387-absent-private-target-v1" || len(certification.DeclaredPrimaryKey) != 0 || !notaloneRuntimeReadCandidate(program, inspected, certification) {
		t.Fatal("缺表必须走独立空目标档，不得伪造主键")
	}
	snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, inspected, *certification.ReadProfile)
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	proof, err := snapshot.FixedSnapshotProof(inspected)
	if err != nil {
		t.Fatal(err)
	}
	if proof.ExpectedPartitionCount != 8 || proof.CompletedPartitionCount != 8 {
		t.Fatal("空目标证明缺少分片")
	}
	for _, part := range proof.Partitions {
		if part.TablePresent || part.Instance != nil || !part.ReaderPinned || !part.SourceInstanceHeld || part.PreSample != part.PostSample {
			t.Fatal("缺表不能伪造表实例或跳过固定读者")
		}
	}
	target := snapshot.Target()
	encodedTarget, _ := json.Marshal(target)
	var targetWire map[string]any
	if err := json.Unmarshal(encodedTarget, &targetWire); err != nil {
		t.Fatal(err)
	}
	if tables, ok := targetWire["tables"].([]any); !ok || len(tables) != 0 {
		t.Fatal("空目标wire必须返回tables:[]，不能变成null")
	}
	if len(target.Partitions) != 8 || len(target.Tables) != 0 || !notaloneSameOrderedStrings(target.CheckedPartitions, inspected.CheckedPartitions) {
		t.Fatal("空目标必须保留经过证明的全部分片")
	}
	page, err := snapshot.Page(context.Background(), "")
	if err != nil || !page.Exhausted || len(page.Records) != 0 || len(page.CompletedPartitions) != 8 || page.ResumeCursor != nil {
		t.Fatalf("完整空终页错误：%#v %v", page, err)
	}
	if certification.ReadProfile.IncrementalTailVerified {
		t.Fatal("空目标不能声称已支持无表到有表增量")
	}
	incomplete := inspected
	incomplete.CheckedPartitions = inspected.CheckedPartitions[:7]
	if _, err := snapshot.FixedSnapshotProof(incomplete); err == nil {
		t.Fatal("缺少分片不得证明空历史")
	}
}

func TestNotAloneEmptyHistorySupportDoesNotInventIncrementalCapability(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 8)
	for _, writer := range f.writers {
		if err := writer.Exec("DROP TABLE " + quoteIdent(f.table)); err != nil {
			t.Fatal(err)
		}
	}
	session := newNotaloneHistorySession(f.server)
	session.selected = &f.selected
	session.program = func(context.Context) (notaloneProgramVersion, error) {
		return notaloneProgramVersion{"4.0.6", "29387"}, nil
	}
	session.sourceProcess = func(context.Context) (notaloneProcessIdentity, error) {
		executable, err := os.Executable()
		if err != nil {
			return notaloneProcessIdentity{}, err
		}
		executable, err = filepath.EvalSymlinks(executable)
		if err != nil {
			return notaloneProcessIdentity{}, err
		}
		return readNotaloneProcessIdentity(os.Getpid(), executable)
	}
	defer session.close()
	report, profile, err := session.support(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "supported" || report.ProfileID != notaloneAbsentPrivateTargetProfile || report.StatusSemantics != "no-message-table-v1" || len(report.DeclaredPrimaryKey) != 0 || report.Capabilities["incrementalTail"] != "unsupported" || report.Capabilities["partitionGrowth"] != "supported" || profile.IncrementalTailVerified {
		t.Fatalf("空目标不能伪造主键或增量能力：%#v", report)
	}
	cached, _, err := session.support(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encodedSupport, _ := json.Marshal(cached)
	var supportWire map[string]any
	if err := json.Unmarshal(encodedSupport, &supportWire); err != nil {
		t.Fatal(err)
	}
	if keys, ok := supportWire["declaredPrimaryKey"].([]any); !ok || len(keys) != 0 {
		t.Fatal("重复support的wire必须保留declaredPrimaryKey:[]")
	}
	if session.snapshot == nil {
		t.Fatal("支持报告必须持有实际固定的缺表证据")
	}
	proof, err := session.snapshot.FixedSnapshotProof(*session.inspected)
	if err != nil || proof.CompletedPartitionCount != 8 {
		t.Fatalf("空报告缺少全部分片证明：%v", err)
	}
}

func TestNotAloneEmptyHistoryRejectsUnreadableChangedAndPresentSources(t *testing.T) {
	for _, mode := range []string{"unreadable", "changed", "present"} {
		t.Run(mode, func(t *testing.T) {
			f := newNotaloneSnapshotFixture(t, 2)
			for _, writer := range f.writers {
				if err := writer.Exec("DROP TABLE " + quoteIdent(f.table)); err != nil {
					t.Fatal(err)
				}
			}
			session := newNotaloneHistorySession(f.server)
			session.selected = &f.selected
			defer session.close()
			inspected, err := session.inspect(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if mode == "unreadable" {
				f.server.cfg.Keys = map[string]string{}
				if _, err := session.inspect(context.Background()); err == nil {
					t.Fatal("无法打开分片不得当空历史")
				}
				return
			}
			if mode == "present" {
				if err := f.writers[1].Exec("CREATE TABLE " + quoteIdent(f.table) + "(incompatible TEXT)"); err != nil {
					t.Fatal(err)
				}
				actual, err := session.inspect(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				certification := certifyNotaloneProfile(notaloneProgramVersion{"4.0.6", "29387"}, actual.Tables)
				if certification.ProfileID == notaloneAbsentPrivateTargetProfile || notaloneRuntimeReadCandidate(notaloneProgramVersion{"4.0.6", "29387"}, actual, certification) {
					t.Fatal("存在不兼容表不能认证为空")
				}
				return
			}
			certification := certifyNotaloneProfile(notaloneProgramVersion{"4.0.6", "29387"}, inspected.Tables)
			snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, inspected, *certification.ReadProfile)
			if err != nil {
				t.Fatal(err)
			}
			defer snapshot.Close()
			source := filepath.Join(f.server.cfg.DBRoot, "db_storage", "message", "message_1.db")
			if err := os.Rename(source, source+".moved"); err != nil {
				t.Fatal(err)
			}
			if _, err := snapshot.FixedSnapshotProof(inspected); err == nil {
				t.Fatal("来源实例丢失不得证明空历史")
			}
		})
	}
}

func TestNotAloneEmptyHistoryJSONProtocolRevalidatesAfterTerminalPage(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 8)
	for _, writer := range f.writers {
		if err := writer.Exec("DROP TABLE " + quoteIdent(f.table)); err != nil {
			t.Fatal(err)
		}
	}
	notaloneTestDB(t, f.server.cfg.DBRoot, f.server.cfg, "session", "session.db", `CREATE TABLE SessionTable(username TEXT PRIMARY KEY,is_hidden INTEGER);INSERT INTO SessionTable VALUES('friend-a',0);`, "22222222222222222222222222222222")
	notaloneTestDB(t, f.server.cfg.DBRoot, f.server.cfg, "contact", "contact.db", `CREATE TABLE contact(username TEXT PRIMARY KEY,remark TEXT,nick_name TEXT,verify_flag INTEGER);INSERT INTO contact VALUES('friend-a','合成目标','',0);`, "33333333333333333333333333333333")
	encodedConfig, _ := json.Marshal(f.server.cfg)
	if err := os.WriteFile(os.Getenv("WECHAT_CLI_CONFIG"), encodedConfig, 0600); err != nil {
		t.Fatal(err)
	}
	session := newNotaloneHistorySession(f.server)
	bound, err := session.bindMetadata(context.Background(), "friend-a")
	if err != nil {
		t.Fatal(err)
	}
	f.selected = bound
	session.program = func(context.Context) (notaloneProgramVersion, error) {
		return notaloneProgramVersion{"4.0.6", "29387"}, nil
	}
	session.sourceProcess = func(context.Context) (notaloneProcessIdentity, error) {
		executable, err := os.Executable()
		if err != nil {
			return notaloneProcessIdentity{}, err
		}
		executable, err = filepath.EvalSymlinks(executable)
		if err != nil {
			return notaloneProcessIdentity{}, err
		}
		return readNotaloneProcessIdentity(os.Getpid(), executable)
	}
	input, writer := io.Pipe()
	reader, output := io.Pipe()
	done := make(chan struct{})
	go func() { runNotaloneHistorySession(session, input, output); _ = output.Close(); close(done) }()
	t.Cleanup(func() { _ = writer.Close(); _ = reader.Close(); <-done })
	encoder, decoder := json.NewEncoder(writer), json.NewDecoder(reader)
	request := func(operation, consent, target string) map[string]any {
		t.Helper()
		if err := encoder.Encode(notaloneHistoryRequest{Operation: operation, Account: f.selected.Account, Conversation: f.selected.Conversation, Consent: consent, Target: target}); err != nil {
			t.Fatal(err)
		}
		response := map[string]any{}
		if err := decoder.Decode(&response); err != nil {
			t.Fatal(err)
		}
		if response["ok"] != true {
			t.Fatalf("正常空历史RPC %s 失败：%#v", operation, response["error"])
		}
		data, ok := response["data"].(map[string]any)
		if !ok {
			t.Fatal("响应缺少data对象")
		}
		return data
	}
	assertEmptyArray := func(data map[string]any, key string) {
		t.Helper()
		values, ok := data[key].([]any)
		if !ok || len(values) != 0 {
			t.Fatalf("JSON协议必须保留%s:[]：%#v", key, data[key])
		}
	}
	support := request("support", "selected-schema-v1", "")
	assertEmptyArray(support, "declaredPrimaryKey")
	target := request("target", "selected-history-v1", "")
	assertEmptyArray(target, "tables")
	descriptor, ok := target["descriptor"].(string)
	if !ok {
		t.Fatal("缺少固定目标")
	}
	page := request("page", "selected-history-v1", descriptor)
	assertEmptyArray(page, "records")
	if page["exhausted"] != true || len(page["completedPartitions"].([]any)) != 8 {
		t.Fatal("空终页没有完成全部分片")
	}
	if _, exists := page["resumeCursor"]; exists {
		t.Fatal("空终页不能声称增量游标")
	}
	after := request("support", "selected-schema-v1", "")
	assertEmptyArray(after, "declaredPrimaryKey")
	if after["status"] != "supported" || after["profileId"] != notaloneAbsentPrivateTargetProfile {
		t.Fatal("终页后的支持报告不得失效")
	}
	if session.snapshot != nil {
		t.Fatal("终页后不得保留已关闭固定快照")
	}
}
