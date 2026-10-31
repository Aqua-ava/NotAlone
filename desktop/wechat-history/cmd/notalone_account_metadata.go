package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/r266-tech/wx-cli/v2/internal/wxkind"
)

const notaloneAccountMetadataProfile = "wechat-4.0.6-29387-account-session-metadata-v1"

// 依据v9匿名实测声明；比较完整列、索引xinfo、主键、自动键及触发器数量，忽略实例编号。
func notaloneAccountMetadataExpected(role string) notaloneTableSchema {
	table := notaloneTableSchema{Role: role, Columns: []notaloneColumn{}, Indexes: []notaloneIndex{}, TriggerFingerprints: []string{}}
	var declaration string
	if role == "session" {
		declaration = "username:TEXT type:INTEGER unread_count:INTEGER unread_first_msg_srv_id:INTEGER unread_first_pat_msg_local_id:INTEGER unread_first_pat_msg_sort_seq:INTEGER is_hidden:INTEGER summary:TEXT draft:TEXT status:INTEGER last_timestamp:INTEGER sort_timestamp:INTEGER last_clear_unread_timestamp:INTEGER last_msg_locald_id:INTEGER last_msg_type:INTEGER last_msg_sub_type:INTEGER last_msg_sender:TEXT last_sender_display_name:TEXT last_msg_ext_type:INTEGER"
		table.DeclaredPrimaryKey = []string{"username"}
	} else if role == "contact" {
		declaration = "id:INTEGER username:TEXT local_type:INTEGER alias:TEXT encrypt_username:TEXT flag:INTEGER delete_flag:INTEGER verify_flag:INTEGER remark:TEXT remark_quan_pin:TEXT remark_pin_yin_initial:TEXT nick_name:TEXT pin_yin_initial:TEXT quan_pin:TEXT big_head_url:TEXT small_head_url:TEXT head_img_md5:TEXT chat_room_notify:INTEGER is_in_chat_room:INTEGER description:TEXT extra_buffer:BLOB chat_room_type:INTEGER"
		table.DeclaredPrimaryKey = []string{"id"}
	}
	for index, field := range strings.Fields(declaration) {
		pair := strings.Split(field, ":")
		column := notaloneColumn{Name: pair[0], Type: pair[1]}
		if index == 0 {
			column.PrimaryKey = 1
		}
		table.Columns = append(table.Columns, column)
	}
	index := func(column, origin string, unique bool) notaloneIndex {
		return notaloneIndex{Unique: unique, Origin: origin, Columns: []notaloneIndexColumn{{Sequence: 0, Name: column, Collation: "BINARY", Key: true}, {Sequence: 1, Collation: "BINARY"}}}
	}
	if role == "session" {
		table.Indexes = []notaloneIndex{index("type", "c", false), index("last_msg_sender", "c", false), index("username", "pk", true)}
	}
	if role == "contact" {
		table.Indexes = []notaloneIndex{index("local_type", "c", false)}
	}
	return table
}
func notaloneAccountMetadataShapeVerified(tables []notaloneTableSchema) bool {
	if len(tables) != 2 {
		return false
	}
	seen := map[string]bool{}
	for _, table := range tables {
		if (table.Role != "session" && table.Role != "contact") || seen[table.Role] || notaloneSnapshotShape([]notaloneTableSchema{table}) != notaloneSnapshotShape([]notaloneTableSchema{notaloneAccountMetadataExpected(table.Role)}) {
			return false
		}
		seen[table.Role] = true
	}
	return true
}

type notaloneAccountMetadataReport struct {
	Format            string  `json:"format"`
	Status            string  `json:"status"`
	Reason            *string `json:"reason"`
	AccountKey        string  `json:"accountKey"`
	IdentityScheme    string  `json:"identityScheme"`
	SourceGeneration  string  `json:"sourceGeneration"`
	SupportProfile    string  `json:"supportProfile"`
	ProgramVersion    string  `json:"programVersion"`
	Build             string  `json:"build"`
	ArtifactSHA256    string  `json:"artifactSha256"`
	WCDBSHA256        string  `json:"wcdbSha256"`
	ConfiguredAccount string  `json:"configuredAccount"`
	Continuity        string  `json:"continuity"`
	NormalHistory     bool    `json:"normalHistory"`
}
type notalonePrivateSessionMetadata struct {
	Username          string `json:"username"`
	DisplayName       string `json:"displayName"`
	Kind              string `json:"kind"`
	IdentityAssurance string `json:"identityAssurance"`
}
type notalonePrivateSessionMetadataReport struct {
	Format   string                           `json:"format"`
	Account  notaloneAccountMetadataReport    `json:"account"`
	Sessions []notalonePrivateSessionMetadata `json:"sessions"`
}

