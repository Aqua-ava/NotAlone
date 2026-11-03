import type {StorageMigration} from '../../storage/sqlite/contracts.ts';
export const memoryContentMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE run_content_input (
 owner_id TEXT NOT NULL,run_id TEXT NOT NULL,input_no INTEGER NOT NULL,
 plugin_id TEXT NOT NULL,plugin_version TEXT NOT NULL,content_kind TEXT NOT NULL,
 identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
 PRIMARY KEY(owner_id,run_id,input_no),
 FOREIGN KEY(owner_id,run_id,input_no) REFERENCES run_input(owner_id,run_id,input_no) ON DELETE CASCADE
) STRICT;
CREATE INDEX run_content_file ON run_content_input(owner_id,json_extract(identity_json,'$.fileId')) WHERE content_kind='image';
CREATE TRIGGER run_content_input_immutable BEFORE UPDATE ON run_content_input
 BEGIN SELECT RAISE(ABORT,'memory_content_input_immutable'); END;
`});
