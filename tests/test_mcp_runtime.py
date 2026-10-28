"""mcp_runtime 独立测试：配置解析、路径定位、兼容转换与真实 stdio 握手。

只依赖 mcp_runtime 与磁盘文件，不依赖模型和任何真实密钥；
不修改被测项目目录中的任何文件。

运行方式：
- 解析类测试：任意装有 pytest 的解释器
    python -m pytest tests/test_mcp_runtime.py -v
- 含真实握手：需要在「四个 server 能 import mcp.server.fastmcp」的解释器下
  运行（例如 ta-uv 隔离环境装的 mcp 1.x），否则该测试自动跳过：
    C:/Users/86133/AppData/Local/Temp/ta-uv/Scripts/python.exe -m pytest tests/test_mcp_runtime.py -v
"""

import asyncio
import hashlib
import importlib.util
import json
import os
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import mcp_runtime

REAL_CONFIG = ROOT / "servers_config.json"
REAL_CONFIG_TEXT = REAL_CONFIG.read_text(encoding="utf-8")

# 四个自带 server 及其脚本名（与 servers_config.json 一一对应）
BUNDLED_SERVERS = {
    "weather": "weather_server.py",
    "write": "write_server.py",
    "calculator": "calculator_server.py",
    "amap": "amap_server.py",
}

# 真实握手时各 server 至少应暴露的代表工具（见各 server 的 @mcp.tool()）
EXPECTED_TOOL_SAMPLES = {
    "query_weather",       # weather
    "save_travel_plan",    # write
    "calculate",           # calculator
    "search_poi",          # amap
}


def _sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _load_runtime_copy(project_dir: Path):
    """把 mcp_runtime.py 拷到别处后按路径加载，验证项目位置无关性。"""
    spec = importlib.util.spec_from_file_location(
        f"mcp_runtime_copy_{abs(hash(project_dir))}", project_dir / "mcp_runtime.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ==================== 默认 4 个 server 的解析 ====================


def test_default_config_four_servers_resolved():
    servers = mcp_runtime.load_server_config()
    assert set(servers) == set(BUNDLED_SERVERS)
    for name, script_name in BUNDLED_SERVERS.items():
        entry = servers[name]
        assert entry["transport"] == "stdio", name
        command = entry["command"]
        assert Path(command).is_absolute(), f"{name} command 应为绝对路径: {command}"
        assert Path(command).is_file(), f"{name} 解释器应真实存在: {command}"
        args = entry["args"]
        assert len(args) == 1 and args[0].endswith(script_name), (name, args)
        script = Path(args[0])
        assert script.is_absolute() and script.is_file(), f"{name} 脚本应存在: {args[0]}"


def test_default_config_python_fallback_to_current_interpreter():
    """项目里没有 venv，写死的 .\\venv\\Scripts\\python.exe 应回退到 sys.executable。"""
    servers = mcp_runtime.load_server_config()
    for name in BUNDLED_SERVERS:
        command = servers[name]["command"]
        if not (ROOT / "venv" / "Scripts" / "python.exe").is_file():
            assert Path(command) == Path(sys.executable), (name, command)


def test_prompt_loads_from_project_dir():
    prompt = mcp_runtime.load_prompt()
    assert "小途" in prompt
    assert mcp_runtime.find_prompt_path() == ROOT / "agent_prompts.txt"


# ==================== 与工作目录、项目位置无关 ====================


def test_resolved_paths_independent_of_cwd(tmp_path, monkeypatch):
    reference = mcp_runtime.load_server_config()
    monkeypatch.chdir(tmp_path)  # 完全无关的目录
    again = mcp_runtime.load_server_config()
    assert again == reference
    # 提示词同样不受 cwd 影响
    assert "小途" in mcp_runtime.load_prompt()


def test_default_config_found_from_foreign_cwd(tmp_path, monkeypatch):
    """从任意 cwd 启动、不设置 MCP_CONFIG 时也能找到项目默认配置。"""
    monkeypatch.delenv("MCP_CONFIG", raising=False)
    monkeypatch.chdir(tmp_path)
    assert mcp_runtime.find_config_path() == REAL_CONFIG


def test_project_location_independence(tmp_path):
    """整个项目拷到别处后，拷贝出的 mcp_runtime 锚定自己的目录。"""
    proj = tmp_path / "moved" / "proj"
    proj.mkdir(parents=True)
    shutil.copyfile(ROOT / "mcp_runtime.py", proj / "mcp_runtime.py")
    (proj / "servers_config.json").write_text(REAL_CONFIG_TEXT, encoding="utf-8")
    for script in BUNDLED_SERVERS.values():
        (proj / script).write_text(f"# stub {script}\n", encoding="utf-8")

    copy = _load_runtime_copy(proj)
    assert copy.PROJECT_DIR == proj.resolve()

    servers = copy.load_server_config()
    for name, script in BUNDLED_SERVERS.items():
        assert Path(servers[name]["args"][0]) == (proj / script).resolve()
        # 拷贝目录里没有 venv，解释器应回退到当前解释器
        assert Path(servers[name]["command"]) == Path(sys.executable)


# ==================== 自定义配置（MCP_CONFIG）保留语义 ====================


def test_custom_non_python_services_pass_through(tmp_path):
    """npx / HTTP 服务保持原样：command、args、env、transport、url、headers 不动。"""
    npx_entry = {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "./data"],
        "env": {"SOME_FLAG": "1"},
        "transport": "stdio",
    }
    http_entry = {
        "url": "https://example.com/mcp",
        "transport": "streamable-http",
        "headers": {"Authorization": "Bearer placeholder-not-a-real-token"},
    }
    config_file = tmp_path / "custom.json"
    config_file.write_text(
        json.dumps({"mcpServers": {"fs": npx_entry, "remote": http_entry}}, ensure_ascii=False),
        encoding="utf-8",
    )

    servers = mcp_runtime.load_server_config(str(config_file))
    assert servers["fs"] == npx_entry
    assert servers["remote"] == http_entry
    assert "python" not in servers["fs"]["command"]


