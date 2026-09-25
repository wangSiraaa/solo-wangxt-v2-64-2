import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AppealEventType } from '../common/enums';
import { Appeal } from './appeal.entity';

/** 追加式事件日志：申诉生命周期的每次合法状态迁移均不可变留痕 */
@Entity('appeal_events')
@Index(['appeal', 'createdAt'])
export class AppealEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Appeal, (a) => a.events, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'appeal_id' })
  appeal: Appeal;

  @Column({ name: 'appeal_id', type: 'uuid' })
  appealId: string;

  @Column({ name: 'event_type', type: 'varchar', length: 32 })
  eventType: AppealEventType;

  @Column({ name: 'from_status', type: 'varchar', length: 32, nullable: true })
  fromStatus: string | null;

  @Column({ name: 'to_status', type: 'varchar', length: 32, nullable: true })
  toStatus: string | null;

  @Column({ name: 'actor_id', type: 'varchar', length: 100 })
  actorId: string;

  @Column({ name: 'payload', type: 'jsonb', nullable: true })
  payload: unknown | null;

  @Column({ name: 'request_fingerprint', type: 'varchar', length: 128, nullable: true })
  requestFingerprint: string | null;

  @Index('appeal_events_idempotency_key_key', {
    unique: true,
    where: 'idempotency_key IS NOT NULL',
  })
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128, nullable: true })
  idempotencyKey: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
