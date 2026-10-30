import type {StorageMigration} from '../../storage/sqlite/contracts.ts';

/** 显式接受顺序不随VACUUM改变；旧捕获和目标不臆造先后。 */
export const historyAcceptanceOrderMigration=(version:number):StorageMigration=>({version,sql:`
ALTER TABLE sync_capture ADD COLUMN acceptance_no INTEGER CHECK(acceptance_no IS NULL OR acceptance_no>0);
CREATE UNIQUE INDEX sync_capture_acceptance_order ON sync_capture(acceptance_no) WHERE acceptance_no IS NOT NULL;
CREATE TRIGGER sync_capture_acceptance_immutable BEFORE UPDATE OF acceptance_no ON sync_capture
 BEGIN SELECT RAISE(ABORT,'history_capture_order_immutable'); END;
ALTER TABLE read_goal ADD COLUMN creation_no INTEGER CHECK(creation_no IS NULL OR creation_no>0);
CREATE UNIQUE INDEX read_goal_creation_order ON read_goal(creation_no) WHERE creation_no IS NOT NULL;
CREATE TRIGGER read_goal_creation_immutable BEFORE UPDATE OF creation_no ON read_goal
 BEGIN SELECT RAISE(ABORT,'history_goal_order_immutable'); END;
`});
