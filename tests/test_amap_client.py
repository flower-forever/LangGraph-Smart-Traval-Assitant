# -*- coding: utf-8 -*-
"""高德客户端离线测试：用 httpx.MockTransport，不访问真实网络。"""

import asyncio

import httpx
import pytest

from travel_itinerary import (
    AMapClient,
    AMapError,
    Coordinate,
    _POI_NAME_MATCH_MIN_SCORE,
    _place_name_score,
    gcj02_to_wgs84,
)


def run(coro):
    return asyncio.run(coro)


async def _call_with_transport(handler, action):
    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        amap = AMapClient("test-key", client=http_client)
        return await action(amap)


def test_geocode_parses_gcj_location_and_keeps_lng_lat_order():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["params"] = dict(request.url.params)
        return httpx.Response(
            200,
            json={
                "status": "1",
                "info": "OK",
                "geocodes": [
                    {
                        "formatted_address": "北京市东城区景山前街4号",
                        "location": "116.397,39.916",
                    }
                ],
            },
        )

    result = run(
        _call_with_transport(
            handler,
            lambda amap: amap.geocode("故宫", city="北京"),
        )
    )

    assert seen["path"] == "/v3/geocode/geo"
    assert seen["params"]["address"] == "故宫"
    assert seen["params"]["city"] == "北京"
    assert seen["params"]["key"] == "test-key"
    # 地理编码结果仍为 GCJ-02，保持经度在前。
    assert result.location.lng == pytest.approx(116.397)
    assert result.location.lat == pytest.approx(39.916)
    assert result.formatted_address == "北京市东城区景山前街4号"


def test_geocode_api_error_raises_amap_error_with_code():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"status": "0", "info": "INVALID_USER_KEY", "infocode": "10001"},
        )

    with pytest.raises(AMapError) as exc_info:
        run(
            _call_with_transport(
                handler,
                lambda amap: amap.geocode("故宫"),
            )
        )
    assert exc_info.value.code == "10001"
    assert "INVALID_USER_KEY" in str(exc_info.value)


def test_missing_key_is_never_sent_to_network():
    called = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        called["count"] += 1
        return httpx.Response(200, json={"status": "1"})

    async def action():
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            amap = AMapClient("", client=http_client)
            assert amap.configured is False
            with pytest.raises(AMapError) as exc_info:
                await amap.geocode("故宫")
            assert exc_info.value.code == "missing_key"

    run(action())
    assert called["count"] == 0


def test_walking_route_requests_v5_and_converts_polyline_to_wgs84():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["params"] = dict(request.url.params)
        return httpx.Response(
            200,
            json={
                "status": "1",
                "route": {
                    "paths": [
                        {
                            "distance": "1234",
                            "cost": {"duration": "300"},
                            "steps": [
                                {"polyline": "116.397,39.908;116.398,39.909"},
                                {"polyline": "116.398,39.909;116.400,39.910"},
                            ],
                        }
                    ]
                },
            },
        )

    result = run(
        _call_with_transport(
            handler,
            lambda amap: amap.route(
                Coordinate(lng=116.397, lat=39.908),
                Coordinate(lng=116.400, lat=39.910),
                "walking",
            ),
        )
    )

    assert seen["path"] == "/v5/direction/walking"
    assert seen["params"]["origin"] == "116.397000,39.908000"
    assert seen["params"]["destination"] == "116.400000,39.910000"
    assert "polyline" in seen["params"]["show_fields"]
    assert result.distance_m == 1234
    assert result.duration_minutes == 5.0

    expected_first = gcj02_to_wgs84(116.397, 39.908)
    assert result.geometry[0].lng == pytest.approx(expected_first[0], abs=1e-6)
    assert result.geometry[0].lat == pytest.approx(expected_first[1], abs=1e-6)
    # 相邻步骤的重复端点被去掉，不是把每一步都原样拼接。
    assert len(result.geometry) == 3


def test_driving_route_uses_driving_endpoint_and_v3_duration_fallback():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        return httpx.Response(
            200,
            json={
                "status": "1",
                "route": {
                    "paths": [
                        {
                            "distance": 5000,
                            "duration": "900",
                            "steps": [{"polyline": "116.397,39.908;116.470,39.950"}],
                        }
                    ]
                },
            },
        )

    result = run(
        _call_with_transport(
            handler,
            lambda amap: amap.route(
                Coordinate(lng=116.397, lat=39.908),
                Coordinate(lng=116.470, lat=39.950),
                "driving",
            ),
        )
    )

    assert seen["path"] == "/v5/direction/driving"
    assert result.distance_m == 5000
    assert result.duration_minutes == 15.0
    assert len(result.geometry) == 2


def test_route_without_polyline_raises_instead_of_faking_geometry():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "status": "1",
                "route": {"paths": [{"distance": "100", "cost": {"duration": "60"}}]},
            },
        )

    with pytest.raises(AMapError) as exc_info:
        run(
            _call_with_transport(
                handler,
                lambda amap: amap.route(
                    Coordinate(lng=116.397, lat=39.908),
                    Coordinate(lng=116.400, lat=39.910),
                    "walking",
                ),
            )
        )
    assert exc_info.value.code == "missing_polyline"


