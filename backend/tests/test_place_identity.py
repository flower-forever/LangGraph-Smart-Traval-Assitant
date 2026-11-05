# -*- coding: utf-8 -*-
"""地点身份识别回归：门店、行政注释、入口三类括号限定词必须区分开。

背景：站点名「如家酒店（西湖店）」的名称地理编码返回
「杭州市西湖区文三路100号如家酒店新西湖店」时，旧实现里的
「core+suffix 纯子串」和「_branch_mentioned 纯包含」把它当成
用户点名的「西湖店」确认通过，错店坐标混进行程且 navigation 无告警。

本文件固定四类行为：
1. 无括号错店地址（新西湖店/武林广场店）不能被「西湖店」确认；
2. 行政注释「西湖（杭州）」走可信门牌级 geocode 必须成功；
3. 候选同时含「西湖店」和「武林广场店」等多分店时保守拒绝；
4. 东西站/入口（午门、东门）身份确认不能被行政注释的修复放宽。

全部走真实 AMapClient + httpx.MockTransport，不访问外网。
"""

import asyncio

import httpx
import pytest

from travel_itinerary import (
    AMapClient,
    TripPlanRequest,
    build_agent_trip,
    gcj02_to_wgs84,
)


def run(coro):
    return asyncio.run(coro)


def make_request(**overrides):
    data = {
        "destination": "杭州",
        "days": 1,
        "travelers": 1,
        "preferences": "",
        "travel_mode": "walking",
    }
    data.update(overrides)
    return TripPlanRequest(**data)


def make_payload(stops):
    return {
        "title": "地点身份回归",
        "summary": "测试用行程。",
        "days": [
            {
                "day": 1,
                "title": "第1天",
                "summary": "当天概述",
                "stops": stops,
            }
        ],
    }


def stop(name, address="", time="09:00"):
    return {"name": name, "time": time, "address": address, "duration_minutes": 60}


def _geocode_body(formatted_address, location="120.130000,30.274000"):
    return {
        "status": "1",
        "info": "OK",
        "geocodes": [
            {
                "formatted_address": formatted_address,
                "location": location,
                "level": "门牌号",
                "city": "杭州市",
            }
        ],
    }


def _identity_handler(*, geocode_address, pois=None):
    """POI 搜索返回指定列表（默认空），名称地理编码返回指定地址。

    「断桥残雪」作为第二站固定返回自己的 POI 与门牌地址，避免 fixture 干扰；
    其余查询统一走指定的 geocode 地址。
    """

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        params = dict(request.url.params)
        if path == "/v3/place/text":
            keywords = params.get("keywords", "")
            if "断桥" in keywords:
                return httpx.Response(
                    200,
                    json={
                        "status": "1",
                        "info": "OK",
                        "pois": [
                            {
                                "name": "断桥残雪",
                                "location": "120.148000,30.263000",
                                "cityname": "杭州市",
                                "adname": "西湖区",
                                "address": "北山街551号",
                            }
                        ],
                    },
                )
            return httpx.Response(
                200, json={"status": "1", "info": "OK", "pois": pois or []}
            )
        if path == "/v3/geocode/geo":
            address = params.get("address", "")
            if "断桥" in address:
                return httpx.Response(
                    200,
                    json={
                        "status": "1",
                        "info": "OK",
                        "geocodes": [
                            {
                                "formatted_address": "杭州市西湖区北山街551号断桥残雪",
                                "location": "120.148000,30.263000",
                                "level": "门牌号",
                                "city": "杭州市",
                            }
                        ],
                    },
                )
            return httpx.Response(200, json=_geocode_body(geocode_address))
        raise AssertionError(f"unexpected path {path}")

    return handler


async def _build(geocode_address, stop_name, *, pois=None):
    transport = httpx.MockTransport(
        _identity_handler(geocode_address=geocode_address, pois=pois)
    )
    async with httpx.AsyncClient(transport=transport) as http_client:
        amap = AMapClient("fixture-key", client=http_client)
        return await build_agent_trip(
            make_payload([stop(stop_name), stop("断桥残雪", time="10:30")]),
            make_request(),
            amap,
        )


# ==================== 1. 无括号错店不能靠纯子串确认 ====================


