package main

import (
	"strings"
	"testing"
)

func TestNotaloneTargetGrowthRequiresSameWhitelistAndOldTableProofs(t *testing.T) {
	oldA := notaloneTableSchema{Target: strings.Repeat("a", 64), Partition: "p-a", Role: "private_message", RootPage: "3", SQLFingerprint: strings.Repeat("c", 64), SchemaVersion: "10", Columns: []notaloneColumn{{Name: "local_id", Type: "INTEGER", PrimaryKey: 1}}, Indexes: []notaloneIndex{}, DeclaredPrimaryKey: []string{"local_id"}, TriggerFingerprints: []string{}}
	newB := oldA
	newB.Target, newB.Partition, newB.RootPage = strings.Repeat("b", 64), "p-b", "4"
	checked := []string{"p-a", "p-b", "p-c"}
	oldTarget := notaloneSnapshotTarget{Protocol: "private-history-v1", Descriptor: "old", Partitions: []string{"p-a"}, Tables: []notaloneSnapshotTable{{Partition: "p-a", Instance: oldA.Target}}, SourceGeneration: "generation", CheckedPartitions: checked}
	current := notaloneSnapshotTarget{Protocol: oldTarget.Protocol, Descriptor: "new", Partitions: []string{"p-a", "p-b"}, Tables: []notaloneSnapshotTable{{Partition: "p-a", Instance: oldA.Target}, {Partition: "p-b", Instance: newB.Target}}, SourceGeneration: oldTarget.SourceGeneration, CheckedPartitions: append([]string(nil), checked...)}
	oldDigests, ok := notaloneTableSchemaDigests([]notaloneTableSchema{oldA})
	if !ok {
		t.Fatal("合成旧表结构摘要未生成")
	}
	added, ok := notaloneSafeTargetGrowth(oldTarget, current, oldDigests, []notaloneTableSchema{oldA, newB})
	if !ok || len(added) != 1 || !added["p-b"] {
		t.Fatalf("已知分片中新增选中表应安全扩张：added=%v ok=%v", added, ok)
	}
	for name, mutate := range map[string]func(*notaloneSnapshotTarget, *[]notaloneTableSchema){
		"checked-file-added": func(target *notaloneSnapshotTarget, _ *[]notaloneTableSchema) {
			target.CheckedPartitions = append(target.CheckedPartitions, "unknown")
		},
		"old-table-removed": func(target *notaloneSnapshotTarget, _ *[]notaloneTableSchema) {
			target.Tables = target.Tables[1:]
			target.Partitions = target.Partitions[1:]
		},
		"old-table-instance-changed": func(target *notaloneSnapshotTarget, _ *[]notaloneTableSchema) {
			target.Tables[0].Instance = strings.Repeat("d", 64)
		},
		"old-table-schema-changed": func(_ *notaloneSnapshotTarget, schemas *[]notaloneTableSchema) {
			(*schemas)[0].TriggerFingerprints = []string{"changed-trigger"}
		},
		"missing-old-schema-proof": func(_ *notaloneSnapshotTarget, _ *[]notaloneTableSchema) {},
	} {
		t.Run(name, func(t *testing.T) {
			target := current
			target.Partitions = append([]string(nil), current.Partitions...)
			target.Tables = append([]notaloneSnapshotTable(nil), current.Tables...)
			target.CheckedPartitions = append([]string(nil), current.CheckedPartitions...)
			schemas := []notaloneTableSchema{oldA, newB}
			schemas[0].Indexes = append([]notaloneIndex{}, oldA.Indexes...)
			mutate(&target, &schemas)
			digests := oldDigests
			if name == "missing-old-schema-proof" {
				digests = nil
			}
			if _, ok := notaloneSafeTargetGrowth(oldTarget, target, digests, schemas); ok {
				t.Fatal("不安全目标扩张被接受")
			}
		})
	}
}

func TestNotaloneSafeInspectionGrowthRequiresSameWhitelistAndOldStructure(t *testing.T) {
	old := notaloneTableSchema{Target: strings.Repeat("a", 64), Partition: "p-a", Role: "private_message", RootPage: "3", SQLFingerprint: strings.Repeat("c", 64), SchemaVersion: "10", Columns: []notaloneColumn{{Name: "local_id", Type: "INTEGER", PrimaryKey: 1}}, Indexes: []notaloneIndex{}, DeclaredPrimaryKey: []string{"local_id"}, TriggerFingerprints: []string{}}
	added := old
	added.Target, added.Partition, added.RootPage, added.SchemaVersion = strings.Repeat("b", 64), "p-b", "4", "11"
	base := notaloneInspection{ScopeDigest: "scope", SourceGeneration: "generation", SchemaFingerprint: "old", Tables: []notaloneTableSchema{old}, CheckedPartitions: []string{"p-a", "p-b"}}
	grown := base
	grown.SchemaFingerprint = "new"
	grown.Tables = []notaloneTableSchema{old, added}
	if !notaloneSafeInspectionGrowth(base, grown) {
		t.Fatal("已检查分片新增目标表应被识别为安全扩张")
	}
	versionOnly := base
	versionOnly.Tables = []notaloneTableSchema{old}
	versionOnly.Tables[0].SchemaVersion = "99"
	if notaloneSchemaFingerprint(base.Tables, base.CheckedPartitions) != notaloneSchemaFingerprint(versionOnly.Tables, versionOnly.CheckedPartitions) {
		t.Fatal("SchemaVersion诊断cookie改变了整体schema摘要")
	}
	changedOld := grown
	changedOld.Tables = append([]notaloneTableSchema(nil), grown.Tables...)
	changedOld.Tables[0].TriggerFingerprints = []string{"changed-trigger"}
	if notaloneSafeInspectionGrowth(base, changedOld) {
		t.Fatal("旧表触发器变化被当作安全新增表")
	}
	unknownFile := grown
	unknownFile.CheckedPartitions = []string{"p-a", "p-b", "p-unknown"}
	if notaloneSafeInspectionGrowth(base, unknownFile) {
		t.Fatal("未知文件扩张被当作已知分片内新增表")
	}
	removed := grown
	removed.Tables = []notaloneTableSchema{added}
	if notaloneSafeInspectionGrowth(base, removed) {
		t.Fatal("旧表丢失被当作安全新增表")
	}
}
