# -*- coding: utf-8 -*-
"""六期 S4 城市导览：prompt 扩展、解析降级、易变事实防呆与请求契约不变。"""

import os

# 测试进程绝不读取仓库里可能存在的真实 .env（必须在 import api_server 之前设置）。
os.environ["PYTHON_DOTENV_DISABLED"] = "1"

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import api_server
from travel_itinerary import (
    TripPlan,
    TripPlanRequest,
    build_agent_prompt,
    normalize_agent_payload,
    stable_trip_id,
)


def make_request(**overrides):
    data = {
        "destination": "Hangzhou",
        "days": 2,
        "departure_date": "2026-05-01",
        "travelers": 2,
        "preferences": "quiet lake",
        "travel_mode": "walking",
    }
    data.update(overrides)
    return TripPlanRequest(**data)


def make_days(days=2):
    return [
        {
            "day": day_number,
            "title": f"Day {day_number}",
            "summary": "A day around the lake.",
            "stops": [
                {
                    "name": f"Stop {day_number}-1",
                    "time": "09:00",
                    "duration_minutes": 90,
                    "description": "Walk by the lake.",
                    "address": "West Lake, Hangzhou",
                },
                {
                    "name": f"Stop {day_number}-2",
                    "time": "11:00",
                    "duration_minutes": 60,
                    "description": "Tea break.",
                    "address": "West Lake, Hangzhou",
                },
            ],
        }
        for day_number in range(1, days + 1)
    ]


def make_payload(city_profile=None, days=2):
    payload = {
        "title": "Hangzhou slow trip",
        "summary": "Two days around West Lake.",
        "days": make_days(days),
    }
    if city_profile is not None:
        payload["cityProfile"] = city_profile
    return payload


def full_city_profile():
    return {
        "oneLineImpression": {"text": "A calm lake city", "source": "model_generated"},
        "suggestedDays": {"min": 2, "max": 4, "source": "model_generated"},
        "districts": [
            {
                "name": "West Lake",
                "summary": "Classic lake views",
                "attractions": ["Broken Bridge", "Su Causeway"],
                "source": "model_generated",
            },
            {
                "name": "Lingyin",
                "summary": "Temple in the hills",
                "attractions": ["Lingyin Temple"],
                "source": "model_generated",
            },
            {
                "name": "Hefang Street",
                "summary": "Local snacks",
                "attractions": ["Hefang Street", "Southern Song Imperial Street"],
                "source": "model_generated",
            },
        ],
        "seasonTips": {"text": "Spring is rainy; bring an umbrella", "source": "model_generated"},
        "classicList": [
            {
                "name": f"Classic {index + 1}",
                "reason": f"Reason {index + 1}",
                "source": "model_generated",
            }
            for index in range(10)
        ],
    }


# ==================== prompt ====================


def test_prompt_requests_optional_city_profile_and_forbids_volatile_facts():
    prompt = build_agent_prompt(make_request())

    assert "cityProfile" in prompt
    assert "model_generated" in prompt
    assert "oneLineImpression" in prompt
    assert "suggestedDays" in prompt
    assert "districts" in prompt
    assert "seasonTips" in prompt
    assert "classicList" in prompt
    assert "全部字段可选" in prompt
    assert "禁止输出营业时间、票价、预约政策" in prompt


# ==================== 解析 ====================


def test_full_city_profile_is_parsed_with_sources_and_limits():
    trip, _ = normalize_agent_payload(make_payload(full_city_profile()), make_request())
    profile = trip.cityProfile

    assert profile is not None
    assert profile.source == "model_generated"
    assert profile.oneLineImpression is not None
    assert profile.oneLineImpression.text == "A calm lake city"
    assert profile.oneLineImpression.source == "model_generated"
    assert profile.suggestedDays is not None
    assert (profile.suggestedDays.min, profile.suggestedDays.max) == (2, 4)
    assert profile.suggestedDays.source == "model_generated"
    assert profile.districts is not None and len(profile.districts) == 3
    assert profile.districts[0].attractions == ["Broken Bridge", "Su Causeway"]
    assert all(district.source == "model_generated" for district in profile.districts)
    assert profile.seasonTips is not None
    assert profile.seasonTips.text.startswith("Spring")
    assert profile.classicList is not None and len(profile.classicList) == 10
    assert profile.classicList[0].name == "Classic 1"
    assert all(item.source == "model_generated" for item in profile.classicList)