@pytest.mark.parametrize(
    ("geocode_address", "poi_name"),
    [
        # 反例（handoff 第 4 节）：纯子串「西湖店」出现在「新西湖店」里。
        ("杭州市西湖区文三路100号如家酒店新西湖店", "如家酒店新西湖店"),
        # 分店词根不在中间而是在别处的同型反例。
        ("杭州市西湖区文三路100号如家酒店西湖新村店", None),
    ],
    ids=["new-xihu-no-paren", "xihu-xincun-no-paren"],
)
def test_no_paren_wrong_branch_not_confirmed_by_substring(geocode_address, poi_name):
    """地址/POI 里的「新西湖店」不能证明用户点名的是「西湖店」。"""

    pois = (
        [
            {
                "name": poi_name,
                "location": "120.135000,30.282000",
                "cityname": "杭州市",
                "adname": "西湖区",
                "address": "文三路100号",
            }
        ]
        if poi_name
        else None
    )
    trip = run(_build(geocode_address, "如家酒店（西湖店）", pois=pois))

    resolved = trip.days[0].stops[0]
    joined = " ".join(trip.warnings)
    assert resolved.location is None, (
        f"错店坐标不应进入行程：{geocode_address} / warnings={trip.warnings!r}"
    )
    assert resolved.address == ""
    assert "无法通过高德获取可信坐标" in joined
    # 没有可信坐标就不许请求路线，路段必须诚实降级。
    assert trip.days[0].legs[0].route_type == "unavailable"
    # POI 与地理编码两条路径都必须把失败归因到门店/方位标识。
    assert ("门店/方位标识" in joined) or ("门店/分店标识" in joined), joined


def test_no_paren_exact_branch_still_accepted():
    """正向：地址原样写出「西湖店」时必须照常确认，不能一刀切拒绝。"""

    trip = run(
        _build("杭州市西湖区文三路100号如家酒店西湖店", "如家酒店（西湖店）")
    )

    resolved = trip.days[0].stops[0]
    assert resolved.location is not None, trip.warnings
    expected = gcj02_to_wgs84(120.13, 30.274)
    assert resolved.location.lng == pytest.approx(expected[0], abs=1e-6)
    assert resolved.location.lat == pytest.approx(expected[1], abs=1e-6)


# ==================== 2. 行政注释「西湖（杭州）」不被当门店拒绝 ====================


def test_admin_annotation_parenthesis_is_not_treated_as_store_branch():
    """「西湖（杭州）」是行政区+城市注释，不是分店点名，可信门牌 geocode 应成功。"""

    trip = run(
        _build(
            "杭州市西湖区龙井路1号杭州西湖风景名胜区",
            "西湖（杭州）",
        )
    )

    resolved = trip.days[0].stops[0]
    joined = " ".join(trip.warnings)
    assert resolved.location is not None, (
        f"行政注释被误判成门店而拒绝：warnings={trip.warnings!r}"
    )
    expected = gcj02_to_wgs84(120.13, 30.274)
    assert resolved.location.lng == pytest.approx(expected[0], abs=1e-6)
    assert resolved.location.lat == pytest.approx(expected[1], abs=1e-6)
    assert "分店" not in joined, joined


# ==================== 3. 多分店矛盾保守拒绝 ====================


@pytest.mark.parametrize(
    ("stop_name", "geocode_address"),
    [
        # 查询只点名西湖店，地址却同时写西湖店+武林广场店：交集匹配会放行。
        ("如家酒店（西湖店）", "杭州市西湖区文三路100号如家酒店（西湖店）（武林广场店）"),
        # 反向：查询点名两家，地址只写了一家，同样是未锁定的多店候选。
        ("如家酒店（西湖店）（武林广场店）", "杭州市西湖区文三路100号如家酒店（西湖店）"),
    ],
    ids=["address-has-extra-branch", "query-has-extra-branch"],
)
def test_conflicting_multi_branch_candidates_are_rejected(stop_name, geocode_address):
    trip = run(_build(geocode_address, stop_name))

    resolved = trip.days[0].stops[0]
    joined = " ".join(trip.warnings)
    assert resolved.location is None, (
        f"多分店矛盾不应确认任何一家：{stop_name} vs {geocode_address}"
    )
    assert "门店/分店标识" in joined, joined


# ==================== 4. 入口身份确认不被放宽 ====================


