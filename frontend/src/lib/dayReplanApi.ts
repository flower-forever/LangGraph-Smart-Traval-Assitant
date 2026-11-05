/**
 * 单日 AI 重规划的网络客户端：POST /api/trips/days/replan。
 *
 * 复用 api.ts 的 postJson / ApiOptions（取消、超时时钟、baseUrl、错误分类），
 * 不另起一套 fetch 与错误处理。响应先按 unknown 接回，再交给
 * validateDayReplanResponse 做完整业务校验；结构不符时统一抛
 * ApiError('bad_payload')，不把坏数据漏给界面。
 *
 * F2 可选 constraints：只有显式给出 `planningConstraints` 时才在既有请求体上加
 * 一个严格构造的 `constraints` 字段；省略时请求体、校验与调用行为与旧版逐字一致。
 * 构建失败在 fetch 之前抛 PlanningConstraintsError（typed），绝不静默发旧请求。
 */
import { ApiError, postJson, type ApiOptions } from './api'
import { validateDayReplanResponse, type DayReplanRequest, type DayReplanResponse } from './dayReplan'
import {
  buildPlanningConstraintsWire,
  PlanningConstraintsError,
  type DayReplanConstraintsOptions,
} from './planningConstraintsApi'

/** 与后端 api_server 中的注册路径一致，走 Vite /api 代理。 */
export const DAY_REPLAN_PATH = '/api/trips/days/replan'

/**
 * 单日重规划的可选参数。`planningConstraints` 省略时与旧版完全兼容；
 * 给出时必须同时提供当前 record / binding / epoch / scope。
 */
export interface DayReplanApiOptions extends ApiOptions {
  planningConstraints?: DayReplanConstraintsOptions
}

/**
 * 发起单日 AI 重规划。成功返回已校验的 DTO；
 * 网络失败、HTTP 错误、取消与超时沿用 postJson 的 ApiError 分类；
 * 响应结构或业务约束不过关时抛 ApiError('bad_payload')。
 */
export async function replanDay(
  request: DayReplanRequest,
  options?: DayReplanApiOptions,
): Promise<DayReplanResponse> {
  let body: unknown = request
  let apiOptions: ApiOptions | undefined = options
  if (options?.planningConstraints !== undefined) {
    const planning = options.planningConstraints
    if (!planning || typeof planning !== 'object') {
      throw new PlanningConstraintsError({
        ok: false,
        reason: 'invalid_input',
        message: 'planningConstraints 必须是包含 constraints / scope / record / binding / epoch 的对象。',
      })
    }
    const built = buildPlanningConstraintsWire({
      constraints: planning.constraints,
      scope: planning.scope,
      record: planning.record,
      binding: planning.binding,
      epoch: planning.epoch,
      // request 只用于核对 day / parent / stops；instruction 原文不读、不改。
      request,
    })
    if (!built.ok) throw new PlanningConstraintsError(built)
    if (Object.prototype.hasOwnProperty.call(request, 'constraints')) {
      throw new PlanningConstraintsError({
        ok: false,
        reason: 'reserved_field',
        message: '单日请求已自带 constraints 字段；拒绝覆盖或重复发送。',
      })
    }
    const { planningConstraints: _planningConstraints, ...rest } = options
    body = { ...request, constraints: built.constraints }
    apiOptions = rest
  }
  const data = await postJson<unknown>(DAY_REPLAN_PATH, body, apiOptions)
  const validated = validateDayReplanResponse(data, request)
  if (!validated.ok) {
    throw new ApiError('bad_payload', 'AI 单日调整返回结构不符合契约')
  }
  return validated.response
}
