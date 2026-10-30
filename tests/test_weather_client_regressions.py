# -*- coding: utf-8 -*-
"""天气客户端公开行为回归测试（28 条，d17 复核结论的正式归档）。

只打公开 ``fetch_day``，全部 httpx.MockTransport / async stream，零真实网络。
覆盖：总 deadline 覆盖等待 headers 与 chunk 间隙、错误响应不消费 body、
注入 follow_redirects=True 也不跨 host、fetched_at 语义、单位核验与数值
约束、网格/时区/coverage 校验、超大 int 输入零网络、requested_date 各状态。

自包含：不依赖测试收集顺序，不引用任何临时目录路径。
"""

from __future__ import annotations

import asyncio
import json
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

import httpx
import pytest

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from weather_client import WeatherClient  # noqa: E402

LAT, LON = 31.2304, 121.4737
TARGET_DATE = "2026-11-02"

DAILY_VARS = [
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_sum",
    "precipitation_probability_max",
    "wind_speed_10m_max",
    "weather_code",
]


# ==================== 夹具辅助 ====================


def make_provider_payload(
    *,
    first_date: str = "2026-10-30",
    days: int = 16,
    timezone_name: str = "Asia/Shanghai",
    utc_offset: Any = 28800,
    grid_lat: float = 31.25,
    grid_lon: float = 121.5,
    elevation: float = 7.0,
    target_values: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """构造一份 Open-Meteo 形状的每日预报 payload。"""
    start = date.fromisoformat(first_date)
    time_list = [(start + timedelta(days=i)).isoformat() for i in range(days)]
    base_values = {
        "temperature_2m_max": 22.1,
        "temperature_2m_min": 15.0,
        "precipitation_sum": 0.4,
        "precipitation_probability_max": 35,
        "wind_speed_10m_max": 12.3,
        "weather_code": 61,
    }
    merged = {**base_values, **(target_values or {})}
    daily: dict[str, Any] = {"time": time_list}
    for name in DAILY_VARS:
        daily[name] = [merged[name]] * len(time_list)
    return {
        "latitude": grid_lat,
        "longitude": grid_lon,
        "elevation": elevation,
        "timezone": timezone_name,
        "utc_offset_seconds": utc_offset,
        "daily_units": {
            "temperature_2m_max": "°C",
            "temperature_2m_min": "°C",
            "precipitation_sum": "mm",
            "precipitation_probability_max": "%",
            "wind_speed_10m_max": "km/h",
            "weather_code": "wmo code",
        },
        "daily": daily,
    }


def handler_ok(
    payload: dict[str, Any], *, status: int = 200
) -> Callable[[httpx.Request], httpx.Response]:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=payload)

    return handler


def run(coro):
    return asyncio.run(coro)


def make_client(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    total_deadline_seconds: float | None = None,
    clock: Callable[[], float] | None = None,
    now_utc: Callable[[], datetime] | None = None,
    client_kwargs: dict[str, Any] | None = None,
) -> WeatherClient:
    transport = httpx.MockTransport(handler)
    http_client = httpx.AsyncClient(transport=transport, **(client_kwargs or {}))
    kwargs: dict[str, Any] = {"client": http_client}
    if total_deadline_seconds is not None:
        kwargs["total_deadline_seconds"] = total_deadline_seconds
    if clock is not None:
        kwargs["clock"] = clock
    if now_utc is not None:
        kwargs["now_utc"] = now_utc
    return WeatherClient(**kwargs)


# ==================== 总 deadline：等待 headers / chunk 间隙 / 资源关闭 ====================


def test_total_deadline_covers_slow_headers():
    """headers 迟迟不返回：总 deadline 到点必须 timeout，外层 0.5s 内结束。"""

    async def handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5)  # 远超总 deadline 0.05s 与外层 0.5s 保护
        return httpx.Response(200, json=make_provider_payload())

    async def action():
        async with make_client(handler, total_deadline_seconds=0.05) as client:
            return await asyncio.wait_for(
                client.fetch_day(LAT, LON, TARGET_DATE), timeout=0.5
            )

    report = run(action())
    assert report.status == "timeout"
    assert report.fetched_at is None


def test_total_deadline_covers_gap_between_chunks():
    """两个 chunk 之间长时间空等：同样受总 deadline 约束。"""
    body = json.dumps(make_provider_payload()).encode("utf-8")

    async def handler(request: httpx.Request) -> httpx.Response:
        async def stream():
            yield body[:100]
            await asyncio.sleep(5)
            yield body[100:]

        return httpx.Response(200, content=stream())

    async def action():
        async with make_client(handler, total_deadline_seconds=0.1) as client:
            return await asyncio.wait_for(
                client.fetch_day(LAT, LON, TARGET_DATE), timeout=0.5
            )

    report = run(action())
    assert report.status == "timeout"


