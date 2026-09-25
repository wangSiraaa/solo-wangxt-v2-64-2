import { DataSource, DataSourceOptions } from 'typeorm';
import { ScaleVersion } from '../entities/scale-version.entity';
import { ScaleItem } from '../entities/scale-item.entity';
import { ScaleOption } from '../entities/scale-option.entity';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { AssessorAnswer } from '../entities/assessor-answer.entity';
import { ReviewDecision } from '../entities/review-decision.entity';
import { NotificationRecord } from '../entities/notification.entity';
import { GradeEffectivePeriod } from '../entities/grade-period.entity';
import { FeeRateVersion } from '../entities/fee-rate-version.entity';
import { Appeal } from '../entities/appeal.entity';
import { AppealEvent } from '../entities/appeal-event.entity';
import { AppealDecision } from '../entities/appeal-decision.entity';
import { seedDemoData } from './seed';

export const entities = [
  ScaleVersion,
  ScaleItem,
  ScaleOption,
  AssessmentCase,
  AssessorAnswer,
  ReviewDecision,
  NotificationRecord,
  GradeEffectivePeriod,
  FeeRateVersion,
  Appeal,
  AppealEvent,
  AppealDecision,
];

export function buildDataSourceOptions(): DataSourceOptions {
  return {
    type: 'postgres',
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_DATABASE || 'eldercare',
    entities,
    synchronize: false,
  };
}

/**
 * 幂等建表 + 防重叠排除约束 + 申诉闭环原子约束（首次启动建表；后续启动只补缺）。
 * 同一老人同一天不得出现重叠生效等级：
 *   btree_gist 提供 daterange 排他约束（半开区间，相邻期间首尾相接不算重叠）。
 * 申诉闭环：
 *   appeals_one_open_per_notification —— 同一告知最多一条进行中申诉；
 *   appeal_events_appeal_idempotency_key —— 同一申诉内补正/撤回/裁决幂等键唯一。
 */
export async function ensureSchema(dataSource: DataSource): Promise<void> {
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

  // 持久化迁移：任一核心表缺失（含升级库缺申诉表）即同步缺失表/列
  const missing = await dataSource.query(
    `SELECT (to_regclass('grade_periods') IS NULL
          OR to_regclass('appeals') IS NULL
          OR to_regclass('appeal_events') IS NULL
          OR to_regclass('appeal_decisions') IS NULL) AS missing`,
  );
  if (missing[0].missing) {
    await dataSource.synchronize();
  }

  const constraint = await dataSource.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'grade_periods_no_overlap'`,
  );
  if (constraint.length === 0) {
    await dataSource.query(`
      ALTER TABLE grade_periods
        ADD CONSTRAINT grade_periods_no_overlap
        EXCLUDE USING gist (
          elder_id WITH =,
          daterange(start_date, end_date_exclusive, '[)') WITH &&
        )
    `);
  }

  // 原子约束（部分唯一索引）：显式创建，对既有库同样生效
  await dataSource.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS appeals_one_open_per_notification
      ON appeals (notification_id)
      WHERE status IN ('SUBMITTED', 'PENDING_CORRECTION', 'PENDING_ADJUDICATION')
  `);
  await dataSource.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS appeal_events_appeal_idempotency_key
      ON appeal_events (appeal_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `);
}

let singleton: Promise<DataSource> | null = null;

/** 一次性“连接-建表-种子”（独立脚本使用） */
export async function buildInitializedDataSource(): Promise<DataSource> {
  const ds = new DataSource(buildDataSourceOptions());
  await ds.initialize();
  await ensureSchema(ds);
  await seedDemoData(ds);
  return ds;
}

/** Nest 启动与 e2e 测试共用同一套“连接-建表-种子”流程 */
export function getOrCreateDataSource(): Promise<DataSource> {
  if (!singleton) {
    singleton = (async () => {
      const ds = new DataSource(buildDataSourceOptions());
      await ds.initialize();
      await ensureSchema(ds);
      await seedDemoData(ds);
      return ds;
    })();
    singleton.catch(() => {
      singleton = null; // 允许后续重试
    });
  }
  return singleton;
}
