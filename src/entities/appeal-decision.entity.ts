import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AppealDecisionValue, GradeCode } from '../common/enums';
import { Appeal } from './appeal.entity';

/**
 * 申诉裁决决定：每条申诉至多一条（appeal_id 唯一约束），
 * 与原复核意见（review_decisions）完全分离——裁决不改写原复核意见。
 * 变更（CHANGED）时追加新等级版本（grade_periods 行）并按明确生效日
 * 计算前后费用差异（fee_impact 快照）。
 */
@Entity('appeal_decisions')
export class AppealDecision {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 一条申诉仅一条有效裁决：并发裁决由行锁 + 本唯一约束双重保证 */
  @Index('appeal_decisions_one_per_appeal', { unique: true })
  @Column({ name: 'appeal_id', type: 'uuid' })
  appealId: string;

  @OneToOne(() => Appeal, (a) => a.decision, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'appeal_id' })
  appeal: Appeal;

  @Column({ name: 'decision', type: 'varchar', length: 20 })
  decision: AppealDecisionValue;

  @Column({ name: 'adjudicator_id', type: 'varchar', length: 64 })
  adjudicatorId: string;

  /** 裁决意见（独立于原复核意见） */
  @Column({ name: 'comment', type: 'text' })
  comment: string;

  /** 裁决前等级（申诉时的确认等级快照） */
  @Column({ name: 'original_grade', type: 'varchar', length: 20 })
  originalGrade: GradeCode;

  /** 变更后的新等级（维持时为 null） */
  @Column({ name: 'new_grade', type: 'varchar', length: 20, nullable: true })
  newGrade: GradeCode | null;

  /** 新等级生效日（维持时为 null） */
  @Column({ name: 'effective_date', type: 'date', nullable: true })
  effectiveDate: string | null;

  /** 前后费用差异快照：窗口、变更前后分段与合计、差额 */
  @Column({ name: 'fee_impact', type: 'jsonb', nullable: true })
  feeImpact: unknown | null;

  /** 追加的新等级版本（grade_periods.id；维持时为 null） */
  @Column({ name: 'grade_period_id', type: 'uuid', nullable: true })
  gradePeriodId: string | null;

  /** 裁决幂等键 */
  @Index('appeal_decisions_idempotency_key_key', {
    unique: true,
    where: 'idempotency_key IS NOT NULL',
  })
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128, nullable: true })
  idempotencyKey: string | null;

  @CreateDateColumn({ name: 'decided_at' })
  decidedAt: Date;
}
