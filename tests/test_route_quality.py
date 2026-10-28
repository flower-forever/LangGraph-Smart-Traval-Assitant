# -*- coding: utf-8 -*-
"""路线质量回归测试（独立评审确认的两个问题，写给你正在修的 travel_itinerary.py）。

问题 1：高德 v5 返回的 polyline 若混入 (0,0) 或离起点/终点很远的离群点，
当前会原样穿过 parse_amap_polyline -> GCJ-02 转 WGS84 -> Leg.geometry，
以 route_type=navigation 输出，前端地图直接画到半个地球外。
预期：异常几何被拒绝，或明确降级为 straight_line / unavailable；
同时合法的北京路线必须仍然生成 navigation（防修过头）。

问题 2：一天里 A 09:00 停留 10 分钟、B 排在 09:10，但地图服务返回
A→B 步行 30 分钟——按计划根本赶不到。预期：保留原站点时间与真实路线
数据、不编造修改，但在 trip.warnings 里标明时间冲突；正常可达时不得
误报；没有真实 route 耗时（如路线获取失败）时不凭空计算冲突。

fixture 约定（沿用 tests/test_amap_client.py 的做法）：
- 真实 AMapClient + httpx.MockTransport，不访问真实网络、不读任何密钥，
  key 用占位串 "fixture-key"。
- 高德 polyline 是 GCJ-02、经度在前的 ``lng,lat;lng,lat``；终点断言用
  gcj02_to_wgs84 现算，不硬编码转换结果。
- mock 同时应答 /v3/geocode/geo、/v3/place/text、/v5/direction/*；
  POI 名与站名一致、geocode 带 level=兴趣点，满足实现侧的坐标可信度
  校验。实现内部先 POI 还是先 geocode 都能工作，不过度耦合实现结构。

修复前预期失败的用例：异常几何三类（零点 / 远途离群点 / 全垃圾）、
客户端层垃圾 polyline 一类、时间冲突告警一类，共 5 个；其余 3 个是
防误报/防回退的护栏，修复前后都应通过。
"""

import asyncio

import httpx
import pytest

from travel_itinerary import (
    AMapClient,
    AMapError,
    Coordinate,
    DayPlan,
    Stop,
    TripPlan,
    TripPlanRequest,
    enrich_trip_with_map,
    gcj02_to_wgs84,
)


def run(coro):
    return asyncio.run(coro)


# ==================== 公共 fixture 数据：两个北京站点 ====================

STOP_A_ID = "stop-a"
STOP_B_ID = "stop-b"
STOP_A_NAME = "天安门广场"
STOP_B_NAME = "王府井"

# 站点坐标是 GCJ-02（高德接口口径），经度在前。
STOP_A_GCJ = (116.397, 39.908)  # 天安门广场附近
STOP_B_GCJ = (116.411, 39.909)  # 王府井附近，直线约 1.2 公里

# 允许几何点偏离起终点走廊的余量。0.5 度约 50 公里，北京两点间的步行
# 路线绝不会超出；而 (0,0)、上海（约 1000 公里外）都会被拦下。GCJ-02
# 与 WGS84 在北京相差约 0.005 度，相对这个余量可以忽略。
CORRIDOR_TOLERANCE_DEG = 0.5


def _beijing_request():
    return TripPlanRequest(destination="北京", days=1, travel_mode="walking")


def _beijing_trip(*, a_time="09:00", a_minutes=10, b_time="09:10", b_minutes=None):
    """最小两站行程：地址可被地理编码，坐标留空等待 enrich 补齐。"""

    return TripPlan(
        id="trip-route-quality",
        source="agent",
        destination="北京",
        title="北京路线质量回归行程",
        summary="两个相邻站点的一日步行行程，用于路线几何与时间冲突回归测试。",
        days=[
            DayPlan(
                day=1,
                title="第一天",
                stops=[
                    Stop(
                        id=STOP_A_ID,
                        name=STOP_A_NAME,
                        time=a_time,
                        duration_minutes=a_minutes,
                        description="起点。",
                        address="北京市东城区东长安街天安门广场",
                    ),
                    Stop(
                        id=STOP_B_ID,
                        name=STOP_B_NAME,
                        time=b_time,
                        duration_minutes=b_minutes,
                        description="终点。",
                        address="北京市东城区王府井大街",
                    ),
                ],
            )
        ],
    )


