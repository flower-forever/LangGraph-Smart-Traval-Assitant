# -*- coding: utf-8 -*-
"""六期 S5 景点深度卡：prompt 扩展、深度块解析降级、易变事实防呆与请求契约不变。"""

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


def make_stop(index=1, depth=None, **overrides):
    stop = {
        "name": f"Stop {index}",
        "time": "09:00",
        "duration_minutes": 90,
        "description": "Walk by the lake.",
        "address": "West Lake, Hangzhou",
    }
    if depth is not None:
        stop.update(depth)
    stop.update(overrides)
    return stop


def make_payload(stops, days=1):
    return {
        "title": "Hangzhou slow trip",
        "summary": "One day around West Lake.",
        "days": [
            {
                "day": day_number,
                "title": f"Day {day_number}",
                "summary": "A day around the lake.",
                "stops": stops if day_number == 1 else [make_stop(day_number)],
            }
            for day_number in range(1, days + 1)
        ],
    }


def full_depth():
    return {
        "highlights": {
            "items": ["湖面开阔，长堤一线", "春晓时分光线柔和"],
            "source": "model_generated",
        },
        "suitableFor": {"tags": ["nature", "photo"], "source": "model_generated"},
        "suggestedStayMinutes": {"min": 60, "max": 90, "source": "model_generated"},
        "tips": {"items": ["清晨与傍晚人少", "沿堤可步行串联北山街"], "source": "model_generated"},
    }


# ==================== prompt ====================


def test_prompt_requests_optional_stop_depth_and_forbids_volatile_facts():
    prompt = build_agent_prompt(make_request())

    for field in ("highlights", "suitableFor", "suggestedStayMinutes", "tips"):
        assert field in prompt
    assert "history / food / nature / photo / family / elder_friendly" in prompt
    assert "全部可选" in prompt
    assert "禁止输出营业时间、票价、预约政策" in prompt
    assert "稳定知识" in prompt


# ==================== 解析 ====================


def test_full_depth_blocks_are_parsed_with_sources():
    trip, _ = normalize_agent_payload(make_payload([make_stop(depth=full_depth())]), make_request())
    stop = trip.days[0].stops[0]

    assert stop.highlights is not None
    assert stop.highlights.items == ["湖面开阔，长堤一线", "春晓时分光线柔和"]
    assert stop.highlights.source == "model_generated"
    assert stop.suitableFor is not None
    assert stop.suitableFor.tags == ["nature", "photo"]
    assert stop.suitableFor.source == "model_generated"
    assert stop.suggestedStayMinutes is not None
    assert (stop.suggestedStayMinutes.min, stop.suggestedStayMinutes.max) == (60, 90)
    assert stop.suggestedStayMinutes.source == "model_generated"
    assert stop.tips is not None
    assert stop.tips.items == ["清晨与傍晚人少", "沿堤可步行串联北山街"]
    assert stop.tips.source == "model_generated"


def test_missing_depth_keeps_old_trip_contract():
    trip, _ = normalize_agent_payload(make_payload([make_stop()]), make_request())
    stop = trip.days[0].stops[0]

    assert stop.highlights is None
    assert stop.suitableFor is None
    assert stop.suggestedStayMinutes is None
    assert stop.tips is None
    # 旧 JSON（没有深度字段）仍然能重建 TripPlan。
    restored = TripPlan.model_validate(json.loads(trip.model_dump_json()))
    old_stop = restored.days[0].stops[0]
    assert old_stop.highlights is None and old_stop.tips is None


def test_partial_depth_keeps_only_present_blocks():
    trip, _ = normalize_agent_payload(
        make_payload(
            [
                make_stop(
                    highlights={"items": ["只有看点"]},
                    suggestedStayMinutes={"min": 30, "max": 45},
                )
            ]
        ),
        make_request(),
    )
    stop = trip.days[0].stops[0]

    assert stop.highlights is not None
    assert stop.highlights.items == ["只有看点"]
    assert stop.suggestedStayMinutes is not None
    assert (stop.suggestedStayMinutes.min, stop.suggestedStayMinutes.max) == (30, 45)
    assert stop.suitableFor is None
    assert stop.tips is None


