BEGIN;

ALTER TABLE public.source_document
    DROP CONSTRAINT source_document_status_check,
    ALTER COLUMN file_name DROP NOT NULL,
    ALTER COLUMN content_sha256 DROP NOT NULL,
    ADD COLUMN deletion_operation_id uuid,
    ADD COLUMN deletion_error_code text,
    ADD CONSTRAINT source_document_status_check
        CHECK (status IN (
            'active',
            'delete_requested',
            'deleting',
            'delete_failed',
            'deleted'
        )),
    ADD CONSTRAINT source_document_deleted_receipt_check
        CHECK (
            (
                status = 'deleted'
                AND file_name IS NULL
                AND content_sha256 IS NULL
                AND record_count = 0
                AND deleted_at IS NOT NULL
                AND deletion_operation_id IS NULL
                AND deletion_error_code IS NULL
            )
            OR (
                status <> 'deleted'
                AND file_name IS NOT NULL
                AND content_sha256 IS NOT NULL
                AND record_count >= 0
                AND deleted_at IS NULL
            )
        );

COMMENT ON COLUMN public.source_document.deletion_operation_id IS
    '当前删除执行的内部 UUID；用于阻止并发执行接管同一来源。';
COMMENT ON COLUMN public.source_document.deletion_error_code IS
    '不含私密正文的删除失败分类；删除成功后清空。';

COMMIT;
