# POI 公开资料候选前端 UI

日期：2026-11-01。对应分支 `feat/interactive-travel-planner`，基线 `74db1e8`（POI 后端已合入）。
本文档说明「本日公开资料」前端面板的交互边界与状态语义；后端合同见 `docs/POI_SOURCES.md`。

## 这是什么

`frontend/src/components/DayPoiSourcesPanel.tsx` 是一个与天气面板同级的独立查询面板：
按本日行程记录坐标调用 `GET /api/poi-sources/nearby?lat&lon`，展示 100 米内
OpenStreetMap 对象的公开标签候选（opening_hours / fee / charge）。候选最多 8 条，
每条带名称、距离、规范 OSM 对象链接与标签原文。

明确的边界（与后端一致）：

- 候选是**公开资料候选**，`identity_status` 恒为 unconfirmed（身份未确认）。
  距离近、名称相似都不是身份确认；选择候选不标 verified，也不把任何资料写进 Trip。
- 标签字段只透传来源原文（state=source_only）或显示「来源未提供」（state=unknown）。
  前端不解析原文：`fee=yes` 不翻译成「已证实免费」，`opening_hours` 不推断实时营业，
  `charge` 不猜币种。
- **获取时间**（信封 checked_at / fetched_at，候选 retrieved_at）与**对象编辑时间**
  （source_updated_at，缺失显示「未知（来源未提供）」）分开显示，不合并成单一「更新时间」。
- 服务端缓存命中（cached=true）时明示「结果来自近期缓存，时间为缓存里保存的原时间」，
  不把缓存命中时间伪装成新抓取。
- 数据 © OpenStreetMap 贡献者，署名链接（copyright）常驻面板底部；许可 ODbL 1.0。

## 交互与状态

- 面板默认收起。**打开 / 挂载 / 切天 / 换站点 / 改行程 revision 都不发请求**；
  只有点「查询附近资料」才发一次 GET，不自动重试。
- 坐标只取本日站点记录里的 WGS84 坐标（0 与负值合法）；本日没有坐标就禁用查询并说明，
  不改用其它天、浏览器定位或按城市猜。`activeStopId` 只作站点下拉的初始线索，
  面板不反向修改地图选中。
- 查询挂起时可「停止等待」：abort + 序号递增，迟到的响应一律丢弃
  （即使 adapter 忽略 abort 也不会串上下文）。停止只结束本页等待，不保证后端停止处理。
  same-query 刷新挂起中手动停止时，屏幕上若还有上次成功候选会显式标注
  「本次没有拿到新结果，下面显示的是上次查询的结果」；第一次查询就停止则没有旧候选可标。
  用户在面板里点「收起」是显式收起：App 在入口重新挂载后把键盘焦点送回
  「查资料」按钮。编辑/AI/地图面板打开导致的隐式收起不置位、不移动焦点。
- same-query（同行程/同 revision/同天/同站点/同坐标）刷新失败时保留上次成功候选，
  并明确显示「本次没有拿到新结果，下面是上次查询的结果」；不同 query 立即清理旧候选。
  合法 no_candidates 覆盖旧结果并说明「不代表该地点不存在」。
- 后端业务失败态（timeout / rate_limited / unavailable / failed / invalid_request）
  与传输错误都映射为前端固定文案，不回显 reason / detail 原文或任意 URL。
- 查询失败绝不修改现有 Trip / 草稿；结果只存在组件内存，不写 localStorage。
- 本地编辑、AI 面板、地图刷新面板打开时，本面板收起卸载；关闭后不自动重开、不自动查询。

## 客户端校验

`frontend/src/lib/poiSources.ts` 独立做运行时验证，`poiSourcesApi.ts` 沿 weatherApi
的 VITE_API_BASE / ApiError / ApiOptions / 覆盖 headers+body 的超时取消模式
（默认等待 12 秒），不改公共 api.ts。校验要点：

- 七种 status；available 必须带候选，非 available 不得带候选；候选 ≤ 8。
- requested 与本次请求坐标按 1e-6 容差比较（后端 round 到 6 位小数的最大舍入
  误差是 5e-7，1e-6 覆盖舍入又不会把附近另一坐标判成本次请求）；requested 本身
  也要是合法 WGS84 坐标：纬 90/经 180 的舍入边界上，90.0000005/180.0000005
  这类越界值拒绝，±90/±180/0 等合法值不误拒。