def test_missing_city_profile_keeps_old_trip_contract():
    trip, _ = normalize_agent_payload(make_payload(), make_request())

    assert trip.cityProfile is None
    assert len(trip.days) == 2
    # 旧 JSON（没有 cityProfile）仍然能重建 TripPlan。
    restored = TripPlan.model_validate(json.loads(trip.model_dump_json()))
    assert restored.cityProfile is None


def test_partial_city_profile_keeps_only_present_blocks():
    trip, _ = normalize_agent_payload(
        make_payload(
            {
                "oneLineImpression": "Only an impression",
                "classicList": [{"name": "Classic A", "reason": "Because"}],
            }
        ),
        make_request(),
    )
    profile = trip.cityProfile

    assert profile is not None
    assert profile.oneLineImpression is not None
    assert profile.oneLineImpression.text == "Only an impression"
    assert profile.suggestedDays is None
    assert profile.districts is None
    assert profile.seasonTips is None
    assert profile.classicList is not None and len(profile.classicList) == 1


def test_city_profile_outside_trip_wrapper_is_tolerated():
    payload = {"trip": make_payload(), "cityProfile": {"oneLineImpression": "Wrapped"}}
    trip, _ = normalize_agent_payload(payload, make_request())

    assert trip.cityProfile is not None
    assert trip.cityProfile.oneLineImpression is not None
    assert trip.cityProfile.oneLineImpression.text == "Wrapped"


def test_malformed_blocks_are_dropped_without_failing_the_trip():
    trip, _ = normalize_agent_payload(
        make_payload(
            {
                "oneLineImpression": {"text": "   "},
                "suggestedDays": {"min": 5, "max": 2},
                "districts": "not-a-list",
                "seasonTips": 42,
                "classicList": [
                    {"name": "Classic A", "reason": "kept"},
                    {"name": "Classic A", "reason": "duplicate"},
                    "junk",
                ],
            }
        ),
        make_request(),
    )
    profile = trip.cityProfile

    assert len(trip.days) == 2
    assert profile is not None
    assert profile.oneLineImpression is None
    assert profile.suggestedDays is None
    assert profile.districts is None
    assert profile.seasonTips is None
    assert profile.classicList is not None
    assert [item.name for item in profile.classicList] == ["Classic A"]


def test_empty_city_profile_is_omitted_entirely():
    trip, _ = normalize_agent_payload(
        make_payload({"districts": [], "classicList": []}), make_request()
    )
    assert trip.cityProfile is None


def test_city_profile_truncates_counts_and_overrides_untrusted_source():
    profile_payload = {
        "oneLineImpression": {"text": "Safe", "source": "human"},
        "districts": [
            {
                "name": f"District {index + 1}",
                "summary": "Safe summary",
                "attractions": ["A", "B", "C", "D"],
                "source": "human",
            }
            for index in range(8)
        ],
        "classicList": [
            {
                "name": f"Classic {index + 1}",
                "reason": "Safe reason",
                "source": "human",
            }
            for index in range(20)
        ],
    }
    trip, _ = normalize_agent_payload(make_payload(profile_payload), make_request())
    profile = trip.cityProfile

    assert profile is not None
    assert profile.source == "model_generated"
    assert profile.oneLineImpression is not None
    assert profile.oneLineImpression.source == "model_generated"
    assert profile.districts is not None and len(profile.districts) == 6
    assert profile.districts[0].attractions == ["A", "B", "C"]
    assert all(district.source == "model_generated" for district in profile.districts)
    assert profile.classicList is not None and len(profile.classicList) == 15
    assert all(item.source == "model_generated" for item in profile.classicList)


