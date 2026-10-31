# 天气客户端并发状态修复（provider_http_status 请求局部化）

分支 `feat/interactive-travel-planner`，基线 `74db1e8673d97ac2c06b873d018d5a47d37a39d8`。
本修复与已发布的 POI（`poi_sources_client.py`）共享状态修复同类：删除实例共享
HTTP 状态字段，改为请求局部传递。只动了三个文件：

- `weather_client.py`（修改）
- `tests/test_weather_client_regressions.py`（修改，28 → 36 条；独立验收
  补 body 中途断开回归后为 39 条，见下文）
- `docs/WEATHER_CONCURRENCY.md`（本文档，新增）

## 问题

`WeatherClient.__init__` 曾创建实例字段 `_last_provider_status`，
`_fetch_payload` 在每次请求前重置、收到响应头时写入，成功返回值与
unavailable/failed 分支从实例字段读取。同一个 client 实例被并发使用时
（如 `asyncio.gather` 同时查多个日期/坐标），坏结果信封可以继承别的请求的
状态，违反"本请求数据只反映本请求"的合同。以下两条时序均已用
MockTransport + `asyncio.Event` 真实复现：

时序一（共享字段串值）：请求 A 收到 200 headers 后挂在 body 读取上，
请求 B 收到 503 先结束。B 的 unavailable 信封读实例字段，可能拿到 A 的
200；反向 A 失败时也可能带上 B 的错误状态，成功信封同样可能被后到的
请求覆盖。

时序二（body 中途断开丢状态，独立验收新增）：请求 A 收到 200 headers
后 body 读取中途抛 `httpx.ReadError`。修复前该异常原样上抛，异常本身
不带状态属性，unavailable 信封读到 None，丢掉本次已知的 200。此场景与
共享字段无关，属请求局部传递实现自身的遗漏，由并发请求（429/503）交错
验证不串值。连接失败（无 HTTP 响应）状态为 None 是正确口径，不在本条
范围内。

## 修复

沿用 POI 已发布的局部传递模式，未复制 POI 框架、未动天气算法：

- 删除实例字段 `_last_provider_status`（构造函数与 `_fetch_payload` 里的
  重置/写入/读取全部移除）。
- 成功路径：`_do_request` 返回 `(body, status)` 二元组，状态随返回值局部
  传递；JSON 解析失败抛出的 `_BadResponse` 携带 `provider_http_status`
  属性。成功信封写本请求真实 2xx 状态，不硬写 200（201/202 原样保留）。
- 失败路径：三类内部信号异常都携带 `provider_http_status` 属性——
  `_UpstreamHTTPError`（429/5xx，仍是 `httpx.HTTPError` 子类，折算
  unavailable 不变）、`_BadResponse`（4xx/重定向/坏 JSON/根非对象，折算
  failed）、`_BodyTooLarge`（超 128 KiB，在流内补上当前 status）。上层
  `fetch_day` 用 `exc.provider_http_status` / `getattr(exc, ...)` 读取。
  headers 已收到后 body 读取中途的 `httpx.ReadError` 等网络层断开：
  用请求局部 `_UpstreamHTTPError` 包装（`from exc`），携带本次已收到的
  状态后按既有口径折算 unavailable；`httpx.TimeoutException` 原样放行给
  timeout 分支，超时口径维持无状态。异常 message 只含异常类名，不回显
  provider 原文或 URL。
- 无 HTTP 响应的失败（`OSError`、连接错误、总 deadline 超时）不带状态，
  信封 `provider_http_status` 为 None，绝不沿用上一次或别的请求的值。
- 非 2xx 处理口径不变：429/5xx → unavailable，其他 4xx → failed；
  即使 body 是合法 payload（如 404 带有效 JSON）也不按成功处理。
  未新增 `rate_limited` 状态，`WeatherStatus` 枚举未动。

保持不变的语义：`WeatherDayReport`/`WeatherStatus`/JSON 形状、endpoint
固定与不跟随重定向、日期 coverage、单位核验、取消上抛、总 deadline 与
流式 128 KiB 上限、三态坐标、`fetched_at` 只在成功读到 2xx body 后设置。

