# -*- coding: utf-8 -*-
"""weather_api 离线测试：FastAPI TestClient + 真实 WeatherClient(MockTransport)。

全部离线，不发真实网络请求；生产 app 的天气请求也通过把
``api_server.app.state.weather_client`` 换成 MockTransport 客户端完成，不 import
启动真实服务、不连接 MCP / DashScope / Open-Meteo。覆盖：

1. available 字段、requested_date/coordinate/source 与固定 provider query
2. 缺值 → null + missing_fields；真实闰日可查询
3. out_of_range / timeout / unavailable / failed 原样 200 信封且不重试
4. 非法 lat/lon/日期/缺参 → 422 且 0 provider 请求
5. 默认 client 与注入 client 的关闭所有权、多 app 状态隔离
6. 初始化失败不拖死 app、失败后可恢复；原 app lifespan 与 router lifespan 同时执行
7. CancelledError 原样上抛
8. 生产 api_server 已注册该 GET、无模型 Key 下天气可用且既有端点语义不变
"""

from __future__ import annotations

import os

# 必须在 import api_server 之前：模块导入时会执行 load_dotenv()。
os.environ["PYTHON_DOTENV_DISABLED"] = "1"

import asyncio
import threading
from contextlib import asynccontextmanager, contextmanager
from datetime import date, timedelta
from typing import Any, Iterator

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api_server
import weather_api
from weather_api import weather_router_factory
from weather_client import WeatherClient

TARGET = "2026-11-02"
LEAP_TARGET = "2028-02-29"

DAILY_UNITS = {
    "temperature_2m_max": "°C",
    "temperature_2m_min": "°C",
    "precipitation_sum": "mm",
    "precipitation_probability_max": "%",
    "wind_speed_10m_max": "km/h",
    "weather_code": "wmo code",
}
DAILY_VALUES = {
    "temperature_2m_max": 22.1,
    "temperature_2m_min": 15.0,
    "precipitation_sum": 0.4,
    "precipitation_probability_max": 35,
    "wind_speed_10m_max": 12.3,
    "weather_code": 61,
}


# ==================== 夹具数据 ====================


def daily_payload(
    *,
    first_date: str = "2026-10-30",
    days: int = 16,
    target_date: str | None = TARGET,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """构造一份 Open-Meteo 形状的每日预报响应。"""

    start = date.fromisoformat(first_date)
    time_list = [(start + timedelta(days=i)).isoformat() for i in range(days)]
    values = dict(DAILY_VALUES)

    if overrides:
        if target_date is None:
            raise ValueError("overrides 需要 target_date")
        index = time_list.index(target_date)
        for key, value in overrides.items():
            values[key] = value
        daily = {"time": time_list}
        for name in DAILY_VALUES:
            daily[name] = [values[name]] * days
        for key, value in overrides.items():
            daily[key][index] = value
    else:
        daily = {"time": time_list}
        for name, value in values.items():
            daily[name] = [value] * days

    return {
        "latitude": 31.25,
        "longitude": 121.5,
        "elevation": 7.0,
        "timezone": "Asia/Shanghai",
        "utc_offset_seconds": 28800,
        "daily_units": dict(DAILY_UNITS),
        "daily": daily,
    }


def ok_responder(payload: dict[str, Any]):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    return handler


class Recorder:
    """记录 provider 请求次数与最后一次请求，用于 0 请求/不重试断言。"""

    def __init__(self, responder: Any) -> None:
        self.calls = 0
        self.last_request: httpx.Request | None = None
        self._lock = threading.Lock()
        self.responder = responder

    def __call__(self, request: httpx.Request) -> httpx.Response:
        with self._lock:
            self.calls += 1
            self.last_request = request
        return self.responder(request)


def make_client(recorder: Recorder) -> tuple[WeatherClient, httpx.AsyncClient]:
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
    return WeatherClient(client=http_client), http_client


async def _close_pair(
    weather_client: WeatherClient, http_client: httpx.AsyncClient
) -> None:
    # 注入的 http client 所有权在测试侧：先关 WeatherClient 的引用，再关 http。
    await weather_client.aclose()
    await http_client.aclose()


@contextmanager
def weather_app(recorder: Recorder) -> Iterator[tuple[TestClient, WeatherClient]]:
    """带 /health 的最小 app；退出时关闭注入的 client。"""

    app = FastAPI()
    weather_client, http_client = make_client(recorder)
    app.include_router(weather_router_factory(client=weather_client))

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "healthy"}

    try:
        with TestClient(app) as test_client:
            yield test_client, weather_client
    finally:
        asyncio.run(_close_pair(weather_client, http_client))