# ==================== 易变事实防呆 ====================


def test_volatile_facts_are_stripped_and_flagged():
    trip, _ = normalize_agent_payload(
        make_payload(
            {
                "oneLineImpression": {"text": "A city worth a slow walk"},
                "districts": [
                    {
                        "name": "West Lake",
                        "summary": "Open 09:00-17:00 daily",
                        "attractions": ["Broken Bridge"],
                    },
                    {
                        "name": "Museum",
                        "summary": "需预约",
                        "attractions": ["Gallery"],
                    },
                ],
                "seasonTips": {"text": "门票 60 元"},
                "classicList": [
                    {"name": "West Lake", "reason": "Classic view"},
                    {"name": "Museum", "reason": "票价 30 元"},
                    {"name": "Ticket Office", "reason": "Safe reason"},
                ],
            }
        ),
        make_request(),
    )
    profile = trip.cityProfile

    assert profile is not None
    assert profile.oneLineImpression is not None
    assert profile.oneLineImpression.text == "A city worth a slow walk"
    assert profile.seasonTips is None
    assert profile.districts is not None
    assert [district.name for district in profile.districts] == ["West Lake", "Museum"]
    assert profile.districts[0].summary == ""
    assert profile.districts[1].summary == ""
    assert profile.classicList is not None
    # 名称本身含易变词的条目整条丢弃；理由含易变词的条目保留名称、省略理由。
    assert [item.name for item in profile.classicList] == ["West Lake", "Museum"]
    assert profile.classicList[1].reason == ""
    assert any("易变信息" in warning for warning in trip.warnings)

    dumped = profile.model_dump_json()
    for pattern in ("营业时间", "开放时间", "09:00", "17:00", "门票", "60 元", "票价", "30 元", "需预约"):
        assert pattern not in dumped


@pytest.mark.parametrize(
    "text",
    [
        # 预约变体（不只是「需预约 / 免预约」）
        "参观需要预约",
        "建议提前预约参观",
        # 预订变体
        "需预订",
        "预订电话 12345678",
        # 全角冒号 + 全角波浪线时间区间
        "08：30～18：00",
        # 12 小时制英文区间
        "9am-6pm",
        # 英文营业日
        "open on monday",
        # 中文数字金额
        "一百元",
        # 本轮 16 个构件级变体（验收员矩阵，全部增钉）
        "门票约五十块",
        "周一下午两点开馆",
        "建议网上预约购票",
        "周一到周五 8:30-17:00",
        "须提前一天订票",
        "早上八点半开门迎客",
        "每日 10 点至 18 点开放",
        "人均三十八块",
        "全价 88 元，学生半价",
        "团体需提前预约导览",
        "开放日：节假日除外",
        "周一下午休馆",
        "晚上七点后停止入场",
        "凭身份证免费领取导览册",
        "十六点半闭馆",
        "需要购票才能进入",
        # V6 第三轮 10 条真实漏网句
        "深夜八点之后不再接待",
        "9 点之后不再接待团队",
        "十点之后停止安检",
        "需要身份证原件",
        "身份证查验后才能入场",
        "扫码入场",
        "请携带有效证件",
        "9 till 5",
        "10 to 6",
        "closed on public holidays",
        # S5 返修：24 小时「开放」搭配 / 英文星期复数（与 S5 深度文本共用同一正则）
        "园区 24 小时开放",
        "24小时开放",
        "closed on Mondays",
        "open on Mondays",
        "closed on Sundays",
    ],
)
def test_volatile_variants_are_filtered(text):
    trip, _ = normalize_agent_payload(
        make_payload({"oneLineImpression": {"text": text}}), make_request()
    )

    assert trip.cityProfile is None
    assert any("易变信息" in warning for warning in trip.warnings)


