package main

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

// 来自本票匿名实际结构的固定镜像，仅结构事实，不含目标标识或消息值。
const notaloneObservedShape = `{"role":"private_message","columns":[{"name":"local_id","type":"INTEGER","primaryKey":1},{"name":"server_id","type":"INTEGER"},{"name":"local_type","type":"INTEGER"},{"name":"sort_seq","type":"INTEGER"},{"name":"real_sender_id","type":"INTEGER"},{"name":"create_time","type":"INTEGER"},{"name":"status","type":"INTEGER"},{"name":"upload_status","type":"INTEGER"},{"name":"download_status","type":"INTEGER"},{"name":"server_seq","type":"INTEGER"},{"name":"origin_source","type":"INTEGER"},{"name":"source","type":"TEXT"},{"name":"message_content","type":"TEXT"},{"name":"compress_content","type":"TEXT"},{"name":"packed_info_data","type":"BLOB"},{"name":"WCDB_CT_message_content","type":"INTEGER"},{"name":"WCDB_CT_source","type":"INTEGER"}],"indexes":[{"unique":false,"origin":"c","partial":false,"columns":[{"sequence":0,"name":"local_type","collation":"BINARY","key":true},{"sequence":1,"name":"sort_seq","collation":"BINARY","key":true},{"sequence":2,"name":"","collation":"BINARY","key":false}]},{"unique":false,"origin":"c","partial":false,"columns":[{"sequence":0,"name":"sort_seq","collation":"BINARY","key":true},{"sequence":1,"name":"","collation":"BINARY","key":false}]},{"unique":false,"origin":"c","partial":false,"columns":[{"sequence":0,"name":"server_id","collation":"BINARY","key":true},{"sequence":1,"name":"","collation":"BINARY","key":false}]},{"unique":false,"origin":"c","partial":false,"columns":[{"sequence":0,"name":"real_sender_id","collation":"BINARY","key":true},{"sequence":1,"name":"","collation":"BINARY","key":false}]}],"declaredPrimaryKey":["local_id"],"autoIncrement":true}`

func notaloneProfileFixture(t *testing.T) notaloneTableSchema {
	t.Helper()
	var table notaloneTableSchema
	if err := json.Unmarshal([]byte(notaloneObservedShape), &table); err != nil {
		t.Fatal(err)
	}
	return table
}

func TestNotAloneProfileAnonymousShapeDoesNotGrantHistory(t *testing.T) {
	table := notaloneProfileFixture(t)
	report := certifyNotaloneProfile(notaloneProgramVersion{Version: "4.0.6", Build: "29387"}, []notaloneTableSchema{table, table})
	for _, capability := range []string{"programVersion", "exactSchema", "declaredLocalKey", "automaticAllocation", "statusColumn"} {
		if report.Capabilities[capability] != "supported" {
			t.Fatalf("已核验结构能力未报告: %s=%s", capability, report.Capabilities[capability])
		}
	}
	if report.Capabilities["serverIdUniqueConstraint"] != "unsupported" {
		t.Fatal("非唯一索引被误报为唯一约束")
	}
	for _, capability := range []string{"statusSemantics", "sourceLifecycle", "restartContinuity", "recoveryMapping", "snapshotBarrier", "partitionCoverage", "normalHistory"} {
		if report.Capabilities[capability] != "unverified" {
			t.Fatalf("缺证能力被伪认证: %s=%s", capability, report.Capabilities[capability])
		}
	}
	if report.Status != "unverified" || report.StatusSemantics != "observed_subset_only" || report.Capabilities["statusSemantics"] != "unverified" || report.Capabilities["normalHistory"] != "unverified" {
		t.Fatal("部分实测状态不能提升整体状态语义或正常历史资格")
	}
	if report.CanReadHistory || len(report.ReadProfile.StatusRules) != 4 || !report.ReadProfile.StatusSemanticsVerified || report.ReadProfile.IncrementalTailVerified || report.ReadProfile.BoundarySemanticsVerified || report.ReadProfile.OpaqueStatusPolicy != "" || report.SchemaShapeFingerprint == "" {
		t.Fatal("profile应仅包含已实测的精确状态元组，其他能力继续关闭")
	}
}

