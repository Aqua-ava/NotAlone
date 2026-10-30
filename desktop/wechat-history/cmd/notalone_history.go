package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
	"strings"
)

type notaloneColumn struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	NotNull    bool   `json:"notNull"`
	PrimaryKey int64  `json:"primaryKey"`
	Hidden     int64  `json:"hidden"`
}
type notaloneIndexColumn struct {
	Sequence   int64  `json:"sequence"`
	Name       string `json:"name"`
	Descending bool   `json:"descending"`
	Collation  string `json:"collation"`
	Key        bool   `json:"key"`
}
type notaloneIndex struct {
	ID      string                `json:"id"`
	Unique  bool                  `json:"unique"`
	Origin  string                `json:"origin"`
	Partial bool                  `json:"partial"`
	Columns []notaloneIndexColumn `json:"columns"`
}
type notaloneTableSchema struct {
	Target              string           `json:"target"`
	Partition           string           `json:"partition"`
	Role                string           `json:"role"`
	Columns             []notaloneColumn `json:"columns"`
	Indexes             []notaloneIndex  `json:"indexes"`
	DeclaredPrimaryKey  []string         `json:"declaredPrimaryKey"`
	AutoIncrement       bool             `json:"autoIncrement"`
	SchemaVersion       string           `json:"schemaVersion"`
	RootPage            string           `json:"rootPage"`
	SQLFingerprint      string           `json:"sqlFingerprint"`
	TriggerFingerprints []string         `json:"triggerFingerprints"`
}

func notaloneHash(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])
}
func notaloneFailure(code string) error { return fmt.Errorf("%s", code) }

// 只投影目标表结构，不读取消息行、正文、source或其他表的数据。
func inspectNotaloneTable(ctx context.Context, db *wcdb.DB, table, partition string) (notaloneTableSchema, error) {
	result := notaloneTableSchema{Target: notaloneHash(partition, table), Partition: partition, Role: "private_message", Columns: []notaloneColumn{}, Indexes: []notaloneIndex{}, DeclaredPrimaryKey: []string{}, TriggerFingerprints: []string{}}
	versions, e := db.QueryBounded(ctx, 1, "PRAGMA schema_version")
	if e != nil || len(versions) != 1 {
		return result, notaloneFailure("history_schema_unavailable")
	}
	result.SchemaVersion = fmt.Sprint(versions[0]["schema_version"])
	definitions, err := db.QueryBounded(ctx, 2, "SELECT sql,rootpage FROM sqlite_master WHERE type='table' AND name=?", table)
	if err != nil || len(definitions) != 1 {
		return result, notaloneFailure("history_schema_missing")
	}
	result.RootPage = fmt.Sprint(definitions[0]["rootpage"])
	definition := rowString(definitions[0], "sql")
	result.SQLFingerprint = notaloneHash(definition)
	result.AutoIncrement = notaloneSQLHasKeyword(definition, "AUTOINCREMENT")
	columns, err := db.QueryBounded(ctx, 128, "PRAGMA table_xinfo("+quoteIdent(table)+")")
	if err != nil || len(columns) == 0 {
		return result, notaloneFailure("history_schema_unavailable")
	}
	for _, r := range columns {
		column := notaloneColumn{Name: rowString(r, "name"), Type: rowString(r, "type"), NotNull: rowInt64(r, "notnull") != 0, PrimaryKey: rowInt64(r, "pk"), Hidden: rowInt64(r, "hidden")}
		result.Columns = append(result.Columns, column)
	}
	for n := int64(1); n <= int64(len(result.Columns)); n++ {
		for _, c := range result.Columns {
			if c.PrimaryKey == n {
				result.DeclaredPrimaryKey = append(result.DeclaredPrimaryKey, c.Name)
			}
		}
	}
	indexes, err := db.QueryBounded(ctx, 64, "PRAGMA index_list("+quoteIdent(table)+")")
	if err != nil {
		return result, notaloneFailure("history_index_unavailable")
	}
	for _, r := range indexes {
		name := rowString(r, "name")
		index := notaloneIndex{ID: notaloneHash(result.Target, name), Unique: rowInt64(r, "unique") != 0, Origin: rowString(r, "origin"), Partial: rowInt64(r, "partial") != 0, Columns: []notaloneIndexColumn{}}
		parts, e := db.QueryBounded(ctx, 128, "PRAGMA index_xinfo("+quoteIdent(name)+")")
		if e != nil {
			return result, notaloneFailure("history_index_unavailable")
		}
		for _, p := range parts {
			index.Columns = append(index.Columns, notaloneIndexColumn{Sequence: rowInt64(p, "seqno"), Name: rowString(p, "name"), Descending: rowInt64(p, "desc") != 0, Collation: rowString(p, "coll"), Key: rowInt64(p, "key") != 0})
		}
		result.Indexes = append(result.Indexes, index)
	}
	triggers, err := db.QueryBounded(ctx, 64, "SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name", table)
	if err != nil {
		return result, notaloneFailure("history_trigger_unavailable")
	}
	for _, r := range triggers {
		result.TriggerFingerprints = append(result.TriggerFingerprints, notaloneHash(rowString(r, "sql")))
	}
	after, e := db.QueryBounded(ctx, 1, "PRAGMA schema_version")
	if e != nil || len(after) != 1 || fmt.Sprint(after[0]["schema_version"]) != result.SchemaVersion {
		return result, notaloneFailure("history_schema_changed")
	}
	result.Target = notaloneHash(partition, table, result.SchemaVersion, result.RootPage, result.SQLFingerprint)
	return result, nil
}

// SQLite只在真实INTEGER PRIMARY KEY子句允许此关键字；跳过字符串、
// 标识符引用及注释，避免默认值或名字伪装成自动分配规则。
func notaloneSQLHasKeyword(sql, keyword string) bool {
	for i := 0; i < len(sql); {
		if i+1 < len(sql) && sql[i:i+2] == "--" {
			for i < len(sql) && sql[i] != '\n' {
				i++
			}
			continue
		}
		if i+1 < len(sql) && sql[i:i+2] == "/*" {
			i += 2
			for i+1 < len(sql) && sql[i:i+2] != "*/" {
				i++
			}
			i += 2
			continue
		}
		c := sql[i]
		if c == '\'' || c == '"' || c == '`' || c == '[' {
			end := c
			if c == '[' {
				end = ']'
			}
			i++
			for i < len(sql) {
				if sql[i] == end {
					i++
					if i < len(sql) && sql[i] == end {
						i++
						continue
					}
					break
				}
				i++
			}
			continue
		}
		isName := func(b byte) bool {
			return b == '_' || b > 127 || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9'
		}
		if isName(c) {
			start := i
			for i < len(sql) && isName(sql[i]) {
				i++
			}
			if strings.EqualFold(sql[start:i], keyword) {
				return true
			}
			continue
		}
		i++
	}
	return false
}
