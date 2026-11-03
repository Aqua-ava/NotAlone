package main

import (
	"context"
	"net/url"
	"strings"
	"unicode"

	"github.com/r266-tech/wx-cli/v2/internal/wxkind"
)

type notaloneContactAvatarMetadata struct {
	Format    string                        `json:"format"`
	Account   notaloneAccountMetadataReport `json:"account"`
	Username  string                        `json:"username"`
	AvatarURL *string                       `json:"avatarUrl"`
}

// 头像仅作展示；固定微信 CDN 的旧 HTTP 元数据升级为 HTTPS，绝不发送 HTTP 请求。
func notaloneAvatarURL(raw string) *string {
	if raw == "" || len(raw) > 2048 || strings.ContainsFunc(raw, unicode.IsSpace) || strings.ContainsAny(raw, "\\\x00\r\n") {
		return nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil || parsed.Port() != "" || parsed.Fragment != "" || parsed.Opaque != "" || !strings.HasPrefix(parsed.Path, "/") || (parsed.Host != "wx.qlogo.cn" && parsed.Host != "thirdwx.qlogo.cn") {
		return nil
	}
	parsed.Scheme = "https"
	secure := parsed.String()
	return &secure
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
		return report, notaloneFailure("history_metadata_unavailable")
	}
	defer contact.Close()
	rows, err := contact.QueryBounded(ctx, 2, "SELECT username,verify_flag,small_head_url,big_head_url FROM contact WHERE username=? LIMIT 2", username)
	if err != nil || len(rows) != 1 || rowString(rows[0], "username") != username {
		return report, notaloneFailure("history_identity_unverified")
	}
	verified, known := rows[0]["verify_flag"].(int64)
	if !known || agentChatType(username, wxkind.ClassifyUsername(username), verified != 0) != "private" {
		return report, notaloneFailure("history_target_not_private")
	}
	avatar := notaloneAvatarURL(rowString(rows[0], "small_head_url"))
	if avatar == nil {
		avatar = notaloneAvatarURL(rowString(rows[0], "big_head_url"))
	}
	after, err := h.metadataAccount(ctx)
	if err != nil {
		return report, err
	}
	if after != account {
		return report, notaloneFailure("history_scope_changed")
	}
	return notaloneContactAvatarMetadata{"wechat-contact-avatar-metadata-v1", account, username, avatar}, nil
}
