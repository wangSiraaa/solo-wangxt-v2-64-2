import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  NotifiableStatus,
  NotificationStatus,
} from '../common/enums';
import { AssessmentCase } from './assessment-case.entity';
import { GradeVersion } from './grade-version.entity';

/** 家属告知记录：送达失败与尚未确认分别独立记录状态 */
@Entity('notification_records')
export class NotificationRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @ManyToOne(() => AssessmentCase, (c) => c.notifications, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assessment_case_id' })
  assessmentCase: AssessmentCase;

  /** 该告知送达的是哪一版确认等级；未确认尝试为空 */
  @ManyToOne(() => GradeVersion, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'grade_version_id' })
  gradeVersion: GradeVersion | null;

  @Column({ name: 'grade_version_id', type: 'uuid', nullable: true })
  gradeVersionId: string | null;

  /** 成功送达日；PENDING/FAILED 为 null，也是申诉期限起算日 */
  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @Column({ name: 'status', type: 'varchar', length: 20, default: NotificationStatus.PENDING })
  status: NotificationStatus;

  /** 告知对象的可告知状态：已确认 / 尚未确认（与送达结果分开记录） */
  @Column({ name: 'notifiable_status', type: 'varchar', length: 20 })
  notifiableStatus: NotifiableStatus;

  @Column({ name: 'message', type: 'text', nullable: true })
  message: string | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'last_attempt_at', type: 'timestamptz', nullable: true })
  lastAttemptAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
