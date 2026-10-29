package main

import (
	"bufio"
	"context"
	"encoding/json"
	"github.com/r266-tech/wx-cli/v2/internal/config"
	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
	"github.com/r266-tech/wx-cli/v2/internal/wxkind"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

type notaloneHistoryRequest struct {
	Operation    string `json:"op"`
	Account      string `json:"account,omitempty"`
	Conversation string `json:"conversation,omitempty"`
	DisplayName  string `json:"displayName,omitempty"`
	Consent      string `json:"consent,omitempty"`
	Target       string `json:"target,omitempty"`
	Cursor       string `json:"cursor,omitempty"`
}
type notaloneResolved struct {
	Account          string `json:"accountKey"`
	Conversation     string `json:"conversationKey"`
	DisplayName      string `json:"displayName"`
	SourceGeneration string `json:"sourceGeneration"`
}
type notaloneInspection struct {
	Format            string                `json:"format"`
	Status            string                `json:"status"`
	ScopeDigest       string                `json:"scopeDigest"`
	SourceGeneration  string                `json:"sourceGeneration"`
	SchemaFingerprint string                `json:"schemaFingerprint"`
	Tables            []notaloneTableSchema `json:"tables"`
	CheckedPartitions []string              `json:"checkedPartitions"`
}
type notaloneHistorySession struct {
	server   *server
	selected *notaloneResolved
	guards   []*notaloneSourceGuard
}

func newNotaloneHistorySession(s *server) *notaloneHistorySession {
	return &notaloneHistorySession{server: s}
}
func (h *notaloneHistorySession) close() {
	for _, g := range h.guards {
		_ = g.Close()
	}
	h.guards = nil
}

var notaloneIdentity = regexp.MustCompile(`^[A-Za-z0-9_.@-]{1,255}$`)

// 仅使用现有schema2配置；不运行探钥、Keychain授权、缓存刷新或路径RPC。
func (h *notaloneHistorySession) initialize() error {
	if err := h.server.ensure(); err != nil {
		return notaloneFailure("history_account_unavailable")
	}
	if err := wcdb.BootstrapBounded(h.server.wcdbPath); err != nil {
		return notaloneFailure("history_native_unavailable")
	}
	return nil
}
func (h *notaloneHistorySession) currentAccount() error {
	current, err := config.Load()
	if err != nil || current.Wxid != h.server.cfg.Wxid || current.DBRoot != h.server.cfg.DBRoot || !current.Ready() {
		return notaloneFailure("history_account_changed")
	}
	for _, g := range h.guards {
		if g.Check() != nil {
			return notaloneFailure("history_source_changed")
		}
	}
	return nil
}
func (h *notaloneHistorySession) resolve(ctx context.Context, name string) (notaloneResolved, error) {
	result := notaloneResolved{}
	if name == "" || len(name) > 255 || strings.ContainsAny(name, "\x00\r\n") {
		return result, notaloneFailure("history_request_invalid")
	}
	contact, err := h.server.openDBNoRefresh("contact", "contact.db")
	if err != nil {
		return result, notaloneFailure("history_metadata_unavailable")
	}
	defer contact.Close()
	rows, err := contact.QueryBounded(ctx, 16, `SELECT username,verify_flag,COALESCE(NULLIF(remark,''),NULLIF(nick_name,''),username) AS display_name FROM contact WHERE COALESCE(NULLIF(remark,''),NULLIF(nick_name,''),username)=? OR username=? LIMIT 16`, name, name)
	if err != nil || len(rows) != 1 {
		return result, notaloneFailure("history_target_ambiguous")
	}
	username := rowString(rows[0], "username")
	if !notaloneIdentity.MatchString(username) || agentChatType(username, wxkind.ClassifyUsername(username), rowInt64(rows[0], "verify_flag") != 0) != "private" {
		return result, notaloneFailure("history_target_not_private")
	}
	session, err := h.server.openDBNoRefresh("session", "session.db")
	if err != nil {
		return result, notaloneFailure("history_metadata_unavailable")
	}
	defer session.Close()
	sessions, err := session.QueryBounded(ctx, 2, "SELECT username FROM SessionTable WHERE username=? AND COALESCE(is_hidden,0)=0 LIMIT 2", username)
	if err != nil || len(sessions) != 1 {
		return result, notaloneFailure("history_target_unverified")
	}
	result = notaloneResolved{Account: h.server.cfg.Wxid, Conversation: username, DisplayName: rowString(rows[0], "display_name")}
	return result, nil
}
func (h *notaloneHistorySession) bindMetadata(ctx context.Context, name string) (notaloneResolved, error) {
	result, err := h.resolve(ctx, name)
	if err != nil {
		return result, err
	}
	if h.selected != nil && (h.selected.Account != result.Account || h.selected.Conversation != result.Conversation || h.selected.DisplayName != result.DisplayName) {
		return result, notaloneFailure("history_scope_changed")
	}
	if h.selected == nil {
		var fingerprints []string
		for _, part := range []struct{ dir, file string }{{"session", "session.db"}, {"contact", "contact.db"}} {
			directory := filepath.Join(h.server.cfg.DBRoot, "db_storage", part.dir)
			guard, e := newNotaloneSourceGuard(directory, []string{filepath.Join(directory, part.file)})
			if e != nil {
				h.close()
				return result, notaloneFailure("history_source_unverified")
			}
			h.guards = append(h.guards, guard)
			fingerprints = append(fingerprints, guard.Fingerprint())
		}
		result.SourceGeneration = notaloneHash(result.Account, strings.Join(fingerprints, "|"))
		h.selected = &result
	} else {
		result.SourceGeneration = h.selected.SourceGeneration
	}
	return result, h.currentAccount()
}
func (h *notaloneHistorySession) inspect(ctx context.Context) (notaloneInspection, error) {
	result := notaloneInspection{Format: "wechat-message-schema-v1", Status: "unverified", ScopeDigest: notaloneHash(h.selected.Account, h.selected.Conversation), SourceGeneration: h.selected.SourceGeneration, Tables: []notaloneTableSchema{}, CheckedPartitions: []string{}}
	directory := filepath.Join(h.server.cfg.DBRoot, "db_storage", "message")
	entries, err := os.ReadDir(directory)
	if err != nil {
		return result, notaloneFailure("history_shards_unavailable")
	}
	var files []string
	for _, entry := range entries {
		if !entry.IsDir() && msgShardRE.MatchString(entry.Name()) {
			files = append(files, filepath.Join(directory, entry.Name()))
		}
	}
	if len(files) == 0 || len(files) > 128 {
		return result, notaloneFailure("history_shards_unavailable")
	}
	sort.Strings(files)
	guard, err := newNotaloneSourceGuard(directory, files)
	if err != nil {
		return result, notaloneFailure("history_source_unverified")
	}
	defer guard.Close()
	table := "Msg_" + talkerHash(h.selected.Conversation)
	for _, file := range files {
		if guard.Check() != nil {
			return result, notaloneFailure("history_source_changed")
		}
		db, e := h.server.openDBNoRefresh("message", filepath.Base(file))
		if e != nil {
			return result, notaloneFailure("history_shard_unavailable")
		}
		partition, e := guard.FileFingerprint(file)
		if e != nil {
			db.Close()
			return result, notaloneFailure("history_source_changed")
		}
		present, e := db.QueryBounded(ctx, 2, "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?", table)
		if e != nil {
			db.Close()
			return result, notaloneFailure("history_schema_unavailable")
		}
		if len(present) > 0 {
			schema, e := inspectNotaloneTable(ctx, db, table, partition)
			if e != nil {
				db.Close()
				return result, e
			}
			result.Tables = append(result.Tables, schema)
		}
		db.Close()
		result.CheckedPartitions = append(result.CheckedPartitions, partition)
	}
	if len(result.Tables) == 0 {
		return result, notaloneFailure("history_target_table_missing")
	}
	if guard.Check() != nil || h.currentAccount() != nil {
		return result, notaloneFailure("history_source_changed")
	}
	encoded, _ := json.Marshal(result.Tables)
	result.SchemaFingerprint = notaloneHash(string(encoded), strings.Join(result.CheckedPartitions, "|"))
	return result, nil
}
func (h *notaloneHistorySession) handle(ctx context.Context, r notaloneHistoryRequest) (any, error) {
	if r.Operation == "resolve" {
		if r.Consent != "selected-metadata-v1" || r.DisplayName == "" || r.Account != "" || r.Conversation != "" || r.Target != "" || r.Cursor != "" {
			return nil, notaloneFailure("history_request_invalid")
		}
	} else if r.Operation == "inspect" {
		if r.Consent != "selected-schema-v1" || !notaloneIdentity.MatchString(r.Account) || !notaloneIdentity.MatchString(r.Conversation) || r.DisplayName != "" || r.Target != "" || r.Cursor != "" {
			return nil, notaloneFailure("history_request_invalid")
		}
	} else {
		return nil, notaloneFailure("history_operation_unsupported")
	}
	if err := h.initialize(); err != nil {
		return nil, err
	}
	if r.Operation == "resolve" {
		if r.Consent != "selected-metadata-v1" || r.Account != "" || r.Conversation != "" || r.Target != "" || r.Cursor != "" {
			return nil, notaloneFailure("history_request_invalid")
		}
		return h.bindMetadata(ctx, r.DisplayName)
	}
	if h.selected == nil || r.Account != h.selected.Account || r.Conversation != h.selected.Conversation || r.DisplayName != "" {
		return nil, notaloneFailure("history_scope_unverified")
	}
	if err := h.currentAccount(); err != nil {
		return nil, err
	}
	if _, err := h.bindMetadata(ctx, h.selected.Conversation); err != nil {
		return nil, err
	}
	if r.Operation == "inspect" && r.Consent == "selected-schema-v1" && r.Target == "" && r.Cursor == "" {
		return h.inspect(ctx)
	}
	return nil, notaloneFailure("history_operation_unsupported")
}
func runNotaloneHistoryWithServer(s *server, input io.Reader, output io.Writer) {
	session := newNotaloneHistorySession(s)
	defer session.close()
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 131072)
	encoder := json.NewEncoder(output)
	for scanner.Scan() {
		request := notaloneHistoryRequest{}
		decoder := json.NewDecoder(strings.NewReader(scanner.Text()))
		decoder.DisallowUnknownFields()
		err := decoder.Decode(&request)
		var data any
		if err == nil {
			var extra any
			if decoder.Decode(&extra) != io.EOF {
				err = notaloneFailure("history_request_invalid")
			}
		}
		if err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			data, err = session.handle(ctx, request)
			cancel()
		}
		if err != nil {
			code := err.Error()
			if !strings.HasPrefix(code, "history_") {
				code = "history_request_invalid"
			}
			if encoder.Encode(map[string]any{"ok": false, "error": map[string]string{"code": code}}) != nil {
				return
			}
		} else {
			if encoder.Encode(map[string]any{"ok": true, "data": data}) != nil {
				return
			}
		}
	}
}
func runNotaloneHistory(input io.Reader, output io.Writer) {
	runNotaloneHistoryWithServer(&server{}, input, output)
}
