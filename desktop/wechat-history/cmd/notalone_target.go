package main

import "regexp"

var notaloneTargetDigestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func notaloneTargetTableMap(target notaloneSnapshotTarget) (map[string]string, bool) {
	if target.Protocol != "private-history-v1" || target.Descriptor == "" || target.SourceGeneration == "" {
		return nil, false
	}
	checked := map[string]bool{}
	for _, partition := range target.CheckedPartitions {
		if partition == "" || checked[partition] {
			return nil, false
		}
		checked[partition] = true
	}
	tables := make(map[string]string, len(target.Tables))
	for _, table := range target.Tables {
		if table.Partition == "" || !notaloneTargetDigestPattern.MatchString(table.Instance) || tables[table.Partition] != "" {
			return nil, false
		}
		if len(target.CheckedPartitions) > 0 && !checked[table.Partition] {
			return nil, false
		}
		tables[table.Partition] = table.Instance
	}
	partitions := map[string]bool{}
	for _, partition := range target.Partitions {
		if partition == "" || partitions[partition] {
			return nil, false
		}
		partitions[partition] = true
	}
	if len(tables) > 0 {
		if len(partitions) != len(tables) {
			return nil, false
		}
		for partition := range tables {
			if !partitions[partition] {
				return nil, false
			}
		}
	} else if len(target.CheckedPartitions) > 0 {
		if !notaloneSameOrderedStrings(target.Partitions, target.CheckedPartitions) {
			return nil, false
		}
	} else if len(partitions) == 0 {
		return nil, false
	}
	return tables, true
}

// 返回当前目标中新增表所在分片。只有带完整旧白名单及MAC保护的旧表结构摘要，
// 才能证明检查点安全扩张；旧协议目标仍可用于相同实例的兼容续读。
func notaloneSafeTargetGrowth(oldTarget, currentTarget notaloneSnapshotTarget, oldSchemaDigests map[string]string, currentSchemas []notaloneTableSchema) (map[string]bool, bool) {
	added := map[string]bool{}
	oldTables, oldOK := notaloneTargetTableMap(oldTarget)
	currentTables, currentOK := notaloneTargetTableMap(currentTarget)
	if !oldOK || !currentOK || oldTarget.Protocol != currentTarget.Protocol || oldTarget.SourceGeneration != currentTarget.SourceGeneration {
		return nil, false
	}
	if len(oldTarget.CheckedPartitions) == 0 || len(currentTarget.CheckedPartitions) == 0 ||
		!notaloneSameOrderedStrings(oldTarget.CheckedPartitions, currentTarget.CheckedPartitions) {
		return nil, false
	}
	currentDigests, schemasOK := notaloneTableSchemaDigests(currentSchemas)
	if !schemasOK || len(currentDigests) != len(currentTables) {
		return nil, false
	}
	currentByPartition := make(map[string]notaloneTableSchema, len(currentSchemas))
	for _, schema := range currentSchemas {
		currentByPartition[schema.Partition] = schema
	}
	for partition, instance := range currentTables {
		schema, exists := currentByPartition[partition]
		if !exists || schema.Target != instance || currentDigests[partition] != notaloneTableSchemaDigest(schema) {
			return nil, false
		}
	}
	if len(oldSchemaDigests) != len(oldTables) {
		return nil, false
	}
	oldStructures := map[string]bool{}
	for partition, instance := range oldTables {
		if currentTables[partition] != instance || !notaloneTargetDigestPattern.MatchString(oldSchemaDigests[partition]) || oldSchemaDigests[partition] != currentDigests[partition] {
			return nil, false
		}
		oldStructures[notaloneTableStructureDigest(currentByPartition[partition])] = true
	}
	for partition := range currentTables {
		if _, existed := oldTables[partition]; !existed {
			added[partition] = true
			if len(oldStructures) == 0 || !oldStructures[notaloneTableStructureDigest(currentByPartition[partition])] {
				return nil, false
			}
		}
	}
	return added, true
}

func notaloneSafeInspectionGrowth(oldInspection, currentInspection notaloneInspection) bool {
	if oldInspection.ScopeDigest == "" || oldInspection.ScopeDigest != currentInspection.ScopeDigest ||
		oldInspection.SourceGeneration == "" || oldInspection.SourceGeneration != currentInspection.SourceGeneration ||
		!notaloneSameOrderedStrings(oldInspection.CheckedPartitions, currentInspection.CheckedPartitions) ||
		len(currentInspection.Tables) <= len(oldInspection.Tables) {
		return false
	}
	oldTables, ok := notaloneTableSchemaDigests(oldInspection.Tables)
	if !ok {
		return false
	}
	currentTables, ok := notaloneTableSchemaDigests(currentInspection.Tables)
	if !ok || len(currentTables) <= len(oldTables) {
		return false
	}
	oldStructures := map[string]bool{}
	for partition, digest := range oldTables {
		if currentTables[partition] != digest {
			return false
		}
		for _, schema := range oldInspection.Tables {
			if schema.Partition == partition {
				oldStructures[notaloneTableStructureDigest(schema)] = true
				break
			}
		}
	}
	for partition := range currentTables {
		if _, existed := oldTables[partition]; existed || len(oldStructures) == 0 {
			continue
		}
		for _, schema := range currentInspection.Tables {
			if schema.Partition == partition && !oldStructures[notaloneTableStructureDigest(schema)] {
				return false
			}
		}
	}
	return true
}
