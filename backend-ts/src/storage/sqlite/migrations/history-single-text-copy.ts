import type {StorageMigration} from '../contracts.ts';

/** 仅移除与消息正文完全一致的旧来源副本，来源身份与不一致的历史内容原样保留。 */
export const historySingleTextCopyMigration=(version:number):StorageMigration=>({version,sql:`
DROP TRIGGER capture_record_immutable;
UPDATE capture_record AS r SET raw_payload=json_set(r.raw_payload,'$.text',NULL),normalizer_version='2'
 WHERE r.state='normalized' AND r.normalizer_version='1' AND json_valid(r.raw_payload)
 AND json_extract(r.raw_payload,'$.kind')='text' AND json_type(r.raw_payload,'$.text')='text'
 AND EXISTS (SELECT 1 FROM message m WHERE m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id
  AND m.kind='text' AND m.text_body=json_extract(r.raw_payload,'$.text'));
CREATE TRIGGER capture_record_immutable BEFORE UPDATE OF owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,observed_scheme,observed_key,normalizer_version,reason_code ON capture_record WHEN OLD.state IN ('normalized','excluded')
 BEGIN SELECT RAISE(ABORT,'capture_record_immutable'); END;
`});
