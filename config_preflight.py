"""config_preflight —— 离线部署配置预检工具。

只做静态配置检查，边界如下：

- 不发起任何网络请求，不启动 API 服务、MCP 子进程或模型/地图/天气调用；
- 不读取 .env 文件，不导入 api_server 等应用模块（顶层导入无副作用）；
- run_preflight 只读取显式传入的 env Mapping，不修改它，也不碰 os.environ；
- CLI 默认模式只读取本工具用到的 6 个环境键（见 PREFLIGHT_ENV_KEYS），
  不复制整个 os.environ，也不读取 .env；
- 报告与文本输出不含任何配置原值（key、host、port 原文都不回显），
  避免把可能含凭据的内容带进日志。

CLI 用法：

    python config_preflight.py             # 检查当前进程环境（默认，只读本工具用到的键）
    python config_preflight.py --empty-env # 全空配置，看默认口径
    python config_preflight.py --example   # 纯假示例配置，演示各类提示
    python config_preflight.py --json      # 输出 JSON 报告

退出码：0 = 无 error（允许 warning/info）；2 = 存在配置 error。
功能缺 key 属于 warning，不会让退出码变非 0（示例预览不因此误判必失败）。

预检口径以 api_server.Configuration 与 README 的现行行为为证据；
本工具只报告，不改变任何运行时行为。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Mapping
from typing import Any

__version__ = "1.0.0"

REPORT_VERSION = 1

SEVERITY_INFO = "info"
SEVERITY_WARNING = "warning"
SEVERITY_ERROR = "error"

EXIT_OK = 0
EXIT_CONFIG_ERROR = 2

DEFAULT_API_HOST = "127.0.0.1"
DEFAULT_API_PORT = 8000

# 与 api_server.LOOPBACK_HOSTNAMES 保持同一判定口径。
LOOPBACK_HOSTNAMES = frozenset({"127.0.0.1", "localhost", "::1"})

# 与 api_server.DEFAULT_CORS_ORIGINS 一致，仅用于报告中描述现行默认值。
DEFAULT_CORS_ORIGINS = (
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:5181",
    "http://localhost:5181",
    "http://127.0.0.1:5182",
    "http://localhost:5182",
)

# CLI 默认模式只读取这些键：不复制整个 os.environ，
# 宿主环境里的其他变量（含可能的密钥）不会进入本工具。
PREFLIGHT_ENV_KEYS: tuple[str, ...] = (
    "API_HOST",
    "API_PORT",
    "DASHSCOPE_API_KEY",
    "AMAP_API_KEY",
    "OPENWEATHER_API_KEY",
    "CORS_ORIGINS",
)

# key 检查清单：(环境变量名, 缺失时受影响的功能说明)。
# 依据 README 与 api_server/weather_server/amap_server 的现行读取行为。
KEY_SPECS: tuple[tuple[str, str], ...] = (
    (
        "DASHSCOPE_API_KEY",
        "影响 /chat 与 /api/trips/plan（运行时返回 503）；"
        "内置示例行程 GET /api/trips/example 不受影响，服务本身仍能启动",
    ),
    (
        "AMAP_API_KEY",
        "影响行程的真实坐标与导航路线增强（map_status 会是 no_key）"
        "以及 amap_server 的 7 个地图工具；文字行程仍可用",
    ),
    (
        "OPENWEATHER_API_KEY",
        "仅影响 weather_server.py 的天气类 MCP 工具；"
        "规划与聊天是否调用天气工具由模型和工具可用性决定",
    ),
)

# 精确匹配（去空白、小写后）即提示"疑似占位符"的保守集合。
PLACEHOLDER_VALUES = frozenset(
    {
        "your_api_key",
        "your-api-key",
        "yourapikey",
        "changeme",
        "change-me",
        "placeholder",
        "apikey",
        "api_key",
        "xxx",
        "xxxx",
        "sk-xxx",
        "sk-xxxx",
        "test",
        "demo",
        "todo",
        "1234567890",
    }
)


def _add_check(
    checks: list[dict[str, Any]],
    code: str,
    severity: str,
    message: str,
    remediation: str,
) -> None:
    checks.append(
        {
            "code": code,
            "severity": severity,
            "ok": severity != SEVERITY_ERROR,
            "message": message,
            "remediation": remediation,
        }
    )


def _check_host(env: Mapping[str, str], checks: list[dict[str, Any]]) -> None:
    raw = (env.get("API_HOST") or "").strip()
    if not raw:
        _add_check(
            checks,
            "API_HOST_DEFAULT",
            SEVERITY_INFO,
            "未设置 API_HOST：服务器将监听默认回环地址，仅本机可访问。",
            "如需局域网访问再显式设置；注意现行服务没有认证，对外监听需自行加防护。",
        )
        return
    if raw not in LOOPBACK_HOSTNAMES:
        _add_check(
            checks,
            "API_HOST_NOT_LOOPBACK",
            SEVERITY_WARNING,
            "API_HOST 是非回环地址：现行服务没有认证和限流，"
            "接口会对所在网络开放。此提示只描述现状，"
            "预检不会为服务增加任何认证或限流。",
            "确认这是有意的部署；否则改回回环地址，或自行补齐认证、TLS 等防护。",
        )


def _check_port(env: Mapping[str, str], checks: list[dict[str, Any]]) -> None:
    raw = env.get("API_PORT")
    if raw is None:
        _add_check(
            checks,
            "API_PORT_DEFAULT",
            SEVERITY_INFO,
            "未设置 API_PORT：服务器将使用默认端口 8000，"
            "与前端 Vite 开发代理的写死目标 http://127.0.0.1:8000 一致。",
            "保持默认即可；改端口时注意前端的 VITE_API_BASE。",
        )
        return
    try:
        port = int(raw)
    except (TypeError, ValueError):
        _add_check(
            checks,
            "API_PORT_NOT_INTEGER",
            SEVERITY_ERROR,
            "API_PORT 的值无法解析为整数。按服务器现行行为会静默回退到"
            f"默认端口 {DEFAULT_API_PORT}，也就是说改端口的意图不会生效，"
            "而配置者可能以为已经改了。",
            f"把 API_PORT 设为 1-65535 之间的整数（默认 {DEFAULT_API_PORT}）。",
        )
        return
    if port <= 0 or port > 65535:
        _add_check(
            checks,
            "API_PORT_OUT_OF_RANGE",
            SEVERITY_ERROR,
            "API_PORT 超出有效端口范围（1-65535）：监听时会启动失败，"
            "或产生不符合预期的行为（把范围下端的边界值填进去，"
            "操作系统会随机选端口）。",
            "把 API_PORT 设为 1-65535 之间的整数。",
        )
        return
    if port < 1024:
        _add_check(
            checks,
            "API_PORT_PRIVILEGED",
            SEVERITY_WARNING,
            "API_PORT 位于特权端口区间（1-1023）：部分系统上非管理员进程"
            "无权监听，服务可能启动失败。",
            "如无必要改用 1024 以上的端口。",
        )
    if port != DEFAULT_API_PORT:
        _add_check(
            checks,
            "API_PORT_VITE_PROXY_MISMATCH",
            SEVERITY_WARNING,
            "API_PORT 不是默认端口：前端 Vite 开发代理把 /api 写死指向"
            " http://127.0.0.1:8000，前端不调整时页面请求会打到旧端口而失败。",
            "前端开发/构建前设置 VITE_API_BASE 指向新端口；生产构建的"
            " VITE_API_BASE 在 build 时读取，之后改环境变量不会重写产物。",
        )


def _check_keys(env: Mapping[str, str], checks: list[dict[str, Any]]) -> None:
    for name, impact in KEY_SPECS:
        value = (env.get(name) or "").strip()
        if not value:
            _add_check(
                checks,
                f"{name}_MISSING",
                SEVERITY_WARNING,
                f"未配置 {name}。{impact}。缺失不阻止服务启动，"
                "属于功能降级，不是配置错误。",
                "需要对应功能时按 README 配置真实 Key；只浏览示例行程可不配置。",
            )
        elif value.lower() in PLACEHOLDER_VALUES:
            _add_check(
                checks,
                f"{name}_PLACEHOLDER",
                SEVERITY_WARNING,
                f"{name} 的值疑似占位符：按\"存在\"处理，但实际调用大概率失败。"
                "预检不输出也不验证 Key 的值。",
                "替换为真实 Key 后重跑预检。",
            )
        else:
            _add_check(
                checks,
                f"{name}_CONFIGURED_UNVERIFIED",
                SEVERITY_INFO,
                f"{name} 已配置，未验证：预检只检查 Key 是否存在，"
                "不能确认它有效，也不代表对应服务可用。",
                "真实可用性以运行时调用结果为准。",
            )


def _check_cors(env: Mapping[str, str], checks: list[dict[str, Any]]) -> None:
    raw = env.get("CORS_ORIGINS")
    if raw is None:
        origins_text = ", ".join(DEFAULT_CORS_ORIGINS)
        _add_check(
            checks,
            "CORS_ORIGINS_UNSET_DEFAULT",
            SEVERITY_INFO,
            "未设置 CORS_ORIGINS：服务器将使用默认白名单，"
            f"共 {len(DEFAULT_CORS_ORIGINS)} 个本机 origin（{origins_text}）。",
            "前端开发服务器顺延到其他端口（如 5174）时，"
            "需要把实际 origin 显式写进 CORS_ORIGINS。",
        )
        return
    if not raw.strip():
        _add_check(
            checks,
            "CORS_ORIGINS_EMPTY_FAIL_CLOSED",
            SEVERITY_WARNING,
            "CORS_ORIGINS 被显式设为空：按现行服务器行为会 fail-closed，"
            "不信任任何跨域浏览器来源，来自前端页面的跨域写请求会被拒绝。",
            "把需要放行的浏览器 origin 以逗号分隔写进 CORS_ORIGINS；"
            "如果确实想要最严格的跨域策略，可保留现状。",
        )
        return
    _add_check(
        checks,
        "CORS_ORIGINS_SET_OVERRIDE",
        SEVERITY_INFO,
        "已设置 CORS_ORIGINS：按现行行为，逗号分隔列表是整体覆盖而非追加；"
        "修改后需重启服务。预检不逐项校验 origin 的合法性，"
        "最终以服务器启动日志为准。",
        "确认列表覆盖了实际会用到的前端 origin。",
    )


def run_preflight(env: Mapping[str, str]) -> dict[str, Any]:
    """对显式传入的 env 做只读预检，返回可 JSON 序列化的报告。

    env 只被读取：本函数不修改传入对象，也不读写 os.environ。
    报告不含任何配置原值，因此可以安全地进日志或工单。

    检查范围是静态配置口径：端口合法性、host 是否回环、key 有无、
    CORS 设置形态。不在范围内的：key 是否真的有效、端口是否被占用、
    host/origin 值是否合法可达、服务能否启动——这些以运行时为准。
    """

    checks: list[dict[str, Any]] = []
    _check_host(env, checks)
    _check_port(env, checks)
    _check_keys(env, checks)
    _check_cors(env, checks)

    error_count = sum(1 for c in checks if c["severity"] == SEVERITY_ERROR)
    warning_count = sum(1 for c in checks if c["severity"] == SEVERITY_WARNING)
    info_count = sum(1 for c in checks if c["severity"] == SEVERITY_INFO)

    if error_count:
        summary = (
            f"发现 {error_count} 个配置错误：请先修复 error 项再启动服务。"
        )
    elif warning_count:
        summary = (
            f"本次静态检查范围内无配置错误；有 {warning_count} 个提醒，"
            "多为功能降级或部署注意事项，不阻止服务启动。"
        )
    else:
        summary = "本次静态检查范围内未发现配置问题。"

    return {
        "tool": "config-preflight",
        "version": REPORT_VERSION,
        "tool_version": __version__,
        "ok": error_count == 0,
        "counts": {
            "error": error_count,
            "warning": warning_count,
            "info": info_count,
            "total": len(checks),
        },
        "summary": summary,
        "exit_code": EXIT_CONFIG_ERROR if error_count else EXIT_OK,
        "checks": checks,
    }


def build_example_env() -> dict[str, str]:
    """纯假示例配置，演示典型部署形态；不含任何真实凭据。"""

    return {
        "API_HOST": "127.0.0.1",
        "API_PORT": "9000",
        "DASHSCOPE_API_KEY": "example-dashscope-key-0001",
        "AMAP_API_KEY": "",
        "OPENWEATHER_API_KEY": "example-openweather-key-0001",
        "CORS_ORIGINS": "",
    }


def render_text(report: Mapping[str, Any]) -> str:
    """把报告渲染成人类可读文本（同样不含配置原值）。"""

    counts = report["counts"]
    lines = [
        f"config-preflight v{report['tool_version']} 检查结果",
        report["summary"],
        "",
    ]
    for check in report["checks"]:
        lines.append(f"[{check['severity'].upper()}] {check['code']}")
        lines.append(f"  {check['message']}")
        lines.append(f"  建议：{check['remediation']}")
        lines.append("")
    lines.append(
        f"合计：error {counts['error']}，warning {counts['warning']}，"
        f"info {counts['info']}；退出码 {report['exit_code']}。"
        "预检只报告静态配置口径，不验证 key 有效性、端口占用、"
        "host/origin 可达性，也不改变运行时行为。"
    )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="config_preflight",
        description=(
            "离线部署配置预检：只读检查环境变量，不做网络请求，"
            "不读取 .env，不启动服务。"
        ),
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--empty-env",
        action="store_true",
        help="按完全为空的环境检查（看默认口径与缺 key 的降级说明）。",
    )
    group.add_argument(
        "--example",
        action="store_true",
        help="用内置纯假示例配置检查（演示各类提示，不含真实凭据）。",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="以 JSON 格式输出报告。",
    )
    args = parser.parse_args(argv)

    if args.empty_env:
        env: Mapping[str, str] = {}
    elif args.example:
        env = build_example_env()
    else:
        # 默认模式只读取本工具用到的键，不复制整个 os.environ：
        # 宿主环境里的其他变量（含可能的密钥）不会进入本工具。
        # 不读取 .env，不修改全局环境。
        env = {name: os.environ[name] for name in PREFLIGHT_ENV_KEYS if name in os.environ}

    report = run_preflight(env)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(render_text(report))
    return report["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
