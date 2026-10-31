"""config_preflight 的离线单测。

全部使用 fake 环境或 CLI 的 --empty-env/--example，不读取真实 .env，
不发起网络请求，不导入 api_server 等应用模块。
CLI 默认模式的测试通过受控子进程环境注入白名单键，
不读取实际宿主的 key。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config_preflight as cp


SECRET_SENTINEL = "sk-SUPER-SECRET-FAKE-KEY-9f3a1"


def _codes(report: dict) -> set[str]:
    return {c["code"] for c in report["checks"]}


def _by_code(report: dict, code: str) -> dict:
    matches = [c for c in report["checks"] if c["code"] == code]
    assert len(matches) == 1, f"期望恰好一条 {code}，实际 {len(matches)}"
    return matches[0]


def _secrets_not_leaked(report: dict, sentinel: str = SECRET_SENTINEL) -> None:
    serialized = json.dumps(report, ensure_ascii=False)
    assert sentinel not in serialized
    for check in report["checks"]:
        assert sentinel not in check["message"]
        assert sentinel not in check["remediation"]


# ---------- 空配置 / 默认口径 ----------


def test_empty_env_defaults_are_info_not_error():
    report = cp.run_preflight({})
    assert report["ok"] is True
    assert report["counts"]["error"] == 0
    host = _by_code(report, "API_HOST_DEFAULT")
    port = _by_code(report, "API_PORT_DEFAULT")
    assert host["severity"] == "info"
    assert port["severity"] == "info"
    assert "127.0.0.1" in host["message"] or "回环" in host["message"]
    assert "8000" in port["message"]


def test_empty_env_missing_keys_are_warnings_with_degradation_note():
    report = cp.run_preflight({})
    for name in ("DASHSCOPE_API_KEY", "AMAP_API_KEY", "OPENWEATHER_API_KEY"):
        check = _by_code(report, f"{name}_MISSING")
        assert check["severity"] == "warning"
        # 缺 key 是功能降级而不是启动必失败，措辞里要写清
        assert "不阻止服务启动" in check["message"]
        assert check["ok"] is True
    assert report["counts"]["error"] == 0


def test_empty_env_dashscope_impact_mentions_example_still_works():
    report = cp.run_preflight({})
    check = _by_code(report, "DASHSCOPE_API_KEY_MISSING")
    assert "示例" in check["message"]


def test_empty_env_cors_default_listed():
    report = cp.run_preflight({})
    check = _by_code(report, "CORS_ORIGINS_UNSET_DEFAULT")
    assert check["severity"] == "info"
    assert "5173" in check["message"]


# ---------- 合法默认与自定义端口 ----------


def test_explicit_default_values_no_port_warning():
    env = {"API_HOST": "127.0.0.1", "API_PORT": "8000"}
    report = cp.run_preflight(env)
    assert "API_PORT_VITE_PROXY_MISMATCH" not in _codes(report)
    assert "API_HOST_NOT_LOOPBACK" not in _codes(report)
    # 显式设置了才会出现"已设置"口径，而不是默认口径
    assert "API_HOST_DEFAULT" not in _codes(report)
    assert "API_PORT_DEFAULT" not in _codes(report)


def test_custom_valid_port_flags_vite_proxy_mismatch():
    report = cp.run_preflight({"API_PORT": "9000"})
    check = _by_code(report, "API_PORT_VITE_PROXY_MISMATCH")
    assert check["severity"] == "warning"
    assert "VITE_API_BASE" in check["remediation"]


def test_localhost_host_is_loopback_no_warning():
    report = cp.run_preflight({"API_HOST": "localhost"})
    assert "API_HOST_NOT_LOOPBACK" not in _codes(report)


# ---------- 非法端口口径 ----------


@pytest.mark.parametrize("bad_port", ["abc", "12.5", ""])
def test_non_integer_port_is_error_and_no_raw_echo(bad_port):
    report = cp.run_preflight({"API_PORT": bad_port})
    check = _by_code(report, "API_PORT_NOT_INTEGER")
    assert check["severity"] == "error"
    assert check["ok"] is False
    assert report["ok"] is False
    assert report["exit_code"] == cp.EXIT_CONFIG_ERROR
    # 未验证过的原值不回显进报告（空串用例单独见下方断言）
    if bad_port:
        assert bad_port not in check["message"]
        assert bad_port not in json.dumps(report, ensure_ascii=False)


def test_integer_with_underscores_matches_server_int_parsing():
    # Python 的 int() 接受 "8_000"，服务器 int() 行为一致，解析为 8000；
    # 预检与服务器同口径，不应误报为非法；解析结果等于默认端口，
    # 也不触发 Vite 代理不匹配提醒。
    report = cp.run_preflight({"API_PORT": "8_000"})
    assert "API_PORT_NOT_INTEGER" not in _codes(report)
    assert "API_PORT_OUT_OF_RANGE" not in _codes(report)
    assert "API_PORT_VITE_PROXY_MISMATCH" not in _codes(report)


@pytest.mark.parametrize("bad_port", ["0", "-1", "65536", "99999"])
def test_out_of_range_port_is_error(bad_port):
    report = cp.run_preflight({"API_PORT": bad_port})
    check = _by_code(report, "API_PORT_OUT_OF_RANGE")
    assert check["severity"] == "error"
    assert report["ok"] is False
    # 原值不回显：越界值不拼进 message；空值用例不适用此断言
    if bad_port not in ("0",):
        assert bad_port not in check["message"]


def test_port_zero_mentioned_in_remediation_not_raw_echo():
    report = cp.run_preflight({"API_PORT": "0"})
    check = _by_code(report, "API_PORT_OUT_OF_RANGE")
    # 0 的语义（操作系统随机选端口）要讲清，但不是把原值拼进 message
    assert "随机" in check["message"] or "随机" in check["remediation"]


def test_privileged_port_is_warning_not_error():
    report = cp.run_preflight({"API_PORT": "80"})
    check = _by_code(report, "API_PORT_PRIVILEGED")
    assert check["severity"] == "warning"
    assert report["ok"] is True


# ---------- key 三态：缺失 / 占位符 / 已配置未验证 ----------


def test_configured_key_is_unverified_info_only():
    env = {
        "DASHSCOPE_API_KEY": "dashscope-fake-key-0001",
        "AMAP_API_KEY": "amap-fake-key-0002",
        "OPENWEATHER_API_KEY": "ow-fake-key-0003",
    }
    report = cp.run_preflight(env)
    for name in ("DASHSCOPE_API_KEY", "AMAP_API_KEY", "OPENWEATHER_API_KEY"):
        check = _by_code(report, f"{name}_CONFIGURED_UNVERIFIED")
        assert check["severity"] == "info"
        assert "已配置" in check["message"]
        assert "未验证" in check["message"]
        # 必须明确「不代表服务可用」，不能只说「已配置」就完事
        assert "不代表对应服务可用" in check["message"]
        assert "服务可用" in check["message"] and "不代表" in check["message"]
    assert report["counts"]["error"] == 0


def test_placeholder_key_is_warning():
    report = cp.run_preflight({"DASHSCOPE_API_KEY": "your_api_key"})
    check = _by_code(report, "DASHSCOPE_API_KEY_PLACEHOLDER")
    assert check["severity"] == "warning"


# ---------- 非回环 host ----------


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.10"])
def test_non_loopback_host_warns_no_auth_claimed(host):
    report = cp.run_preflight({"API_HOST": host})
    check = _by_code(report, "API_HOST_NOT_LOOPBACK")
    assert check["severity"] == "warning"
    assert "没有认证" in check["message"]
    # 预检不声称新增了认证/限流
    assert "不会为服务增加" in check["message"] or "只描述现状" in check["message"]
    # host 原文不回显
    assert host not in check["message"]


# ---------- CORS ----------


def test_cors_explicit_empty_warns_fail_closed():
    report = cp.run_preflight({"CORS_ORIGINS": "   "})
    check = _by_code(report, "CORS_ORIGINS_EMPTY_FAIL_CLOSED")
    assert check["severity"] == "warning"
    assert "fail-closed" in check["message"]
    assert report["counts"]["error"] == 0


def test_cors_set_override_is_info_about_overwrite_semantics():
    report = cp.run_preflight({"CORS_ORIGINS": "http://localhost:5174"})
    check = _by_code(report, "CORS_ORIGINS_SET_OVERRIDE")
    assert check["severity"] == "info"
    assert "覆盖" in check["message"]


# ---------- 输入不变 / 无副作用 / 无业务导入 ----------


def test_env_mapping_not_mutated():
    env = {
        "API_PORT": "9000",
        "DASHSCOPE_API_KEY": SECRET_SENTINEL,
        "UNRELATED": "keep-me",
    }
    snapshot = dict(env)
    cp.run_preflight(env)
    assert env == snapshot


def test_preflight_makes_no_socket_and_no_app_imports():
    """在带 guard 的干净子进程里跑真实 import + run_preflight。

    子进程启动后先把 socket 连接/应用模块导入/.env 读取全部换成即败 guard，
    再导入 config_preflight 并执行 run_preflight 和 main。
    guard 之后任何真实 socket、应用导入或 .env 读取都会直接报错，
    子进程以非 0 退出，测试失败——不依赖父进程补丁，也不只看 sys.modules。
    """
    project_root = Path(__file__).resolve().parents[1]
    code = """