@pytest.mark.parametrize(
    "text",
    [
        # V6 8 类新构件变体各一例
        "正午十二点开馆",
        "8 点之后",
        "10 until 6",
        "public holiday",
        "请携带证件",
        "刷脸入园",
        "核验有效证件",
        "08~18",
    ],
)
def test_v6_component_variants_are_filtered(text):
    trip, _ = normalize_agent_payload(
        make_payload({"oneLineImpression": {"text": text}}), make_request()
    )

    assert trip.cityProfile is None
    assert any("易变信息" in warning for warning in trip.warnings)


@pytest.mark.parametrize(
    "text",
    [
        # V8 第四轮 36 条残余 + 会员卡 200 元
        "membership required",
        "需购买会员卡才能入园",
        "am 9 to pm 5",
        "夜市从六点开张",
        "码头五点收摊",
        "需要实名登记才能入园",
        "入场需核销二维码",
        "持年卡可无限次入园",
        "closed on Mid-Autumn Festival",
        "七点夜市才开张",
        "开张",
        "关张",
        "收摊",
        "开摊",
        "闭摊",
        "开闸",
        "闭闸",
        "封馆",
        "闭门谢客",
        "停止接待",
        "暂停接待",
        "取消当日开放",
        "需实名",
        "实名登记",
        "核销",
        "换票",
        "annual pass required",
        "season pass required",
        "entry permit required",
        "pass required",
        "需持卡入场",
        "通行证要求",
        "membership fee 30",
        "年费 1200",
        "am 10 to pm 8",
        "pm 2 to pm 6",
        "会员卡 200 元",
    ],
)
def test_v8_residual_variants_are_filtered(text):
    trip, _ = normalize_agent_payload(
        make_payload({"oneLineImpression": {"text": text}}), make_request()
    )

    assert trip.cityProfile is None
    assert any("易变信息" in warning for warning in trip.warnings)


@pytest.mark.parametrize(
    "text",
    [
        # 售罄族 19
        "sold out 快",
        "sold out",
        "tickets sold out",
        "sell out fast",
        "sells out quickly",
        "tickets are selling fast",
        "tickets often sell out",
        "no tickets available",
        "售罄",
        "门票已售罄",
        "当日票已售完",
        "售完",
        "售光",
        "余票紧张",
        "票源紧张",
        "通常很快售罄",
        "票很快卖完",
        "早场已售光",
        "下午场售完",
        # 附加费族 14
        "旺季加收",
        "旺季溢价",
        "旺季票价上浮",
        "旺季加价",
        "节假日加收",
        "节假日加价",
        "加收附加费",
        "另收附加费",
        "surcharge applies",
        "peak season surcharge",
        "peak-season rates higher",
        "附加费 20 元",
        "另加 30 元服务费",
        "旺季价格上浮两成",
        # 支付方式族 13
        "card only",
        "cards only",
        "credit card only",
        "only cash accepted",
        "cash only",
        "仅收现金",
        "只接受现金",
        "只支持刷卡",
        "仅限刷卡",
        "仅接受银行卡",
        "需刷卡入场",
        "会员卡才可入园",
        "只对持卡人开放",
        # 核验入场族 16
        "需实名",
        "实名登记",
        "实名核验",
        "刷脸入园",
        "刷证入园",
        "指纹入场",
        "人脸识别入场",
        "门禁",
        "闸机入场",
        "按号入场",
        "凭号入场",
        "扫码核销",
        "电子票核销",
        "ID check required",
        "passport check",
        "fingerprint entry",
        # 验收员点名的核验/限流样例
        "凭学生证半价",
        "限流预约",
    ],
)
def test_v9_family_variants_are_filtered(text):
    trip, _ = normalize_agent_payload(
        make_payload({"oneLineImpression": {"text": text}}), make_request()
    )

    assert trip.cityProfile is None
    assert any("易变信息" in warning for warning in trip.warnings)


