/** 评估案件状态：必填项缺失不得定级；冲突进入复核而非自动取高 */
export enum CaseStatus {
  /** 评估员答案缺失必填项，无法定级，需补充/重新评估 */
  INCOMPLETE = 'INCOMPLETE',
  /** 两位评估员等级一致，系统确认（系统生成“一致确认”复核记录） */
  CONFIRMED = 'CONFIRMED',
  /** 两位评估员结果冲突，等待管理复核 */
  PENDING_REVIEW = 'PENDING_REVIEW',
}

export enum GradeCode {
  LIGHT = 'LIGHT', // 轻度失能
  MODERATE = 'MODERATE', // 中度失能
  SEVERE = 'SEVERE', // 重度失能
}

export enum ReviewResult {
  /** 双评估员一致，系统直接确认 */
  AGREEMENT = 'AGREEMENT',
  /** 冲突案件由管理员复核确认 */
  CONFIRMED = 'CONFIRMED',
}

export enum NotificationStatus {
  /** 等级已确认，待送达 */
  PENDING = 'PENDING',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
}

export enum NotifiableStatus {
  CONFIRMED = 'CONFIRMED',
  UNCONFIRMED = 'UNCONFIRMED',
}

/**
 * 家属申诉状态机：
 *  SUBMITTED（已提交，材料齐全）/ PENDING_CORRECTION（待补正）
 *    --补正--> PENDING_ADJUDICATION（待裁决）
 *  SUBMITTED / PENDING_ADJUDICATION --裁决--> UPHELD（维持）/ CHANGED（变更）
 *  任意进行中状态 --撤回--> WITHDRAWN
 *  PENDING_CORRECTION 超过补正期限仍未补齐 --> EXPIRED（过期，惰性判定）
 * UPHELD / CHANGED / WITHDRAWN / EXPIRED 为终态，不再接受任何写操作。
 */
export enum AppealStatus {
  SUBMITTED = 'SUBMITTED',
  PENDING_CORRECTION = 'PENDING_CORRECTION',
  PENDING_ADJUDICATION = 'PENDING_ADJUDICATION',
  UPHELD = 'UPHELD',
  CHANGED = 'CHANGED',
  WITHDRAWN = 'WITHDRAWN',
  EXPIRED = 'EXPIRED',
}

/** 申诉裁决结论（裁决不改写原复核意见，仅追加申诉决定与新等级版本） */
export enum AppealDecisionValue {
  UPHELD = 'UPHELD',
  CHANGED = 'CHANGED',
}

/** 申诉留痕事件类型（完整审计链） */
export enum AppealEventAction {
  FILED = 'FILED',
  SUPPLEMENTED = 'SUPPLEMENTED',
  ADJUDICATED = 'ADJUDICATED',
  WITHDRAWN = 'WITHDRAWN',
  EXPIRED = 'EXPIRED',
}

/** 量表不适用项（NA）如何影响分母：由量表版本自行定义 */
export enum NaPolicy {
  /** NA 项从分母中剔除 */
  EXCLUDE_FROM_DENOMINATOR = 'EXCLUDE_FROM_DENOMINATOR',
  /** NA 按 0 分计入分母（本演示量表不使用，仅展示枚举完整性） */
  COUNT_AS_ZERO = 'COUNT_AS_ZERO',
}