def _clean_polyline():
    """合法北京路线：起点 -> 途经点 -> 终点，全部在两站之间。"""

    mid_lng = (STOP_A_GCJ[0] + STOP_B_GCJ[0]) / 2
    mid_lat = (STOP_A_GCJ[1] + STOP_B_GCJ[1]) / 2
    return ";".join(
        f"{lng:.6f},{lat:.6f}"
        for lng, lat in (STOP_A_GCJ, (mid_lng, mid_lat), STOP_B_GCJ)
    )


_STOP_META = {
    "a": {
        "name": STOP_A_NAME,
        "address": "北京市东城区东长安街天安门广场",
        "district": "东城区",
        "street": "东长安街",
        "lng": STOP_A_GCJ[0],
        "lat": STOP_A_GCJ[1],
    },
    "b": {
        "name": STOP_B_NAME,
        "address": "北京市东城区王府井大街",
        "district": "东城区",
        "street": "王府井大街",
        "lng": STOP_B_GCJ[0],
        "lat": STOP_B_GCJ[1],
    },
}


def _beijing_amap_handler(*, polyline, distance="1500", duration_seconds="900"):
    """按请求路径分发的高德 mock；坐标按地址里的地标词返回 GCJ-02。"""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        params = dict(request.url.params)

        if path in ("/v3/geocode/geo", "/v3/place/text"):
            query = params.get("address") or params.get("keywords") or ""
            meta = _STOP_META["b"] if "王府井" in query else _STOP_META["a"]
            location = f"{meta['lng']:.6f},{meta['lat']:.6f}"
            if path == "/v3/geocode/geo":
                # 真实高德地理编码回包带 level/city/district；level=兴趣点
                # 表示命中了具体地点，属于实现侧认可的可信结果。
                return httpx.Response(
                    200,
                    json={
                        "status": "1",
                        "info": "OK",
                        "geocodes": [
                            {
                                "formatted_address": meta["address"],
                                "location": location,
                                "level": "兴趣点",
                                "city": "北京市",
                                "district": meta["district"],
                            }
                        ],
                    },
                )
            # 真实高德 POI 搜索返回名称与关键词一致的条目；cityname 供城市核对。
            return httpx.Response(
                200,
                json={
                    "status": "1",
                    "info": "OK",
                    "pois": [
                        {
                            "name": meta["name"],
                            "location": location,
                            "cityname": "北京市",
                            "adname": meta["district"],
                            "address": meta["street"],
                        }
                    ],
                },
            )

        if path in ("/v5/direction/walking", "/v5/direction/driving"):
            return httpx.Response(
                200,
                json={
                    "status": "1",
                    "route": {
                        "paths": [
                            {
                                "distance": distance,
                                "cost": {"duration": duration_seconds},
                                "steps": [{"polyline": polyline}],
                            }
                        ]
                    },
                },
            )

        return httpx.Response(
            200,
            json={"status": "0", "info": f"unexpected path {path}", "infocode": "fixture_miss"},
        )

    return handler


async def _enrich_with_handler(trip, request, handler):
    """真实 AMapClient + MockTransport 跑 enrich_trip_with_map。"""

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        amap = AMapClient("fixture-key", client=http_client)
        return await enrich_trip_with_map(trip, request, amap)


async def _route_with_handler(handler, mode="walking"):
    """直接调用 AMapClient.route，用于客户端层面的几何检查。"""

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        amap = AMapClient("fixture-key", client=http_client)
        return await amap.route(
            Coordinate(lng=STOP_A_GCJ[0], lat=STOP_A_GCJ[1]),
            Coordinate(lng=STOP_B_GCJ[0], lat=STOP_B_GCJ[1]),
            mode,
        )


def _offending_points(geometry, *, tol=CORRIDOR_TOLERANCE_DEG):
    """找出落在起终点走廊之外的几何点（含 (0,0) 与远途离群点）。"""

    lng_lo = min(STOP_A_GCJ[0], STOP_B_GCJ[0]) - tol
    lng_hi = max(STOP_A_GCJ[0], STOP_B_GCJ[0]) + tol
    lat_lo = min(STOP_A_GCJ[1], STOP_B_GCJ[1]) - tol
    lat_hi = max(STOP_A_GCJ[1], STOP_B_GCJ[1]) + tol
    return [
        (point.lng, point.lat)
        for point in geometry
        if not (lng_lo <= point.lng <= lng_hi and lat_lo <= point.lat <= lat_hi)
    ]