def test_route_reads_distance_from_cost_container_when_path_field_missing():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "status": "1",
                "route": {
                    "paths": [
                        {
                            "cost": {"duration": "120", "distance": "777"},
                            "steps": [{"polyline": "116.397,39.908;116.398,39.909"}],
                        }
                    ]
                },
            },
        )

    result = run(
        _call_with_transport(
            handler,
            lambda amap: amap.route(
                Coordinate(lng=116.397, lat=39.908),
                Coordinate(lng=116.398, lat=39.909),
                "walking",
            ),
        )
    )
    assert result.distance_m == 777
    assert result.duration_minutes == 2.0


def test_route_quota_error_is_reported_readably():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"status": "0", "info": "DAILY_QUERY_OVER_LIMIT", "infocode": "10003"},
        )

    with pytest.raises(AMapError) as exc_info:
        run(
            _call_with_transport(
                handler,
                lambda amap: amap.route(
                    Coordinate(lng=116.397, lat=39.908),
                    Coordinate(lng=116.400, lat=39.910),
                    "walking",
                ),
            )
        )
    assert exc_info.value.code == "10003"
    assert "DAILY_QUERY_OVER_LIMIT" in str(exc_info.value)


# ==================== POI 名称辨识性：不同门店/方位/航站楼不能当成同一处 ====================
#
# 之前括号会被整体归一化掉，如家酒店（西湖店）与（武林广场店）得满分、
# 杭州东站与杭州西站靠 difflib 拿到 0.75 也被接受，结果把用户指到另一家店。
# 这里用真实 AMapClient + MockTransport 固定行为：明确冲突必须拒绝，
# 而正常简称/同义名（灵隐寺 vs 灵隐禅寺）不能跟着回退。


def _poi_response(name, *, location="120.150000,30.260000", city="杭州市"):
    return {
        "name": name,
        "location": location,
        "cityname": city,
        "adname": "西湖区",
        "address": "测试路1号",
    }


def _search_poi_with(pois, keywords):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v3/place/text"
        return httpx.Response(200, json={"status": "1", "info": "OK", "pois": pois})

    return run(
        _call_with_transport(
            handler,
            lambda amap: amap.search_poi(keywords, city="杭州"),
        )
    )


def test_search_poi_rejects_same_brand_other_branch():
    """如家酒店（西湖店）不能匹配到武林广场店。"""

    pois = [_poi_response("如家酒店（武林广场店）")]
    with pytest.raises(AMapError) as exc_info:
        _search_poi_with(pois, "如家酒店（西湖店）")

    assert exc_info.value.code == "poi_mismatch"


def test_search_poi_accepts_same_branch_with_extra_suffix():
    """同一家店写成“西湖分店”只是措辞差异，不能误拒。"""

    pois = [_poi_response("如家酒店（西湖分店）")]
    result = _search_poi_with(pois, "如家酒店（西湖店）")

    assert result.name == "如家酒店（西湖分店）"
    assert result.location.lng == pytest.approx(120.150)
    assert result.location.lat == pytest.approx(30.260)


def test_search_poi_rejects_east_station_for_west_station():
    """杭州东站不能匹配到杭州西站（旧实现靠 0.75 的相似度放行）。"""

    pois = [_poi_response("杭州西站", location="120.030000,30.290000")]
    with pytest.raises(AMapError) as exc_info:
        _search_poi_with(pois, "杭州东站")

    assert exc_info.value.code == "poi_mismatch"


def test_search_poi_rejects_terminal_mismatch():
    """T1 与 T2 航站楼是不同点位；“1号航站楼”这类同义写法可以接受。"""

    with pytest.raises(AMapError) as exc_info:
        _search_poi_with([_poi_response("T2航站楼")], "T1航站楼")
    assert exc_info.value.code == "poi_mismatch"

    result = _search_poi_with([_poi_response("1号航站楼")], "T1航站楼")
    assert result.name == "1号航站楼"


def test_search_poi_accepts_common_abbreviation_and_alias():
    """正常简称/同义名不能被辨识性检查误伤。"""

    assert _search_poi_with([_poi_response("断桥")], "断桥残雪").name == "断桥"
    assert _search_poi_with([_poi_response("灵隐禅寺")], "灵隐寺").name == "灵隐禅寺"


def test_place_name_score_rejects_direction_and_branch_confusion():
    """名称分的下界：这些配对必须低于阈值，避免下游把错点当可信坐标。"""

    for query, candidate in (
        ("杭州东站", "杭州西站"),
        ("如家酒店（西湖店）", "如家酒店（武林广场店）"),
        ("T1航站楼", "T2航站楼"),
        # 用户点名了具体门店，候选没写门店 => 无法确认，同样不算可信。
        ("如家酒店（西湖店）", "如家酒店"),
        # 反方向：用户只说“杭州站”，候选写死了东站 => 也不能锁定具体点位。
        ("杭州站", "杭州东站"),
    ):
        score = _place_name_score(query, candidate)
        assert score < _POI_NAME_MATCH_MIN_SCORE, (
            f"{query!r} vs {candidate!r} 得到 {score}，会被当成可信匹配"
        )


