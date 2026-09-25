import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  AppealRulingOutcome,
  AppealStatus,
  GradeCode,
} from '../common/enums';
import { AssessmentCase } from './assessment-case.entity';
import { NotificationRecord } from './notification.entity';
import { GradeVersion } from './grade-version.entity';
import { AppealEvent } from './appeal-event.entity';
import { AppealMaterial } from './appeal-material.entity';

/**
 * 家属申诉：绑定提出异议时的确认等级、量表答案与送达快照。
 * 相同告知只允许一个进行中的申诉，终态后才可以基于新告知重新申诉。
 */
@Entity('appeals')
export class Appeal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @ManyToOne(() => AssessmentCase, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assessment_case_id' })
  assessmentCase: AssessmentCase;

  @Index('appeals_notification_active_idx', {
    unique: true,
    where: `status IN ('SUBMITTED','PENDING_CORRECTION','PENDING_RULING')`,
  })
  @ManyToOne(() => NotificationRecord, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'notification_id' })
  notification: NotificationRecord;

  /** 申请时当前等级版本（等级快照另行 JSON 固化） */
  @ManyToOne(() => GradeVersion, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'bound_grade_version_id' })
  boundGradeVersion: GradeVersion;

  @Column({ name: 'bound_grade_version_id', type: 'uuid' })
  boundGradeVersionId: string;

  @Column({ name: 'family_requester', type: 'varchar', length: 100 })
  familyRequester: string;

  @Column({ name: 'reason', type: 'text' })
  reason: string;

  @Column({ name: 'status', type: 'varchar', length: 32 })
  status: AppealStatus;

  @Column({ name: 'deadline_date', type: 'date' })
  deadlineDate: string;

  @Column({ name: 'submitted_at', type: 'timestamptz', default: () => 'now()' })
  submittedAt: Date;

  @Column({ name: 'correction_due_date', type: 'date', nullable: true })
  correctionDueDate: string | null;

  @Column({ name: 'correction_requested_at', type: 'timestamptz', nullable: true })
  correctionRequestedAt: Date | null;

  @Column({ name: 'supplemented_at', type: 'timestamptz', nullable: true })
  supplementedAt: Date | null;

  @Column({ name: 'ruling_outcome', type: 'varchar', length: 20, nullable: true })
  rulingOutcome: AppealRulingOutcome | null;

  @Column({ name: 'ruled_grade', type: 'varchar', length: 20, nullable: true })
  ruledGrade: GradeCode | null;

  @Column({ name: 'ruling_comment', type: 'text', nullable: true })
  rulingComment: string | null;

  @Column({ name: 'reviewer_id', type: 'varchar', length: 64, nullable: true })
  reviewerId: string | null;

  @Column({ name: 'ruled_at', type: 'timestamptz', nullable: true })
  ruledAt: Date | null;

  @Column({ name: 'effective_date', type: 'date', nullable: true })
  effectiveDate: string | null;

  /** 裁决产生的新等级版本；维持时为空 */
  @ManyToOne(() => GradeVersion, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'result_grade_version_id' })
  resultGradeVersion: GradeVersion | null;

  @Column({ name: 'result_grade_version_id', type: 'uuid', nullable: true })
  resultGradeVersionId: string | null;

  @Column({ name: 'fee_before_amount', type: 'numeric', precision: 12, scale: 2, nullable: true })
  feeBeforeAmount: string | null;

  @Column({ name: 'fee_after_amount', type: 'numeric', precision: 12, scale: 2, nullable: true })
  feeAfterAmount: string | null;

  @Column({ name: 'fee_delta_amount', type: 'numeric', precision: 12, scale: 2, nullable: true })
  feeDeltaAmount: string | null;

  @Column({ name: 'fee_impact_from', type: 'date', nullable: true })
  feeImpactFrom: string | null;

  @Column({ name: 'fee_impact_to', type: 'date', nullable: true })
  feeImpactTo: string | null;

  @Column({ name: 'withdrawn_at', type: 'timestamptz', nullable: true })
  withdrawnAt: Date | null;

  @Column({ name: 'expired_at', type: 'timestamptz', nullable: true })
  expiredAt: Date | null;

  /** 确认等级、复核意见、量表答案、送达结果在申请时的不可变快照 */
  @Column({ name: 'grade_snapshot', type: 'jsonb' })
  gradeSnapshot: unknown;

  @Column({ name: 'answers_snapshot', type: 'jsonb' })
  answersSnapshot: unknown;

  @Column({ name: 'delivery_snapshot', type: 'jsonb' })
  deliverySnapshot: unknown;

  @Index('appeals_submit_idempotency_key_key', {
    unique: true,
    where: 'submit_idempotency_key IS NOT NULL',
  })
  @Column({ name: 'submit_idempotency_key', type: 'varchar', length: 128, nullable: true })
  submitIdempotencyKey: string | null;

  @OneToMany(() => AppealMaterial, (m) => m.appeal, { cascade: true })
  materials: AppealMaterial[];

  @OneToMany(() => AppealEvent, (e) => e.appeal, { cascade: true })
  events: AppealEvent[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