- element_id 为正整数且 ≤ 2^53-1；source_url 必须与校验后的 type/id 构造的
  `https://www.openstreetmap.org/{type}/{id}` 逐字一致；外链一律 noopener noreferrer。
- `source` 元数据（provider/endpoint/docs_url/attribution_url/license/data_source）
  与后端固定常量（PROVIDER_*）逐字相等才算通过——署名与文档链接挂在
  「OpenStreetMap」名下，仅「是 https」不能证明一个任意站点是可查证的 OSM 来源。
- radius_m 必须等于后端固定查询半径 100；available 候选的 distance_m ≤ 100，
  且每个候选坐标经独立 haversine 复核确实落在请求点固定半径内。复核基准是
  后端舍入后的 requested，与后端同一坐标算球面距离；容差只覆盖浮点数值误差
  （1e-6 米，与 distance_m 边界同口径），不扩大接收半径。distance 声称很小、
  实际坐标在 100m 外的候选不展示。
- available 响应必须有真实 fetched_at（不为 null）且 provider_http_status 为 2xx；
  失败态（timeout 等本地判定）provider_http_status 可为 null。不用 checked_at
  伪装获取时间。
- source_elements_seen 可以大于 30（后端只处理前 30 但如实记录 seen），不错拒。
- 时间形状除正则外还做真实日历校验：`2026-02-30`、`2026-13-01`、`25:00` 这类
  会被 Date.parse 静默滚动的值一律拒绝；后端合法的微秒 ISO、`+00:00`、`Z`
  均接受。checked_at / fetched_at / retrieved_at / source_updated_at 同一口径。
- 标签字段只认 source_only（非空白、≤300 字符的原文，允许首尾空格并原样展示、
  不 trim 冒充原文）/ unknown（value 为 null）。与后端 `_tag_field` 同口径。

## 文件

- `frontend/src/lib/poiSources.ts` — 类型 + 运行时验证 + 展示工具
- `frontend/src/lib/poiSourcesApi.ts` — 请求适配（getJson 复用）
- `frontend/src/components/DayPoiSourcesPanel.tsx` / `dayPoiSourcesPanel.css` — 面板
- `frontend/src/App.tsx` — 仅接线：入口（默认收起）与面板互斥显示
- `frontend/src/__tests__/poiSources.test.ts` / `poiSourcesApi.test.ts` /
  `DayPoiSourcesPanel.test.tsx` / `AppPoiSourcesIntegration.test.tsx` /
  `fixtures/poiSources.ts` — 离线测试（mock fetch / adapter，明确示例数据）

## 已知局限

- 未做真实 POI 样本评估，也未做真实浏览器视觉验收；响应式（320/375/768/1440）
  按 CSS 断点代码检查，未经实机截图验证。
- 结果不声称完整或全局最近；way/relation 用 center 近似距离，可能与用户感知有偏差。
- 结果只反映查询时刻的 OSM 标签，不承诺实时准确。

## 验收修订记录（2026-11-01）

独立验收对首轮实现做了以下修复（详见 F:/MunderDifflin/Travel-Assistant/poi-sources-ui-acceptance.md）：

- 显式收起后键盘焦点回到「查资料」入口；隐式收起不移动焦点。
- source 元数据改为与后端固定常量逐字比对，任意 https 站点不再能冒充 OSM 来源。
- 时间戳增加真实日历校验，拒绝 2026-02-30 这类滚动值；标签原文按 ≤300/非空白收紧。
- radius_m 固定 100、候选距离与坐标做半径复核；available 必须有真实 fetched_at 与 2xx。
- 手动停止等待时旧候选显式标注「上次结果」。

## 发布前收尾（2026-11-01）

Lead 批准的三处窄收尾：

- requested 补实际 WGS84 范围校验（isLatitude/isLongitude）：1e-6 舍入匹配不再
  放行 90.0000005/180.0000005 这类越界值；±90/±180/0 与 6 位舍入正常口径不变。
- haversine 复核接收半径从 FIXED_RADIUS_M+1 米收紧到 +1e-6 米数值误差：后端与
  前端同样基于已回传的 center 坐标算球面距离，center 近似不是扩大接收半径的
  理由；复核基准仍是 requested，不改为原始高精度 query。
- App.tsx 中被误并成一行 interactionPaused 声明恢复原两行与注释归属。
