"""
文件写入 MCP 服务器
提供文件读写功能，用于保存旅行计划、行程记录等

安全策略：
- 默认输出目录锚定在本模块所在的项目根目录下，不随进程工作目录变化
- 所有文件名都限制在 OUTPUT_DIR 内，拒绝绝对路径、盘符、UNC 路径和 ".." 目录遍历
- 读写前把路径按符号链接展开，展开后仍必须落在 OUTPUT_DIR 内
- save_travel_plan 用 destination 清洗出安全文件名，并用 O_CREAT|O_EXCL 原子创建；
  同一秒重复保存时编号重试，已存在的文件/目录/符号链接一律不覆盖
"""
import os
import re
import unicodedata
from datetime import datetime
from pathlib import Path

from mcp.server.fastmcp import FastMCP

# 初始化 MCP 服务器
mcp = FastMCP("WriteServer")

# 默认输出目录：锚定到本模块所在的项目根目录，不随进程工作目录变化
OUTPUT_DIR = str(Path(__file__).resolve().parent / "outputs")

# Windows 保留设备名（不区分大小写，CON.txt 这类带扩展名的形式同样保留）
_WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}

# 文件名中不允许出现的字符（Windows 非法字符 + 控制字符）
_UNSAFE_NAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

# save_travel_plan 同名候选的最大编号尝试次数
_MAX_SAVE_ATTEMPTS = 10000


def _get_output_dir() -> Path:
    """返回 OUTPUT_DIR 的绝对路径（符号链接展开后）。"""
    return Path(OUTPUT_DIR).resolve()


def _validate_name_characters(candidate: Path) -> None:
    """校验文件名各段的字符：拒绝 Windows 非法字符、控制字符和保留设备名。"""
    for part in candidate.parts:
        if _UNSAFE_NAME_CHARS.search(part):
            raise ValueError(f"文件名包含不允许的字符: {part!r}")
        stem = part.split(".")[0].upper()
        if stem in _WINDOWS_RESERVED:
            raise ValueError(f"文件名使用了 Windows 保留设备名: {part}")


def _resolve_output_path(filename: str, *, create_dir: bool = False) -> Path:
    """
    把用户提供的 filename 安全地解析到 OUTPUT_DIR 内。

    :param filename: 用户提供的相对文件名（允许 "子目录/文件名" 形式）
    :param create_dir: 是否确保 OUTPUT_DIR 存在（写入时需要）
    :return: OUTPUT_DIR 内的目标绝对路径
    :raises ValueError: filename 为空、绝对路径、包含 ".."、
        越出输出目录或经由符号链接越出输出目录
    """
    if not isinstance(filename, str) or not filename.strip():
        raise ValueError("文件名不能为空")

    filename = filename.strip()
    # 统一把反斜杠当普通分隔符处理，避免 "..\\x" 这类写法在不同平台语义不一致
    filename = filename.replace("\\", "/")
    candidate = Path(filename)
    if not candidate.parts:
        raise ValueError(f"文件名无效: {filename}")

    # 拒绝盘符路径（C:/x、C:x）与 UNC 路径（//server/share）
    if candidate.drive or candidate.root:
        raise ValueError(f"不允许使用绝对路径或盘符: {filename}")
    if candidate.is_absolute():
        raise ValueError(f"不允许使用绝对路径: {filename}")

    # 拒绝 ".." 目录遍历
    if ".." in candidate.parts:
        raise ValueError(f"文件名不允许包含 '..': {filename}")

    _validate_name_characters(candidate)

    base = _get_output_dir()
    target = base.joinpath(candidate)

    if create_dir:
        os.makedirs(base, exist_ok=True)

    # 符号链接展开后必须仍位于 OUTPUT_DIR 内
    real_target = target.resolve()
    if real_target != base and base not in real_target.parents:
        raise ValueError(f"路径越出了输出目录（可能经过符号链接）: {filename}")

    return real_target


def _sanitize_destination(destination: str) -> str:
    """
    把目的地清洗成安全的文件名片段。

    - 先做 NFKC 归一化（全角斜杠等会变回半角，再统一替换）
    - 路径分隔符、Windows 非法字符、控制字符统一替换为下划线
    - 去掉前后点号/下划线，规避 ".."、隐藏文件与 Windows 保留设备名
    - 最长保留 50 个字符
    """
    if not isinstance(destination, str):
        raise ValueError("目的地必须是字符串")

    text = unicodedata.normalize("NFKC", destination).strip()
    text = _UNSAFE_NAME_CHARS.sub("_", text)
    text = re.sub(r"\s+", "_", text)
    text = re.sub(r"_+", "_", text).strip("._ ")

    if not text:
        text = "destination"
    if text.split(".")[0].upper() in _WINDOWS_RESERVED:
        text = f"_{text}"
    if len(text) > 50:
        text = text[:50].rstrip("._ ")
    return text or "destination"