def _first_leg(trip):
    legs = trip.days[0].legs
    assert legs, f"行程没有生成任何 leg，warnings={trip.warnings!r}"
    return legs[0]


# ==================== 问题 1：异常 polyline 不得变成 navigation 几何 ====================


def test_polyline_with_zero_point_must_not_reach_navigation_geometry():
    """polyline 混入 (0,0)（无效空点）时，不得以 navigation 输出该几何。"""

    polyline = (
        f"{STOP_A_GCJ[0]:.6f},{STOP_A_GCJ[1]:.6f};"
        "0.000000,0.000000;"
        f"{STOP_B_GCJ[0]:.6f},{STOP_B_GCJ[1]:.6f}"
    )
    handler = _beijing_amap_handler(polyline=polyline)
    trip = run(_enrich_with_handler(_beijing_trip(), _beijing_request(), handler))

    leg = _first_leg(trip)
    if leg.route_type == "navigation":
        offenders = _offending_points(leg.geometry)
        assert not offenders, (
            "navigation 几何包含 (0,0) 一类离谱离群点，会把地图拉到半个地球外: "
            f"{offenders}; 实际 warnings: {trip.warnings!r}"
        )
    else:
        # 明确降级为 straight_line / unavailable 也算修复达标。
        assert leg.route_type in ("straight_line", "unavailable")


def test_polyline_with_far_outlier_must_not_reach_navigation_geometry():
    """polyline 混入上海坐标（在中国境内但离北京上千公里）同样必须拦下。"""

    polyline = (
        f"{STOP_A_GCJ[0]:.6f},{STOP_A_GCJ[1]:.6f};"
        "121.473700,31.230400;"  # 上海人民广场，境内远途离群点
        f"{STOP_B_GCJ[0]:.6f},{STOP_B_GCJ[1]:.6f}"
    )
    handler = _beijing_amap_handler(polyline=polyline)
    trip = run(_enrich_with_handler(_beijing_trip(), _beijing_request(), handler))

    leg = _first_leg(trip)
    if leg.route_type == "navigation":
        offenders = _offending_points(leg.geometry)
        assert not offenders, (
            "navigation 几何包含远途离群点，北京两站之间的路线不应扫过上海: "
            f"{offenders}; 实际 warnings: {trip.warnings!r}"
        )
    else:
        assert leg.route_type in ("straight_line", "unavailable")


def test_all_garbage_polyline_degrades_instead_of_navigation():
    """整条 polyline 都是垃圾点时，最多降级，绝不能以 navigation 输出。"""

    handler = _beijing_amap_handler(polyline="0.000000,0.000000;0.000001,0.000001")
    trip = run(_enrich_with_handler(_beijing_trip(), _beijing_request(), handler))

    leg = _first_leg(trip)
    offenders = _offending_points(leg.geometry) if leg.geometry else []
    assert leg.route_type != "navigation" or not offenders, (
        "全垃圾 polyline 不应生成 navigation（或至少不得携带垃圾几何点）: "
        f"route_type={leg.route_type}, 离群点={offenders}, warnings={trip.warnings!r}"
    )
    if leg.route_type == "navigation":
        # 走廊内降级路线也必须有可用的几何，不允许空壳 navigation。
        assert len(leg.geometry) >= 2


def test_route_client_rejects_or_sanitizes_absurd_polyline():
    """客户端层：全垃圾 polyline 要么抛 AMapError，要么返回走廊内的干净几何。"""

    handler = _beijing_amap_handler(polyline="0.000000,0.000000;0.000001,0.000001")
    try:
        result = run(_route_with_handler(handler))
    except AMapError:
        return  # 拒绝整条路线，符合"拒绝或降级"的要求

    offenders = _offending_points(result.geometry)
    assert not offenders, f"RouteResult.geometry 含离谱离群点: {offenders}"