def test_bare_arrays_and_chinese_tags_are_tolerated():
    trip, _ = normalize_agent_payload(
        make_payload(
            [
                make_stop(
                    highlights=["裸数组看点"],
                    suitableFor=["历史", "老人友好", "unknown-tag"],
                    tips=({"items": ["裸对象里的数组"]}),
                )
            ]
        ),
        make_request(),
    )
    stop = trip.days[0].stops[0]

    assert stop.highlights is not None and stop.highlights.items == ["裸数组看点"]
    assert stop.suitableFor is not None and stop.suitableFor.tags == ["history", "elder_friendly"]
    assert stop.tips is not None and stop.tips.items == ["裸对象里的数组"]


def test_malformed_depth_blocks_are_dropped_without_failing_the_trip():
    trip, _ = normalize_agent_payload(
        make_payload(
            [
                make_stop(
                    highlights={"items": []},
                    suitableFor={"tags": ["not-a-tag", 42]},
                    suggestedStayMinutes={"min": 90, "max": 30},
                    tips="not-a-list",
                )
            ]
        ),
        make_request(),
    )
    stop = trip.days[0].stops[0]

    assert len(trip.days[0].stops) == 1
    assert stop.highlights is None
    assert stop.suitableFor is None
    assert stop.suggestedStayMinutes is None
    assert stop.tips is None


def test_depth_truncates_counts_and_overrides_untrusted_source():
    depth = {
        "highlights": {"items": ["A", "B", "C", "D", "E"], "source": "human"},
        "suitableFor": {
            "tags": ["history", "food", "nature", "photo", "family", "elder_friendly"],
            "source": "human",
        },
        "suggestedStayMinutes": {"min": 15, "max": 30, "source": "human"},
        "tips": {"items": ["T1", "T2", "T3", "T4"], "source": "human"},
    }
    trip, _ = normalize_agent_payload(make_payload([make_stop(depth=depth)]), make_request())
    stop = trip.days[0].stops[0]

    assert stop.highlights is not None
    assert stop.highlights.items == ["A", "B", "C"]
    assert stop.highlights.source == "model_generated"
    assert stop.suitableFor is not None
    assert stop.suitableFor.tags == ["history", "food", "nature", "photo", "family", "elder_friendly"]
    assert stop.suitableFor.source == "model_generated"
    assert stop.tips is not None
    assert stop.tips.items == ["T1", "T2", "T3"]
    assert stop.tips.source == "model_generated"
    assert stop.suggestedStayMinutes is not None
    assert stop.suggestedStayMinutes.source == "model_generated"


# ==================== 易变事实防呆 ====================


@pytest.mark.parametrize(
    "text",
    [
        "营业时间 09:00-17:00",
        "门票 60 元",
        "需提前预约",
        "周一闭馆",
        "旺季加收 30 元",
        "凭身份证入场",
        # S5 返修：24 小时「开放」搭配 / 英文星期复数（S4 共用正则同缺口）
        "园区 24 小时开放",
        "24小时开放",
        "closed on Mondays",
        "open on Mondays",
        "closed on Sundays",
    ],
)
def test_volatile_depth_text_is_stripped_and_flagged(text):
    trip, _ = normalize_agent_payload(
        make_payload(
            [
                make_stop(
                    highlights={"items": ["稳妥看点", text]},
                    suitableFor={"tags": ["history"]},
                    suggestedStayMinutes={"min": 60, "max": 90},
                    tips={"items": [text]},
                )
            ]
        ),
        make_request(),
    )
    stop = trip.days[0].stops[0]

    # 看点：只丢命中条目，稳妥条目保留；贴士整块被清空。
    assert stop.highlights is not None
    assert stop.highlights.items == ["稳妥看点"]
    assert stop.tips is None
    assert stop.suitableFor is not None
    assert stop.suggestedStayMinutes is not None
    assert any("易变信息" in warning for warning in trip.warnings)

    dumped = json.dumps(stop.model_dump(), ensure_ascii=False)
    for pattern in ("营业时间", "门票", "预约", "闭馆", "加收", "身份证", "09:00-17:00", "60 元"):
        assert pattern not in dumped