# ==================== 5. 黑名单外前后缀变体（对抗复核新增） ====================
#
# 旧实现的 _BRANCH_IDENTITY_CHARS 是有限黑名单「新老东西南北分一二…号本总副」，
# 只挡得住「新西湖店」。这里固定真实反例：core 两侧出现任何未列入黑名单的字
# （大/湖滨/美丽/铺）或品牌不同，都不能把「西湖店」从错店名里抠出来确认。


@pytest.mark.parametrize(
    ("stop_name", "geocode_address", "poi_name"),
    [
        # 无括号查询 + POI 黑名单外前缀（修复前靠 difflib 0.8 误接受）。
        ("如家酒店西湖店", "", "如家酒店大西湖店"),
        ("如家酒店西湖店", "", "如家酒店湖滨西湖店"),
        ("如家酒店西湖店", "", "如家酒店美丽西湖店"),
        # 无括号查询 + POI 西湖店铺（「铺」字在黑名单外）。
        ("如家酒店西湖店", "", "如家酒店西湖店铺"),
        # 无括号查询 + POI 品牌不同但同店名。
        ("如家酒店西湖店", "", "汉庭酒店西湖店"),
        # 括号查询 + POI 黑名单外前缀。
        ("如家酒店（西湖店）", "", "如家酒店大西湖店"),
        ("如家酒店（西湖店）", "", "如家酒店湖滨西湖店"),
        ("如家酒店（西湖店）", "", "如家酒店西湖店铺"),
        # 括号查询 + 名称 geocode 黑名单外前缀。
        ("如家酒店（西湖店）", "杭州市西湖区文三路100号如家酒店大西湖店", None),
        ("如家酒店（西湖店）", "杭州市西湖区文三路100号如家酒店西湖店铺", None),
        # 无括号查询 + 名称 geocode 不含店名 / 错店（旧边界：无条件放行）。
        ("如家酒店西湖店", "杭州市西湖区文三路100号", None),
        ("如家酒店西湖店", "杭州市西湖区文三路100号如家酒店大西湖店", None),
    ],
    ids=[
        "no-paren-poi-da-xihu",
        "no-paren-poi-hubin-xihu",
        "no-paren-poi-meili-xihu",
        "no-paren-poi-xihu-pu",
        "no-paren-poi-other-brand",
        "paren-poi-da-xihu",
        "paren-poi-hubin-xihu",
        "paren-poi-xihu-pu",
        "paren-geocode-da-xihu",
        "paren-geocode-xihu-pu",
        "no-paren-geocode-no-branch",
        "no-paren-geocode-wrong-branch",
    ],
)
def test_blacklist_outside_branch_variants_rejected(stop_name, geocode_address, poi_name):
    """黑名单外的前后缀变体不能确认门店身份：坐标必须为 null 且不请求路线。"""

    pois = (
        [
            {
                "name": poi_name,
                "location": "120.135000,30.282000",
                "cityname": "杭州市",
                "adname": "西湖区",
                "address": "文三路100号",
            }
        ]
        if poi_name
        else None
    )
    trip = run(
        _build(geocode_address or "杭州市西湖区文三路100号如家酒店新西湖店", stop_name, pois=pois)
    )

    resolved = trip.days[0].stops[0]
    joined = " ".join(trip.warnings)
    assert resolved.location is None, (
        f"错店/未证实门店不应进入行程：{stop_name} / poi={poi_name} / geo={geocode_address}"
        f" / warnings={trip.warnings!r}"
    )
    assert resolved.address == ""
    assert "无法通过高德获取可信坐标" in joined
    assert trip.days[0].legs[0].route_type == "unavailable"
    assert ("门店/方位标识" in joined) or ("门店/分店标识" in joined), joined