import json
import sys

violations = []


def _guard_socket(*args, **kwargs):
    violations.append("socket")
    raise AssertionError("预检在 guard 后创建 socket: %r %r" % (args, kwargs))


# 拦的是对外发起连接的入口；解释器内部对 socket 模块的正常加载不受影响。
import socket as _socket_mod

_socket_mod.socket = _guard_socket
_socket_mod.create_connection = _guard_socket
_socket_mod.socketpair = _guard_socket


class _AppImportGuard:
    banned_roots = {
        "api_server", "fastapi", "uvicorn", "httpx", "requests",
        "aiohttp", "travel_itinerary", "weather_client", "amap_server",
        "mcp_runtime", "dotenv",
    }

    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in self.banned_roots:
            violations.append("import:" + name)
            raise AssertionError("预检在 guard 后导入应用模块: %s" % name)
        return None


sys.meta_path.insert(0, _AppImportGuard())


# .env 读取 guard：预检声明不读 .env，open() 指向 .env 文件时要拦。
# 只拦以 .env 结尾的路径，不拦 Python 读自己模块源文件。
_real_open = open


def _guard_open(file, *args, **kwargs):
    if isinstance(file, (str, bytes)):
        name = file.decode("utf-8", "replace") if isinstance(file, bytes) else file
        if name.lower().endswith(".env"):
            violations.append("open:" + name)
            raise AssertionError("预检在 guard 后读取 .env: %s" % name)
    return _real_open(file, *args, **kwargs)