def test_valid_beijing_route_still_becomes_navigation():
    """护栏：合法北京 polyline 必须仍然生成 navigation，端点为转换后的 WGS84。"""

    handler = _beijing_amap_handler(
        polyline=_clean_polyline(), distance="1500", duration_seconds="900"
    )
    trip = run(_enrich_with_handler(_beijing_trip(), _beijing_request(), handler))

    leg = _first_leg(trip)
    assert leg.route_type == "navigation"
    assert leg.distance_m == 1500
    assert leg.duration_minutes == pytest.approx(15.0)
    assert len(leg.geometry) >= 2

    expected_origin = gcj02_to_wgs84(*STOP_A_GCJ)
    expected_dest = gcj02_to_wgs84(*STOP_B_GCJ)
    assert leg.geometry[0].lng == pytest.approx(expected_origin[0], abs=1e-5)
    assert leg.geometry[0].lat == pytest.approx(expected_origin[1], abs=1e-5)
    assert leg.geometry[-1].lng == pytest.approx(expected_dest[0], abs=1e-5)
    assert leg.geometry[-1].lat == pytest.approx(expected_dest[1], abs=1e-5)


# ==================== 问题 2：时刻表与真实耗时的冲突必须告警 ====================

# 宽松关键词池：修复作者的措辞可以不同，但至少要出现冲突相关的语义。
_CONFLICT_KEYWORDS = (
    "时间", "冲突", "赶不上", "来不及", "无法", "没法", "不符",
    "早于", "晚于", "超过", "抵达", "到达", "间隔", "紧张", "矛盾", "不可行",
)


def _find_time_conflict_warning(warnings):
    """宽松匹配时间冲突告警：出现任一站点标识 + 任一冲突相关词即命中。

    刻意不硬编码整句；同时要求提到站点（名称或 id），确保告警能定位到
    具体冲突的站点，而不是一句无法行动的泛泛提示。
    """

    identifiers = (STOP_A_NAME, STOP_B_NAME, STOP_A_ID, STOP_B_ID)
    for warning in warnings:
        hit_id = any(token in warning for token in identifiers)
        hit_keyword = any(keyword in warning for keyword in _CONFLICT_KEYWORDS)
        if hit_id and hit_keyword:
            return warning
    return None


def test_walk_time_exceeding_gap_is_flagged_without_touching_schedule():
    """A 09:00 停留 10 分钟、B 09:10，步行却要 30 分钟——必须告警且不改数据。"""

    handler = _beijing_amap_handler(polyline=_clean_polyline(), duration_seconds="1800")
    trip = run(_enrich_with_handler(_beijing_trip(), _beijing_request(), handler))

    # 不编造修改：站点时间、停留时长与真实路线耗时原样保留。
    assert [stop.time for stop in trip.days[0].stops] == ["09:00", "09:10"]
    assert trip.days[0].stops[0].duration_minutes == 10
    leg = _first_leg(trip)
    assert leg.duration_minutes == pytest.approx(30.0)

    hit = _find_time_conflict_warning(trip.warnings)
    assert hit is not None, (
        "站点间隔 10 分钟、步行需 30 分钟，warnings 里没有可定位的时间冲突提示；"
        f"实际 warnings: {trip.warnings!r}"
    )


def test_feasible_schedule_does_not_trigger_conflict_warning():
    """护栏：正常可达（09:00 停留 60 分钟 + 30 分钟步行，11:00 前到）不得误报。"""

    handler = _beijing_amap_handler(polyline=_clean_polyline(), duration_seconds="1800")
    trip = run(
        _enrich_with_handler(
            _beijing_trip(a_time="09:00", a_minutes=60, b_time="11:00"),
            _beijing_request(),
            handler,
        )
    )

    hit = _find_time_conflict_warning(trip.warnings)
    assert hit is None, f"可达行程被误报时间冲突: {trip.warnings!r}"


def test_no_route_duration_means_no_conflict_warning():
    """护栏：路线获取失败、没有真实耗时，不该凭空计算并告警时间冲突。"""

    base_handler = _beijing_amap_handler(polyline=_clean_polyline())

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/v5/direction/"):
            return httpx.Response(
                200, json={"status": "0", "info": "ROUTE_FAILED", "infocode": "30001"}
            )
        return base_handler(request)

    trip = run(_enrich_with_handler(_beijing_trip(), _beijing_request(), handler))

    leg = _first_leg(trip)
    assert leg.duration_minutes is None, (
        f"路线获取失败时不应有真实耗时: {leg.duration_minutes!r}"
    )
    hit = _find_time_conflict_warning(trip.warnings)
    assert hit is None, f"没有真实 route 耗时却报了时间冲突: {trip.warnings!r}"
