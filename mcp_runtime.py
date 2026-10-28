"""旧客户端（client.py / client_simple.py）共用的 MCP 运行时辅助模块。

解决的问题：
- servers_config.json 里四个自带 server 的 command 原来写死成
  ``.\\venv\\Scripts\\python.exe``，脚本参数是相对路径，导致换 .venv、
  在 Linux/macOS 上运行、或从其他工作目录启动 CLI 时全部连不上。
- 配置文件与 agent_prompts.txt 原来按当前工作目录查找，换目录启动就找不到。

职责边界：
- 默认配置与系统提示词锚定在本模块所在目录（即项目根目录），
  与启动时的工作目录无关；整个项目搬到别的盘符/路径也能用。
- 只对「命令看起来是 Python 解释器、且该路径实际不存在」的情况回退到
  当前运行的 sys.executable；自带 server 的 *.py 脚本参数解析成已存在的
  绝对路径。
- 通过 MCP_CONFIG 指定的自定义配置尽量原样保留：command、args、env、
  transport、url、headers 都不动；非 Python 程序（npx/node/uvx 等）
  绝不会被改写成 Python。
- 本模块不读取、不记录、不输出任何密钥；条目里的 env 字段只做透传，
  由 MCP 子进程自行继承。

本模块不修改磁盘上的任何配置文件。
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Union

# 项目根目录：mcp_runtime.py 与 client*.py、servers_config.json 同层
PROJECT_DIR = Path(__file__).resolve().parent

DEFAULT_CONFIG_FILENAME = "servers_config.json"
DEFAULT_PROMPT_FILENAME = "agent_prompts.txt"
CONFIG_ENV_VAR = "MCP_CONFIG"

# 匹配「命令名就是 Python 解释器」的情况：
# python / python3 / python3.12 / pythonw / python.exe / python3.exe ...
# 不匹配 npx、node、my_python_helper.exe 之类的其他程序。
_PYTHON_NAME_RE = re.compile(
    r"^python(?:[\d.]+)?w?(?:\.exe|\.bat|\.cmd)?$", re.IGNORECASE
)


def _looks_like_python_command(command: str) -> bool:
    """判断命令名是否为 Python 解释器（按 basename 判断，与路径分隔符无关）。"""
    name = Path(command.replace("\\", "/")).name
    return bool(_PYTHON_NAME_RE.match(name))


def _first_existing(*candidates: Optional[Path]) -> Optional[Path]:
    for candidate in candidates:
        if candidate is None:
            continue
        try:
            if candidate.is_file():
                return candidate
        except OSError:
            continue
    return None


def find_config_path(explicit: Union[str, Path, None] = None) -> Path:
    """定位 MCP 配置文件。

    优先级：显式参数 > MCP_CONFIG 环境变量 > 项目目录默认配置。
    相对路径依次按「当前工作目录 → 项目目录」查找；都找不到时抛出
    FileNotFoundError，并给出尝试过的位置（只含路径，不含任何密钥）。
    """
    raw = explicit if explicit is not None else os.getenv(CONFIG_ENV_VAR)
    if raw:
        expanded = Path(raw).expanduser()
        if expanded.is_absolute():
            candidates = [expanded]
        else:
            candidates = [Path.cwd() / expanded, PROJECT_DIR / expanded]
        for candidate in candidates:
            try:
                if candidate.is_file():
                    return candidate.resolve()
            except OSError:
                continue
        tried = "、".join(str(c) for c in candidates)
        raise FileNotFoundError(
            f"未找到 MCP 配置文件「{raw}」，尝试过以下位置: {tried}。"
            f"请检查 MCP_CONFIG 环境变量或传入正确的配置文件路径。"
        )
    return PROJECT_DIR / DEFAULT_CONFIG_FILENAME


def _resolve_command(
    command: str, config_dir: Path, project_dir: Path
) -> str:
    """解析单条 command。

    - 相对路径按「配置文件所在目录 → 当前工作目录」查找，命中则转绝对路径；
    - 命中存在的解释器文件时原样保留（绝对化），尊重用户自己的 venv；
    - 带路径分隔符、看起来是 Python 解释器、但哪里都找不到时（典型：
      旧配置写死的 .\\venv\\Scripts\\python.exe），回退到当前运行的
      sys.executable——仍然运行 Python，只是换成实际可用的那个；
    - 裸命令（python / npx / node 等，无路径分隔符）一律不动，
      交给操作系统按 PATH 解析；非 Python 程序永远不会被改写。
    """
    text = command.strip()
    if not text:
        return command

    raw = Path(text)
    is_python = _looks_like_python_command(text)

    if raw.is_absolute():
        candidates = [raw]
    else:
        candidates = [config_dir / raw, Path.cwd() / raw]
    found = _first_existing(*candidates)
    if found is not None:
        return str(found.resolve())

    has_separator = ("\\" in text) or ("/" in text)
    if is_python and has_separator:
        # 旧配置的硬编码解释器路径不存在（.venv / Linux / 换机器等场景）。
        return sys.executable
    return command


def _resolve_args(
    args: Any, config_dir: Path, project_dir: Path
) -> Any:
    """解析 args 中指向 Python 脚本的相对路径（仅对 Python 解释器条目调用）。

    相对 *.py 参数按「配置文件所在目录 → 项目目录」查找，命中则转绝对路径；
    找不到的参数（-m、--flag 等）原样保留。
    """
    if not isinstance(args, list):
        return args
    resolved: list = []
    for arg in args:
        if isinstance(arg, str) and arg.endswith(".py"):
            raw = Path(arg)
            if raw.is_absolute():
                candidates = [raw]
            else:
                candidates = [config_dir / raw, project_dir / raw]
            found = _first_existing(*candidates)
            if found is not None:
                resolved.append(str(found.resolve()))
                continue
        resolved.append(arg)
    return resolved


def _normalize_entry(entry: Any, config_dir: Path, project_dir: Path) -> Any:
    """规整单个 server 条目；非 dict 条目原样交回，由 MCP 客户端自行报错。"""
    if not isinstance(entry, dict):
        return entry
    item = dict(entry)

    command = item.get("command")
    if isinstance(command, str) and command.strip():
        is_python = _looks_like_python_command(command)
        item["command"] = _resolve_command(command, config_dir, project_dir)
        if is_python:
            item["args"] = _resolve_args(item.get("args"), config_dir, project_dir)

    # env / transport / url / headers 等其余字段一律原样保留。
    return item


def resolve_servers(
    raw_servers: Any,
    config_dir: Union[str, Path, None] = None,
    project_dir: Union[str, Path, None] = None,
) -> Dict[str, Any]:
    """安全解析 mcpServers 配置，返回可直接交给 MultiServerMCPClient 的 dict。

    不写磁盘、不打印、不读取环境变量里的密钥。
    """
    config_dir = Path(config_dir) if config_dir else PROJECT_DIR
    project_dir = Path(project_dir) if project_dir else PROJECT_DIR
    if not isinstance(raw_servers, dict):
        return {}
    resolved: Dict[str, Any] = {}
    for name, entry in raw_servers.items():
        resolved[name] = _normalize_entry(entry, config_dir, project_dir)
    return resolved


def load_server_config(config_path: Union[str, Path, None] = None) -> Dict[str, Any]:
    """读取并解析 MCP 配置文件，返回规整后的 servers dict。"""
    path = find_config_path(config_path)
    with open(path, "r", encoding="utf-8") as f:
        config = json.load(f)
    servers = config.get("mcpServers", {}) if isinstance(config, dict) else {}
    return resolve_servers(servers, config_dir=path.parent)


def find_prompt_path(prompt_path: Union[str, Path, None] = None) -> Path:
    """定位系统提示词文件，默认锚定项目目录。"""
    if prompt_path:
        return Path(prompt_path).expanduser()
    return PROJECT_DIR / DEFAULT_PROMPT_FILENAME


def load_prompt(prompt_path: Union[str, Path, None] = None) -> str:
    """读取系统提示词内容。"""
    path = find_prompt_path(prompt_path)
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def safe_print(message: str) -> None:
    """打印错误提示；输出被重定向到 GBK 编码的管道/文件时降级为可打印文本。

    与 api_server.py 的 _print_safe 同一套策略，保证「缺少 API Key /
    配置错误」这类提示在任何输出环境下都能到达用户，而不是自己先崩溃。
    """
    try:
        print(message)
    except UnicodeEncodeError:
        encoding = getattr(sys.stdout, "encoding", None) or "ascii"
        try:
            print(message.encode(encoding, "replace").decode(encoding, "replace"))
        except Exception:
            print(message.encode("ascii", "replace").decode("ascii"))