def test_total_deadline_close_closes_stream_context():
    """deadline 触发取消后，底层响应流被关闭（无半开流泄漏）。"""
    closed = {"flag": False}
    body = json.dumps(make_provider_payload()).encode("utf-8")

    async def handler(request: httpx.Request) -> httpx.Response:
        async def stream():
            try:
                while True:
                    yield body
                    await asyncio.sleep(0.05)
            finally:
                closed["flag"] = True

        return httpx.Response(200, content=stream())

    async def action():
        async with make_client(handler, total_deadline_seconds=0.1) as client:
            return await asyncio.wait_for(
                client.fetch_day(LAT, LON, TARGET_DATE), timeout=0.5
            )

    report = run(action())
    assert report.status == "timeout"
    assert closed["flag"] is True


# ==================== 错误响应不消费 body / 重定向 ====================


def test_error_body_not_consumed_on_5xx():
    """5xx 的错误 body 不读：绝不无限消费，关闭即可。"""
    chunks_served = {"count": 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        async def stream():
            for _ in range(2000):
                chunks_served["count"] += 1
                yield b"x" * 1024

        return httpx.Response(500, content=stream())

    async def action():
        async with make_client(handler) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "unavailable"
    assert chunks_served["count"] < 10


def test_error_body_not_consumed_on_4xx():
    chunks_served = {"count": 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        async def stream():
            for _ in range(2000):
                chunks_served["count"] += 1
                yield b"y" * 1024

        return httpx.Response(400, content=stream())

    async def action():
        async with make_client(handler) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "failed"
    assert chunks_served["count"] < 10


def test_redirect_not_followed_even_if_client_follows():
    """外部注入 follow_redirects=True 时，stream 调用必须显式拒绝重定向。"""
    seen_hosts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_hosts.append(request.url.host)
        if request.url.host == "evil.example.com":
            return httpx.Response(200, json=make_provider_payload())
        return httpx.Response(
            302, headers={"location": "https://evil.example.com/v1/forecast"}
        )

    async def action():
        async with make_client(
            handler, client_kwargs={"follow_redirects": True}
        ) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert seen_hosts == ["api.open-meteo.com"]
    assert report.status == "failed"
    assert report.fetched_at is None


def test_provider_http_status_kept_on_http_errors():
    """已知 HTTP 状态码保留在 provider_http_status，不回显 provider 正文。"""

    async def action(status: int):
        async with make_client(
            handler_ok(make_provider_payload(), status=status)
        ) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report_503 = run(action(503))
    assert report_503.status == "unavailable"
    assert report_503.provider_http_status == 503

    report_400 = run(action(400))
    assert report_400.status == "failed"
    assert report_400.provider_http_status == 400
    dumped = report_400.model_dump_json()
    assert "rate limited secret" not in dumped


# ==================== fetched_at 语义 ====================


def test_fetched_at_is_after_network_completion():
    """fetched_at 在网络完成之后取 now_utc：延迟期间时钟应推进。"""

    async def handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.12)
        return httpx.Response(200, json=make_provider_payload())

    async def action():
        async with make_client(
            handler, now_utc=lambda: datetime.now(timezone.utc)
        ) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "available"
    checked = datetime.fromisoformat(report.checked_at)
    fetched = datetime.fromisoformat(report.fetched_at)
    assert (fetched - checked).total_seconds() >= 0.1


def test_fetched_at_null_on_structural_failure():
    """坏 coverage / 缺日期结构等 failed 分支不得携带 fetched_at。"""
    payload = make_provider_payload()
    del payload["daily"]["time"]

    async def action():
        async with make_client(handler_ok(payload)) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "failed"
    assert report.fetched_at is None


def test_fetched_at_allowed_on_out_of_range():
    """out_of_range 的 dataset 合法，fetched_at 可非空。"""
    payload = make_provider_payload(days=3)

    async def action():
        async with make_client(handler_ok(payload)) as client:
            return await client.fetch_day(LAT, LON, "2026-11-15")

    report = run(action())
    assert report.status == "out_of_range"
    assert report.fetched_at is not None


# ==================== 单位核验与数值约束 ====================


def test_missing_unit_makes_value_null():
    payload = make_provider_payload()
    del payload["daily_units"]["temperature_2m_max"]

    async def action():
        async with make_client(handler_ok(payload)) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "available"
    assert report.forecast.values["temperature_2m_max"] is None
    assert "temperature_2m_max" in report.forecast.missing_fields
    assert report.forecast.units["temperature_2m_max"] is None


def test_mismatched_unit_fahrenheit_value_null():
    """请求固定 celsius：单位是 °F 时数值不可信，value 置 null 并进 missing_fields。"""
    payload = make_provider_payload()
    payload["daily_units"]["temperature_2m_max"] = "°F"

    async def action():
        async with make_client(handler_ok(payload)) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.forecast.units["temperature_2m_max"] == "°F"  # 单位透传展示，不冒充
    assert report.forecast.values["temperature_2m_max"] is None
    assert "temperature_2m_max" in report.forecast.missing_fields


def test_probability_out_of_bounds_value_null():
    payload = make_provider_payload(
        target_values={"precipitation_probability_max": 150}
    )

    async def action():
        async with make_client(handler_ok(payload)) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.forecast.values["precipitation_probability_max"] is None
    assert "precipitation_probability_max" in report.forecast.missing_fields


def test_negative_precip_and_wind_value_null():
    payload = make_provider_payload(
        target_values={"precipitation_sum": -0.5, "wind_speed_10m_max": -1.0}
    )

    async def action():
        async with make_client(handler_ok(payload)) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    values = report.forecast.values
    assert values["precipitation_sum"] is None
    assert values["wind_speed_10m_max"] is None
    assert set(report.forecast.missing_fields) == {
        "precipitation_sum",
        "wind_speed_10m_max",
    }


def test_weather_code_non_integer_value_null():
    payload = make_provider_payload()
    payload["daily"]["weather_code"][3] = 61.5

    async def action():
        async with make_client(handler_ok(payload)) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.forecast.values["weather_code"] is None
    assert "weather_code" in report.forecast.missing_fields


def test_weather_code_missing_unit_value_null():
    payload = make_provider_payload()
    del payload["daily_units"]["weather_code"]

    async def action():
        async with make_client(handler_ok(payload)) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.forecast.values["weather_code"] is None
    assert "weather_code" in report.forecast.missing_fields


def test_negative_temperature_is_real_value():
    """负温是真值，不是缺值。"""
    payload = make_provider_payload(
        target_values={"temperature_2m_max": -12.5, "temperature_2m_min": -20.0}
    )

    async def action():
        async with make_client(handler_ok(payload)) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "available"
    assert report.forecast.values["temperature_2m_max"] == pytest.approx(-12.5)
    assert report.forecast.values["temperature_2m_min"] == pytest.approx(-20.0)
    assert report.forecast.missing_fields == []


# ==================== 网格 / 时区 / coverage / 超大 int 输入 ====================


def test_grid_out_of_wgs84_range_not_accepted():
    payload = make_provider_payload(grid_lat=95.0)

    async def action():
        async with make_client(handler_ok(payload)) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.coordinate.grid is None
    assert report.coordinate.grid_elevation_m is None


def test_fractional_utc_offset_is_unknown():
    payload = make_provider_payload(utc_offset=28800.5)

    async def action():
        async with make_client(handler_ok(payload)) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.provider_utc_offset_seconds is None


def test_outrageous_utc_offset_is_unknown():
    payload = make_provider_payload(utc_offset=10**9)

    async def action():
        async with make_client(handler_ok(payload)) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.provider_utc_offset_seconds is None


def test_unsorted_daily_time_is_failed():
    payload = make_provider_payload(days=5)
    time_list = payload["daily"]["time"]
    time_list[1], time_list[2] = time_list[2], time_list[1]

    async def action():
        async with make_client(handler_ok(payload)) as client:
            return await client.fetch_day(LAT, LON, time_list[0])

    report = run(action())
    assert report.status == "failed"


def test_huge_int_lat_invalid_request_zero_network():
    """超大整数坐标：float() 溢出不能崩，且不发任何网络请求。"""
    called = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        called["count"] += 1
        return httpx.Response(200, json=make_provider_payload())

    async def action():
        async with make_client(handler) as client:
            return await client.fetch_day(10**400, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "invalid_request"
    assert called["count"] == 0


def test_huge_int_lon_invalid_request_zero_network():
    called = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        called["count"] += 1
        return httpx.Response(200, json=make_provider_payload())

    async def action():
        async with make_client(handler) as client:
            return await client.fetch_day(LAT, 10**400, TARGET_DATE)

    report = run(action())
    assert report.status == "invalid_request"
    assert called["count"] == 0


# ==================== requested_date 各状态 ====================


def test_requested_date_present_on_success():
    async def action():
        async with make_client(handler_ok(make_provider_payload())) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.requested_date == TARGET_DATE


def test_requested_date_present_on_out_of_range():
    payload = make_provider_payload(days=3)

    async def action():
        async with make_client(handler_ok(payload)) as client:
            return await client.fetch_day(LAT, LON, "2026-11-15")

    report = run(action())
    assert report.status == "out_of_range"
    assert report.requested_date == "2026-11-15"


def test_requested_date_present_on_failed():
    payload = make_provider_payload()
    del payload["daily"]["time"]

    async def action():
        async with make_client(handler_ok(payload)) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "failed"
    assert report.requested_date == TARGET_DATE


def test_requested_date_present_on_invalid_lat_with_valid_date():
    async def action():
        async with make_client(handler_ok(make_provider_payload())) as client:
            return await client.fetch_day(91.0, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "invalid_request"
    assert report.requested_date == TARGET_DATE


def test_requested_date_null_on_invalid_date():
    async def action():
        async with make_client(handler_ok(make_provider_payload())) as client:
            return await client.fetch_day(LAT, LON, "not-a-date")

    report = run(action())
    assert report.status == "invalid_request"
    assert report.requested_date is None