import builtins

builtins.open = _guard_open

sys.path.insert(0, "__PROJECT_ROOT__")
import config_preflight as cp

# 1) 纯函数路径
r1 = cp.run_preflight({"API_PORT": "abc", "DASHSCOPE_API_KEY": "k1"})

# 2) CLI 路径：默认读进程环境，这里的环境是测试注入的受控 env
exit_code = cp.main(["--json"])

print(json.dumps({
    "run_ok": r1["ok"],
    "cli_exit": exit_code,
    "violations": violations,
}))
""".replace("__PROJECT_ROOT__", str(project_root).replace("\\", "/"))
    proc = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=str(project_root),
        timeout=60,
        env={
            "PATH": os.environ["PATH"],
            "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
            "API_PORT": "not-a-port",
            "DASHSCOPE_API_KEY": "fake-key-0001",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONIOENCODING": "utf-8",
        },
    )
    assert proc.returncode == 0, (
        "guard 子进程非 0 退出（可能触发 guard 或崩溃）: " + proc.stderr
    )
    payload = json.loads(proc.stdout.strip().splitlines()[-1])
    assert payload["run_ok"] is False
    assert payload["cli_exit"] == 2
    assert payload["violations"] == [], payload["violations"]


def test_module_import_has_no_environ_side_effects():
    # run_preflight 对 os.environ 本身也是只读的。
    # 只比对键名集合，不把宿主环境的真实值复制进测试进程。
    before = set(os.environ)
    cp.run_preflight({})
    after = set(os.environ)
    assert before == after


# ---------- 泄漏防护 ----------


def test_fake_secret_never_leaks_into_report_or_text():
    env = {
        "DASHSCOPE_API_KEY": SECRET_SENTINEL,
        "AMAP_API_KEY": SECRET_SENTINEL,
        "OPENWEATHER_API_KEY": SECRET_SENTINEL,
        "API_HOST": SECRET_SENTINEL,
        "API_PORT": "9000",
        "CORS_ORIGINS": SECRET_SENTINEL,
    }
    report = cp.run_preflight(env)
    _secrets_not_leaked(report)
    text = cp.render_text(report)
    assert SECRET_SENTINEL not in text


def test_report_is_json_serializable():
    report = cp.run_preflight({"API_PORT": "abc", "CORS_ORIGINS": ""})
    parsed = json.loads(json.dumps(report))
    assert parsed["version"] == cp.REPORT_VERSION
    assert isinstance(parsed["checks"], list) and parsed["checks"]


# ---------- CLI ----------


def _run_cli(args, capsys):
    code = cp.main(args)
    captured = capsys.readouterr()
    return code, captured.out


def test_cli_default_exit_zero_on_empty_env_json(capsys):
    code, out = _run_cli(["--empty-env", "--json"], capsys)
    assert code == 0
    report = json.loads(out)
    assert report["ok"] is True
    assert report["exit_code"] == 0


def test_cli_example_env_exit_zero_and_marks_example(capsys):
    code, out = _run_cli(["--example", "--json"], capsys)
    assert code == 0
    report = json.loads(out)
    # 示例里有自定义端口与空 CORS，应有对应提示但没有 error
    assert report["counts"]["error"] == 0
    codes = _codes(report)
    assert "API_PORT_VITE_PROXY_MISMATCH" in codes
    assert "CORS_ORIGINS_EMPTY_FAIL_CLOSED" in codes
    # 示例 key 不该被当真实凭据输出；host/port 默认值本来就合法出现在报告里，
    # 只检查 key 类字段
    for value in (
        cp.build_example_env()["DASHSCOPE_API_KEY"],
        cp.build_example_env()["OPENWEATHER_API_KEY"],
    ):
        assert value and value not in out


def test_cli_config_error_exit_code_two_via_environ(capsys, monkeypatch):
    # 隔离：先清掉宿主环境里的白名单键，再注入受控假值，
    # 保证 main 默认模式读到的是本测试的 env，不是真实主机配置。
    for name in cp.PREFLIGHT_ENV_KEYS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("API_PORT", "not-a-port")
    code, out = _run_cli(["--json"], capsys)
    assert code == 2
    report = json.loads(out)
    assert report["exit_code"] == 2
    assert report["counts"]["error"] >= 1
    # 非法端口原值不回显
    assert "not-a-port" not in out


def test_cli_text_mode_summary_and_no_json(capsys):
    code, out = _run_cli(["--empty-env"], capsys)
    assert code == 0
    assert "config-preflight" in out
    assert "[INFO]" in out
    assert "[WARNING]" in out
    with pytest.raises(json.JSONDecodeError):
        json.loads(out)


def test_cli_example_and_empty_env_mutually_exclusive(capsys):
    with pytest.raises(SystemExit) as excinfo:
        cp.main(["--empty-env", "--example"])
    assert excinfo.value.code != 0


# ---------- 回归：CLI 默认模式只读白名单键 ----------


def test_preflight_env_keys_cover_all_checked_keys():
    # CLI 默认模式只读 PREFLIGHT_ENV_KEYS；如果检查逻辑新增了读取的键，
    # 白名单必须同步，否则默认模式会漏检。用 _check_* 的读键路径反推：
    # 直接检查 KEY_SPECS 的键和 host/port/cors 键都在白名单里。
    declared = set(cp.PREFLIGHT_ENV_KEYS)
    expected = {"API_HOST", "API_PORT", "CORS_ORIGINS"}
    expected |= {name for name, _ in cp.KEY_SPECS}
    assert declared == expected


def test_cli_default_mode_reads_only_whitelisted_keys_in_subprocess():
    """受控子进程验证：默认模式只读白名单键。

    1) 干净环境（只有 PATH 等运行必需变量）下，默认模式报告与 --empty-env
       完全一致——宿主环境的其他变量没被带进来；
    2) 注入白名单键后报告随之变化——白名单键确实被读取；
    3) 白名单外的假 secret 不出现在任何输出里。
    """
    project_root = Path(__file__).resolve().parents[1]

    def _base_env() -> dict:
        return {
            "PATH": os.environ["PATH"],
            "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONIOENCODING": "utf-8",
        }

    def _run_cli_json(extra_env: dict) -> tuple[int, dict, str]:
        env = _base_env()
        env.update(extra_env)
        proc = subprocess.run(
            [sys.executable, "-c",
             "import sys, json, config_preflight as cp;"
             "code = cp.main(['--json']);"
             "print('EXIT_CODE_MARKER:' + str(code))"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=str(project_root),
            timeout=60,
            env=env,
        )
        assert proc.returncode == 0, proc.stderr
        lines = proc.stdout.strip().splitlines()
        exit_line = lines[-1]
        assert exit_line.startswith("EXIT_CODE_MARKER:")
        exit_code = int(exit_line.split(":", 1)[1])
        report = json.loads("\n".join(lines[:-1]))
        return exit_code, report, proc.stdout + proc.stderr

    # 1) 干净环境：默认模式报告 == --empty-env 报告
    exit_bare, report_bare, output_bare = _run_cli_json({})
    proc_empty = subprocess.run(
        [sys.executable, "-c", "import config_preflight as cp; cp.main(['--empty-env', '--json'])"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=str(project_root),
        timeout=60,
        env=_base_env(),
    )
    assert proc_empty.returncode == 0, proc_empty.stderr
    report_empty = json.loads(proc_empty.stdout.strip())
    assert report_bare == report_empty

    # 2) 白名单键确实被读取：注入非法端口后退出码变 2
    exit_injected, report_injected, _ = _run_cli_json({"API_PORT": "not-a-port"})
    assert exit_injected == 2
    assert report_injected["counts"]["error"] >= 1
    assert exit_bare == 0

    # 3) 白名单外的假 secret 不进任何输出
    _, _, output_secret = _run_cli_json({"FAKE_UNLISTED_SECRET": "sk-fake-unlisted-0001"})
    assert "sk-fake-unlisted-0001" not in output_secret
