import type {StorageMigration} from '../contracts.ts';

/** 无正文的来源终态抑制与原始捕获分开；source_absent 仅保留旧结构兼容，不推断消息消失。 */
export const historyTerminalMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE history_source_terminal (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,binding_id TEXT NOT NULL,external_key TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN ('source_recalled','source_absent','source_system_replaced')),
 accepted_data_generation INTEGER NOT NULL CHECK(accepted_data_generation>=0),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,contact_id,binding_id,external_key),
 FOREIGN KEY(owner_id,contact_id,binding_id) REFERENCES conversation_binding(owner_id,contact_id,id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER history_source_terminal_identity BEFORE UPDATE OF owner_id,id,contact_id,binding_id,external_key,accepted_data_generation ON history_source_terminal
 BEGIN SELECT RAISE(ABORT,'history_source_terminal_immutable'); END;
CREATE TRIGGER history_source_terminal_monotonic BEFORE UPDATE OF reason ON history_source_terminal
 WHEN NEW.reason<>OLD.reason AND NEW.reason<>'source_absent'
 BEGIN SELECT RAISE(ABORT,'history_source_terminal_not_monotonic'); END;
`});