type notaloneAccountSchemaReport struct {
	Format            string                `json:"format"`
	Status            string                `json:"status"`
	AccountKey        string                `json:"accountKey"`
	SourceGeneration  string                `json:"sourceGeneration"`
	SchemaFingerprint string                `json:"schemaFingerprint"`
	Tables            []notaloneTableSchema `json:"tables"`
	NormalHistory     bool                  `json:"normalHistory"`
}

// 仅诊断两个固定元数据表的声明结构，不投影任何联系人或会话记录。
func (h *notaloneHistorySession) inspectAccountSchema(ctx context.Context) (report notaloneAccountSchemaReport, err error) {
	generation, err := h.bindAccountMetadata(ctx)
	if err != nil {
		return report, err
	}
	tables := []notaloneTableSchema{}
	for index, part := range []struct{ dir, file, table string }{{"session", "session.db", "SessionTable"}, {"contact", "contact.db", "contact"}} {
		file := filepath.Join(h.server.cfg.DBRoot, "db_storage", part.dir, part.file)
		partition, e := h.guards[index].FileFingerprint(file)
		if e != nil {
			return report, notaloneFailure("history_source_changed")
		}
		db, e := h.server.openDBNoRefresh(part.dir, part.file)
		if e != nil {
			return report, notaloneFailure("history_metadata_unavailable")
		}
		schema, e := inspectNotaloneTable(ctx, db, part.table, partition)
		db.Close()
		if e != nil {
			return report, e
		}
		schema.Role = part.dir
		tables = append(tables, schema)
	}
	if err = h.currentAccount(); err != nil {
		return report, err
	}
	return notaloneAccountSchemaReport{"wechat-account-schema-v1", "unverified", h.server.cfg.Wxid, generation, notaloneSchemaFingerprint(tables, nil), tables, false}, nil
}

// 只固定显式schema2账号的两个元数据实例；不证明微信进程当前登录态或跨恢复连续性。
func (h *notaloneHistorySession) bindAccountMetadata(ctx context.Context) (generation string, err error) {
	if h.life == nil || h.life.Err() != nil {
		return "", notaloneFailure("history_native_closed")
	}
	if ctx == nil || ctx.Err() != nil {
		return "", notaloneFailure("history_snapshot_cancelled")
	}
	if h.accountGeneration != "" {
		return h.accountGeneration, h.currentAccount()
	}
	base := len(h.guards)
	defer func() {
		if err != nil {
			for _, guard := range h.guards[base:] {
				_ = guard.Close()
			}
			h.guards = h.guards[:base]
		}
	}()
	fingerprints := []string{}
	for _, part := range []struct{ dir, file string }{{"session", "session.db"}, {"contact", "contact.db"}} {
		directory := filepath.Join(h.server.cfg.DBRoot, "db_storage", part.dir)
		guard, e := newNotaloneSourceGuard(directory, []string{filepath.Join(directory, part.file)})
		if e != nil {
			return "", notaloneFailure("history_source_unverified")
		}
		h.guards = append(h.guards, guard)
		fingerprints = append(fingerprints, guard.Fingerprint())
	}
	if err = h.currentAccount(); err != nil {
		return "", err
	}
	h.accountGeneration = notaloneHash(h.server.cfg.Wxid, strings.Join(fingerprints, "|"))
	return h.accountGeneration, nil
}

