# -*- coding: utf-8 -*-
"""地址地理编码路径的身份核对回归。

背景：``_resolve_stop`` 第 2 步把模型写的 ``stop.address`` 直接交给地理编码，
旧实现只在「用站点名称兜底」时才核对门店/入口/航站楼，于是输入地址或高德
返回地址里写着「另一家门店/另一个入口/另一个航站楼」时，错坐标照样进入
行程并发起导航。

本文件固定四类行为（全部离线，真实 AMapClient + httpx.MockTransport）：
1. ``stop.address`` 自身写了另一家门店/入口/航站楼 -> 拒绝该候选坐标，
   保留用户原地址，不请求路线；
2. ``provider.formatted_address`` 自行指到另一家门店 -> 同样拒绝（输入地址
   干净也要拒绝，说明核对的是返回地址而不是只对 query 做字符串检查）；
3. 没有任何门店/入口/航站楼标识的精确门牌仍然可信 fallback，不被误杀；
4. 拒绝只针对「矛盾候选」：正确的 POI 或名称地理编码结果仍是可靠替代路径。

不访问外网、不读 dotenv、不改任何既有测试预期。
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


COMPANION = {
    "name": "断桥残雪",
    "lng": 120.148000,
    "lat": 30.263000,
    "city": "杭州市",
    "district": "西湖区",
    "street": "北山街551号",
}

GCJ_LNG = 120.130000
GCJ_LAT = 30.274000
# 陪衬点用一套独立坐标，route 计数才有区分度。
COMPANION_LOCATION = f"{COMPANION['lng']:.6f},{COMPANION['lat']:.6f}"


def make_request(destination="杭州"):
    return TripPlanRequest(
        destination=destination,
        days=1,
        travelers=1,
        preferences="",
        travel_mode="walking",
    )


def make_payload(target_name, target_address, destination="杭州"):
    companion_address = (
        f"{COMPANION['city']}{COMPANION['district']}{COMPANION['street']}"
    )
    return {
        "title": "地址身份回归",
        "summary": "目标站点 + 可信陪衬点。",
        "days": [
            {
                "day": 1,
                "title": "第1天",
                "summary": "当天概述",
                "stops": [
                    {
                        "name": target_name,
                        "time": "09:00",
                        "address": target_address,
                        "duration_minutes": 60,
                    },
                    {
                        "name": COMPANION["name"],
                        "time": "10:30",
                        "address": companion_address,
                        "duration_minutes": 60,
                    },
                ],
            }
        ],
    }


def _geocode_body(formatted_address, *, location, level, city):
    return {
        "status": "1",
        "info": "OK",
        "geocodes": [
            {
                "formatted_address": formatted_address,
                "location": location,
                "level": level,
                "city": city,
            }
        ],
    }


def _build_trip(
    *,
    target_name,
    target_address,
    target_geo,
    target_geo_by_query=None,
    poi=None,
    destination="杭州",
    geo_location=f"{GCJ_LNG:.6f},{GCJ_LAT:.6f}",
    level="门牌号",
    city="杭州市",
):
    """跑一趟行程，返回 (trip, calls)。

    ``target_geo`` 是目标站点任意地理编码查询的默认返回地址；
    ``target_geo_by_query`` 可以按查询文字覆盖（用于「地址查询错、名称查询对」）。
    ``poi`` 非空时，目标站点的 POI 搜索返回该条结果。
    """

    calls = {"poi": [], "geo": [], "route": []}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        params = dict(request.url.params)
        if path == "/v3/place/text":
            keywords = params.get("keywords", "")
            calls["poi"].append(keywords)
            if poi is not None and keywords == target_name:
                return httpx.Response(
                    200, json={"status": "1", "info": "OK", "pois": [poi]}
                )
            if keywords == COMPANION["name"]:
                return httpx.Response(
                    200,
                    json={
                        "status": "1",
                        "info": "OK",
                        "pois": [
                            {
                                "name": COMPANION["name"],
                                "location": COMPANION_LOCATION,
                                "cityname": COMPANION["city"],
                                "adname": COMPANION["district"],
                                "address": COMPANION["street"],
                            }
                        ],
                    },
                )
            return httpx.Response(
                200, json={"status": "1", "info": "OK", "pois": []}
            )
        if path == "/v3/geocode/geo":
            query = params.get("address", "")
            calls["geo"].append(query)
            formatted = target_geo
            if target_geo_by_query and query in target_geo_by_query:
                formatted = target_geo_by_query[query]
            if not formatted:
                return httpx.Response(
                    200, json={"status": "1", "info": "OK", "geocodes": []}
                )
            return httpx.Response(
                200,
                json=_geocode_body(
                    formatted, location=geo_location, level=level, city=city
                ),
            )
        if path.startswith("/v5/direction/"):
            origin = params.get("origin", "")
            dest = params.get("destination", "")
            calls["route"].append((origin, dest))
            return httpx.Response(
                200,
                json={
                    "status": "1",
                    "info": "OK",
                    "route": {
                        "paths": [
                            {
                                "distance": "900",
                                "cost": {"duration": "600"},
                                "steps": [{"polyline": f"{origin};{dest}"}],
                            }
                        ]
                    },
                },
            )
        raise AssertionError(f"unexpected path {path}")

    transport = httpx.MockTransport(handler)

    async def build():
        async with httpx.AsyncClient(transport=transport) as http_client:
            amap = AMapClient("fixture-key", client=http_client)
            return await build_agent_trip(
                make_payload(target_name, target_address, destination),
                make_request(destination),
                amap,
            )

    return run(build()), calls


def _assert_rejected(trip, calls, original_address, *warning_fragments):
    target = trip.days[0].stops[0]
    companion = trip.days[0].stops[1]

    assert target.location is None, (
        f"矛盾候选的坐标不应进入行程：warnings={trip.warnings!r}"
    )
    # 没有可信坐标时，用户写的地址一字不改保留（不是清空，也不是写成别家店）。
    assert target.address == original_address
    # 没有可信坐标就不许请求路线，路段必须诚实降级。
    assert calls["route"] == [], "地点身份未确认时不应请求路线"
    assert trip.days[0].legs[0].route_type == "unavailable"
    # 陪衬点照常可信，说明拒绝只针对矛盾候选，而不是整趟降级。
    assert companion.location is not None

    joined = " ".join(trip.warnings)
    assert "无法通过高德获取可信坐标" in joined, joined
    for fragment in warning_fragments:
        assert fragment in joined, joined


def _assert_accepted(trip, calls, expected_address=None):
    target = trip.days[0].stops[0]
    companion = trip.days[0].stops[1]
    assert target.location is not None, (
        f"可信结果被误拒：warnings={trip.warnings!r}"
    )
    expected = gcj02_to_wgs84(GCJ_LNG, GCJ_LAT)
    assert target.location.lng == pytest.approx(expected[0], abs=1e-6)
    assert target.location.lat == pytest.approx(expected[1], abs=1e-6)
    if expected_address is not None:
        assert target.address == expected_address
    assert companion.location is not None
    # 两站都有坐标：恰好一条路线请求，且路段是真实导航。
    assert len(calls["route"]) == 1
    assert [leg.route_type for leg in trip.days[0].legs] == ["navigation"]


# ==================== 1. 输入地址自身写了另一家门店 ====================

ADDRESS_NEW_XIHU = "杭州市西湖区文三路100号如家酒店新西湖店"
ADDRESS_DA_XIHU = "杭州市西湖区文三路100号如家酒店大西湖店"


@pytest.mark.parametrize(
    ("target_name", "target_address", "wrong_variant"),
    [
        ("如家酒店（西湖店）", ADDRESS_NEW_XIHU, "新西湖"),
        # 无括号门店词：不能靠「西湖店」是「大西湖店」的子串就确认。
        ("如家酒店（西湖店）", ADDRESS_DA_XIHU, "大西湖"),
        # 无括号指定店名的查询同样要核对。
        ("如家酒店西湖店", ADDRESS_DA_XIHU, "大西湖"),
        # 不同品牌但同一个分店词：不是用户点名的门店。
        (
            "如家酒店（西湖店）",
            "杭州市西湖区文三路100号汉庭酒店（西湖店）",
            "汉庭",
        ),
    ],
    ids=[
        "paren-store-new-xihu",
        "paren-store-da-xihu",
        "no-paren-store-da-xihu",
        "other-brand-same-branch-word",
    ],
)
def test_input_address_naming_another_store_is_rejected(
    target_name, target_address, wrong_variant
):
    trip, calls = _build_trip(
        target_name=target_name,
        target_address=target_address,
        target_geo=target_address,
    )

    _assert_rejected(trip, calls, target_address, "门店/分店标识")

    # 原因里要写出地址实际写的门店词（含不同品牌），便于用户判断。
    assert wrong_variant in " ".join(trip.warnings)


def test_input_address_naming_another_entrance_is_rejected():
    address = "北京市东城区景山前街4号故宫博物院（神武门）"
    trip, calls = _build_trip(
        target_name="故宫博物院（午门）",
        target_address=address,
        target_geo=address,
        destination="北京",
        city="北京市",
    )

    _assert_rejected(trip, calls, address, "入口", "午门", "神武门")


def test_input_address_naming_another_terminal_is_rejected():
    address = "杭州市萧山区杭州萧山国际机场T2航站楼"
    trip, calls = _build_trip(
        target_name="杭州萧山国际机场T1航站楼",
        target_address=address,
        target_geo=address,
        level="兴趣点",
    )

    _assert_rejected(trip, calls, address, "航站楼")


def test_input_address_naming_another_direction_is_rejected():
    address = "杭州市余杭区杭州西站"
    trip, calls = _build_trip(
        target_name="杭州东站",
        target_address=address,
        target_geo=address,
        level="兴趣点",
    )

    _assert_rejected(trip, calls, address, "方位")


# ==================== 2. 返回地址自行指到另一家门店 ====================


def test_provider_address_alone_naming_another_store_is_rejected():
    """输入地址是干净门牌，但高德返回的 formatted_address 自带「新西湖店」。"""

    clean_address = "杭州市西湖区文三路100号"
    trip, calls = _build_trip(
        target_name="如家酒店（西湖店）",
        target_address=clean_address,
        target_geo="杭州市西湖区文三路100号如家酒店新西湖店",
    )

    # 地址确实进入了地理编码（不是没查就拒绝）。
    assert calls["geo"][0] == clean_address
    _assert_rejected(trip, calls, clean_address, "门店/分店标识", "新西湖")


def test_returned_address_contradiction_is_checked_independently_of_input():
    """同一条输入地址：返回地址干净就接受，返回地址写了别家店就拒绝。"""

    clean_address = "杭州市西湖区文三路100号"
    accepted, accepted_calls = _build_trip(
        target_name="如家酒店（西湖店）",
        target_address=clean_address,
        target_geo=clean_address,
    )
    _assert_accepted(accepted, accepted_calls, clean_address)

    rejected, rejected_calls = _build_trip(
        target_name="如家酒店（西湖店）",
        target_address=clean_address,
        target_geo="杭州市西湖区文三路100号如家酒店新西湖店",
    )
    _assert_rejected(rejected, rejected_calls, clean_address, "新西湖")


# ==================== 3. 纯门牌仍然可信 fallback ====================


def test_clean_door_address_without_identity_is_still_trusted():
    """没有任何门店/入口/航站楼标识的精确门牌不能一刀切禁止。"""

    address = "杭州市西湖区文三路100号"
    trip, calls = _build_trip(
        target_name="如家酒店（西湖店）",
        target_address=address,
        target_geo=address,
    )

    _assert_accepted(trip, calls, address)


def test_brand_only_address_without_branch_is_not_treated_as_conflict():
    """地址写了品牌但没写分店：只是「没证实」，不是矛盾，不能当冲突拒绝。"""

    address = "杭州市西湖区文三路100号如家酒店"
    trip, calls = _build_trip(
        target_name="如家酒店（西湖店）",
        target_address=address,
        target_geo=address,
    )

    _assert_accepted(trip, calls, address)


@pytest.mark.parametrize(
    ("target_name", "address"),
    [
        # 括号门店：地址写成“西湖分店”，只是措辞差异。
        ("如家酒店（西湖店）", "杭州市西湖区文三路100号如家酒店（西湖分店）"),
        # 地址带城市前缀、门店词无括号。
        ("如家酒店（西湖店）", "杭州市西湖区文三路100号杭州如家酒店西湖店"),
        # 无括号门店查询 + 地址原样写出同一家店。
        ("如家酒店西湖店", "杭州市西湖区文三路100号如家酒店西湖店"),
    ],
    ids=["paren-fen-dian", "city-prefix-no-paren", "no-paren-exact"],
)
def test_address_that_confirms_the_named_store_is_still_trusted(target_name, address):
    """真实同名门店的地址不能被新规则误拒。"""

    trip, calls = _build_trip(
        target_name=target_name,
        target_address=address,
        target_geo=address,
    )

    _assert_accepted(trip, calls, address)


# ==================== 4. 拒绝矛盾候选，但保留可靠替代路径 ====================


def test_correct_name_geocode_still_used_after_address_candidate_rejected():
    """地址候选被拒不能把名称地理编码一起禁用。"""

    clean_address = "杭州市西湖区文三路100号"
    trip, calls = _build_trip(
        target_name="如家酒店（西湖店）",
        target_address=clean_address,
        target_geo=clean_address,
        target_geo_by_query={
            clean_address: "杭州市西湖区文三路100号如家酒店新西湖店",
            "如家酒店（西湖店）": "杭州市西湖区文三路100号如家酒店（西湖店）",
        },
    )

    _assert_accepted(trip, calls, "杭州市西湖区文三路100号如家酒店（西湖店）")
    assert "无法通过高德获取可信坐标" not in " ".join(trip.warnings)


def test_incorrect_model_address_does_not_block_correct_name_geocode():
    """模型地址自己写错时，名称兜底拿到正确门店仍要采用。"""

    trip, calls = _build_trip(
        target_name="如家酒店（西湖店）",
        target_address=ADDRESS_NEW_XIHU,
        target_geo="杭州市西湖区文三路100号如家酒店（西湖店）",
    )

    _assert_accepted(trip, calls, "杭州市西湖区文三路100号如家酒店（西湖店）")
    # 矛盾地址没有发起地理编码，名称兜底独立拿到正确门店。
    assert calls["geo"] == ["如家酒店（西湖店）"]
    assert "无法通过高德获取可信坐标" not in " ".join(trip.warnings)


def test_correct_poi_is_still_used_when_model_address_conflicts():
    """真正匹配的 POI 已给出正确点位时，模型地址写错不能连坐这个 POI。"""

    trip, calls = _build_trip(
        target_name="如家酒店（西湖店）",
        target_address=ADDRESS_NEW_XIHU,
        target_geo=ADDRESS_NEW_XIHU,
        poi={
            "name": "如家酒店（西湖店）",
            "location": f"{GCJ_LNG:.6f},{GCJ_LAT:.6f}",
            "cityname": "杭州市",
            "adname": "西湖区",
            "address": "文三路100号",
        },
    )

    _assert_accepted(trip, calls)
    assert "无法通过高德获取可信坐标" not in " ".join(trip.warnings)


# ==================== 5. 别品牌别分店的完整门店不能当纯门牌放行 ====================
#
# 残留 P0：模型地址写「汉庭酒店武林广场店」而查询是「如家酒店（西湖店）」时，
# 品牌锚定和同名分店词两条核对都不命中，旧实现把这条地址当成“无矛盾纯门牌”
# 直接导航——这是已知可造成错店导航的洞。

ADDRESS_HANTING_WULIN = "杭州市下城区体育场路280号汉庭酒店武林广场店"
ADDRESS_HOMEINN_WULIN = "杭州市下城区体育场路280号如家酒店武林广场店"


def _assert_door_address_still_trusted(trip, calls, address):
    """含“店”字但并非另一门店的地址，不能被新结构判断误杀。"""

    _assert_accepted(trip, calls, address)
    assert "无法通过高德获取可信坐标" not in " ".join(trip.warnings)


@pytest.mark.parametrize(
    ("target_name", "target_address", "other_brand"),
    [
        # 括号点名门店 vs 别品牌别分店：品牌、core 都不相交。
        ("如家酒店（西湖店）", ADDRESS_HANTING_WULIN, "汉庭"),
        # 无括号门店查询同样要拦。
        ("如家酒店西湖店", ADDRESS_HANTING_WULIN, "汉庭"),
        # 反向：查汉庭武林广场店，地址写成别品牌同分店词。
        ("汉庭酒店（武林广场店）", ADDRESS_HOMEINN_WULIN, "如家"),
    ],
    ids=[
        "input-paren-vs-other-brand-branch",
        "input-no-paren-vs-other-brand-branch",
        "input-other-brand-same-branch-word",
    ],
)
def test_input_address_explicit_other_store_is_rejected(
    target_name, target_address, other_brand
):
    trip, calls = _build_trip(
        target_name=target_name,
        target_address=target_address,
        target_geo=target_address,
    )

    _assert_rejected(trip, calls, target_address, "门店/分店标识")
    if other_brand != "如家":
        # 同名 core 别品牌场景走“缺少品牌名→无法核对”既有路径，
        # 拒绝已成立（坐标不采用、不导航），但不要求原因里点出品牌字样。
        assert other_brand in " ".join(trip.warnings)


def test_input_address_brand_and_branch_both_different_is_rejected():
    """query 无括号、西湖店 vs 汉庭武林广场店：双不同必须报矛盾。"""

    trip, calls = _build_trip(
        target_name="如家酒店西湖店",
        target_address=ADDRESS_HANTING_WULIN,
        target_geo=ADDRESS_HANTING_WULIN,
    )

    _assert_rejected(trip, calls, ADDRESS_HANTING_WULIN, "汉庭", "武林广场")


def test_provider_address_alone_naming_other_brand_store_is_rejected():
    """输入纯门牌，但高德返回地址自行写到别品牌别分店：同样不能采用。"""

    clean_address = "杭州市下城区体育场路280号"
    trip, calls = _build_trip(
        target_name="如家酒店西湖店",
        target_address=clean_address,
        target_geo=ADDRESS_HANTING_WULIN,
    )

    # 地址确实进入了地理编码，拒绝的是返回地址自带的另一家门店。
    assert calls["geo"][0] == clean_address
    _assert_rejected(trip, calls, clean_address, "门店/分店标识", "汉庭", "武林广场")


@pytest.mark.parametrize(
    ("target_name", "address"),
    [
        # 行政地名带“店”字：店口镇是镇名，不是门店词。
        ("如家酒店（西湖店）", "浙江省诸暨市店口镇中央路5号"),
        # 村名带“店”字：王家店村某路5号是门牌，不能被当另一门店拒掉。
        ("如家酒店（西湖店）", "杭州市余杭区王家店村整理路5号"),
        # 同店别措辞（括号分店写法）是同一家的另一种写法，仍要放行。
        ("如家酒店西湖店", "杭州市下城区体育场路280号如家酒店西湖分店"),
    ],
    ids=["town-name-dian-kou", "village-wang-jia-dian", "same-store-paren-fen-dian"],
)
def test_addresses_without_other_store_remain_trusted(target_name, address):
    """新结构判断不能把含“店”字的行政/村名或同店别措辞误杀。"""

    trip, calls = _build_trip(
        target_name=target_name,
        target_address=address,
        target_geo=address,
    )

    _assert_door_address_still_trusted(trip, calls, address)


# ==================== 6. 裸门店词（无品牌/不足拆分长度）降级核对 ====================
#
# 地址写出“…280号武林店”这类没有品牌、商家段不足 4 字的完整门店词时，
# 旧实现当成“裸门店名可能是村镇名”直接放行并导航。与点名分店“西湖店”
# 明显不是同一家：不采用坐标，也不断言一定是别家店，只报“无法核对”。

ADDRESS_BARE_WULIN = "杭州市西湖区文三路280号武林店"


def test_bare_branch_word_in_input_address_is_not_navigated():
    """查询点名西湖店，地址却写“…280号武林店”：降级，不导航。"""

    trip, calls = _build_trip(
        target_name="如家酒店（西湖店）",
        target_address=ADDRESS_BARE_WULIN,
        target_geo=ADDRESS_BARE_WULIN,
    )

    _assert_rejected(trip, calls, ADDRESS_BARE_WULIN, "无法核对", "武林店")


def test_bare_branch_word_only_in_provider_address_is_rejected():
    """输入纯门牌，返回地址自己带“…280号武林店”：同样不能采用。"""

    clean_address = "杭州市西湖区文三路280号"
    trip, calls = _build_trip(
        target_name="如家酒店（西湖店）",
        target_address=clean_address,
        target_geo=ADDRESS_BARE_WULIN,
    )

    # 地址确实进入了地理编码，拒绝的是返回地址自带的裸门店词。
    assert calls["geo"][0] == clean_address
    _assert_rejected(trip, calls, clean_address, "无法核对", "武林店")


def test_bare_branch_word_does_not_block_correct_name_geocode():
    """裸门店词地址被降级后，名称兑底拿到正确门店仍要采用。"""

    trip, calls = _build_trip(
        target_name="如家酒店（西湖店）",
        target_address=ADDRESS_BARE_WULIN,
        target_geo=ADDRESS_BARE_WULIN,
        target_geo_by_query={
            "如家酒店（西湖店）": "杭州市西湖区文三路100号如家酒店（西湖店）",
        },
    )

    _assert_accepted(trip, calls, "杭州市西湖区文三路100号如家酒店（西湖店）")
    assert "无法通过高德获取可信坐标" not in " ".join(trip.warnings)


def test_named_store_address_still_trusted_for_wulin_branch():
    """查汉庭武林广场店、地址原样写出同一家的正向回归。"""

    trip, calls = _build_trip(
        target_name="汉庭酒店（武林广场店）",
        target_address=ADDRESS_HANTING_WULIN,
        target_geo=ADDRESS_HANTING_WULIN,
    )

    _assert_accepted(trip, calls, ADDRESS_HANTING_WULIN)
