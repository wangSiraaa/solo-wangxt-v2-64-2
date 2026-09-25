import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Appeal } from './appeal.entity';

export type AppealMaterialKind = 'INITIAL' | 'SUPPLEMENT';

@Entity('appeal_materials')
@Index(['appeal', 'sequence'])
export class AppealMaterial {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Appeal, (a) => a.materials, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'appeal_id' })
  appeal: Appeal;

  @Column({ name: 'appeal_id', type: 'uuid' })
  appealId: string;

  @Column({ name: 'sequence', type: 'int' })
  sequence: number;

  @Column({ name: 'kind', type: 'varchar', length: 20, default: 'INITIAL' })
  kind: AppealMaterialKind;

  @Column({ name: 'file_name', type: 'varchar', length: 255 })
  fileName: string;

  /** 演示系统不接收真实文件，仅保存外部材料标识或说明 */
  @Column({ name: 'file_ref', type: 'varchar', length: 255 })
  fileRef: string;

  @Column({ name: 'note', type: 'text', nullable: true })
  note: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