## 并发元数据合同（修复后的口径）

- `provider_http_status` 只反映**本请求**收到的 provider HTTP 状态；
  来源是本请求的返回值或本请求抛出的异常属性，不经过任何实例级存储。
- 无 HTTP 响应（连接失败、超时、取消前未收到响应）时为 `None`。
- 同一 `WeatherClient` 实例可安全并发调用 `fetch_day`；各请求的
  状态、坐标、coverage、forecast 互不串值。

## 离线测试证据

全部用 `httpx.MockTransport` + `asyncio.Event` 控制请求先后，无长 sleep
凑顺序、无真实网络、无 `.env`/业务 key 读取（`PYTHON_DOTENV_DISABLED=1`，
key 留空/假值），未启动真实服务 lifespan。`.venv/Scripts/python.exe -m pytest`
真实输出（前两行为原作者运行记录；第三行为独立验收运行）：

| 范围 | 结果 |
| --- | --- |
| `tests/test_weather_client_regressions.py` | 36 passed（0.68s，原作者时点） |
| `tests/test_poi_sources_client.py` | 52 passed（0.43s，原作者时点） |
| `tests/test_poi_sources_api.py` | 26 passed, 1 warning（13.44s，原作者时点） |
| 三文件合并 | 114 passed, 1 warning，退出码 0（14.4s，原作者时点） |
| `tests/test_weather_client_regressions.py`（独立验收，39 条） | 39 passed（1.71s） |
| 五文件合并（天气 3 文件 + POI 2 文件，独立验收） | 199 passed, 1 warning，退出码 0（31.14s） |

新增测试函数（429/503 参数化展开为 2 条；独立验收前为 7 个函数展开 8 条，
28 → 36；独立验收补 2 个函数、429/503 参数化再展开 2 条，现为 39 条）：

- `test_concurrent_slow_200_then_error_status_isolated`：200 流挂起的
  请求 A（headers 已到、body 未读）与先结束的 429/503 请求 B 并发，
  B 的 unavailable 信封携带自己的错误状态，A 随后超 body 失败携带自己的
  200，互不串值；错误正文不进信封。
- `test_concurrent_connect_error_does_not_inherit_inflight_status`：
  连接错误的请求 B 状态为 None，不继承挂起中请求 A 的 200。
- `test_concurrent_different_queries_parallel_success`：不同坐标并行成功，
  网格坐标各归各。
- `test_success_keeps_real_2xx_status`：201/202 保留真实状态。
- `test_non_2xx_with_valid_payload_not_fake_success`：404 + 合法 payload
  不得假成功。
- `test_bad_json_failed_carries_own_status`：坏 JSON 的 failed 携带本请求 200。
- `test_no_instance_shared_provider_status_attribute`：结构性保证实例上
  不存在 `_last_provider_status`。

独立验收补充（针对 body 中途断开丢状态）：

- `test_body_read_error_keeps_own_status_not_err_status`（429/503
  参数化展开 2 条）：请求 A 收到 200 headers 后 body 中途 ReadError，
  先结束的请求 B 各携带自己的 429/503；A 的信封保留本请求 200，
  不丢状态也不串值，错误正文不进信封。
- `test_body_read_error_alone_still_unavailable_status_200`：无并发干扰
  时单请求同样保留 200；折算口径维持 unavailable，与既有网络错误合同一致。

- 旧 28 条全部保留，断言未弱化。

## 局限

- 所有证据来自 MockTransport 离线回归；未对 Open-Meteo 做真实请求，
  天气数据真实性与实时可用性未验证。
- 201/202 的成功口径按"provider 返回 2xx 即成功"处理；这是防御性设计，
  覆盖 provider 未来可能返回 201/202 的情况。未对 Open-Meteo 真实返回的
  状态分布做过评估或观察，不做此断言。
- `weather_client.py` 与测试文件的工作副本行尾因编辑工具统一为 LF
  （仓库 `core.autocrlf=true`，`git diff` 不受影响，提交时按配置归一）。
- frontend/ 与 `docs/POI_SOURCES_UI.md` 的 dirty 来自并行的 POI 前端
  开发者，与本修复无关，未触碰。
