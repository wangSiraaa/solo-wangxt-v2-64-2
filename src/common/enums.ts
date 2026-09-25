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

/** 量表不适用项（NA）如何影响分母：由量表版本自行定义 */
export enum NaPolicy {
  /** NA 项从分母中剔除 */
  EXCLUDE_FROM_DENOMINATOR = 'EXCLUDE_FROM_DENOMINATOR',
  /** NA 按 0 分计入分母（本演示量表不使用，仅展示枚举完整性） */
  COUNT_AS_ZERO = 'COUNT_AS_ZERO',
}

/** 等级版本来源：首次复核/一致确认，或申诉裁决变更 */
export enum GradeVersionSource {
  REVIEW = 'REVIEW',
  APPEAL = 'APPEAL',
}

/** 申诉状态机 */
export enum AppealStatus {
  /** 家属已提交，等待裁决机构受理/裁决 */
  SUBMITTED = 'SUBMITTED',
  /** 申诉材料需补正；补正期限内未补正则过期 */
  PENDING_CORRECTION = 'PENDING_CORRECTION',
  /** 材料已补正，等待裁决 */
  PENDING_RULING = 'PENDING_RULING',
  /** 裁决维持原等级 */
  UPHELD = 'UPHELD',
  /** 裁决变更等级 */
  CHANGED = 'CHANGED',
  /** 家属撤回 */
  WITHDRAWN = 'WITHDRAWN',
  /** 超过补正期限等，申诉失效 */
  EXPIRED = 'EXPIRED',
}

export enum AppealRulingOutcome {
  UPHELD = 'UPHELD',
  CHANGED = 'CHANGED',
}

export enum AppealEventType {
  SUBMITTED = 'SUBMITTED',
  CORRECTION_REQUESTED = 'CORRECTION_REQUESTED',
  SUPPLEMENTED = 'SUPPLEMENTED',
  RULED_UPHELD = 'RULED_UPHELD',
  RULED_CHANGED = 'RULED_CHANGED',
  WITHDRAWN = 'WITHDRAWN',
  EXPIRED = 'EXPIRED',
}