def _prepare_output_dir() -> Path:
    """解析输出目录并确保它真实存在且是目录（符号链接展开后）。"""
    base = _get_output_dir()
    os.makedirs(base, exist_ok=True)
    if not base.is_dir():
        raise ValueError(f"输出路径不是目录: {base}")
    return base


def _exclusive_create(path: Path, content: str) -> None:
    """
    原子排他地创建文本文件并写入内容。

    使用 O_CREAT|O_EXCL：同名文件、目录或符号链接已存在时直接抛 FileExistsError，
    不做任何截断或覆盖；创建后再复核路径不是符号链接，防止平台层沿重解析点写出目录。
    """
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_BINARY"):
        flags |= os.O_BINARY
    fd = os.open(path, flags, 0o600)
    try:
        if os.path.islink(path):
            raise ValueError(f"目标路径是符号链接，拒绝写入: {path}")
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            fd = -1
            stream.write(content)
    finally:
        if fd != -1:
            os.close(fd)


@mcp.tool()
async def write_file(filename: str, content: str) -> str:
    """
    将内容写入文件。
    :param filename: 文件名（会自动添加到 outputs 目录）
    :param content: 要写入的内容
    :return: 写入结果
    """
    try:
        filepath = _resolve_output_path(filename, create_dir=True)

        # 支持 "子目录/文件名" 形式，自动补齐 outputs 内的子目录
        os.makedirs(filepath.parent, exist_ok=True)

        # 写入文件
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)

        return f"✅ 文件已成功保存到: {filepath}"
    except Exception as e:
        return f"❌ 写入失败: {e}"


@mcp.tool()
async def read_file(filename: str) -> str:
    """
    读取文件内容。
    :param filename: 文件名（从 outputs 目录读取）
    :return: 文件内容
    """
    try:
        filepath = _resolve_output_path(filename, create_dir=False)

        if not filepath.exists():
            return f"❌ 文件不存在: {filepath}"

        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()

        return content
    except Exception as e:
        return f"❌ 读取失败: {e}"


@mcp.tool()
async def list_files() -> str:
    """
    列出 outputs 目录下的所有文件。
    :return: 文件列表
    """
    try:
        base = _get_output_dir()
        if not base.exists():
            return "📁 输出目录为空"

        files = os.listdir(base)
        if not files:
            return "📁 输出目录为空"

        file_list = "\n".join([f"  📄 {f}" for f in files])
        return f"📁 已保存的文件:\n{file_list}"
    except Exception as e:
        return f"❌ 列出文件失败: {e}"


@mcp.tool()
async def save_travel_plan(destination: str, plan: str) -> str:
    """
    保存旅行计划到文件。
    :param destination: 目的地名称
    :param plan: 旅行计划内容
    :return: 保存结果
    """
    try:
        safe_destination = _sanitize_destination(destination)
        base = _prepare_output_dir()

        now = datetime.now()
        base_name = f"travel_plan_{safe_destination}_{now.strftime('%Y%m%d_%H%M%S')}"

        # 格式化内容
        formatted_content = f"""# 🗺️ {destination} 旅行计划

📅 创建时间: {now.strftime("%Y年%m月%d日 %H:%M")}

---

{plan}

---
*由智能出行助手自动生成*
"""

        # 原子排他创建：exists/lexists 只用于快速跳过，真正的防覆盖由 O_EXCL 保证。
        # 候选名从无编号开始递增，同名文件、目录或悬空符号链接都已存在时自动编号重试。
        filepath = None
        for i in range(_MAX_SAVE_ATTEMPTS):
            name = f"{base_name}.md" if i == 0 else f"{base_name}_{i}.md"
            candidate = base / name
            if os.path.lexists(candidate):
                continue
            try:
                _exclusive_create(candidate, formatted_content)
            except FileExistsError:
                continue
            filepath = candidate
            break

        if filepath is None:
            return "❌ 保存失败: 同一秒内保存次数过多，请稍后重试"

        return f"✅ 旅行计划已保存到: {filepath}"
    except Exception as e:
        return f"❌ 保存失败: {e}"


if __name__ == "__main__":
    mcp.run(transport='stdio')