@pytest.fixture()
def ok_app() -> Iterator[tuple[TestClient, Recorder]]:
    recorder = Recorder(ok_responder(daily_payload()))
    with weather_app(recorder) as (test_client, _weather_client):
        yield test_client, recorder


# ==================== 1. available ====================


def test_available_full_envelope(ok_app) -> None:
    test_client, recorder = ok_app
    response = test_client.get(
        "/api/weather/day",
        params={"lat": 31.2304, "lon": 121.4737, "date": TARGET},
    )

    assert response.status_code == 200
    assert response.headers["x-weather-status"] == "available"
    body = response.json()
    assert body["status"] == "available"
    assert body["requested_date"] == TARGET
    assert body["provider_http_status"] == 200
    assert body["provider_timezone"] == "Asia/Shanghai"
    assert body["provider_utc_offset_seconds"] == 28800
    assert body["checked_at"]
    assert body["fetched_at"] is not None
    assert body["coordinate"]["system"] == "WGS84"
    assert body["coordinate"]["verified"] is False
    assert body["coordinate"]["requested"] == {"lat": 31.2304, "lon": 121.4737}
    assert body["coordinate"]["grid"] == {"lat": 31.25, "lon": 121.5}
    assert body["coordinate"]["grid_elevation_m"] == 7.0
    assert body["source"]["provider"] == "open-meteo"
    assert body["source"]["endpoint"] == "https://api.open-meteo.com/v1/forecast"
    assert body["source"]["license"] == "CC BY 4.0"
    assert body["coverage"] == {
        "first_date": "2026-10-30",
        "last_date": "2026-11-14",
        "count": 16,
    }
    assert body["forecast"]["date"] == TARGET
    assert body["forecast"]["values"]["temperature_2m_max"] == 22.1
    assert body["forecast"]["units"]["temperature_2m_max"] == "°C"
    assert body["forecast"]["missing_fields"] == []
    # 启动少数一次，实际查询恰好一次：没有重试，也不在 lifespan 里发请求。
    assert recorder.calls == 1


def test_provider_request_is_fixed_and_has_no_user_url(ok_app) -> None:
    test_client, recorder = ok_app
    test_client.get(
        "/api/weather/day",
        params={"lat": 31.2304, "lon": 121.4737, "date": TARGET},
    )

    request = recorder.last_request
    assert request is not None
    assert request.url.host == "api.open-meteo.com"
    assert request.url.path == "/v1/forecast"
    params = request.url.params
    assert params["latitude"] == "31.2304"
    assert params["longitude"] == "121.4737"
    assert params["timezone"] == "auto"
    assert params["forecast_days"] == "16"
    assert "user" not in request.url.query.decode().lower()


# ==================== 2. 缺值 / out_of_range ====================


def test_missing_value_is_null_and_listed() -> None:
    recorder = Recorder(
        ok_responder(daily_payload(overrides={"temperature_2m_max": None}))
    )
    with weather_app(recorder) as (test_client, _weather_client):
        response = test_client.get(
            "/api/weather/day",
            params={"lat": 31.2, "lon": 121.4, "date": TARGET},
        )

    assert response.status_code == 200
    forecast = response.json()["forecast"]
    assert forecast["values"]["temperature_2m_max"] is None
    assert "temperature_2m_max" in forecast["missing_fields"]
    assert forecast["values"]["precipitation_sum"] == 0.4


def test_out_of_range_is_200_envelope() -> None:
    recorder = Recorder(ok_responder(daily_payload(target_date=None)))
    with weather_app(recorder) as (test_client, _weather_client):
        response = test_client.get(
            "/api/weather/day",
            params={"lat": 31.2, "lon": 121.4, "date": "2027-01-01"},
        )

    assert response.status_code == 200
    assert response.headers["x-weather-status"] == "out_of_range"
    body = response.json()
    assert body["status"] == "out_of_range"
    assert body["forecast"] is None
    assert body["coverage"]["count"] == 16
    assert body["fetched_at"] is not None
    assert "open-meteo.com/v1/forecast" not in body["reason"]
    assert recorder.calls == 1


