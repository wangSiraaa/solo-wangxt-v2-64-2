# 养老机构评估 → 管理复核 → 家属告知 → 费用生效（服务端流程演示）

NestJS + PostgreSQL + TypeORM + decimal.js 的服务端流程。**无前端**。

> ⚠️ 本项目使用**虚构量表 DEMO_ADL**，仅用于行政流程（评估、复核、告知、计费）演示，
> **不构成医疗诊断、护理分级依据或真实护理建议**。该声明同时固化在量表版本与每条家属告知文本中。

## 流程规则（对应业务要求）

1. **必填项缺失不得自动定级**：任一评估员必填条目缺失/无效/误用 NA，案件为 `INCOMPLETE`，无确认等级，不能复核、不能费用生效。
2. **不适用项（NA）如何影响分母由量表定义**：`scale_versions.na_policy` 决定。演示量表为 `EXCLUDE_FROM_DENOMINATOR`，且仅 `STAIRS`、`OUTDOOR` 两题允许 NA；对不允许 NA 的题选 NA 视为无效作答。
3. **两位评估员结果冲突进入复核，不能简单取较高等级**：等级不一致 → `PENDING_REVIEW`；管理员必须在**两位评估员候选等级之内**显式选择并填写意见。取候选外等级（如“折中”）返回 400。
4. **等级确认后生成告知记录**：一致由系统确认（reviewer=`SYSTEM`），冲突由管理员确认；确认即生成一条 `PENDING / CONFIRMED` 告知。
5. **送达失败与尚未确认分别记录**：
   - 送达结果 `status`：`PENDING / DELIVERED / FAILED`（失败原因独立留痕，每次尝试一行）；
   - 可告知状态 `notifiableStatus`：`CONFIRMED / UNCONFIRMED`。尚未确认时也可尝试告知，落 `UNCONFIRMED + FAILED（等级尚未确认）`。
6. **费用生效按机构示例规则独立判断**：等级是否已确认才是生效前提，与家属告知是否送达无关。
7. **同一天不能出现重叠生效等级**：服务层显式校验 + PostgreSQL `btree_gist` 的 daterange 排他约束双保险。月中换级时旧期间自动截至生效日前一日（半开区间首尾相接）。
8. **费用按天分段**：等级期间 × 日费版本切换日二次切分，闭区间逐天连续（含无生效等级空洞段），天数守恒校验；金额一律 decimal.js 计算，两位小数 `ROUND_HALF_UP`。
9. **接口可解释**：评估响应内嵌两位评估员逐项明细（原始选项、分值、是否计入分母、NA 说明、原始分/有效分母/百分比/定级阈值）；费用分段逐段给出等级、日费版本、天数、金额与来源。
10. **申诉闭环（家属异议 → 补正 → 裁决）**：
    - 受理前提：告知记录**已送达**且申诉日在受理期限内（送达日 + `APPEAL_WINDOW_DAYS`，默认 30 天）；送达失败/未送达/超期一律 409 拒绝受理，且**不产生任何数据、不污染评估**；
    - 受理即固化快照：**当时的确认等级、两位评估员量表答案、送达记录、复核意见**，后续任何变更不得改写；
    - 状态机：`SUBMITTED`（材料齐全）/ `PENDING_CORRECTION`（待补正）→ 补正 → `PENDING_ADJUDICATION`（待裁决）→ 裁决 → `UPHELD`（维持）/ `CHANGED`（变更）；进行中可 `WITHDRAWN`（撤回）；待补正超期未补齐 → `EXPIRED`（过期，惰性判定）；
    - **同一告知只能有一个进行中的申诉**：部分唯一索引 `appeals_one_open_per_notification` 原子保证；
    - 补正/撤回/裁决均支持幂等键：同键回放、异键冲突 409、终态后乱序请求 409；撤回后迟到的裁决不得生效；
    - **裁决不改写原复核意见**（`review_decisions` 保持原样），决定独立存 `appeal_decisions`（一申诉一裁决，唯一约束）；
    - 变更裁决**追加新等级版本**（`grade_periods` 新行、旧期间截断、`source_appeal_id` 可追溯），并在**同一事务内按明确生效日**计算前后费用差异快照（开放旧期间取 30 天演示比较窗口，可用 `APPEAL_IMPACT_HORIZON_DAYS` 调整）；
    - 并发裁决：申诉行 `FOR UPDATE` 串行化 + 一申诉一裁决唯一约束 + 等级期间 gist 排他约束，**仅一个成功，绝不产生两条有效等级**；
    - 裁决结果自动生成新的家属告知记录（告知链追加，既有告知不改动）。

## 演示数据

- 量表 `DEMO_ADL v1.0.0`：10 题（8 必填 + STAIRS/OUTDOOR 可 NA），0~3 分制；
  百分比阈值 `<40% LIGHT / [40%,70%) MODERATE / >=70% SEVERE`。
- 示例日费（元/天）：LIGHT 100；MODERATE 180（2024-01-01 起 200）；SEVERE 260（2024-01-01 起 300）。

## 运行

无需系统 PostgreSQL / root：默认在项目内启动**用户态嵌入式 PostgreSQL 18**（`embedded-postgres`）。
如有外部 PG，在 `.env` 设置 `DB_HOST` 即切换为外部连接（见 `.env.example`）。

```bash
npm install
npm run seed          # 可选：仅建表+种子
npm run start         # http://127.0.0.1:3000/api
npm test              # e2e（自带嵌入式 PG，覆盖下列全部场景）
```

