package main

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

const notaloneProgramPlist = "/Applications/WeChat.app/Contents/Info.plist"

type notaloneProgramVersion struct {
	Version string `json:"version"`
	Build   string `json:"build"`
}

type notaloneProfileCertification struct {
	Status                 string               `json:"status"`
	Reason                 string               `json:"reason"`
	ProfileID              string               `json:"profileId"`
	ProgramVersion         string               `json:"programVersion"`
	Build                  string               `json:"build"`
	DeclaredPrimaryKey     []string             `json:"declaredPrimaryKey"`
	StatusSemantics        string               `json:"statusSemantics"`
	Continuity             string               `json:"continuity"`
	SchemaShapeFingerprint string               `json:"schemaShapeFingerprint"`
	Capabilities           map[string]string    `json:"capabilities"`
	Reasons                []string             `json:"reasons"`
	CanReadHistory         bool                 `json:"canReadHistory"`
	ReadProfile            *notaloneReadProfile `json:"-"`
}

var notaloneVersionFormat = regexp.MustCompile(`^[0-9]{1,3}(\.[0-9]{1,3}){1,3}$`)
var notaloneBuildFormat = regexp.MustCompile(`^[0-9]{1,12}$`)

func notaloneValidProgramVersion(version notaloneProgramVersion) bool {
	return notaloneVersionFormat.MatchString(version.Version) && notaloneBuildFormat.MatchString(version.Build)
}

type notaloneProgramOutput struct{ bytes []byte }

func (output *notaloneProgramOutput) Write(bytes []byte) (int, error) {
	if len(output.bytes)+len(bytes) > 128 {
		return 0, errors.New("history_program_version_invalid")
	}
	output.bytes = append(output.bytes, bytes...)
	return len(bytes), nil
}

// 固定读取当前标准安装包的两个版本键，不扫描、运行微信或接受 RPC 路径。
func readNotaloneProgramVersion(ctx context.Context) (notaloneProgramVersion, error) {
	version := notaloneProgramVersion{}
	if ctx == nil || ctx.Err() != nil {
		return version, errors.New("history_program_version_unavailable")
	}
	before, err := os.Lstat(notaloneProgramPlist)
	if err != nil || !before.Mode().IsRegular() || before.Size() < 1 || before.Size() > 1024*1024 {
		return version, errors.New("history_program_version_unavailable")
	}
	values := make([]string, 2)
	for index, key := range []string{"CFBundleShortVersionString", "CFBundleVersion"} {
		bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
		command := exec.CommandContext(bounded, "/usr/bin/plutil", "-extract", key, "raw", "-n", "-o", "-", "--", notaloneProgramPlist)
		command.Env = []string{"PATH=/usr/bin:/bin", "LANG=en_US.UTF-8"}
		command.WaitDelay = time.Second
		output := &notaloneProgramOutput{}
		command.Stdout, command.Stderr = output, io.Discard
		err := command.Run()
		cancel()
		if err != nil {
			return version, errors.New("history_program_version_unavailable")
		}
		values[index] = string(output.bytes)
	}
	after, err := os.Lstat(notaloneProgramPlist)
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) || before.Size() != after.Size() || before.ModTime() != after.ModTime() {
		return version, errors.New("history_program_version_changed")
	}
	version = notaloneProgramVersion{Version: values[0], Build: values[1]}
	if !notaloneValidProgramVersion(version) {
		return notaloneProgramVersion{}, errors.New("history_program_version_invalid")
	}
	return version, nil
}

