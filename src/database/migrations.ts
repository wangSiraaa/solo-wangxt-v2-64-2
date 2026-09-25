import { DataSource } from 'typeorm';

/**
 * 001_appeal_workflow
 *
 * 持久化、幂等的结构迁移：申诉/等级版本/事件/材料、告知送达日、
 * 等级期间版本指针，以及状态机所需的部分唯一索引和 CHECK 约束。
 * TypeORM synchronize 负责补缺列/表；这里保留显式 SQL，使关键原子约束
 * 不依赖装饰器，并可在既有数据库重启时重复执行。
 */
const statements: string[] = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     version varchar(128) PRIMARY KEY,
     applied_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,

  `ALTER TABLE notification_records ADD COLUMN IF NOT EXISTS grade_version_id uuid`,
  `ALTER TABLE notification_records ADD COLUMN IF NOT EXISTS delivered_at timestamptz`,
  `UPDATE notification_records
      SET delivered_at = last_attempt_at
    WHERE status = 'DELIVERED' AND delivered_at IS NULL`,

  `ALTER TABLE grade_periods ADD COLUMN IF NOT EXISTS grade_version_id uuid`,

  // 历史确认数据回填为不可变 v1；原复核意见仍在 review_decisions，不复制改写。
  `INSERT INTO grade_versions (
     id, assessment_case_id, version_number, grade, source,
     source_review_id, source_appeal_id, effective_date, grade_period_id,
     basis_snapshot, created_at
   )
   SELECT gen_random_uuid(), c.id, 1, c.confirmed_grade, 'REVIEW',
          r.id, NULL, NULL, NULL,
          jsonb_build_object(
            'reviewId', r.id,
            'result', r.result,
            'reviewerId', r.reviewer_id,
            'comment', r.comment,
            'decidedAt', r.decided_at
          ),
          COALESCE(r.decided_at, now())
     FROM assessment_cases c
     JOIN review_decisions r ON r.assessment_case_id = c.id
    WHERE c.confirmed_grade IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM grade_versions gv WHERE gv.assessment_case_id = c.id
      )`,
  `UPDATE assessment_cases c
      SET current_grade_version_id = gv.id
     FROM grade_versions gv
    WHERE gv.assessment_case_id = c.id
      AND gv.version_number = 1
      AND c.current_grade_version_id IS NULL`,
  `UPDATE notification_records n
      SET grade_version_id = gv.id
     FROM grade_versions gv
    WHERE gv.assessment_case_id = n.assessment_case_id
      AND gv.version_number = 1
      AND n.notifiable_status = 'CONFIRMED'
      AND n.grade_version_id IS NULL`,
  `UPDATE grade_periods p
      SET grade_version_id = gv.id
     FROM grade_versions gv
    WHERE gv.assessment_case_id = p.source_case_id
      AND gv.version_number = 1
      AND p.grade_version_id IS NULL`,

  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_records_grade_version_fk') THEN
       ALTER TABLE notification_records
         ADD CONSTRAINT notification_records_grade_version_fk
         FOREIGN KEY (grade_version_id) REFERENCES grade_versions(id) ON DELETE RESTRICT;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grade_periods_grade_version_fk') THEN
       ALTER TABLE grade_periods
         ADD CONSTRAINT grade_periods_grade_version_fk
         FOREIGN KEY (grade_version_id) REFERENCES grade_versions(id) ON DELETE RESTRICT;
     END IF;
   END $$`,

  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grade_versions_source_check') THEN
       ALTER TABLE grade_versions
         ADD CONSTRAINT grade_versions_source_check
         CHECK (source IN ('REVIEW','APPEAL'));
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appeals_status_check') THEN
       ALTER TABLE appeals
         ADD CONSTRAINT appeals_status_check
         CHECK (status IN ('SUBMITTED','PENDING_CORRECTION','PENDING_RULING','UPHELD','CHANGED','WITHDRAWN','EXPIRED'));
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appeals_ruling_outcome_check') THEN
       ALTER TABLE appeals
         ADD CONSTRAINT appeals_ruling_outcome_check
         CHECK (ruling_outcome IS NULL OR ruling_outcome IN ('UPHELD','CHANGED'));
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appeals_ruled_grade_check') THEN
       ALTER TABLE appeals
         ADD CONSTRAINT appeals_ruled_grade_check
         CHECK (ruled_grade IS NULL OR ruled_grade IN ('LIGHT','MODERATE','SEVERE'));
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appeals_changed_requires_version_check') THEN
       ALTER TABLE appeals
         ADD CONSTRAINT appeals_changed_requires_version_check
         CHECK (
           (status <> 'CHANGED' AND ruling_outcome <> 'CHANGED')
           OR result_grade_version_id IS NOT NULL
         );
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appeal_events_event_type_check') THEN
       ALTER TABLE appeal_events
         ADD CONSTRAINT appeal_events_event_type_check
         CHECK (event_type IN (
           'SUBMITTED','CORRECTION_REQUESTED','SUPPLEMENTED',
           'RULED_UPHELD','RULED_CHANGED','WITHDRAWN','EXPIRED'
         ));
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appeal_materials_kind_check') THEN
       ALTER TABLE appeal_materials
         ADD CONSTRAINT appeal_materials_kind_check
         CHECK (kind IN ('INITIAL','SUPPLEMENT'));
     END IF;
   END $$`,

  // 相同告知只能有一个进行中的申诉。
  `CREATE UNIQUE INDEX IF NOT EXISTS appeals_notification_active_idx
     ON appeals (notification_id)
     WHERE status IN ('SUBMITTED','PENDING_CORRECTION','PENDING_RULING')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS appeals_submit_idempotency_key_key
     ON appeals (submit_idempotency_key)
     WHERE submit_idempotency_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS appeal_events_idempotency_key_key
     ON appeal_events (idempotency_key)
     WHERE idempotency_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS grade_versions_case_version_key
     ON grade_versions (assessment_case_id, version_number)`,
];

export async function runMigrations(dataSource: DataSource): Promise<void> {
  await dataSource.query(statements[0]);
  const applied = await dataSource.query(
    `SELECT version FROM schema_migrations WHERE version = $1`,
    ['001_appeal_workflow'],
  );
  if (applied.length > 0) return;

  await dataSource.transaction(async (em) => {
    for (const statement of statements.slice(1)) {
      await em.query(statement);
    }
    await em.query(
      `INSERT INTO schema_migrations (version) VALUES ($1)`,
      ['001_appeal_workflow'],
    );
  });
}