@pytest.mark.parametrize(
    ("stop_name", "geocode_address", "poi_name"),
    [
        # 正向：无括号查询原样、带城市前缀、品牌后紧接西湖。
        ("如家酒店西湖店", "", "如家酒店西湖店"),
        ("如家酒店西湖店", "", "杭州如家酒店西湖店"),
        # 括号查询：换后缀写法、品牌含「西湖」也必须接受。
        ("如家酒店（西湖店）", "", "如家酒店西湖分店"),
        ("如家酒店（西湖店）", "", "如家酒店西湖旗舰店"),
        ("西湖人家（西湖店）", "", "西湖人家西湖店"),
        # 括号查询 + 名称 geocode 原样/带城市前缀。
        ("如家酒店（西湖店）", "杭州市西湖区文三路100号如家酒店西湖店", None),
        ("如家酒店（西湖店）", "杭州市西湖区文三路100号杭州如家酒店西湖店", None),
    ],
    ids=[
        "no-paren-poi-exact",
        "no-paren-poi-city-prefix",
        "paren-poi-fen-dian",
        "paren-poi-flagship",
        "paren-poi-brand-contains-xihu",
        "paren-geocode-exact",
        "paren-geocode-city-prefix",
    ],
)
def test_branch_identity_positives_still_accepted(stop_name, geocode_address, poi_name):
    """正向护栏：真实同名店不能被新规则误杀。"""

    pois = (
        [
            {
                "name": poi_name,
                "location": "120.130000,30.274000",
                "cityname": "杭州市",
                "adname": "西湖区",
                "address": "文三路100号",
            }
        ]
        if poi_name
        else None
    )
    trip = run(
        _build(geocode_address or "杭州市西湖区文三路100号", stop_name, pois=pois)
    )

    resolved = trip.days[0].stops[0]
    assert resolved.location is not None, (
        f"正确门店被误拒：{stop_name} / poi={poi_name} / warnings={trip.warnings!r}"
    )


# ==================== 6. 无括号方位/航站楼名称地理编码必须证实标识 ====================
#
# 旧边界：无括号查询（雷峰塔东门/首都机场T1）的名称地理编码完全跳过标识核对，
# 地址只写主体名（雷峰塔/首都机场）时仍给精准坐标，可能造成假导航。


@pytest.mark.parametrize(
    ("stop_name", "geocode_address", "should_confirm"),
    [
        ("雷峰塔东门", "杭州市西湖区南山路15号雷峰塔", False),
        ("雷峰塔东门", "杭州市西湖区南山路15号雷峰塔东门", True),
        ("首都机场T1", "北京市顺义区首都机场路1号首都机场", False),
        ("首都机场T1", "北京市顺义区首都机场路1号首都机场T1航站楼", True),
    ],
    ids=[
        "dongmen-not-confirmed",
        "dongmen-confirmed",
        "t1-not-confirmed",
        "t1-confirmed",
    ],
)
def test_no_paren_direction_terminal_name_geocode_identity(
    stop_name, geocode_address, should_confirm
):
    """无括号方位/航站楼查询的名称地理编码必须写出同一标识才算确认。"""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        params = dict(request.url.params)
        if path == "/v3/place/text":
            return httpx.Response(200, json={"status": "1", "info": "OK", "pois": []})
        if path == "/v3/geocode/geo":
            city = "北京市" if "首都机场" in stop_name else "杭州市"
            return httpx.Response(
                200,
                json={
                    "status": "1",
                    "info": "OK",
                    "geocodes": [
                        {
                            "formatted_address": geocode_address,
                            "location": "120.130000,30.274000",
                            "level": "门牌号",
                            "city": city,
                        }
                    ],
                },
            )
        raise AssertionError(f"unexpected path {path}")

    transport = httpx.MockTransport(handler)

    async def build():
        async with httpx.AsyncClient(transport=transport) as http_client:
            amap = AMapClient("fixture-key", client=http_client)
            destination = "北京" if "首都机场" in stop_name else "杭州"
            request = make_request(destination=destination)
            return await build_agent_trip(
                make_payload([stop(stop_name), stop("断桥残雪", time="10:30")]),
                request,
                amap,
            )

    trip = run(build())

    resolved = trip.days[0].stops[0]
    joined = " ".join(trip.warnings)
    if should_confirm:
        assert resolved.location is not None, trip.warnings
    else:
        assert resolved.location is None, (
            f"地址未写出标识却给了精准点：{stop_name} vs {geocode_address}"
        )
        assert "方位/航站楼标识" in joined, joined
        assert trip.days[0].legs[0].route_type == "unavailable"


def test_entrance_identity_still_requires_explicit_confirmation():
    """「午门」这类入口是独立点位：地址只有主体名时不能当作已确认。"""

    trip = run(
        _build(
            "北京市东城区景山前街4号故宫博物院",
            "故宫博物院（午门）",
        )
    )

    resolved = trip.days[0].stops[0]
    assert resolved.location is None, "入口未证实却给了坐标"
    assert "无法通过高德获取可信坐标" in " ".join(trip.warnings)