func notalone40629387ExpectedShape() notaloneTableSchema {
	table := notaloneTableSchema{Role: "private_message", AutoIncrement: true, DeclaredPrimaryKey: []string{"local_id"}}
	for _, name := range strings.Fields("local_id server_id local_type sort_seq real_sender_id create_time status upload_status download_status server_seq origin_source source message_content compress_content packed_info_data WCDB_CT_message_content WCDB_CT_source") {
		kind := "INTEGER"
		if name == "source" || name == "message_content" || name == "compress_content" {
			kind = "TEXT"
		} else if name == "packed_info_data" {
			kind = "BLOB"
		}
		column := notaloneColumn{Name: name, Type: kind}
		if name == "local_id" {
			column.PrimaryKey = 1
		}
		table.Columns = append(table.Columns, column)
	}
	for _, names := range [][]string{{"local_type", "sort_seq"}, {"sort_seq"}, {"server_id"}, {"real_sender_id"}} {
		index := notaloneIndex{Origin: "c"}
		for position, name := range append(names, "") {
			index.Columns = append(index.Columns, notaloneIndexColumn{Sequence: int64(position), Name: name, Collation: "BINARY", Key: name != ""})
		}
		table.Indexes = append(table.Indexes, index)
	}
	return table
}

// 仅记录当前真实受控观察过的完整元组；同一原始 status 不跨消息类型或发送方推断。
func notalone40629387ObservedStatusRules() []notaloneStatusRule {
	return []notaloneStatusRule{
		{LocalType: 1, Sender: "owner", Status: 2, State: notaloneMessageSent, RequiresServerID: true},
		{LocalType: 1, Sender: "contact", Status: 3, State: notaloneMessageReceived, RequiresServerID: true},
		{LocalType: 10000, Sender: "unknown", Status: 4, State: notaloneMessageRecalled},
	}
}

// 仅可信的本机版本读取和受控结构检查调用此函数，RPC 不能提交 profile 或能力事实。
// 真实匿名结构只认证结构；未知状态与来源生命周期不能被 opaque 原值策略放行。
func certifyNotaloneProfile(program notaloneProgramVersion, tables []notaloneTableSchema) notaloneProfileCertification {
	report := notaloneProfileCertification{Status: "unverified", Reason: "history_program_version_uncertified", ProfileID: "wechat-4.0.6-29387-observed-states-v1",
		ProgramVersion: program.Version, Build: program.Build, DeclaredPrimaryKey: []string{}, StatusSemantics: "unverified", Continuity: "unverified",
		Capabilities: map[string]string{}, Reasons: []string{"history_message_state_unverified", "history_source_lifecycle_unverified", "history_snapshot_runtime_proof_required", "history_partition_coverage_runtime_proof_required"}}
	for _, capability := range []string{"programVersion", "exactSchema", "declaredLocalKey", "automaticAllocation", "serverIdUniqueConstraint", "statusColumn", "statusSemantics", "sourceLifecycle", "restartContinuity", "recoveryMapping", "snapshotBarrier", "partitionCoverage", "normalHistory"} {
		report.Capabilities[capability] = "unverified"
	}
	if program.Version != "4.0.6" || program.Build != "29387" {
		return report
	}
	report.Capabilities["programVersion"] = "supported"
	report.Reason = "history_schema_shape_uncertified"
	if len(tables) == 0 || len(tables) > 128 {
		return report
	}
	for _, table := range tables {
		if table.Role != "private_message" {
			return report
		}
	}
	shape := notaloneSnapshotShape(tables)
	if shape != notaloneSnapshotShape([]notaloneTableSchema{notalone40629387ExpectedShape()}) {
		return report
	}
	for _, capability := range []string{"exactSchema", "declaredLocalKey", "automaticAllocation", "statusColumn"} {
		report.Capabilities[capability] = "supported"
	}
	report.Capabilities["serverIdUniqueConstraint"] = "unsupported"
	report.DeclaredPrimaryKey = []string{"local_id"}
	report.SchemaShapeFingerprint = shape
	report.StatusSemantics = "observed_subset_only"
	report.ReadProfile = &notaloneReadProfile{SchemaShapeFingerprint: shape, StatusSemanticsVerified: true, StatusRules: notalone40629387ObservedStatusRules()}
	report.Reason = "history_message_state_unverified"
	return report
}
