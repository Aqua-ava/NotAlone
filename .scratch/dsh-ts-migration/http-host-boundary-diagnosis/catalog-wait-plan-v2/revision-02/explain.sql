EXPLAIN (ANALYZE TRUE, BUFFERS TRUE, TIMING FALSE, SUMMARY TRUE, FORMAT JSON) WITH catalog_rows AS (
        SELECT c.relname,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS kind
        FROM unnest($1::text[],$2::text[]) AS required(relname,attname)
        JOIN pg_catalog.pg_class c ON c.relname=required.relname
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=required.attname AND a.attnum>0 AND NOT a.attisdropped
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND EXISTS(
          SELECT 1 FROM pg_catalog.pg_attribute visible WHERE visible.attrelid=c.oid AND visible.attnum>0 AND NOT visible.attisdropped)
      ), checked_tables AS (
        SELECT c.oid,c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p')
          AND c.relname IN ('model_call_receipt','model_call_learning_claim','background_task_step')
      ) SELECT
        COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM catalog_rows r),'[]'::jsonb) AS catalog,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('table',t.relname,'attname',a.attname,'attnotnull',a.attnotnull))
          FROM checked_tables t JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid
          WHERE t.relname IN ('model_call_receipt','model_call_learning_claim') AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb) AS columns,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('table',t.relname,'contype',c.contype,
          'convalidated',c.convalidated,'condeferrable',c.condeferrable,'condeferred',c.condeferred,
          'definition',pg_catalog.pg_get_constraintdef(c.oid),'indisvalid',i.indisvalid,'indisready',i.indisready))
          FROM checked_tables t JOIN pg_catalog.pg_constraint c ON c.conrelid=t.oid
          LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.conindid),'[]'::jsonb) AS constraints