@pytest.mark.parametrize(
    "text",
    [
        # V11 · S4-19 十个全新家族（与 S4 城市卡共用同一正则，深度侧同步钉住）
        # 夜游场次
        "夜游每天 19:30 和 20:30 两场",
        "夜游分两场，第一场 19:30 开船",
        "夜游共三场，每场约四十分钟",
        "夜游加场至 22:30",
        "夜游班次以当日公告为准",
        "夜游共两轮，每轮约四十分钟",
        # 观光车班次
        "观光车每 20 分钟一班",
        "观光车班次间隔约 15 分钟",
        "观光车首班 8:00，末班 18:00",
        "观光车发车间隔约半小时",
        "观光车班次从早到晚都有",
        # 汉服租赁
        "汉服租赁 80 元/小时",
        "汉服租赁按小时计费",
        "汉服租赁两小时起租",
        "汉服租赁押金 200 元",
        "汉服租赁按套计价",
        # 寄存柜计费
        "寄存柜 5 元/小时",
        "寄存柜按小时计费",
        "寄存柜超时加收 10 元",
        "寄存柜按天计费",
        "寄存柜租金另计",
        # 接驳车发车
        "接驳车每 30 分钟一班",
        "接驳车流水发车，坐满即走",
        "接驳车按点发车，首班 7:00",
        "接驳车定时发车",
        "接驳车循环发车",
        "接驳车坐满发车",
        "接驳车 20 分钟一趟",
        # 母婴室位置
        "母婴室位于三楼东侧",
        "母婴室设在游客中心一楼",
        "母婴室在 B1 层",
        # 无障碍设施位置
        "无障碍电梯在 B1 层",
        "无障碍通道位于南门入口",
        "无障碍卫生间设在游客中心一楼",
        # 储物设施位置
        "储物柜位于入口处",
        "寄存柜分布在三个楼层",
        "行李寄存处在东门出口",
        # 餐饮供应
        "餐饮供应时间为 11:00-14:00",
        "园区仅供应午餐",
        "晚餐供应至 20:00",
        "餐饮供应时段为午间",
        "园区停止供应夜宵",
        "供应午餐仅限周末",
        "午餐仅周末供应",
        "仅在午餐时段供应",
        # 行李报案
        "行李遗失可拨打 12345 报案",
        "行李丢失可到服务台挂失",
        "行李报案电话 110",
        "失物招领处位于东门",
    ],
)
def test_v11_new_family_depth_variants_are_filtered(text):
    trip, _ = normalize_agent_payload(
        make_payload([make_stop(tips={"items": [text]})]), make_request()
    )
    stop = trip.days[0].stops[0]

    assert stop.tips is None
    assert any("易变信息" in warning for warning in trip.warnings)
    assert text not in json.dumps(stop.model_dump(), ensure_ascii=False)


def test_depth_blocks_never_contain_volatile_fact_patterns():
    """防呆：正常深度内容序列化后不出现营业/票价类构件。"""

    trip, _ = normalize_agent_payload(make_payload([make_stop(depth=full_depth())]), make_request())
    stop = trip.days[0].stops[0]
    dumped = json.dumps(stop.model_dump(), ensure_ascii=False)

    for pattern in ("营业", "开放时间", "票价", "门票", "预约", "预订", "闭馆", "元", "￥", "¥"):
        assert pattern not in dumped


