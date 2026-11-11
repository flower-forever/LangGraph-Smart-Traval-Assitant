# -*- coding: utf-8 -*-
"""六期 S7 · 规划 prompt 就近约束测试。

只钉一件事：规划 prompt 含一条温和的「同一天相邻站点尽量就近安排、避免长距离
折返」约束；请求与响应契约不变（旧请求不带任何新字段仍走同一 prompt 结构）。
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from travel_itinerary import TripPlanRequest, build_agent_prompt  # noqa: E402


def make_request(**overrides):
    data = {
        "destination": "张家界",
        "days": 2,
        "departure_date": "2026-05-01",
        "travelers": 2,
        "preferences": "",
        "travel_mode": "driving",
    }
    data.update(overrides)
    return TripPlanRequest(**data)


def test_prompt_contains_nearby_ordering_guidance():
    prompt = build_agent_prompt(make_request())
    assert "同一天相邻站点尽量就近安排，避免长距离折返" in prompt
    assert "在 description 里简要说明理由" in prompt


def test_prompt_legacy_request_keeps_same_json_contract():
    """旧请求（不带 pace / constraints / interests）仍得到同一 JSON 结构要求。"""
    prompt = build_agent_prompt(make_request())
    assert "只输出一个 JSON 对象" in prompt
    assert "只输出 JSON" in prompt
    assert '"days"' in prompt
    assert '"stops"' in prompt
