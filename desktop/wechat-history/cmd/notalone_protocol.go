package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	Kind         string `json:"kind,omitempty"`
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
type notaloneMetadataReport struct {
	Format            string                       `json:"format"`
	Status            string                       `json:"status"`
	ScopeDigest       string                       `json:"scopeDigest"`
	SourceGeneration  string                       `json:"sourceGeneration"`
	SchemaFingerprint string                       `json:"schemaFingerprint"`
	Kind              string                       `json:"kind"`
	CheckedPartitions []string                     `json:"checkedPartitions"`
	Record            *notaloneMetadataObservation `json:"record"`
}
type notaloneHistorySession struct {
	server       *server
	selected     *notaloneResolved
	guards       []*notaloneSourceGuard
	life         context.Context
	cancel       context.CancelFunc
	snapshot     *notaloneSnapshot
	inspected    *notaloneInspection
	program      func(context.Context) (notaloneProgramVersion, error)
	certify      func(notaloneProgramVersion, []notaloneTableSchema) notaloneProfileCertification
	testMetadata *notaloneTestMetadataWatch
}

func newNotaloneHistorySession(s *server) *notaloneHistorySession {
	life, cancel := context.WithCancel(context.Background())
	return &notaloneHistorySession{server: s, life: life, cancel: cancel, program: readNotaloneProgramVersion, certify: certifyNotaloneProfile}
}
func (h *notaloneHistorySession) close() {
	h.cancel()
	if h.testMetadata != nil {
		_ = h.testMetadata.Close()
	}
	if h.snapshot != nil {
		_ = h.snapshot.Close()
		h.snapshot = nil
	}
	for _, g := range h.guards {
		_ = g.Close()
	}
	h.guards = nil
}

var notaloneIdentity = regexp.MustCompile(`^[A-Za-z0-9_.@-]{1,255}$`)