@pytest.mark.parametrize(
    "text",
    [
        # 第六轮 65 条兄弟词样本（V10 收口）
        "早场票不再补售",
        "夜场票停售",
        "停止补售",
        "余票停售",
        "不再售卖当日票",
        "现场无票可补",
        "夜场票只在现场发售",
        "须现场购买",
        "仅现场有售",
        "只在现场售出",
        "现场才能买到",
        "团体票需要整团一起购买",
        "团体票须整团购买",
        "十人成团方可购团体票",
        "团体票不可拆分",
        "散客票需单人购买",
        "团队票须一次购买十张",
        "团体票需统一开票",
        "内部整修，暂停对外开放",
        "整修中暂不开放",
        "翻修期间不开放",
        "设备保养期间不开放",
        "维护期间闭馆",
        "维修期间停止开放",
        "整修中暂停接待",
        "the site shuts down for maintenance in December",
        "under maintenance until further notice",
        "suspended for maintenance",
        "maintenance shutdown in April",
        "site shut for maintenance work",
        "seasonal shut down in winter",
        "seasonal shutdown each autumn",
        "目前处于试营业阶段",
        "部分区域尚未开放",
        "尚未正式对外开放",
        "新馆尚未对外开放",
        "每日接待量上限为八百人",
        "每日限流八百人",
        "每日期限八百人",
        "每天接待上限八百人",
        "每日最多接待八百人",
        "每日入园上限八百人",
        "visitors must carry printed ID",
        "must bring photo ID",
        "carry original ID",
        "visitors need printed ID",
        "bring printed identification",
        "need a physical ID",
        "不支持电子证件",
        "电子证件不可用",
        "仅接受实体证件",
        "二寸白底照片",
        "证件照需近三个月内拍摄",
        "需交两寸免冠照",
        "照片规格为一寸",
        "散客与团队需分两个入口",
        "散客团队分设入口",
        "团队走专用入口",
        "散客与团队分开入场",
        "需按散客团队分流",
        "散客入口在东，团队入口在西",
        "团体请走团队通道",
        "散客与团体分别排队",
        "两个入口分别对应散客和团队",
        "分流通道按团队或散客区分",
    ],
)
def test_v10_sibling_variants_are_filtered(text):
    trip, _ = normalize_agent_payload(
        make_payload({"oneLineImpression": {"text": text}}), make_request()
    )

    assert trip.cityProfile is None
    assert any("易变信息" in warning for warning in trip.warnings)

@pytest.mark.parametrize(
    "text",
    [
        # 第六轮 13 子槽位代表性样本
        "当日票已售完",
        "线上购票",
        "团购票",
        "整修中暂停开放",
        "closed for maintenance",
        "尚未正式对外开放",
        "每日限额 500 人",
        "只对持卡人开放",
        "ID check required",
        "仅接受实体证件",
        "二寸白底照片",
        "团体需配备领队",
        "需购买人身意外险",
    ],
)
def test_v10_subslot_samples_are_filtered(text):
    trip, _ = normalize_agent_payload(
        make_payload({"oneLineImpression": {"text": text}}), make_request()
    )

    assert trip.cityProfile is None
    assert any("易变信息" in warning for warning in trip.warnings)

@pytest.mark.parametrize(
    "text",
    [
        # V10 原补丁在 130 条中残余的 4 条兄弟词
        "现场有售",
        "现场可购",
        "每日承载量八百人",
        "show original ID",
    ],
)
def test_v10_gap_variants_are_filtered(text):
    trip, _ = normalize_agent_payload(
        make_payload({"oneLineImpression": {"text": text}}), make_request()
    )

    assert trip.cityProfile is None
    assert any("易变信息" in warning for warning in trip.warnings)

