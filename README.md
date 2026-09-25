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
10. **家属申诉形成闭环**：只能对已送达且在规定期限内的确认告知提出申诉；提交时冻结当前确认等级版本、量表答案与送达快照。相同告知只允许一个进行中的申诉。
11. **申诉状态机与证据留痕**：`SUBMITTED / PENDING_CORRECTION / PENDING_RULING / UPHELD / CHANGED / WITHDRAWN / EXPIRED` 全部迁移写追加式事件表；原始复核意见永不被改写。
12. **裁决变更只追加等级版本**：维持不产生新版本；变更追加 `grade_versions`，按裁决明确的 `effectiveDate` 原子切割等级期间，并持久化/查询变更前后费用差异。
13. **并发与乱序安全**：申诉、补正、撤回、裁决均支持幂等键或相同请求回放；撤回后的迟到裁决不生效；并发裁决通过申诉行锁、状态条件和等级期间排他约束保证只有一个有效结果。

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
| POST | `/assessments/:caseId/appeals` | 基于已送达且未超期的告知提交申诉（冻结等级/答案/送达快照，支持幂等键） |
| GET | `/assessments/:caseId/appeals` | 查询案件申诉历史、材料与事件链 |
| GET | `/assessments/:caseId/appeals/:appealId` | 查询单条申诉完整证据 |
| POST | `/assessments/:caseId/appeals/:appealId/corrections` | 要求补正：`SUBMITTED -> PENDING_CORRECTION` |
| POST | `/assessments/:caseId/appeals/:appealId/supplements` | 提交补正材料：`PENDING_CORRECTION -> PENDING_RULING`；逾期转 `EXPIRED` |
| POST | `/assessments/:caseId/appeals/:appealId/withdraw` | 家属撤回进行中申诉 |
| POST | `/assessments/:caseId/appeals/:appealId/expire` | 管理端标记超期申诉 |
| POST | `/assessments/:caseId/appeals/:appealId/ruling` | 裁决维持/变更；变更需 `effectiveDate`，返回费用影响 |
| GET | `/assessments/:caseId/appeals/:appealId/fee-impact` | 查询变更等级的前后费用与差额 |

完整契约见 [`openapi.yaml`](./openapi.yaml)。

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
- 期限内申诉经补正后维持：原复核意见不变、等级/答案/送达快照与全部事件可复核；
- 补正后变更等级：追加等级版本、按明确生效日切期间、生成变更前后费用差异；
- 送达失败或超过期限拒绝受理且不创建申诉、不污染评估；
- 撤回后迟到补正/裁决不生效，重复撤回和裁决请求幂等；
- 两个管理员并发裁决仅一个成功，数据库中不产生同日两条有效等级；
- 应用重启后申诉证据、裁决决定、等级期间、迁移记录和既有告知链仍可查询。