// 仅使用现有schema2配置；不运行探钥、Keychain授权、缓存刷新或路径RPC。
func (h *notaloneHistorySession) initialize() error {
	// 缺少既有账号或根目录时直接拒绝，绝不走上游自动账号目录发现。
	if !h.server.ok {
		cfg, err := config.Load()
		if err != nil || cfg.SchemaVersion != 2 || !cfg.Ready() || !notaloneIdentity.MatchString(cfg.Wxid) || !filepath.IsAbs(cfg.DBRoot) || filepath.Clean(cfg.DBRoot) != cfg.DBRoot {
			return notaloneFailure("history_account_unavailable")
		}
		library, err := findWCDB()
		if err != nil {
			return notaloneFailure("history_native_unavailable")
		}
		h.server.cfg = cfg
		h.server.wcdbPath = library
		h.server.ok = true
	}
	cfg := h.server.cfg
	if cfg == nil || cfg.SchemaVersion != 2 || !cfg.Ready() || !notaloneIdentity.MatchString(cfg.Wxid) || !filepath.IsAbs(cfg.DBRoot) || filepath.Clean(cfg.DBRoot) != cfg.DBRoot {
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
	oldKeys, _ := json.Marshal(h.server.cfg.Keys)
	newKeys, _ := json.Marshal(current.Keys)
	if string(oldKeys) != string(newKeys) {
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
func (h *notaloneHistorySession) bindMetadata(ctx context.Context, name string) (result notaloneResolved, err error) {
	base := len(h.guards)
	alreadyBound := h.selected != nil
	defer func() {
		if !alreadyBound && err != nil {
			for _, guard := range h.guards[base:] {
				_ = guard.Close()
			}
			h.guards = h.guards[:base]
			h.selected = nil
		}
	}()
	var fingerprints []string
	if h.selected == nil {
		for _, part := range []struct{ dir, file string }{{"session", "session.db"}, {"contact", "contact.db"}} {
			directory := filepath.Join(h.server.cfg.DBRoot, "db_storage", part.dir)
			guard, err := newNotaloneSourceGuard(directory, []string{filepath.Join(directory, part.file)})
			if err != nil {
				return notaloneResolved{}, notaloneFailure("history_source_unverified")
			}
			h.guards = append(h.guards, guard)
			fingerprints = append(fingerprints, guard.Fingerprint())
		}
	}
	result, err = h.resolve(ctx, name)
	if err != nil {
		return result, err
	}
	if h.selected != nil && (h.selected.Account != result.Account || h.selected.Conversation != result.Conversation || h.selected.DisplayName != result.DisplayName) {
		return result, notaloneFailure("history_scope_changed")
	}
	if h.selected == nil {
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

type notaloneSupportReport struct {
	Protocol             string            `json:"protocol"`
	ProfileID            string            `json:"profileId"`
	AdapterVersion       string            `json:"adapterVersion"`
	Status               string            `json:"status"`
	Reason               *string           `json:"reason"`
	AccountKey           string            `json:"accountKey"`
	ConversationKey      string            `json:"conversationKey"`
	SourceGeneration     string            `json:"sourceGeneration"`
	ProgramVersion       string            `json:"programVersion"`
	Build                string            `json:"build"`
	ArtifactSHA256       string            `json:"artifactSha256"`
	SchemaFingerprint    string            `json:"schemaFingerprint"`
	DeclaredPrimaryKey   []string          `json:"declaredPrimaryKey"`
	ServerAliasSemantics string            `json:"serverAliasSemantics"`
	Identity             string            `json:"identity"`
	StatusSemantics      string            `json:"statusSemantics"`
	Continuity           string            `json:"continuity"`
	Capabilities         map[string]string `json:"capabilities,omitempty"`
}

func notaloneFileHash(file string) (string, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return "", notaloneFailure("history_artifact_unverified")
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}
func (h *notaloneHistorySession) support(ctx context.Context) (notaloneSupportReport, *notaloneReadProfile, error) {
	result := notaloneSupportReport{Protocol: "private-history-v1", AdapterVersion: "1", Status: "unverified", AccountKey: h.selected.Account, ConversationKey: h.selected.Conversation, SourceGeneration: h.selected.SourceGeneration, ServerAliasSemantics: "unverified", Identity: "source-table-local-v1", DeclaredPrimaryKey: []string{}}
	inspected, err := h.inspect(ctx)
	if err != nil {
		return result, nil, err
	}
	program, err := h.program(ctx)
	if err != nil {
		return result, nil, err
	}
	certification := h.certify(program, inspected.Tables)
	result.ProfileID = certification.ProfileID
	result.ProgramVersion = certification.ProgramVersion
	result.Build = certification.Build
	result.Status = certification.Status
	result.SchemaFingerprint = inspected.SchemaFingerprint
	result.DeclaredPrimaryKey = certification.DeclaredPrimaryKey
	result.StatusSemantics = certification.StatusSemantics
	result.Continuity = certification.Continuity
	result.Capabilities = certification.Capabilities
	if certification.Reason != "" {
		reason := certification.Reason
		result.Reason = &reason
	}
	executable, err := os.Executable()
	if err != nil {
		return result, nil, notaloneFailure("history_artifact_unverified")
	}
	result.ArtifactSHA256, err = notaloneFileHash(executable)
	if err != nil {
		return result, nil, err
	}
	library, err := notaloneFileHash(h.server.wcdbPath)
	if err != nil || library != "4f05cafc4626a142afca1818f0a88c4092a13d5f4c83e30cd5125b558ba0417d" {
		reason := "history_artifact_unverified"
		result.Status = "unverified"
		result.Reason = &reason
		return result, nil, nil
	}
	if h.inspected != nil && h.snapshot != nil && h.inspected.SchemaFingerprint != inspected.SchemaFingerprint {
		return result, nil, notaloneFailure("history_schema_changed")
	}
	h.inspected = &inspected
	return result, certification.ReadProfile, nil
}
func (h *notaloneHistorySession) handle(ctx context.Context, r notaloneHistoryRequest) (any, error) {
	if r.Operation != "observe-metadata" && r.Operation != "observe-test-metadata" && r.Kind != "" {
		return nil, notaloneFailure("history_request_invalid")
	}
	switch r.Operation {
	case "resolve":
		if r.Consent != "selected-metadata-v1" || r.DisplayName == "" || r.Account != "" || r.Conversation != "" || r.Target != "" || r.Cursor != "" {
			return nil, notaloneFailure("history_request_invalid")
		}
	case "observe-metadata":
		if r.Consent != "selected-message-metadata-v1" || !validNotaloneMetadataKind(r.Kind) || !notaloneIdentity.MatchString(r.Account) || !notaloneIdentity.MatchString(r.Conversation) || r.DisplayName != "" || r.Target != "" || r.Cursor != "" {
			return nil, notaloneFailure("history_request_invalid")
		}
	case "observe-test-metadata":
		if r.Consent != "selected-test-lifecycle-metadata-v1" || !validNotaloneTestMetadataAction(r.Kind) || !notaloneIdentity.MatchString(r.Account) || !notaloneIdentity.MatchString(r.Conversation) || r.DisplayName != "" || r.Target != "" || r.Cursor != "" {
			return nil, notaloneFailure("history_request_invalid")
		}
	case "inspect", "support", "target", "page":
		consent := "selected-schema-v1"
		if r.Operation == "target" || r.Operation == "page" {
			consent = "selected-history-v1"
		}
		if r.Consent != consent || !notaloneIdentity.MatchString(r.Account) || !notaloneIdentity.MatchString(r.Conversation) || r.DisplayName != "" || (r.Operation != "page" && (r.Target != "" || r.Cursor != "")) || (r.Operation == "page" && r.Target == "") {
			return nil, notaloneFailure("history_request_invalid")
		}
	default:
		return nil, notaloneFailure("history_operation_unsupported")
	}
	if err := h.initialize(); err != nil {
		return nil, err
	}
	if err := h.currentAccount(); err != nil {
		return nil, err
	}
	if r.Operation == "resolve" {
		return h.bindMetadata(ctx, r.DisplayName)
	}
	if h.selected == nil || r.Account != h.selected.Account || r.Conversation != h.selected.Conversation {
		return nil, notaloneFailure("history_scope_unverified")
	}
	if err := h.currentAccount(); err != nil {
		return nil, err
	}
	if _, err := h.bindMetadata(ctx, h.selected.Conversation); err != nil {
		return nil, err
	}
	if r.Operation == "inspect" {
		return h.inspect(ctx)
	}
	if r.Operation == "observe-test-metadata" {
		inspection, err := h.inspect(ctx)
		if err != nil {
			return nil, err
		}
		if h.testMetadata == nil {
			h.testMetadata = newNotaloneTestMetadataWatch()
		}
		report, err := h.testMetadata.observe(ctx, h.server, *h.selected, inspection, r.Kind)
		if err != nil {
			return nil, err
		}
		if err = h.currentAccount(); err != nil {
			return nil, err
		}
		return report, nil
	}
	if r.Operation == "observe-metadata" {
		inspection, err := h.inspect(ctx)
		if err != nil {
			return nil, err
		}
		observation, err := observeNotaloneMessageMetadata(ctx, h.server, *h.selected, inspection, r.Kind)
		if err != nil {
			return nil, err
		}
		if err = h.currentAccount(); err != nil {
			return nil, err
		}
		return notaloneMetadataReport{Format: "wechat-message-metadata-observation-v1", Status: "unverified", ScopeDigest: inspection.ScopeDigest, SourceGeneration: inspection.SourceGeneration, SchemaFingerprint: inspection.SchemaFingerprint, Kind: r.Kind, CheckedPartitions: inspection.CheckedPartitions, Record: observation}, nil
	}

	report, profile, err := h.support(ctx)
	if err != nil {
		return nil, err
	}
	if r.Operation == "support" {
		return report, nil
	}
	if report.Status != "supported" || profile == nil {
		return nil, notaloneFailure("history_support_unverified")
	}
	if r.Operation == "target" {
		if h.snapshot != nil {
			_ = h.snapshot.Close()
			h.snapshot = nil
		}
		snapshot, err := newNotaloneSnapshot(h.life, h.server, *h.selected, *h.inspected, *profile)
		if err != nil {
			return nil, err
		}
		h.snapshot = snapshot
		return snapshot.Target(), nil
	}
	if h.snapshot == nil || r.Target != h.snapshot.Target().Descriptor {
		return nil, notaloneFailure("history_target_invalid")
	}
	page, err := h.snapshot.Page(ctx, r.Cursor)
	if err != nil {
		_ = h.snapshot.Close()
		h.snapshot = nil
		return nil, err
	}
	return page, nil
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
