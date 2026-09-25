import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { GradeCode } from '../common/enums';
import { GradeVersion } from './grade-version.entity';

/**
 * 老人已生效等级期间（半开区间 [startDate, endDateExclusive)）。
 * 同一老人同一天不得出现重叠生效等级：
 *   数据库排除约束 grade_periods_no_overlap（btree_gist + daterange）为最终防线，
 *   服务层先做显式重叠校验给出可读错误。
 */
@Entity('grade_periods')
@Index(['elderId', 'startDate'])
export class GradeEffectivePeriod {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  @Column({ name: 'grade', type: 'varchar', length: 20 })
  grade: GradeCode;

  /** 生效首日 YYYY-MM-DD */
  @Column({ name: 'start_date', type: 'date' })
  startDate: string;

  /** 失效日（不含）；null 表示开放区间。结束时写入最后生效日的次日 */
  @Column({ name: 'end_date_exclusive', type: 'date', nullable: true })
  endDateExclusive: string | null;

  /** 来源评估案件 */
  @Column({ name: 'source_case_id', type: 'uuid' })
  sourceCaseId: string;

  /** 原确认或申诉变更等级版本；历史数据由迁移回填为案件 v1 */
  @ManyToOne(() => GradeVersion, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'grade_version_id' })
  gradeVersion: GradeVersion | null;

  @Column({ name: 'grade_version_id', type: 'uuid', nullable: true })
  gradeVersionId: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
