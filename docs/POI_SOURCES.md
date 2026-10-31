# POI 公开资料候选后端

日期：2026-10-31。对应分支 `feat/interactive-travel-planner`，基线 `dc2a978`。

## 这是什么

`GET /api/poi-sources/nearby?lat=<WGS84>&lon=<WGS84>`：给定一个 WGS84 坐标，
返回附近 100 米内带 `opening_hours`/`fee`/`charge` 任一标签的 OpenStreetMap
对象，作为「公开资料候选」。数据来自固定的 Overpass 端点
`https://overpass-api.de/api/interpreter`，不需要用户密钥。

明确的边界：候选的 `identity_status` 永远是 `unconfirmed`。距离近、名称相似
都不构成身份确认；本接口不修改 Trip/草稿/模型规划内容，也不把候选标成
「原站点已核实」。`source_only` 不等于官方核验——它是协作地图上其他贡献者
写的标签原文。

## 查询语义

发给 Overpass 的查询是固定的数值化 QL（无任何用户可控片段）：

```
[out:json][timeout:6];
(
  nwr["opening_hours"](around:100.0,<lat>,<lon>);
  nwr["fee"](around:100.0,<lat>,<lon>);
  nwr["charge"](around:100.0,<lat>,<lon>);
);
out meta center 30;
```

- `nwr`：node/way/relation 三种元素类型一起查（Overpass QL 官方语法，
  依据 wiki.openstreetmap.org 的 Overpass_API/Overpass_QL 页面）。
- 括号 union 合并三条分支；Overpass 自身会合并去重，客户端再做一次
  `(type, id)` 去重作为防御。
- `out meta center 30`：meta 带对象编辑时间戳（`timestamp`），center 给
  way/relation 的中心坐标，末尾数字限制最多 30 个源元素。

本地处理：真实 haversine 距离（米）→ 按距离排序 → 最多保留 8 个候选。

## 响应信封（PoiSourceReport）

HTTP 200（`invalid_request` 为 422），`x-poi-sources-status` 头带状态。

| status | 含义 |
| --- | --- |
| available | 至少 1 个真实候选 |
| no_candidates | 本期未找到可用公开字段候选；不代表地点不存在 |
| invalid_request | lat/lon 缺失/布尔/非有限/越界（HTTP 422，0 provider 请求） |
| timeout | 总 deadline（默认 8 秒）内未完成 |
| rate_limited | 上游 429 |
| unavailable | 上游 5xx / 网络错误 |
| failed | 上游 4xx / 坏 JSON（含极深嵌套触发 RecursionError 的形态）/ 缺 elements / remark 部分错误 / 超 1 MiB body |

单个候选（PoiSourceCandidate）字段：

| 字段 | 说明 |
| --- | --- |
| element_type / element_id | node/way/relation + 正整数 id（上限 JS 安全整数 2^53-1，超过按非法排除，前端 JSON 无法安全表达更大 id），校验后才用于构造 URL |
| name | `name` 标签原文；空白/超长/缺失为 null |
| location | node 的 lat/lon 或 way/relation 的 center，WGS84 |
| distance_m | 到请求点的 haversine 距离（米），仅供排序参考 |
| source_url | 只按已校验 type/id 构造 `https://www.openstreetmap.org/{type}/{id}` |
| retrieved_at | 本次实际收到并解析 provider 2xx 响应体的 UTC 时间 |
| source_updated_at | OSM 对象编辑时间（`timestamp`）；缺失/非法为 null，不用当前时间填充 |
| identity_status | 恒为 `unconfirmed` |
| opening_hours / fee / charge | `{"state": "source_only", "value": "<原文>"}` 或 `{"state": "unknown", "value": null}` |

三个标签字段的口径：原文透传，不推断实时营业状态、不判断免费与否、
不换算票价或币种。空白值、非字符串、超过 300 字符的值记 `unknown`，
不截断后冒充原文。标签键存在但值不可用的元素仍保留为候选（字段 unknown），
不因值不可用丢掉整个候选。

排除规则（都记录在 `notes` 里）：类型/id 非法（含布尔、非正整数、超过
2^53-1）、node 缺 lat/lon 或 way/relation 缺 center、坐标非法或越界
（含无法转换为浮点数的极大整数坐标，保守排除不抛异常）、center 超出
100m 半径（大元素的 bbox 可能触及圆域而中心在外，保守排除且不补坐标）、
三项标签键全缺。`uid`/`user`/`changeset` 等无关元数据一律丢弃，不进任何
输出。

`provider_http_status` 语义：信封里的这个值永远是**本次请求自己**的
provider HTTP 状态（成功路径是收到的 2xx 状态——不硬写 200，201/202 等
有效 2xx 如实记录；429/重定向/4xx/超 body 等失败路径由请求局部异常携带），
并发请求互不串值。严格只有 2xx 进入成功 body 处理，其他状态沿 typed
失败口径。网络连接失败等没有 HTTP 状态的场景为 null。API 层面本接口
响应始终是 HTTP 200 信封（invalid_request 为 422），`provider_http_status`
才是上游 provider 的真实状态，两者不混淆。

## 合同示例（示例数据，离线 Mock）

