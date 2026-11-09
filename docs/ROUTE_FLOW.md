# 顺路度提示（四期 S5）

只读的局部路线优化提示：当日站点顺序中，若交换相邻两站能明显缩短总路程，则在行程区顶部提示一次。只提示，不自动修改行程，也不提供应用入口。

## 输入与坐标口径

- 输入为当日 `TripDay.stops`，组件只读取每站的 `name` 与 `location.lat` / `location.lng`（WGS84）。
- 有效坐标必须同时满足：`lat` / `lng` 为有限数，`lat ∈ [-90, 90]`，`lng ∈ [-180, 180]`。
- 坐标缺失、`NaN` / `Infinity` 或越界时，总路程不可知，分析结果为 `none / missing_coordinates`。**不会把缺失坐标当成 (0,0) 或任何默认值填充**，也不会因此给出提示。
- 站点少于 3 个时返回 `none / too_few_stops`；所有站点同坐标导致原顺序总路程为 0 时返回 `none / zero_distance`。

## 距离

`haversineKm` 使用标准 haversine 球面距离，WGS84 平均地球半径 **6371.0088 km**。无效坐标返回 `NaN`。

## 算法

1. 按当日 `stops` 原顺序，累加所有相邻站点的 haversine 距离，得到交换前总路程 `before`。
2. 枚举全部 **n−1** 种相邻交换：交换第 1/2 站、第 2/3 站……第 n−1/n 站。其余站点顺序保持不变。
3. 对每种交换计算交换后的总路程，取最短者 `after`。若多个交换并列最短，取 **1-based 序号最小** 的那个，保证同输入同输出。
4. 缩短比例 `improvementRatio = (before − after) / before`，节省距离 `savedKm = before − after`。
5. 仅当 `improvementRatio >= SWAP_IMPROVEMENT_THRESHOLD`（**0.10，即 10%**，边界包含等号）时返回 `suggestion`；否则返回 `none / no_improvement`。比较时使用内部常量 `IMPROVEMENT_EPSILON = 1e-9` 的浮点容差（即 `>= 0.10 - 1e-9`）：只吸收 haversine 分段累加误差，不放宽 10% 业务阈值，9.9% 仍保持沉默。

10% 是「相邻两站交换值得提示」的经验阈值，不是全局最优判定。算法只比较这 n−1 种交换，不尝试任意重排、不求解旅行商问题，也不结合营业时间、预约、交通方式或真实路网。

## 序号与文案

- `suggestion.index` 是被交换两站中 **第一站在当日 stops 中的 1-based 序号**；第二站为 `index + 1`。
- 组件文案固定为：
  - 主文案：「本日路线可优化：第 {index} 站与第 {index + 1} 站互换，路程约缩短 {X}%（约 {Y} 公里）。」
  - 辅助说明：「只提示相邻两站的交换，不是全局最优路线；不会自动修改行程，是否调整请用编辑或 AI 助手。」
- 舍入：百分比 `X` 保留 1 位小数（`improvementRatio × 100`），节省公里 `Y` 保留 1 位小数。内部比例与距离不预先舍入，避免边界误判。
- 距离单位统一为公里；数据源与展示坐标均为 WGS84。

## 只读与确定性

- 组件没有按钮、没有应用入口，不调用任何存储 API，不写 `localStorage` / `sessionStorage`，不修改 `TripDay` / `Trip`。
- 分析为纯函数：不修改入参，不使用 `Math.random`、`Date.now`、网络或计时；同输入两次调用结果全等。
- 站点不足、坐标缺失、无改善或全程零距离时，组件整卡不渲染（诚实沉默），不显示「未知」占位卡。

## 代码与测试

- 纯函数：`frontend/src/lib/routeFlow.ts`（`SWAP_IMPROVEMENT_THRESHOLD` / `haversineKm` / `analyzeDayRoute`）。
- 提示组件：`frontend/src/components/RouteFlowHint.tsx`。
- 接线：`frontend/src/App.tsx` 行程区 `ITINERARY_PANE` 内、`ItineraryView` 之前；列表与时间轴两种视图共用同一提示。
- 测试：`frontend/src/__tests__/routeFlow.test.ts`（已知距离、绕路、9.9% / 10% / 10.1% 边界、坐标缺失、零距离、确定性）与 `frontend/src/__tests__/RouteFlowHint.test.tsx`（文案、无建议不渲染、零存储写入、窄屏样式）。
