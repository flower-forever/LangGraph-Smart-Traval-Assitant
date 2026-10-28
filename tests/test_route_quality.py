# -*- coding: utf-8 -*-
"""路线质量回归测试：异常几何不得以 navigation 输出，时间冲突必须告警。

问题 1（路线几何真实性）：高德 v5 返回的 polyline 若混入 (0,0)、
离起点/终点很远的离群点，或整条折线端点根本不是请求的起终点
（哪怕全部点都落在起终点包围盒内），都不允许穿过 parse_amap_polyline
-> GCJ-02 转 WGS84 -> Leg.geometry 以 route_type=navigation 输出，
否则前端地图会画到几十公里甚至半个地球外。
预期：异常几何被拒绝并降级为 straight_line / unavailable；同时合法的
北京路线、端点仅有路网吸附级偏移的路线必须仍然生成 navigation
（防修过头）。

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
# 这个余量只用于断言侧的离群点检测；实现侧还会核验折线首末点接近
# 请求的起终点（见 travel_itinerary.py 的 _polyline_is_plausible）。
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


async def _route_with_handler(handler, mode="walking", *, origin_gcj=None, destination_gcj=None):
    """直接调用 AMapClient.route，用于客户端层面的几何检查。

    origin_gcj / destination_gcj 缺省用公共 fixture 的两个北京站点；
    需要更长腿（逆向、阈值差异等场景）时单独传入。
    """

    if origin_gcj is None:
        origin_gcj = STOP_A_GCJ
    if destination_gcj is None:
        destination_gcj = STOP_B_GCJ
    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        amap = AMapClient("fixture-key", client=http_client)
        return await amap.route(
            Coordinate(lng=origin_gcj[0], lat=origin_gcj[1]),
            Coordinate(lng=destination_gcj[0], lat=destination_gcj[1]),
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
        # 明确降级为 straight_line / unavailable 也算达标。
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


# ==================== 问题 3：折线端点必须真是请求的起终点 ====================
#
# 包围盒检查拦得住 (0,0) 和外市坐标，拦不住“整条折线都平移到走廊内
# 别处”的假路线。实现侧按出行方式在 GCJ-02 原坐标空间核验首末点：
# 步行 2 公里、驾车 5 公里，容忍正常路网吸附，超限即抛 implausible_polyline
# 并降级，不把假几何标成 navigation。


def test_bbox_passing_polyline_with_distant_endpoints_is_rejected():
    """整条折线在原包围盒内、但端点离请求起终点几十公里，必须拒绝。"""

    # (116.75,40.20)→(116.76,40.21) 在 ±0.5 度包围盒内，但首点离天安门
    # 约 44 公里——旧的包围盒检查放行，端点距离检查必须拦下。
    fake_polyline = "116.750000,40.200000;116.755000,40.205000;116.760000,40.210000"
    handler = _beijing_amap_handler(polyline=fake_polyline)

    with pytest.raises(AMapError) as exc_info:
        run(_route_with_handler(handler))
    assert exc_info.value.code == "implausible_polyline"

    trip = run(_enrich_with_handler(_beijing_trip(), _beijing_request(), handler))
    leg = _first_leg(trip)
    assert leg.route_type == "straight_line", (
        f"端点偏离几十公里的假路线不得以 navigation 输出: {leg.route_type}, "
        f"warnings={trip.warnings!r}"
    )
    # 直线示意的几何只允许是两个站点的 WGS84 坐标，假折线不许漏进来。
    stops = trip.days[0].stops
    assert [(p.lng, p.lat) for p in leg.geometry] == [
        (stops[0].location.lng, stops[0].location.lat),
        (stops[1].location.lng, stops[1].location.lat),
    ]


def test_moderate_road_snap_offset_still_navigates():
    """端点只有路网吸附级偏移（几百米）时不得误拒，且几何不被悄悄替换。"""

    polyline = (
        "116.399000,39.906000;"  # 离 STOP_A 约 280 米
        "116.404000,39.907500;"
        "116.409000,39.911000"  # 离 STOP_B 约 280 米
    )
    handler = _beijing_amap_handler(
        polyline=polyline, distance="1500", duration_seconds="900"
    )
    trip = run(_enrich_with_handler(_beijing_trip(), _beijing_request(), handler))

    leg = _first_leg(trip)
    assert leg.route_type == "navigation", (
        f"吸附级端点偏移被误拒: route_type={leg.route_type}, "
        f"warnings={trip.warnings!r}"
    )
    assert leg.distance_m == 1500
    assert leg.duration_minutes == pytest.approx(15.0)
    # 输出仍是 WGS84、经度在前；首末点来自折线本身（吸附后的端点），
    # 不是被替换成站点坐标。
    expected_first = gcj02_to_wgs84(116.399, 39.906)
    expected_last = gcj02_to_wgs84(116.409, 39.911)
    assert leg.geometry[0].lng == pytest.approx(expected_first[0], abs=1e-5)
    assert leg.geometry[0].lat == pytest.approx(expected_first[1], abs=1e-5)
    assert leg.geometry[-1].lng == pytest.approx(expected_last[0], abs=1e-5)
    assert leg.geometry[-1].lat == pytest.approx(expected_last[1], abs=1e-5)


def test_reversed_polyline_is_not_passed_off_as_navigation():
    """把 A→B 的路线反过来发给 A→B 的请求，不得伪装成真实导航。"""

    # 造一段 7 公里级的腿：正向路线首点必须贴 origin，反向折线的首点
    # 在 destination 一侧、离 origin 数公里，超出步行 2 公里阈值。
    # 站点距离小于阈值时（如 fixture 的 1.2 公里），端点检查无法区分
    # 正反向，这类几何上等价的路径不在拦截范围内。
    far_b = (116.480, 39.910)
    reversed_polyline = ";".join(
        f"{lng:.6f},{lat:.6f}" for lng, lat in (far_b, (116.440, 39.909), STOP_A_GCJ)
    )
    handler = _beijing_amap_handler(polyline=reversed_polyline)

    with pytest.raises(AMapError) as exc_info:
        run(_route_with_handler(handler, origin_gcj=STOP_A_GCJ, destination_gcj=far_b))
    assert exc_info.value.code == "implausible_polyline"


def test_polyline_missing_destination_end_is_rejected():
    """缺终点：折线从 origin 出发却停在离 destination 二十多公里的半路。"""

    truncated_polyline = (
        f"{STOP_A_GCJ[0]:.6f},{STOP_A_GCJ[1]:.6f};"
        "116.700000,40.000000"  # 离 STOP_B 约 27 公里，仍在包围盒内
    )
    handler = _beijing_amap_handler(polyline=truncated_polyline)

    with pytest.raises(AMapError) as exc_info:
        run(_route_with_handler(handler))
    assert exc_info.value.code == "implausible_polyline"

    trip = run(_enrich_with_handler(_beijing_trip(), _beijing_request(), handler))
    leg = _first_leg(trip)
    assert leg.route_type != "navigation", (
        f"缺终点的路径不得伪装成 navigation: {leg.route_type}, warnings={trip.warnings!r}"
    )


def test_endpoint_tolerance_is_wider_for_driving_than_walking():
    """3 公里级端点偏差：按驾车阈值（5 公里）放行，按步行阈值（2 公里）拒绝。"""

    off_origin = (116.430, 39.908)  # 离 STOP_A 约 2.9 公里
    off_dest = (116.440, 39.910)    # 离 STOP_B 约 2.5 公里
    polyline = ";".join(
        f"{lng:.6f},{lat:.6f}" for lng, lat in (off_origin, (116.435, 39.909), off_dest)
    )
    handler = _beijing_amap_handler(polyline=polyline)

    result = run(
        _route_with_handler(
            handler, mode="driving", origin_gcj=STOP_A_GCJ, destination_gcj=STOP_B_GCJ
        )
    )
    assert len(result.geometry) >= 2

    with pytest.raises(AMapError) as exc_info:
        run(
            _route_with_handler(
                handler, mode="walking", origin_gcj=STOP_A_GCJ, destination_gcj=STOP_B_GCJ
            )
        )
    assert exc_info.value.code == "implausible_polyline"


def test_oversized_polyline_is_thinned_without_losing_endpoints():
    """6000 点的超长折线被安全抽样到上限内，首末点原样保留。"""

    count = 6000
    chunks = []
    for index in range(count):
        ratio = index / (count - 1)
        lng = STOP_A_GCJ[0] + (STOP_B_GCJ[0] - STOP_A_GCJ[0]) * ratio
        lat = STOP_A_GCJ[1] + (STOP_B_GCJ[1] - STOP_A_GCJ[1]) * ratio
        chunks.append(f"{lng:.6f},{lat:.6f}")
    handler = _beijing_amap_handler(polyline=";".join(chunks), distance="1500")

    result = run(_route_with_handler(handler))

    assert result.distance_m == 1500
    assert len(result.geometry) <= 5000
    expected_first = gcj02_to_wgs84(*STOP_A_GCJ)
    expected_last = gcj02_to_wgs84(*STOP_B_GCJ)
    assert result.geometry[0].lng == pytest.approx(expected_first[0], abs=1e-5)
    assert result.geometry[0].lat == pytest.approx(expected_first[1], abs=1e-5)
    assert result.geometry[-1].lng == pytest.approx(expected_last[0], abs=1e-5)
    assert result.geometry[-1].lat == pytest.approx(expected_last[1], abs=1e-5)


# ==================== 问题 2：时刻表与真实耗时的冲突必须告警 ====================

# 宽松关键词池：实现侧的措辞可以不同，但至少要出现冲突相关的语义。
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