以下 JSON 是格式示例，**数据是编造的**，不是真实地点，也不代表任何
真实 OSM 对象的现状。仅供后续 UI 接线参考字段形状。

```json
{
  "status": "available",
  "reason": null,
  "provider_http_status": 200,
  "checked_at": "2026-10-30T04:05:00+00:00",
  "fetched_at": "2026-10-30T04:05:02+00:00",
  "requested": {"lat": 31.2304, "lon": 121.4737},
  "radius_m": 100.0,
  "cached": false,
  "source": {
    "provider": "overpass-api.de",
    "endpoint": "https://overpass-api.de/api/interpreter",
    "docs_url": "https://wiki.openstreetmap.org/wiki/Overpass_API",
    "attribution_url": "https://www.openstreetmap.org/copyright",
    "license": "ODbL 1.0",
    "data_source": "OpenStreetMap"
  },
  "source_elements_seen": 2,
  "candidates": [
    {
      "element_type": "node",
      "element_id": 1234567890,
      "name": "示例便利店（虚构）",
      "location": {"lat": 31.23041, "lon": 121.47371},
      "distance_m": 1.2,
      "source_url": "https://www.openstreetmap.org/node/1234567890",
      "retrieved_at": "2026-10-30T04:05:02+00:00",
      "source_updated_at": "2025-06-01T08:00:00Z",
      "identity_status": "unconfirmed",
      "opening_hours": {"state": "source_only", "value": "Mo-Su 07:00-22:00"},
      "fee": {"state": "unknown", "value": null},
      "charge": {"state": "unknown", "value": null}
    },
    {
      "element_type": "way",
      "element_id": 987654321,
      "name": null,
      "location": {"lat": 31.23060, "lon": 121.47390},
      "distance_m": 26.5,
      "source_url": "https://www.openstreetmap.org/way/987654321",
      "retrieved_at": "2026-10-30T04:05:02+00:00",
      "source_updated_at": null,
      "identity_status": "unconfirmed",
      "opening_hours": {"state": "unknown", "value": null},
      "fee": {"state": "source_only", "value": "yes"},
      "charge": {"state": "unknown", "value": null}
    }
  ],
  "notes": []
}
```

UI 展示候选时必须带 OSM 署名（attribution/copyright 链接在 `source` 里），
并把「身份未确认」「来源标签非实时核验」传达给用户。

## 缓存与生命周期

- 内存缓存默认开：TTL 5 分钟、最多 128 键，键为四舍五入到 6 位小数的
  (lat, lon)。只缓存 `available` 与 `no_candidates`；失败响应不缓存。
  命中返回深拷贝，`cached=true`，`retrieved_at`/`fetched_at` 保留原值，
  不把取缓存时间伪装成新抓取。不持久化，进程重启即清空。
  `cache_ttl_seconds=0` 或 `cache_max_keys=0` 都等于关闭缓存（每次都打
  provider）。
- 构造参数在分配任何 HTTP 资源之前校验（本地配置合同）：
  `total_deadline_seconds` 为大于 0 的有限数值；`cache_ttl_seconds` 为
  大于等于 0 的有限数值；`cache_max_keys` 为大于等于 0 的整数。非法配置
  抛 TypeError/ValueError，不遗留半初始化对象或 owned client。除此之外
  不新增与用户任务无关的上限。
- 资源限制：总 deadline 默认 8 秒覆盖等待 headers 与全部 body；流式读取
  解压后硬上限 1 MiB（读取时生效，不是先全量读再查大小）；不跟随重定向、
  无重试、无自动换源。
- `asyncio.CancelledError` 原样上抛。
- Router 用 `poi_sources_router_factory()` 接入 api_server（与 weather 相同
  的 router lifespan 机制）：每个 app/worker 一个独立 owned client，shutdown
  时 close；注入 client 时所有权在调用方；初始化失败只让本路由 503，不拖垮
  其他路由。关闭幂等；关闭后 `fetch_nearby` 抛 RuntimeError，路由层折算 503。
- 模块 import 不发请求、不读 .env；测试全部离线（MockTransport/假时钟/
  独立 FastAPI app），不发真实 Overpass 请求。测试进程用
  `PYTHON_DOTENV_DISABLED=1` 加受控导入期间对 `dotenv.load_dotenv` 的
  临时 no-op 补丁（导入完成即还原原函数，不污染同进程其他测试），
  不依赖 dotenv 版本行为，绝不读取真实 .env。

## 已知局限

- 未做真实 POI 样本评估：覆盖范围、标签质量、距离准确性都没有验收数据，
  不要宣称「数据已验证」。
- 限定 100m/30 元素/8 候选的结果不声称完整或全局最近；`around` 圆域过滤
  基于 provider 端的元素几何，way/relation 用 center 近似，可能与用户感知
  的「在附近」有偏差。
- `no_candidates` 只说明本期查询条件下没有可用公开字段候选，不代表该地点
  在 OSM 中不存在，也不代表该地点现实中不存在。
- 后续前端将显式点击请求（本批先稳定后端合同），持续高频调用仍可能触发
  上游限流；`rate_limited` 是正常业务状态，不是故障。
