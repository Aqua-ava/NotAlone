import type { StorageMigration } from '../../storage/sqlite/contracts.ts';

/** 联系人展示头像独立于聊天来源保存，按 owner/contact 清理。 */
export const contactAvatarMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE contact_avatar (
 owner_id TEXT NOT NULL, contact_id TEXT NOT NULL,
 mime_type TEXT NOT NULL CHECK(mime_type='image/png'), image BLOB NOT NULL CHECK(length(image)>0 AND length(image)<=262144),
 digest TEXT NOT NULL CHECK(length(digest)=64), updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,contact_id), FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id)
) STRICT;
CREATE TABLE contact_avatar_clock (
 owner_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=0),
 FOREIGN KEY(owner_id) REFERENCES owner(owner_id)
) STRICT;
CREATE TRIGGER contact_avatar_insert_clock AFTER INSERT ON contact_avatar BEGIN
 INSERT INTO contact_avatar_clock(owner_id,revision) VALUES(NEW.owner_id,1)
 ON CONFLICT(owner_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER contact_avatar_update_clock AFTER UPDATE ON contact_avatar BEGIN
 INSERT INTO contact_avatar_clock(owner_id,revision) VALUES(NEW.owner_id,1)
 ON CONFLICT(owner_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER contact_avatar_delete_clock AFTER DELETE ON contact_avatar BEGIN
 INSERT INTO contact_avatar_clock(owner_id,revision) VALUES(OLD.owner_id,1)
 ON CONFLICT(owner_id) DO UPDATE SET revision=revision+1;
END;
`});
