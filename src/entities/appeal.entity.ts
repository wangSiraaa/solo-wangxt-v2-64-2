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
import { AppealStatus, GradeCode } from '../common/enums';
import { AssessmentCase } from './assessment-case.entity';
import { NotificationRecord } from './notification.entity';
import { AppealEvent } from './appeal-event.entity';
import { AppealDecision } from './appeal-decision.entity';

/**
 * 家属申诉：绑定“当时的”确认等级、量表答案与送达快照。
 * 同一告知（notification）最多存在一条进行中的申诉——
 * 由部分唯一索引 appeals_one_open_per_notification 原子保证。
 * 受理前提：告知已送达（DELIVERED）且在申诉期限内；否则拒绝受理且不污染评估。
 */
@Entity('appeals')
export class Appeal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 被异议的告知记录（送达快照来源） */
  @Index()
  @Column({ name: 'notification_id', type: 'uuid' })
  notificationId: string;

  @ManyToOne(() => NotificationRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'notification_id' })
  notification: NotificationRecord;

  @Index()
  @Column({ name: 'assessment_case_id', type: 'uuid' })
  assessmentCaseId: string;

  @ManyToOne(() => AssessmentCase, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assessment_case_id' })
  assessmentCase: AssessmentCase;

  @Index()
  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  @Index()
  @Column({ name: 'status', type: 'varchar', length: 24 })
  status: AppealStatus;

  /** 异议理由 */
  @Column({ name: 'reason', type: 'text' })
  reason: string;

  /** 申诉人标识（家属） */
  @Column({ name: 'filed_by', type: 'varchar', length: 64 })
  filedBy: string;

  /** 业务申诉日期（受理期限判断基准；演示环境可显式指定） */
  @Column({ name: 'filed_on', type: 'date' })
  filedOn: string;

  /** 已提交材料清单（初始 + 历次补正追加） */
  @Column({ name: 'materials', type: 'jsonb', default: [] })
  materials: string[];

  // ---- 快照：异议所针对的“当时”状态，复核/裁决与后续变更均不得改写 ----
  /** 当时的确认等级 */
  @Column({ name: 'snapshot_grade', type: 'varchar', length: 20 })
  snapshotGrade: GradeCode;

  /** 当时的量表答案快照（两位评估员逐项作答） */
  @Column({ name: 'snapshot_answers', type: 'jsonb' })
  snapshotAnswers: unknown;

  /** 当时的送达快照（告知记录原文、状态、送达时间） */
  @Column({ name: 'snapshot_delivery', type: 'jsonb' })
  snapshotDelivery: unknown;

  /** 当时的复核意见快照（裁决不得改写原复核意见，仅对照留档） */
  @Column({ name: 'snapshot_review', type: 'jsonb', nullable: true })
  snapshotReview: unknown | null;

  /** 受理期限（送达日 + 申诉窗口），快照保存便于审计 */
  @Column({ name: 'appeal_deadline', type: 'date' })
  appealDeadline: string;

  /** 补正期限（仅 PENDING_CORRECTION 状态适用；过期未补齐 → EXPIRED） */
  @Column({ name: 'correction_deadline', type: 'date', nullable: true })
  correctionDeadline: string | null;

  /** 申诉创建幂等键 */
  @Index('appeals_idempotency_key_key', {
    unique: true,
    where: 'idempotency_key IS NOT NULL',
  })
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128, nullable: true })
  idempotencyKey: string | null;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => AppealEvent, (e) => e.appeal)
  events: AppealEvent[];

  @OneToOne(() => AppealDecision, (d) => d.appeal)
  decision: AppealDecision | null;
}