@pytest.mark.parametrize(
    "text",
    [
        "傍晚光线最好",
        "清晨与傍晚人少",
        "片区可步行串联",
        "适合慢游细看",
        "带孩子可以在草地跑一跑",
        "老人可在树荫下休息",
    ],
)
def test_safe_depth_text_is_not_over_filtered(text):
    trip, _ = normalize_agent_payload(
        make_payload([make_stop(tips={"items": [text]})]), make_request()
    )
    stop = trip.days[0].stops[0]

    assert stop.tips is not None
    assert stop.tips.items == [text]
    assert not any("易变信息" in warning for warning in trip.warnings)


@pytest.mark.parametrize(
    "text",
    [
        # V11 稳定描述对照：每族 ≥2 条，不得被新词族误杀
        # 夜游场次
        "夜游是古城夜晚的经典体验",
        "夜游氛围安静",
        "夜游路线沿河展开",
        # 观光车班次
        "观光车是园内主要代步方式",
        "观光车路线覆盖主要景点",
        # 汉服租赁
        "景区提供汉服租赁服务",
        "汉服款式多样",
        # 寄存柜计费
        "园区提供自助寄存柜",
        "寄存柜数量充足",
        # 接驳车发车
        "接驳车连接东西两个片区",
        "接驳车乘坐舒适",
        # 母婴室位置
        "母婴室干净整洁",
        "母婴室设施齐全",
        # 无障碍设施位置
        "园区内有无障碍设施",
        "无障碍设施完善",
        # 储物设施位置
        "储物柜使用方便",
        "园区提供储物设施",
        # 餐饮供应
        "园区餐饮选择丰富",
        "餐厅环境干净整洁",
        "园内提供餐饮",
        "提供餐饮和住宿",
        "供应午餐和晚餐",
        # 行李报案
        "请看管好随身行李",
        "行李遗失可向工作人员求助",
        "贵重物品请随身携带",
    ],
)
def test_v11_stable_depth_text_is_not_over_filtered(text):
    trip, _ = normalize_agent_payload(
        make_payload([make_stop(tips={"items": [text]})]), make_request()
    )
    stop = trip.days[0].stops[0]

    assert stop.tips is not None
    assert stop.tips.items == [text]
    assert not any("易变信息" in warning for warning in trip.warnings)


# ==================== 请求契约不变 ====================


def test_request_contract_and_stable_trip_id_are_unchanged():
    request = make_request()

    assert "highlights" not in TripPlanRequest.model_fields
    assert "suggestedStayMinutes" not in TripPlanRequest.model_fields
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


def test_plan_response_exposes_stop_depth(client):
    api_server.planner_agent = FakePlanner(
        json.dumps(make_payload([make_stop(depth=full_depth())]), ensure_ascii=False)
    )
    response = client.post(
        "/api/trips/plan",
        json={
            "destination": "Hangzhou",
            "days": 1,
            "departure_date": "2026-05-01",
            "travelers": 2,
            "preferences": "quiet lake",
            "travel_mode": "walking",
        },
    )

    assert response.status_code == 200
    body = response.json()
    stop = body["days"][0]["stops"][0]
    assert stop["highlights"]["items"] == ["湖面开阔，长堤一线", "春晓时分光线柔和"]
    assert stop["highlights"]["source"] == "model_generated"
    assert stop["suitableFor"]["tags"] == ["nature", "photo"]
    assert stop["suggestedStayMinutes"] == {"min": 60, "max": 90, "source": "model_generated"}
    assert stop["tips"]["source"] == "model_generated"


def test_plan_response_without_stop_depth_stays_readable(client):
    api_server.planner_agent = FakePlanner(json.dumps(make_payload([make_stop()]), ensure_ascii=False))
    response = client.post(
        "/api/trips/plan",
        json={
            "destination": "Hangzhou",
            "days": 1,
            "departure_date": "2026-05-01",
            "travelers": 2,
            "preferences": "quiet lake",
            "travel_mode": "walking",
        },
    )

    assert response.status_code == 200
    stop = response.json()["days"][0]["stops"][0]
    assert stop["highlights"] is None
    assert stop["suitableFor"] is None
    assert stop["suggestedStayMinutes"] is None
    assert stop["tips"] is None