# ==================== 3. upstream 失败折算 ====================


def test_timeout_is_200_and_not_retried() -> None:
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("read timeout", request=request)

    recorder = Recorder(timeout)
    with weather_app(recorder) as (test_client, _weather_client):
        response = test_client.get(
            "/api/weather/day",
            params={"lat": 31.2, "lon": 121.4, "date": TARGET},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "timeout"
    assert body["fetched_at"] is None
    assert recorder.calls == 1


def test_connect_error_is_200_unavailable() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns failure", request=request)

    recorder = Recorder(refuse)
    with weather_app(recorder) as (test_client, _weather_client):
        response = test_client.get(
            "/api/weather/day",
            params={"lat": 31.2, "lon": 121.4, "date": TARGET},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "unavailable"
    assert recorder.calls == 1
    assert recorder.calls == 1


@pytest.mark.parametrize("status_code", [429, 500, 503])
def test_unavailable_statuses_keep_200_and_hide_body(status_code: int) -> None:
    recorder = Recorder(
        lambda request: httpx.Response(status_code, text="secret upstream body")
    )
    with weather_app(recorder) as (test_client, _weather_client):
        response = test_client.get(
            "/api/weather/day",
            params={"lat": 31.2, "lon": 121.4, "date": TARGET},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "unavailable"
    assert body["provider_http_status"] == status_code
    assert body["fetched_at"] is None
    assert "secret upstream body" not in response.text
    assert recorder.calls == 1


def test_provider_4xx_is_200_failed() -> None:
    recorder = Recorder(lambda request: httpx.Response(400, text="bad request"))
    with weather_app(recorder) as (test_client, _weather_client):
        response = test_client.get(
            "/api/weather/day",
            params={"lat": 31.2, "lon": 121.4, "date": TARGET},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "failed"
    assert body["provider_http_status"] == 400
    assert "bad request" not in response.text


def test_non_json_body_is_200_failed() -> None:
    recorder = Recorder(lambda request: httpx.Response(200, content=b"not json"))
    with weather_app(recorder) as (test_client, _weather_client):
        response = test_client.get(
            "/api/weather/day",
            params={"lat": 31.2, "lon": 121.4, "date": TARGET},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "failed"
    assert response.json()["fetched_at"] is None


def test_malformed_daily_is_200_failed() -> None:
    recorder = Recorder(ok_responder({"latitude": 31.2, "longitude": 121.4}))
    with weather_app(recorder) as (test_client, _weather_client):
        response = test_client.get(
            "/api/weather/day",
            params={"lat": 31.2, "lon": 121.4, "date": TARGET},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "failed"


# ==================== 4. 非法输入 422 + 0 provider 请求 ====================


def test_invalid_inputs_422_and_zero_provider_calls() -> None:
    recorder = Recorder(ok_responder(daily_payload()))
    local_invalid = [
        {"lat": 90.1, "lon": 0.0, "date": TARGET},
        {"lat": -90.1, "lon": 0.0, "date": TARGET},
        {"lat": 0.0, "lon": 180.1, "date": TARGET},
        {"lat": 0.0, "lon": -180.1, "date": TARGET},
        {"lat": "NaN", "lon": 0.0, "date": TARGET},
        {"lat": "Infinity", "lon": 0.0, "date": TARGET},
        {"lat": "1e309", "lon": 0.0, "date": TARGET},
        {"lat": "abc", "lon": 0.0, "date": TARGET},
        {"lat": 0.0, "lon": 0.0, "date": "2026/10/30"},
        {"lat": 0.0, "lon": 0.0, "date": "30-10-2026"},
        {"lat": 0.0, "lon": 0.0, "date": "20261030"},
        {"lat": 0.0, "lon": 0.0, "date": "2026-2-3"},
    ]
    # 格式合法但不是真实日历日：交给 client 判 invalid_request，同样 0 请求。
    client_invalid = [
        {"lat": 0.0, "lon": 0.0, "date": "2026-02-30"},
        {"lat": 0.0, "lon": 0.0, "date": "2026-13-01"},
        {"lat": 0.0, "lon": 0.0, "date": "2026-00-10"},
        {"lat": 0.0, "lon": 0.0, "date": "2027-02-29"},
        {"lat": 0.0, "lon": 0.0, "date": "2026-ab-cd"},
    ]

    with weather_app(recorder) as (test_client, _weather_client):
        for params in local_invalid:
            response = test_client.get("/api/weather/day", params=params)
            assert response.status_code == 422, params
            assert "detail" in response.json(), params
            assert recorder.calls == 0, params

        for params in client_invalid:
            response = test_client.get("/api/weather/day", params=params)
            assert response.status_code == 422, params
            body = response.json()
            assert body["report"]["status"] == "invalid_request", params
            assert body["report"]["reason"], params
            # 信封里固定带 source 元数据；但不能回显 provider 错误原文。
            assert "secret" not in response.text, params
            assert recorder.calls == 0, params

    assert recorder.calls == 0


def test_missing_params_422_without_provider_call() -> None:
    recorder = Recorder(ok_responder(daily_payload()))
    with weather_app(recorder) as (test_client, _weather_client):
        assert test_client.get("/api/weather/day").status_code == 422
        assert (
            test_client.get("/api/weather/day", params={"lat": 1.0}).status_code
            == 422
        )
        assert (
            test_client.get(
                "/api/weather/day", params={"lat": 1.0, "lon": 2.0}
            ).status_code
            == 422
        )

    assert recorder.calls == 0


def test_valid_leap_day_is_queried() -> None:
    payload = daily_payload(
        first_date="2028-02-20", days=16, target_date=LEAP_TARGET
    )
    recorder = Recorder(ok_responder(payload))
    with weather_app(recorder) as (test_client, _weather_client):
        response = test_client.get(
            "/api/weather/day",
            params={"lat": 0.0, "lon": 0.0, "date": LEAP_TARGET},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "available"
    assert response.json()["forecast"]["date"] == LEAP_TARGET
    assert recorder.calls == 1


# ==================== 5. 生命周期与所有权 ====================


def test_client_unavailable_before_lifespan_returns_503() -> None:
    recorder = Recorder(ok_responder(daily_payload()))
    weather_client, http_client = make_client(recorder)
    app = FastAPI()
    app.include_router(weather_router_factory(client=weather_client))

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "healthy"}

    test_client = TestClient(app)
    try:
        response = test_client.get(
            "/api/weather/day",
            params={"lat": 31.2, "lon": 121.4, "date": TARGET},
        )
        assert response.status_code == 503
        assert response.json()["detail"] == "天气服务未初始化，请稍后再试。"
        assert "open-meteo" not in response.text
        assert "WeatherClient" not in response.text
        assert test_client.get("/health").json() == {"status": "healthy"}
        assert recorder.calls == 0
    finally:
        test_client.close()
        asyncio.run(_close_pair(weather_client, http_client))


def test_multiple_apps_get_isolated_default_clients() -> None:
    app_a = FastAPI()
    app_b = FastAPI()
    app_a.include_router(weather_router_factory())
    app_b.include_router(weather_router_factory())

    with TestClient(app_a) as _ta, TestClient(app_b) as _tb:
        client_a = app_a.state.weather_client
        client_b = app_b.state.weather_client
        assert isinstance(client_a, WeatherClient)
        assert isinstance(client_b, WeatherClient)
        assert client_a is not client_b

    assert client_a._closed is True
    assert client_a._client is None
    assert client_b._closed is True
    assert client_b._client is None
    assert app_a.state.weather_client is None
    assert app_b.state.weather_client is None


def test_same_router_included_in_two_apps_stays_isolated() -> None:
    shared_router = weather_router_factory()
    app_a = FastAPI()
    app_b = FastAPI()
    app_a.include_router(shared_router)
    app_b.include_router(shared_router)

    with TestClient(app_a) as _ta, TestClient(app_b) as _tb:
        client_a = app_a.state.weather_client
        client_b = app_b.state.weather_client
        assert client_a is not None and client_b is not None
        assert client_a is not client_b

    assert client_a._closed is True
    assert client_b._closed is True


def test_app_lifespan_and_router_lifespan_both_run() -> None:
    events: list[tuple[str, Any]] = []

    @asynccontextmanager
    async def app_lifespan(app: FastAPI):
        events.append(("app-start", getattr(app.state, "weather_client", "missing")))
        yield
        # 合并后的关闭顺序是先 router 后 app：此时天气 client 已被清空并关闭。
        events.append(("app-stop", getattr(app.state, "weather_client", "missing")))

    app = FastAPI(lifespan=app_lifespan)
    app.include_router(weather_router_factory())

    with TestClient(app) as _test_client:
        weather_client = app.state.weather_client
        assert isinstance(weather_client, WeatherClient)
        events.append(("running", weather_client))

    assert [name for name, _value in events] == ["app-start", "running", "app-stop"]
    assert events[0][1] == "missing"
    assert events[2][1] is None
    assert weather_client._closed is True
    assert weather_client._client is None


def test_injected_client_is_not_closed_by_router_lifespan() -> None:
    recorder = Recorder(ok_responder(daily_payload()))
    weather_client, http_client = make_client(recorder)
    app = FastAPI()
    app.include_router(weather_router_factory(client=weather_client))

    try:
        with TestClient(app) as test_client:
            assert app.state.weather_client is weather_client
            assert (
                test_client.get(
                    "/api/weather/day",
                    params={"lat": 31.2, "lon": 121.4, "date": TARGET},
                ).status_code
                == 200
            )

        assert weather_client._closed is False
        assert http_client.is_closed is False
        assert app.state.weather_client is weather_client
        # 关闭后仍能复用（证明所有权确实在调用方）。
        report = asyncio.run(weather_client.fetch_day(31.2, 121.4, TARGET))
        assert report.status == "available"
    finally:
        asyncio.run(_close_pair(weather_client, http_client))


def test_closed_injected_client_returns_503() -> None:
    recorder = Recorder(ok_responder(daily_payload()))
    weather_client, http_client = make_client(recorder)
    app = FastAPI()
    app.include_router(weather_router_factory(client=weather_client))

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "healthy"}

    try:
        with TestClient(app) as test_client:
            asyncio.run(weather_client.aclose())
            response = test_client.get(
                "/api/weather/day",
                params={"lat": 31.2, "lon": 121.4, "date": TARGET},
            )
            assert response.status_code == 503
            assert response.json()["detail"] == "天气服务未初始化，请稍后再试。"
            assert "已关闭" not in response.text
            assert test_client.get("/health").status_code == 200
    finally:
        asyncio.run(_close_pair(weather_client, http_client))


def test_router_startup_makes_no_provider_request() -> None:
    recorder = Recorder(ok_responder(daily_payload()))
    with weather_app(recorder) as (_test_client, _weather_client):
        pass
    assert recorder.calls == 0


class _ExplodingClient:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        raise RuntimeError("secret-token https://api.open-meteo.com/v1/forecast boom")


def test_init_failure_does_not_kill_health_and_recovers(monkeypatch) -> None:
    recorder = Recorder(ok_responder(daily_payload()))
    app = FastAPI()
    app.include_router(weather_router_factory())

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "healthy"}

    with monkeypatch.context() as patch:
        patch.setattr(weather_api, "WeatherClient", _ExplodingClient)
        with TestClient(app) as test_client:
            assert app.state.weather_client is None
            assert test_client.get("/health").json() == {"status": "healthy"}
            response = test_client.get(
                "/api/weather/day",
                params={"lat": 31.2, "lon": 121.4, "date": TARGET},
            )
            assert response.status_code == 503
            assert response.json()["detail"] == "天气服务未初始化，请稍后再试。"
            assert "secret-token" not in response.text
            assert "open-meteo" not in response.text
            assert "boom" not in response.text

    # 故障解除后，同一个 app 重新启动 lifespan 能重建可用 client，并能正常查询。
    weather_client, http_client = make_client(recorder)
    try:
        with TestClient(app) as test_client:
            recovered = app.state.weather_client
            assert isinstance(recovered, WeatherClient)
            app.state.weather_client = weather_client
            response = test_client.get(
                "/api/weather/day",
                params={"lat": 31.2, "lon": 121.4, "date": TARGET},
            )
            assert response.status_code == 200
            assert response.json()["status"] == "available"
    finally:
        asyncio.run(_close_pair(weather_client, http_client))


# ==================== 6. 取消 ====================


class _CancelledClient(WeatherClient):
    async def fetch_day(self, lat: float, lon: float, date: str):  # type: ignore[override]
        raise asyncio.CancelledError


def test_cancelled_error_propagates_from_route() -> None:
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={}))
    )
    weather_client = _CancelledClient(client=http_client)
    app = FastAPI()
    app.include_router(weather_router_factory(client=weather_client))

    async def scenario() -> None:
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                with pytest.raises(asyncio.CancelledError):
                    await client.get(
                        "/api/weather/day",
                        params={"lat": 31.2, "lon": 121.4, "date": TARGET},
                    )
        await _close_pair(weather_client, http_client)

    asyncio.run(scenario())


# ==================== 7. 生产 api_server 接线 ====================


def _prepare_no_model_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("DASHSCOPE_API_KEY", "AMAP_API_KEY", "API_HOST"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(api_server.cfg, "api_key", None)
    monkeypatch.setattr(api_server.cfg, "amap_api_key", None)
    monkeypatch.setattr(api_server, "agent", None)
    monkeypatch.setattr(api_server, "planner_agent", None)
    monkeypatch.setattr(api_server, "mcp_client", None)
    monkeypatch.setattr(api_server, "available_tools", [])


@pytest.fixture()
def production_client(monkeypatch: pytest.MonkeyPatch):
    _prepare_no_model_keys(monkeypatch)
    with TestClient(api_server.app) as test_client:
        yield test_client


def test_production_openapi_registers_weather_get() -> None:
    schema = api_server.app.openapi()
    assert "/api/weather/day" in schema["paths"]
    operation = schema["paths"]["/api/weather/day"]
    assert "get" in operation
    parameters = {item["name"]: item for item in operation["get"]["parameters"]}
    assert set(parameters) == {"lat", "lon", "date"}
    assert all(parameters[name]["required"] is True for name in parameters)
    ok_schema = operation["get"]["responses"]["200"]["content"]["application/json"][
        "schema"
    ]
    assert ok_schema.get("$ref", "").endswith("/WeatherDayReport")
    # 既有业务路径没有因为接入天气路由而消失。
    assert "/api/trips/plan" in schema["paths"]
    assert "/api/trips/days/replan" in schema["paths"]


def test_production_weather_works_without_model_key(
    production_client: TestClient,
) -> None:
    recorder = Recorder(ok_responder(daily_payload()))
    weather_client, http_client = make_client(recorder)
    api_server.app.state.weather_client = weather_client
    try:
        response = production_client.get(
            "/api/weather/day",
            params={"lat": 31.2304, "lon": 121.4737, "date": TARGET},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "available"
        assert response.json()["requested_date"] == TARGET
        assert recorder.calls == 1

        health = production_client.get("/health")
        assert health.status_code == 200
        assert health.json()["status"] == "healthy"
    finally:
        asyncio.run(_close_pair(weather_client, http_client))


def test_production_existing_endpoints_keep_their_semantics(
    production_client: TestClient,
) -> None:
    health = production_client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["agent_ready"] is False
    assert health.json()["planner_ready"] is False

    example = production_client.get("/api/trips/example")
    assert example.status_code == 200
    assert example.json()["source"] == "example"

    chat = production_client.post("/chat", json={"message": "你好"})
    assert chat.status_code == 503
    assert "DASHSCOPE_API_KEY" in chat.json()["detail"]

    plan = production_client.post(
        "/api/trips/plan",
        json={"destination": "杭州", "days": 2, "travel_mode": "walking"},
    )
    assert plan.status_code == 503
    assert "DASHSCOPE_API_KEY" in plan.json()["detail"]


def test_production_weather_init_failure_does_not_kill_health(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _prepare_no_model_keys(monkeypatch)
    with monkeypatch.context() as patch:
        patch.setattr(weather_api, "WeatherClient", _ExplodingClient)
        with TestClient(api_server.app) as test_client:
            health = test_client.get("/health")
            assert health.status_code == 200
            assert health.json()["status"] == "healthy"

            example = test_client.get("/api/trips/example")
            assert example.status_code == 200

            response = test_client.get(
                "/api/weather/day",
                params={"lat": 31.2, "lon": 121.4, "date": TARGET},
            )
            assert response.status_code == 503
            assert response.json()["detail"] == "天气服务未初始化，请稍后再试。"
            for leaked in ("secret-token", "open-meteo", "boom", "Traceback"):
                assert leaked not in response.text