def test_place_name_score_keeps_plain_aliases_above_threshold():
    """护栏：简称、同义名、景区后缀这些正常差异不能被判否。"""

    for query, candidate in (
        ("断桥残雪", "断桥"),
        ("灵隐寺", "灵隐禅寺"),
        ("西湖", "西湖风景区"),
        ("雷峰塔", "雷峰塔景区"),
        ("雷峰塔", "雷峰塔(售票处)"),
        ("颐和园", "颐和园(东宫门)"),
    ):
        score = _place_name_score(query, candidate)
        assert score >= _POI_NAME_MATCH_MIN_SCORE, (
            f"{query!r} vs {candidate!r} 只得 {score}，正常同义名被误杀"
        )


# ==================== POI 边界：门店后缀、入口、括号限定词 ====================


@pytest.mark.parametrize(
    ("query", "candidate", "should_match", "note"),
    [
        # “东直门店”是“东直门”+“店”，不能把“门”当门店后缀吞掉。
        ("全聚德（东直门店）", "全聚德(东直门分店)", True, "同店不同写法"),
        ("全聚德（东直门店）", "全聚德(东直门店)", True, "括号全半角差异"),
        # 同一景点的入口谨慎接受；两个不同入口之间仍然冲突。
        ("雷峰塔", "雷峰塔东门", True, "景点入口"),
        ("雷峰塔", "雷峰塔西门", True, "景点入口"),
        ("雷峰塔东门", "雷峰塔(东门)", True, "入口的括号写法"),
        ("雷峰塔东门", "雷峰塔西门", False, "不同入口"),
        ("雷峰塔东门", "雷峰塔(西门)", False, "不同入口"),
        # 括号里是城市限定词，候选全名已经包含它。
        ("西湖（杭州）", "杭州西湖风景名胜区", True, "括号限定词"),
        ("西湖（杭州市）", "杭州西湖风景名胜区", True, "限定词带行政区后缀"),
        ("西湖（杭州）", "杭州西溪湿地", False, "同名不同景点"),
        # 用户只说了品牌，候选锁定到具体分店：不能替用户认定。
        ("全聚德", "全聚德（王府井店）", False, "未指定分店"),
        # 同品牌不同门店。
        ("如家酒店（西湖店）", "如家酒店（西湖分店）", True, "同店不同写法"),
        ("如家酒店（西湖店）", "如家酒店（武林广场店）", False, "不同门店"),
        # 站点/航站楼不是入口，仍按硬冲突处理。
        ("杭州站", "杭州东站", False, "不同方位车站"),
        ("首都机场T1", "首都机场T2", False, "不同航站楼"),
        # 景点自带的补充说明不能被当成另一家门店。
        ("颐和园", "颐和园(东宫门)", True, "景点入口补充说明"),
    ],
)
def test_poi_name_score_boundary_table(query, candidate, should_match, note):
    score = _place_name_score(query, candidate)
    if should_match:
        assert score >= _POI_NAME_MATCH_MIN_SCORE, f"{note}: {query!r} vs {candidate!r} 得 {score}"
    else:
        assert score < _POI_NAME_MATCH_MIN_SCORE, f"{note}: {query!r} vs {candidate!r} 得 {score}"


def test_search_poi_accepts_store_branch_with_extra_suffix():
    """全聚德（东直门店）能匹配高德返回的全聚德(东直门分店)。"""

    result = _search_poi_with(
        [_poi_response("全聚德(东直门分店)")], "全聚德（东直门店）"
    )

    assert result.name == "全聚德(东直门分店)"
    assert result.location.lng == pytest.approx(120.150)


def test_search_poi_accepts_same_attraction_entrance():
    """搜索“雷峰塔”时，高德返回“雷峰塔东门”可以作为同一景点入口使用。"""

    result = _search_poi_with([_poi_response("雷峰塔东门")], "雷峰塔")

    assert result.name == "雷峰塔东门"


def test_search_poi_accepts_parenthetical_city_qualifier():
    """西湖（杭州）能匹配杭州西湖风景名胜区，括号限定词已在候选全名中。"""

    result = _search_poi_with([_poi_response("杭州西湖风景名胜区")], "西湖（杭州）")

    assert result.name == "杭州西湖风景名胜区"


def test_search_poi_does_not_invent_unspecified_branch():
    """用户只说“全聚德”，不能直接把王府井店当成确定位置。"""

    with pytest.raises(AMapError) as exc_info:
        _search_poi_with([_poi_response("全聚德（王府井店）")], "全聚德")

    assert exc_info.value.code == "poi_unconfirmed"