func (h *notaloneHistorySession) metadataAccount(ctx context.Context) (report notaloneAccountMetadataReport, err error) {
	generation, err := h.bindAccountMetadata(ctx)
	if err != nil {
		return report, err
	}
	program, err := h.program(ctx)
	if err != nil {
		return report, err
	}
	executable, err := os.Executable()
	if err != nil {
		return report, notaloneFailure("history_artifact_unverified")
	}
	cliHash, err := notaloneFileHash(executable)
	if err != nil {
		return report, err
	}
	libraryHash, err := notaloneFileHash(h.server.wcdbPath)
	if err != nil || libraryHash != "4f05cafc4626a142afca1818f0a88c4092a13d5f4c83e30cd5125b558ba0417d" {
		return report, notaloneFailure("history_artifact_unverified")
	}
	reason := "history_metadata_profile_unverified"
	report = notaloneAccountMetadataReport{Format: "wechat-account-metadata-v1", Status: "unverified", Reason: &reason, AccountKey: h.server.cfg.Wxid, IdentityScheme: "wechat.account.v1", SourceGeneration: generation, SupportProfile: notaloneAccountMetadataProfile, ProgramVersion: program.Version, Build: program.Build, ArtifactSHA256: cliHash, WCDBSHA256: libraryHash, ConfiguredAccount: "unverified", Continuity: "held-contact-session-instances", NormalHistory: false}
	if program.Version != "4.0.6" || program.Build != "29387" {
		reason = "history_program_version_uncertified"
	} else {
		before, e := h.inspectAccountSchema(ctx)
		if e != nil {
			return report, e
		}
		if notaloneAccountMetadataShapeVerified(before.Tables) {
			// 只证明固定配置账号可读，不投影username/列表/摘要，也不证明微信前台登录。
			db, e := h.server.openDBNoRefresh("session", "session.db")
			if e != nil {
				return report, notaloneFailure("history_metadata_unavailable")
			}
			_, e = db.QueryBounded(ctx, 1, "SELECT 1 AS readable FROM SessionTable LIMIT 1")
			db.Close()
			if e != nil {
				return report, notaloneFailure("history_metadata_unavailable")
			}
			after, e := h.inspectAccountSchema(ctx)
			if e != nil {
				return report, e
			}
			if before.SchemaFingerprint != after.SchemaFingerprint {
				return report, notaloneFailure("history_schema_changed")
			}
			report.Status, report.ConfiguredAccount, report.Reason = "verified", "verified", nil
		}
	}
	return report, h.currentAccount()
}

func (h *notaloneHistorySession) metadataSessions(ctx context.Context) (report notalonePrivateSessionMetadataReport, err error) {
	account, err := h.metadataAccount(ctx)
	if err != nil {
		return report, err
	}
	if account.Status != "verified" {
		return report, notaloneFailure(*account.Reason)
	}
	session, err := h.server.openDBNoRefresh("session", "session.db")
	if err != nil {
		return report, notaloneFailure("history_metadata_unavailable")
	}
	defer session.Close()
	rows, err := session.QueryBounded(ctx, 5000, "SELECT username FROM SessionTable WHERE is_hidden=0 LIMIT 5001")
	if err != nil {
		return report, notaloneFailure("history_metadata_unavailable")
	}
	contact, err := h.server.openDBNoRefresh("contact", "contact.db")
	if err != nil {
		return report, notaloneFailure("history_metadata_unavailable")
	}
	defer contact.Close()
	seen := map[string]bool{}
	result := []notalonePrivateSessionMetadata{}
	for _, row := range rows {
		username := rowString(row, "username")
		if !notaloneIdentity.MatchString(username) || seen[username] {
			return report, notaloneFailure("history_identity_ambiguous")
		}
		seen[username] = true
		kind := wxkind.ClassifyUsername(username)
		if agentChatType(username, kind, false) != "private" {
			continue
		}
		contacts, e := contact.QueryBounded(ctx, 2, "SELECT username,verify_flag,COALESCE(NULLIF(remark,''),NULLIF(nick_name,''),username) AS display_name FROM contact WHERE username=? LIMIT 2", username)
		if e != nil || len(contacts) != 1 || rowString(contacts[0], "username") != username {
			return report, notaloneFailure("history_identity_unverified")
		}
		verified, known := contacts[0]["verify_flag"].(int64)
		displayName := rowString(contacts[0], "display_name")
		if !known || len(displayName) == 0 || len(displayName) > 255 || !utf8.ValidString(displayName) || strings.ContainsAny(displayName, "\x00\r\n") {
			return report, notaloneFailure("history_identity_unverified")
		}
		if agentChatType(username, kind, verified != 0) != "private" {
			continue
		}
		result = append(result, notalonePrivateSessionMetadata{username, displayName, "private", "verified"})
	}
	after, err := h.metadataAccount(ctx)
	if err != nil {
		return report, err
	}
	if after != account {
		return report, notaloneFailure("history_scope_changed")
	}
	return notalonePrivateSessionMetadataReport{"wechat-private-session-metadata-v1", account, result}, nil
}