@pytest.mark.parametrize(
    "text",
    [
        "A calm lake city",
        "春季多雨，带伞",
        "适合慢游的老城",
        "傍晚光线最好",
        "片区可步行串联",
        # 草地/礁石等正常量词「块」不得当金额误杀
        "一块开阔的草地",
        "三块礁石",
        "两块大石头",
        # 「点/时」非时间用法
        "给你两点建议",
        "多留一点时间",
        "一时半会走不完",
        # 开闭馆/迎客类固定词的非营业语义
        "这里开门见山，视野开阔",
        "黄山迎客松是经典景观",
        # 含「元/角」的地名不得当金额误杀
        "一元路的老街",
        "五角场的夜市",
        # V6 0 误杀：裸区间数量表达 / 早一点 / 周末两点建议
        "5-10 人",
        "8-10 米高",
        "5 to 10 people",
        "8 to 10 meters",
        "早一点出发",
        "晚一点回酒店",
        "周末两点建议",
        # V9 service charge/cover charge 负向断言的 is/are 形态
        "service charge is rare",
        "service charges are rare",
        "cover charge is rare",
        "service charge is uncommon",
        "service charge 不常见",
        # S5 返修：24 小时搭配「热水供应」等非营业语境不得误杀
        "24 小时热水供应",
    ],
)
def test_safe_city_profile_text_is_not_over_filtered(text):
    trip, _ = normalize_agent_payload(
        make_payload({"oneLineImpression": {"text": text}}), make_request()
    )

    assert trip.cityProfile is not None
    assert trip.cityProfile.oneLineImpression is not None
    assert trip.cityProfile.oneLineImpression.text == text


# ==================== 请求契约不变 ====================


def test_request_contract_and_stable_trip_id_are_unchanged():
    request = make_request()

    assert "cityProfile" not in TripPlanRequest.model_fields
    assert stable_trip_id(request) == "trip-agent-f21d434412f1"
    assert json.dumps(request.model_dump(), ensure_ascii=True, sort_keys=True) == (
        '{"constraints": null, "days": 2, "departure_date": "2026-05-01", '
        '"destination": "Hangzhou", "interests": [], "pace": "balanced", '
        '"preferences": "quiet lake", "travel_mode": "walking", "travelers": 2}'
    )


# ==================== API 响应 ====================


class FakePlanner:
    def __init__(self, content):
        self.content = content
        self.calls = []

    async def ainvoke(self, payload, config=None):
        self.calls.append((payload, config))
        return {"messages": [SimpleNamespace(content=self.content)]}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(api_server.cfg, "api_key", None)
    monkeypatch.setattr(api_server.cfg, "amap_api_key", None)
    monkeypatch.setattr(api_server, "agent", None)
    monkeypatch.setattr(api_server, "planner_agent", None)
    monkeypatch.setattr(api_server, "mcp_client", None)
    monkeypatch.setattr(api_server, "available_tools", [])
    with TestClient(api_server.app) as test_client:
        yield test_client


def test_plan_response_exposes_city_profile(client):
    api_server.planner_agent = FakePlanner(
        json.dumps(make_payload(full_city_profile()), ensure_ascii=False)
    )
    response = client.post(
        "/api/trips/plan",
        json={
            "destination": "Hangzhou",
            "days": 2,
            "departure_date": "2026-05-01",
            "travelers": 2,
            "preferences": "quiet lake",
            "travel_mode": "walking",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == stable_trip_id(make_request())
    assert body["cityProfile"]["source"] == "model_generated"
    assert body["cityProfile"]["oneLineImpression"]["text"] == "A calm lake city"
    assert body["cityProfile"]["suggestedDays"] == {
        "min": 2,
        "max": 4,
        "source": "model_generated",
    }
    assert len(body["cityProfile"]["classicList"]) == 10
    assert body["cityProfile"]["classicList"][0]["source"] == "model_generated"


def test_plan_response_without_city_profile_stays_readable(client):
    api_server.planner_agent = FakePlanner(
        json.dumps(make_payload(), ensure_ascii=False)
    )
    response = client.post(
        "/api/trips/plan",
        json={
            "destination": "Hangzhou",
            "days": 2,
            "departure_date": "2026-05-01",
            "travelers": 2,
            "preferences": "quiet lake",
            "travel_mode": "walking",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["cityProfile"] is None
    assert len(body["days"]) == 2