def test_custom_config_relative_discovery_from_foreign_cwd(tmp_path, monkeypatch):
    """MCP_CONFIG 给相对文件名时，cwd 找不到会回落到项目目录。"""
    custom = ROOT / "custom_servers_for_test.json"
    custom.write_text(json.dumps({"mcpServers": {}}), encoding="utf-8")
    try:
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("MCP_CONFIG", "custom_servers_for_test.json")
        assert mcp_runtime.find_config_path() == custom
        assert mcp_runtime.load_server_config() == {}
    finally:
        custom.unlink(missing_ok=True)


def test_missing_custom_config_raises_clear_error(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(FileNotFoundError) as exc_info:
        mcp_runtime.find_config_path("definitely_missing.json")
    assert "definitely_missing.json" in str(exc_info.value)


# ==================== Python 路径兼容转换规则 ====================


def test_python_command_conversion_rules(tmp_path):
    """分四种情况：写死路径缺失→回退；存在的解释器→绝对化保留；裸命令与非 Python→原样。"""
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "weather_server.py").write_text("# stub\n", encoding="utf-8")
    # 「存在的解释器」用与写死路径不同的目录名，保证 .\venv\... 保持缺失
    fake_venv = proj / "pyvenv" / "Scripts"
    fake_venv.mkdir(parents=True)
    (fake_venv / "python.exe").write_text("", encoding="utf-8")

    raw = {
        "legacy_missing": {
            "command": ".\\venv\\Scripts\\python.exe",
            "args": ["weather_server.py"],
            "transport": "stdio",
        },
        "legacy_present": {
            "command": "pyvenv/Scripts/python.exe",
            "args": ["weather_server.py"],
            "transport": "stdio",
        },
        "bare_python": {"command": "python", "args": ["-m", "somepkg"], "transport": "stdio"},
        "not_python": {"command": "npx", "args": ["-y", "@org/server"], "transport": "stdio"},
    }

    servers = mcp_runtime.resolve_servers(raw, config_dir=proj, project_dir=proj)

    # 写死的解释器不存在 → 当前解释器；脚本参数转成绝对路径
    assert servers["legacy_missing"]["command"] == sys.executable
    assert servers["legacy_missing"]["args"] == [str((proj / "weather_server.py").resolve())]

    # 写死的解释器真实存在 → 绝对化后保留，尊重用户自己的 venv
    assert Path(servers["legacy_present"]["command"]) == (fake_venv / "python.exe").resolve()
    assert Path(servers["legacy_present"]["command"]).is_absolute()

    # 裸 python / 非 Python 命令：命令与参数都不改写
    assert servers["bare_python"]["command"] == "python"
    assert servers["bare_python"]["args"] == ["-m", "somepkg"]
    assert servers["not_python"] == raw["not_python"]