func TestNotAloneObservedStatusTuplesAreNarrow(t *testing.T) {
	table := notaloneProfileFixture(t)
	report := certifyNotaloneProfile(notaloneProgramVersion{Version: "4.0.6", Build: "29387"}, []notaloneTableSchema{table, table})
	profile := *report.ReadProfile
	allocated := "123456"
	for _, tc := range []struct {
		name      string
		localType int64
		sender    string
		status    int64
		serverID  *string
		state     notaloneMessageState
		matched   bool
		eligible  bool
	}{
		{name: "observed sent tuple", localType: 1, sender: "owner", status: 2, serverID: &allocated, state: notaloneMessageSent, matched: true, eligible: true},
		{name: "observed historical sent tuple", localType: 1, sender: "owner", status: 3, serverID: &allocated, state: notaloneMessageSent, matched: true, eligible: true},
		{name: "observed received tuple", localType: 1, sender: "contact", status: 3, serverID: &allocated, state: notaloneMessageReceived, matched: true, eligible: true},
		{name: "observed historical received tuple", localType: 1, sender: "contact", status: 4, serverID: &allocated, state: notaloneMessageReceived, matched: true, eligible: true},
		{name: "system metadata does not prove recall", localType: 10000, sender: "unknown", status: 4, serverID: &allocated, state: notaloneMessageUnknown},
		{name: "owner system metadata does not prove recall", localType: 10000, sender: "owner", status: 4, serverID: &allocated, state: notaloneMessageUnknown},
		{name: "contact system metadata does not prove recall", localType: 10000, sender: "contact", status: 4, serverID: &allocated, state: notaloneMessageUnknown},
		{name: "sent without allocated server id", localType: 1, sender: "owner", status: 2, state: notaloneMessageSent, matched: true},
		{name: "historical sent without allocated server id", localType: 1, sender: "owner", status: 3, state: notaloneMessageSent, matched: true},
		{name: "received without allocated server id", localType: 1, sender: "contact", status: 3, state: notaloneMessageReceived, matched: true},
		{name: "historical received without allocated server id", localType: 1, sender: "contact", status: 4, state: notaloneMessageReceived, matched: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			decision := notaloneClassifyStatus(profile, tc.localType, tc.sender, tc.status, tc.serverID)
			if decision.State != tc.state || decision.RuleMatched != tc.matched || decision.HistoryEligible != tc.eligible {
				t.Fatalf("unexpected tuple decision: %+v", decision)
			}
		})
	}
}

func TestNotAloneRuntimeCandidateRequiresExactObservedProfile(t *testing.T) {
	table := notaloneProfileFixture(t)
	tables := []notaloneTableSchema{table, table}
	program := notaloneProgramVersion{Version: "4.0.6", Build: "29387"}
	inspection := notaloneInspection{SchemaFingerprint: "schema-fingerprint", Tables: tables}
	certification := certifyNotaloneProfile(program, tables)
	if !notaloneRuntimeReadCandidate(program, inspection, certification) {
		t.Fatal("固定版本、精确结构与四条已观察文字状态规则应可进入运行时快照证明")
	}
	broad := *certification.ReadProfile
	broad.StatusRules = append(broad.StatusRules, notaloneStatusRule{LocalType: 1, Sender: "contact", Status: 4, State: notaloneMessageRecalled})
	certification.ReadProfile = &broad
	if notaloneRuntimeReadCandidate(program, inspection, certification) {
		t.Fatal("未经观察的contact/status=4不得升级profile")
	}
	certification = certifyNotaloneProfile(program, tables)
	certification.ProfileID = "other-profile"
	if notaloneRuntimeReadCandidate(program, inspection, certification) {
		t.Fatal("未知profile不能借用已观察规则")
	}
}

func TestNotAloneProfileUnknownShapeOrVersionRemainsUnverified(t *testing.T) {
	for _, mutation := range []string{"version", "build", "column_type", "hidden", "extra_trigger", "composite_key", "no_autoincrement", "unique_index", "partial_index", "different_role", "mixed_shards"} {
		t.Run(mutation, func(t *testing.T) {
			version := notaloneProgramVersion{Version: "4.0.6", Build: "29387"}
			table := notaloneProfileFixture(t)
			tables := []notaloneTableSchema{table}
			switch mutation {
			case "version":
				version.Version = "4.1.0"
			case "build":
				version.Build = "29388"
			case "column_type":
				table.Columns[12].Type = "BLOB"
			case "hidden":
				table.Columns[0].Hidden = 1
			case "extra_trigger":
				table.TriggerFingerprints = []string{"anonymous-trigger"}
			case "composite_key":
				table.DeclaredPrimaryKey = []string{"local_id", "server_id"}
			case "no_autoincrement":
				table.AutoIncrement = false
			case "unique_index":
				table.Indexes[2].Unique = true
			case "partial_index":
				table.Indexes[2].Partial = true
			case "different_role":
				table.Role = "other"
			case "mixed_shards":
				other := notaloneProfileFixture(t)
				other.Columns[0].PrimaryKey = 0
				tables = append(tables, other)
			}
			tables[0] = table
			report := certifyNotaloneProfile(version, tables)
			if report.Capabilities["exactSchema"] != "unverified" || report.CanReadHistory || report.SchemaShapeFingerprint != "" {
				t.Fatal("未知版本或结构被自动放行")
			}
		})
	}
}

func TestNotAloneProgramVersionValidation(t *testing.T) {
	for _, version := range []notaloneProgramVersion{{Version: "4.0.6", Build: "29387"}, {Version: "4.1.0", Build: "30000"}} {
		if !notaloneValidProgramVersion(version) {
			t.Fatal("合法程序版本被拒绝")
		}
	}
	for _, version := range []notaloneProgramVersion{{}, {Version: "4.0.6\nsecret", Build: "29387"}, {Version: "4.0.6", Build: "29/path"}} {
		if notaloneValidProgramVersion(version) {
			t.Fatal("非法版本被接受")
		}
	}
}

func TestNotAloneProfileInstalledProgramVersion(t *testing.T) {
	if os.Getenv("NOTALONE_TEST_WECHAT_PROGRAM") != "1" {
		t.Skip("未开启固定安装包版本的只读验收")
	}
	version, err := readNotaloneProgramVersion(context.Background())
	if err != nil || !notaloneValidProgramVersion(version) {
		t.Fatalf("固定安装包版本读取失败: %v", err)
	}
}
