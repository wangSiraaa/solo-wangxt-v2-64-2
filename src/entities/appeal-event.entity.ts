import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AppealEventAction } from '../common/enums';
import { Appeal } from './appeal.entity';

/**
 * 申诉留痕事件：每次状态迁移（提交/补正/裁决/撤回/过期）独立成行，
 * 携带操作者、说明与负载（补正材料、裁决要点、费用影响等），全程可复核。
 * (appeal_id, idempotency_key) 部分唯一索引：补正/撤回/裁决的重复或乱序
 * 请求按幂等回放处理，并发下也不会产生重复事件。
 */
@Entity('appeal_events')
@Index(
  'appeal_events_appeal_idempotency_key',
  ['appealId', 'idempotencyKey'],
  { unique: true, where: 'idempotency_key IS NOT NULL' },
)
export class AppealEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'appeal_id', type: 'uuid' })
  appealId: string;

  @ManyToOne(() => Appeal, (a) => a.events, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'appeal_id' })
  appeal: Appeal;

  @Column({ name: 'action', type: 'varchar', length: 20 })
  action: AppealEventAction;

  /** 操作者（家属/管理员/系统） */
  @Column({ name: 'actor', type: 'varchar', length: 64 })
  actor: string;

  @Column({ name: 'note', type: 'text', nullable: true })
  note: string | null;

  /** 事件负载：补正材料、裁决结论、费用影响等 */
  @Column({ name: 'payload', type: 'jsonb', nullable: true })
  payload: unknown | null;

  /** 幂等键：同一申诉内唯一 */
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128, nullable: true })
  idempotencyKey: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