def test_resolve_servers_does_not_mutate_input():
    raw = {
        "weather": {
            "command": ".\\venv\\Scripts\\python.exe",
            "args": ["weather_server.py"],
            "transport": "stdio",
        }
    }
    snapshot = json.dumps(raw, ensure_ascii=False)
    mcp_runtime.resolve_servers(raw, config_dir=ROOT, project_dir=ROOT)
    assert json.dumps(raw, ensure_ascii=False) == snapshot


# ==================== 原配置不被污染 ====================


def test_original_config_file_not_polluted():
    before = _sha256_of(REAL_CONFIG)
    for _ in range(3):
        mcp_runtime.load_server_config()
    assert _sha256_of(REAL_CONFIG) == before
    # 项目目录里也不应多出测试残留的配置文件
    assert not (ROOT / "custom_servers_for_test.json").exists()


# ==================== 真实 stdio 握手（无模型、无真实 key） ====================


def _current_interpreter_can_run_servers() -> bool:
    try:
        import mcp.server.fastmcp  # noqa: F401
        import langchain_mcp_adapters  # noqa: F401

        return True
    except Exception:
        return False


@pytest.mark.skipif(
    not _current_interpreter_can_run_servers(),
    reason=(
        "当前解释器无法 import mcp.server.fastmcp / langchain_mcp_adapters，"
        "四个自带 server 起不来；请改用装好 mcp 1.x 依赖的解释器运行，"
        "例如 ta-uv 隔离环境"
    ),
)
def test_real_stdio_handshake_four_servers():
    """用规整后的配置真实拉起 4 个 stdio server 并 get_tools（不调用模型）。"""
    from langchain_mcp_adapters.client import MultiServerMCPClient

    servers = mcp_runtime.load_server_config()
    client = MultiServerMCPClient(servers)
    tools = asyncio.run(client.get_tools())

    names = {tool.name for tool in tools}
    assert len(tools) >= 20
    missing = EXPECTED_TOOL_SAMPLES - names
    assert not missing, f"握手成功但缺少预期工具: {missing}"


def _client_deps_available() -> bool:
    try:
        import langchain_mcp_adapters  # noqa: F401
        import langchain_community.chat_models  # noqa: F401
        import langgraph.prebuilt  # noqa: F401

        return True
    except Exception:
        return False


@pytest.mark.skipif(
    not _client_deps_available(),
    reason="当前解释器缺 langchain_mcp_adapters 等客户端依赖，导入冒烟测试需在 ta-uv 环境下运行",
)
def test_clients_import_cleanly():
    """两份客户端能被导入（语法/依赖层面的冒烟检查），且导入后项目配置可解析。"""
    import client  # noqa: F401
    import client_simple  # noqa: F401

    cfg = client.Configuration()
    assert cfg.load_servers().keys() == BUNDLED_SERVERS.keys()