## API（均在 /api 前缀下）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/scales/:id` | 量表版本、原始条目/选项、NA 分母策略、定级阈值 |
| POST | `/assessments` | 提交两位评估员作答 → INCOMPLETE / CONFIRMED / PENDING_REVIEW |
| GET | `/assessments/:id` | 案件 + 逐项评分来源 + 复核意见 + 告知记录 |
| POST | `/assessments/:id/review/confirm` | 管理复核（等级限候选内，支持 `idempotencyKey`） |
| POST | `/assessments/:id/notification/attempt` | 家属告知尝试（`{"simulateFail":true}` 模拟通道失败） |
| GET | `/assessments/:id/notification` | 全部告知记录（失败历史、未确认尝试均保留） |
| POST | `/fees/activate` | 等级生效 `{caseId, effectiveDate}` |
| GET | `/fees/segments?elderId=&from=&to=` | 按天分段费用与 decimal 合计 |
| POST | `/appeals` | 申诉受理（绑定等级/答案/送达快照；未送达或超期 409；支持幂等键） |
| POST | `/appeals/:id/supplement` | 补正材料 → 待裁决（同键回放，终态/过期拒绝） |
| POST | `/appeals/:id/withdraw` | 撤回申诉（重复撤回幂等回放） |
| POST | `/appeals/:id/adjudicate` | 裁决维持/变更（变更追加新等级版本并按生效日算费用差异；并发仅一个成功） |
| GET | `/appeals/:id` | 申诉详情：快照、材料、决定与完整留痕事件 |
| GET | `/assessments/:caseId/appeals` | 案件维度的申诉历史 |
| GET | `/openapi.json` | OpenAPI 3.0 文档（覆盖全部接口） |

### 示例：申诉 → 补正 → 变更裁决

```bash
# 1) 对已送达的告知提出异议（材料不足 → 待补正）
curl -sXPOST localhost:3000/api/appeals -H 'Content-Type: application/json' -d '{
  "notificationId":"<notification-uuid>","reason":"家属认为等级偏低","filedBy":"family-li"}'
# 2) 补正材料 → 待裁决
curl -sXPOST localhost:3000/api/appeals/<appeal-uuid>/supplement -H 'Content-Type: application/json' \
  -d '{"materials":["医院诊断证明.pdf"],"idempotencyKey":"sup-1"}'
# 3) 变更裁决：追加新等级版本，响应内含前后费用差异（feeImpact）
curl -sXPOST localhost:3000/api/appeals/<appeal-uuid>/adjudicate -H 'Content-Type: application/json' -d '{
  "decision":"CHANGED","newGrade":"SEVERE","effectiveDate":"2024-02-15",
  "comment":"补充材料充分，复评认定为重度","adjudicatorId":"admin-li","idempotencyKey":"adj-1"}'
```

### 示例：月中升级 + 闰月

```bash
# 1) 轻度确认并 2024-01-01 生效（两位评估员全选独立完成）
curl -sXPOST localhost:3000/api/assessments -H 'Content-Type: application/json' -d '{
  "elderId":"E1","elderName":"张某","familyContact":"13900000000",
  "assessors":[{"assessorId":1,"answers":[{"itemCode":"TRANSFER","optionCode":"INDEPENDENT"}]},
               {"assessorId":2,"answers":[{"itemCode":"TRANSFER","optionCode":"INDEPENDENT"}]}]}'
# 全部 10 题均提交；冲突案件再 POST /review/confirm；然后：
curl -sXPOST localhost:3000/api/fees/activate -H 'Content-Type: application/json' \
  -d '{"caseId":"<case-uuid>","effectiveDate":"2024-02-15"}'
curl -s 'localhost:3000/api/fees/segments?elderId=E1&from=2024-02-01&to=2024-02-29'
# 2024 为闰年：2/1~2/14 与 2/15~2/29 两段，共 29 天
```

## e2e 覆盖场景

- 必填缺失 / 无效 NA → INCOMPLETE，不定级、不可复核生效；
- NA 从分母剔除（8 题 TOTAL_DEP + 2 NA → 分母 8 而非 10）及逐项解释；
- LIGHT vs SEVERE 冲突 → 复核候选外等级 400、显式选较低 LIGHT 成功（证明不取高）；
- 重复确认请求：相同幂等键回放、无键重复 409；
- 尚未确认尝试告知 → `UNCONFIRMED/FAILED`；送达失败原因分行留痕；
- 月中升级切旧区间、同案重复生效回放、同日不同等级重叠 409；
- 闰月 2024-02（29 天）分段金额、跨 2024-01-01 调价日同等级二次分段、无等级空洞段、非法闰日期拒绝；
- **申诉闭环**：
  - 期限内申诉 → 补正 → 裁决维持：原等级不变、原复核意见不改写、FILED/SUPPLEMENTED/ADJUDICATED 全程留痕；
  - 待补正 → 补正（同键幂等回放、材料不重复）→ 变更裁决：追加新等级版本（旧期间截断、`source_appeal_id` 可追溯），按生效日给出前后费用差异（30 天窗口 3000.00 → 9000.00，差 6000.00）；
  - 送达失败 / 未送达 / 超期 / 申诉日倒挂：拒绝受理且不产生数据、不污染评估与告知链；
  - 撤回（重复撤回幂等）后迟到裁决 409 不生效、无等级期间；撤回后同一告知可再次申诉；
  - 同一告知已有进行中申诉 → 409（唯一索引兜底）；
  - 两管理员并发裁决同一申诉：恰一个 201 一个 409，仅一条裁决、一条等级期间；
  - 待补正超期 → 惰性 EXPIRED，补正/裁决/撤回均 409；
  - 服务重启后：申诉快照（等级/答案/送达）、裁决决定、等级期间与既有告知链完整可复核。
