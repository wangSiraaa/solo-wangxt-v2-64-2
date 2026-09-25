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
} from 'typeorm';
import { CaseStatus, GradeCode } from '../common/enums';
import { ScaleVersion } from './scale-version.entity';
import { AssessorAnswer } from './assessor-answer.entity';
import { ReviewDecision } from './review-decision.entity';
import { NotificationRecord } from './notification.entity';
import { GradeVersion } from './grade-version.entity';
import { Appeal } from './appeal.entity';

/** 一次评估案件：同一位老人可多次评估，每次独立成案 */
@Entity('assessment_cases')
export class AssessmentCase {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  @Column({ name: 'elder_name', type: 'varchar', length: 100 })
  elderName: string;

  /** 家属联系方式（告知服务适配器使用） */
  @Column({ name: 'family_contact', type: 'varchar', length: 64 })
  familyContact: string;

  @ManyToOne(() => ScaleVersion)
  @JoinColumn({ name: 'scale_version_id' })
  scaleVersion: ScaleVersion;

  @Column({ name: 'status', type: 'varchar', length: 20, default: CaseStatus.INCOMPLETE })
  status: CaseStatus;

  // ---- 评估员 1 的评分解释（可定级时才有值） ----
  @Column({ name: 'assessor1_raw_score', type: 'int', nullable: true })
  assessor1RawScore: number | null;

  @Column({ name: 'assessor1_max_score', type: 'int', nullable: true })
  assessor1MaxScore: number | null;

  @Column({ name: 'assessor1_score_pct', type: 'numeric', precision: 8, scale: 5, nullable: true })
  assessor1ScorePct: string | null;

  @Column({ name: 'assessor1_grade', type: 'varchar', length: 20, nullable: true })
  assessor1Grade: GradeCode | null;

  // ---- 评估员 2 ----
  @Column({ name: 'assessor2_raw_score', type: 'int', nullable: true })
  assessor2RawScore: number | null;

  @Column({ name: 'assessor2_max_score', type: 'int', nullable: true })
  assessor2MaxScore: number | null;

  @Column({ name: 'assessor2_score_pct', type: 'numeric', precision: 8, scale: 5, nullable: true })
  assessor2ScorePct: string | null;

  @Column({ name: 'assessor2_grade', type: 'varchar', length: 20, nullable: true })
  assessor2Grade: GradeCode | null;

  /** 两位评估员逐项评分解释快照（评分来源可追溯） */
  @Column({ name: 'assessor1_details', type: 'jsonb', nullable: true })
  assessor1Details: unknown | null;

  @Column({ name: 'assessor2_details', type: 'jsonb', nullable: true })
  assessor2Details: unknown | null;

  /** 最终确认等级（未确认前为 null） */
  @Index()
  @Column({ name: 'confirmed_grade', type: 'varchar', length: 20, nullable: true })
  confirmedGrade: GradeCode | null;

  /** 两位评估员等级是否冲突 */
  @Column({ name: 'conflicting', type: 'boolean', default: false })
  conflicting: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @OneToMany(() => AssessorAnswer, (a) => a.assessmentCase, { cascade: true })
  answers: AssessorAnswer[];

  @OneToOne(() => ReviewDecision, (r) => r.assessmentCase)
  review: ReviewDecision;

  /** 当前有效等级版本；申诉变更时追加版本并切换指向 */
  @ManyToOne(() => GradeVersion, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'current_grade_version_id' })
  currentGradeVersion: GradeVersion | null;

  @Column({ name: 'current_grade_version_id', type: 'uuid', nullable: true })
  currentGradeVersionId: string | null;

  @OneToMany(() => NotificationRecord, (n) => n.assessmentCase)
  notifications: NotificationRecord[];

  @OneToMany(() => GradeVersion, (g) => g.assessmentCase)
  gradeVersions: GradeVersion[];

  @OneToMany(() => Appeal, (a) => a.assessmentCase)
  appeals: Appeal[];
}
