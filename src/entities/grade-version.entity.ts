import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { GradeCode, GradeVersionSource } from '../common/enums';
import { AssessmentCase } from './assessment-case.entity';
import { ReviewDecision } from './review-decision.entity';

/**
 * 已确认等级的不可变版本。
 * 原始复核意见永远不被改写；申诉变更时追加新版本，原版本仍可追溯。
 */
@Entity('grade_versions')
@Index(['assessmentCase', 'versionNumber'], { unique: true })
export class GradeVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => AssessmentCase, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assessment_case_id' })
  assessmentCase: AssessmentCase;

  /** 同一案件内从 1 递增 */
  @Column({ name: 'version_number', type: 'int' })
  versionNumber: number;

  @Column({ name: 'grade', type: 'varchar', length: 20 })
  grade: GradeCode;

  @Column({ name: 'source', type: 'varchar', length: 20 })
  source: GradeVersionSource;

  /** v1 指向复核记录；变更版本指向申诉 */
  @Column({ name: 'source_review_id', type: 'uuid', nullable: true })
  sourceReviewId: string | null;

  @Column({ name: 'source_appeal_id', type: 'uuid', nullable: true })
  sourceAppealId: string | null;

  /** 变更等级的明确费用生效日；原确认版本无强制生效日 */
  @Column({ name: 'effective_date', type: 'date', nullable: true })
  effectiveDate: string | null;

  /** 变更版本生成等级期间后回填；v1 可能尚未手动费用生效 */
  @Column({ name: 'grade_period_id', type: 'uuid', nullable: true })
  gradePeriodId: string | null;

  /** 快照记录等级确认依据，避免后续编辑影响证据链 */
  @Column({ name: 'basis_snapshot', type: 'jsonb' })
  basisSnapshot: unknown;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => ReviewDecision)
  sourceReview?: ReviewDecision;
}
