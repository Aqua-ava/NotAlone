package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"os"
	"path/filepath"

	"github.com/r266-tech/wx-cli/v2/internal/wxkind"
)

const notaloneAvatarByteLimit = 256 * 1024

type notaloneContactAvatar struct {
	MIMEType   string `json:"mimeType"`
	DataBase64 string `json:"dataBase64"`
}

type notaloneContactAvatarMetadata struct {
	Format   string                        `json:"format"`
	Account  notaloneAccountMetadataReport `json:"account"`
	Username string                        `json:"username"`
	Avatar   *notaloneContactAvatar        `json:"avatar"`
}

// 仅识别本机位图载体，完整解码和缩图由后台完成；没有网址或网络兜底。
func notaloneLocalAvatar(data []byte) *notaloneContactAvatar {
	if len(data) == 0 || len(data) > notaloneAvatarByteLimit {
		return nil
	}
	kind := ""
	switch {
	case bytes.HasPrefix(data, []byte{137, 80, 78, 71, 13, 10, 26, 10}):
		kind = "image/png"
	case bytes.HasPrefix(data, []byte{255, 216, 255}):
		kind = "image/jpeg"
	case bytes.HasPrefix(data, []byte("GIF87a")), bytes.HasPrefix(data, []byte("GIF89a")):
		kind = "image/gif"
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		kind = "image/webp"
	default:
		return nil
	}
	return &notaloneContactAvatar{kind, base64.StdEncoding.EncodeToString(data)}
}

func notaloneAvatarSchemaVerified(table notaloneTableSchema) bool {
	// 依据当前受支持微信的本机 head_image.db 声明，只接受按 username 主键取单行。
	expected := notaloneTableSchema{
		Columns:            []notaloneColumn{{Name: "username", Type: "TEXT", PrimaryKey: 1}, {Name: "md5", Type: "TEXT"}, {Name: "image_buffer", Type: "BLOB"}, {Name: "update_time", Type: "INTEGER"}},
		DeclaredPrimaryKey: []string{"username"},
		Indexes:            []notaloneIndex{{Unique: true, Origin: "pk", Columns: []notaloneIndexColumn{{Sequence: 0, Name: "username", Collation: "BINARY", Key: true}, {Sequence: 1, Collation: "BINARY"}}}},
	}
	return notaloneSnapshotShape([]notaloneTableSchema{table}) == notaloneSnapshotShape([]notaloneTableSchema{expected})
}

func (h *notaloneHistorySession) metadataAvatar(ctx context.Context, username string) (notaloneContactAvatarMetadata, error) {
	var report notaloneContactAvatarMetadata
	account, err := h.metadataAccount(ctx)
	if err != nil {
		return report, err
	}
	if account.Status != "verified" {
		return report, notaloneFailure("history_metadata_profile_unverified")
	}
	if agentChatType(username, wxkind.ClassifyUsername(username), false) != "private" || username == h.server.cfg.Wxid || username == "filehelper" || username == "notifymessage" {
		return report, notaloneFailure("history_target_not_private")
	}
	contact, err := h.server.openDBNoRefresh("contact", "contact.db")
	if err != nil {
		return report, notaloneReadFailure(err, "history_metadata_unavailable")
	}
	rows, err := contact.QueryBounded(ctx, 2, "SELECT username,verify_flag FROM contact WHERE username=? LIMIT 2", username)
	contact.Close()
	if err != nil || len(rows) != 1 || rowString(rows[0], "username") != username {
		return report, notaloneReadFailure(err, "history_identity_unverified")
	}
	verified, known := rows[0]["verify_flag"].(int64)
	if !known || agentChatType(username, wxkind.ClassifyUsername(username), verified != 0) != "private" {
		return report, notaloneFailure("history_target_not_private")
	}
	report = notaloneContactAvatarMetadata{"wechat-contact-avatar-local-v1", account, username, nil}
	file := filepath.Join(h.server.cfg.DBRoot, "db_storage", "head_image", "head_image.db")
	if _, err = os.Lstat(file); os.IsNotExist(err) {
		return report, nil
	}
	guard, err := newNotaloneSourceGuard(filepath.Dir(file), []string{file})
	if err != nil {
		return report, notaloneFailure("history_source_changed")
	}
	defer guard.Close()
	avatarDB, err := h.server.openDBNoRefresh("head_image", "head_image.db")
	if err != nil {
		return report, notaloneReadFailure(err, "history_metadata_unavailable")
	}
	defer avatarDB.Close()
	schema, err := inspectNotaloneTable(ctx, avatarDB, "head_image", "head_image")
	if err != nil || !notaloneAvatarSchemaVerified(schema) {
		return report, notaloneReadFailure(err, "history_metadata_profile_unverified")
	}
	// 限制读取字节；超限、缺失或非位图均保持空头像，不读取其他联系人。
	images, err := avatarDB.QueryBounded(ctx, 2, "SELECT image_buffer FROM head_image WHERE username=? AND typeof(image_buffer)='blob' AND length(image_buffer) BETWEEN 1 AND ? LIMIT 2", username, notaloneAvatarByteLimit)
	if err != nil || len(images) > 1 {
		return report, notaloneReadFailure(err, "history_metadata_unavailable")
	}
	if len(images) == 1 {
		if data, ok := images[0]["image_buffer"].([]byte); ok {
			report.Avatar = notaloneLocalAvatar(data)
		}
	}
	after, err := h.metadataAccount(ctx)
	if err != nil {
		return report, err
	}
	if after != account || guard.Check() != nil {
		return report, notaloneFailure("history_scope_changed")
	}
	return report, nil
}
