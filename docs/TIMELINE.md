# 行程时间轴视图（四期 S3）

## 入口与结构

行程区由 `ItineraryView` 承载，顶部是「列表 / 时间轴」分段控件（`role="group"`、`aria-label="行程视图"`、`data-testid="itinerary-view-toggle"`，每个按钮带 `aria-pressed`）。默认显示列表；切换只改组件内状态，不持久化。

- 列表视图：既有 `ItineraryList`（复制本日行程、站点展开、资料卡摘要等行为不变）。
- 时间轴视图：`TimelineView`，卡片容器与天头口径同列表（第 N 天 · 标题、日期、站点数、`day.summary`），主体为有序列表 `<ol>`：左侧时间列 + 竖线/圆点，右侧序号、站名、描述摘要与「无坐标」徽标。
- 站点节点是按钮：点击展开详情，再次点击收起；`aria-current` / `aria-expanded` 与列表视图一致，展开区显示讲解、地址、时长、坐标与 OpenStreetMap 检索链接（仅有坐标时）、资料卡摘要。
- 每个停点（最后一站除外）之后显示站间交通段：`MODE_LABELS` + `ROUTE_LABELS` + `formatDistance` + `formatDuration`；`navigation` 且 geometry 不足时保留列表视图同款「地图服务未返回折线…」说明。

## 只读零写入

`TimelineView` 与 `ItineraryView` 都不调用 `localStorage` / `sessionStorage`，不修改 `Trip` 数据结构，也不创建任何存储键。视图切换与节点展开/收起只是渲染状态；`activeStopId` 始终由父级 `App` 持有，切换视图不会改变当前选中站点。测试对挂载与来回切换前后的 localStorage 全键 raw 做逐字节比较。

## 缺失字段口径

- 时刻为空或缺失：显示「时间未知」，不补默认时刻。
- 讲解缺失：「后端暂未提供这一站点的讲解。」
- 地址缺失：「地址未知」；时长缺失：「时长未知」。
- 交通段缺失或 `to_stop_id` 找不到对应站点：「未提供本段路线信息。」
- 距离 / 时长缺失：沿用既有 `formatDistance` / `formatDuration` 的「距离未知 / 时长未知」，不编造数值。
- 无坐标站点：节点显示「无坐标」徽标，展开区不出现坐标与 OSM 链接。

## 资料卡匹配提示

列表与时间轴共用 `StopPoiCard`，按 `findPoiCardByName(poiCards, stop.name)` 做名称归一化匹配：只有唯一命中才显示「景点资料卡 · 未核实」及介绍 / 开放时间 / 门票（空字段显示「未知」），并固定提示「按名称匹配，请自行核对」；0 命中或多命中都不显示。资料卡只读展示，编辑仍走既有 `PoiCardPanel` 的显式保存流程。

## 深浅主题与窄屏

全部使用 shadcn/ui + Tailwind 与 `theme.css` 语义变量（`bg-card`、`border-border`、`text-foreground`、`text-muted-foreground`、`bg-accent-surface` 等），不引入新的颜色字面量；深色模式沿用 `.dark` 变量覆盖。时间轴网格在窄屏收窄时间列（64px → 46px）并使用 `min-w-0` / `overflow-wrap:anywhere`，375px 下不产生横向溢出。

## 测试

- `frontend/src/__tests__/TimelineView.test.tsx`：停点顺序、时间缺失、交通段缺失与距离/时长缺失、折线不足说明、展开/收起与回调参数、activeStopId 高亮与 aria、资料卡唯一命中/无命中/多命中。
- `frontend/src/__tests__/ItineraryView.test.tsx`：默认列表、分段控件 `aria-pressed`、来回切换、切换前后 localStorage raw 全等、选中站点跨视图保留、时间轴节点仍回传父级回调。
- `frontend/src/__tests__/ItineraryList.test.tsx`：抽取 `StopPoiCard` 后既有复制与资料卡断言保持全绿。
