# -*- coding: utf-8 -*-
"""write_server 路径安全与输出保护测试。

覆盖：中文文件名正常读写、相对/绝对/Windows 风格路径遍历被拒、
不访问输出目录外的真实文件、符号链接越界拒绝、
save_travel_plan 目的地清洗与时间戳冲突不覆盖、已有输出不被删除。
"""

import asyncio
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import pytest

import write_server


def run(coro_fn, *args, **kwargs):
    """同步调用 MCP 工具的 async 函数。"""
    return asyncio.run(coro_fn(*args, **kwargs))


@pytest.fixture()
def outputs_dir(tmp_path, monkeypatch):
    """把 OUTPUT_DIR 指向测试专用临时目录，避免碰真实 outputs。"""
    outputs = tmp_path / "outputs"
    monkeypatch.setattr(write_server, "OUTPUT_DIR", str(outputs))
    return outputs


# ---------------------------------------------------------------- 正常功能


def test_write_and_read_chinese_filename(outputs_dir):
    result = run(write_server.write_file, "旅行计划.md", "内容：西湖两日游")
    assert "✅" in result
    assert (outputs_dir / "旅行计划.md").exists()

    content = run(write_server.read_file, "旅行计划.md")
    assert content == "内容：西湖两日游"


def test_subdirectory_filename_stays_inside(outputs_dir):
    result = run(write_server.write_file, "backup/日程.md", "x")
    assert "✅" in result
    assert (outputs_dir / "backup" / "日程.md").exists()


def test_read_missing_file_reports_error(outputs_dir):
    result = run(write_server.read_file, "不存在.md")
    assert "❌" in result
    assert "文件不存在" in result


def test_list_files_lists_existing(outputs_dir):
    outputs_dir.mkdir()
    (outputs_dir / "旧计划.md").write_text("旧", encoding="utf-8")
    listing = run(write_server.list_files)
    assert "旧计划.md" in listing


# ---------------------------------------------------------------- 路径遍历与绝对路径


@pytest.mark.parametrize(
    "bad_name",
    [
        "../outside.txt",           # 相对路径遍历
        "..\\outside.txt",          # Windows 反斜杠遍历
        "a/../../outside.txt",      # 混合遍历
        "C:/evil.txt",              # 盘符路径
        "//server/share/x.txt",     # UNC 路径
        "a<b>.md",                  # Windows 非法字符
        "CON.md",                   # Windows 保留设备名
        "",                         # 空文件名
        "   ",                      # 纯空白
    ],
)
def test_rejected_filenames(tmp_path, outputs_dir, bad_name):
    write_result = run(write_server.write_file, bad_name, "HACKED")
    assert write_result.startswith("❌"), f"应拒绝 {bad_name!r}: {write_result}"

    read_result = run(write_server.read_file, bad_name)
    assert read_result.startswith("❌"), f"读取也应拒绝 {bad_name!r}"

    # 目录外不应出现任何新文件
    assert not (tmp_path / "outside.txt").exists()
    assert not (tmp_path / "evil.txt").exists()
    assert not Path("C:/evil.txt").exists()
    if outputs_dir.exists():
        assert list(outputs_dir.glob("**/*")) == []


def test_absolute_path_from_tmp_rejected(tmp_path, outputs_dir):
    """平台无关的绝对路径（用 tmp_path 构造）必须被拒绝。"""
    outside = tmp_path / "abs_outside.txt"
    outside.write_text("TOPSECRET", encoding="utf-8")

    write_result = run(write_server.write_file, str(outside), "HACKED")
    assert write_result.startswith("❌")
    assert outside.read_text(encoding="utf-8") == "TOPSECRET"


def test_outside_real_file_not_touched(tmp_path, outputs_dir):
    """遍历尝试既不能读到也不能改写目录外的真实文件。"""
    outputs_dir.mkdir()
    secret = tmp_path / "real_secret.txt"
    secret.write_text("TOPSECRET", encoding="utf-8")

    read_result = run(write_server.read_file, "../real_secret.txt")
    assert "❌" in read_result
    assert "TOPSECRET" not in read_result

    write_result = run(write_server.write_file, "../real_secret.txt", "HACKED")
    assert "❌" in write_result
    assert secret.read_text(encoding="utf-8") == "TOPSECRET"


def test_symlink_escape_rejected(tmp_path, outputs_dir):
    """符号链接指向目录外时，读写都必须被拒绝。"""
    if sys.platform == "win32" and not os.environ.get("WINDIR"):
        pytest.skip("非 Windows 环境跳过 Windows 分支")
    outputs_dir.mkdir()
    outside = tmp_path / "outside_secret.txt"
    outside.write_text("TOPSECRET", encoding="utf-8")
    link = outputs_dir / "link.txt"
    try:
        os.symlink(outside, link)
    except (OSError, NotImplementedError):
        pytest.skip("当前环境无权限创建符号链接")

    read_result = run(write_server.read_file, "link.txt")
    assert read_result.startswith("❌")
    assert "TOPSECRET" not in read_result

    write_result = run(write_server.write_file, "link.txt", "HACKED")
    assert write_result.startswith("❌")
    assert outside.read_text(encoding="utf-8") == "TOPSECRET"


def test_symlinked_subdirectory_escape_rejected(tmp_path, outputs_dir):
    """outputs 内的符号链接子目录同样不能成为越界出口。"""
    outputs_dir.mkdir()
    target_dir = tmp_path / "elsewhere"
    target_dir.mkdir()
    link_dir = outputs_dir / "subdir"
    try:
        os.symlink(target_dir, link_dir, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("当前环境无权限创建符号链接")

    result = run(write_server.write_file, "subdir/new.txt", "HACKED")
    assert result.startswith("❌")
    assert not (target_dir / "new.txt").exists()


# ---------------------------------------------------------------- save_travel_plan


def test_save_travel_plan_chinese_destination(outputs_dir):
    result = run(write_server.save_travel_plan, "杭州", "第一天：西湖")
    assert "✅" in result
    files = list(outputs_dir.glob("travel_plan_杭州_*.md"))
    assert len(files) == 1
    content = files[0].read_text(encoding="utf-8")
    assert "杭州" in content
    assert "西湖" in content


@pytest.mark.parametrize(
    "destination",
    ["../evil", "..\\evil", "C:/evil", "西/湖", "a*b?c", "CON", "", "   ", ".."],
)
def test_save_travel_plan_destination_sanitized(outputs_dir, destination):
    result = run(write_server.save_travel_plan, destination, "计划")
    assert "✅" in result

    files = list(outputs_dir.glob("travel_plan_*.md"))
    assert files, "文件应保存在 outputs 目录内"
    for f in files:
        # 文件名不应包含路径分隔符或 Windows 非法字符
        assert not any(ch in f.name for ch in '/\\<>:"|?*')
        assert f.parent == outputs_dir

    # 目录外不应有任何写入
    assert not (outputs_dir.parent / "evil").exists()


def test_save_travel_plan_same_second_no_overwrite(outputs_dir, monkeypatch):
    """同一秒重复保存时追加序号，不覆盖旧文件。"""

    class FakeDatetime:
        @staticmethod
        def now():
            return datetime(2026, 1, 1, 12, 0, 0)

    monkeypatch.setattr(write_server, "datetime", FakeDatetime)

    r1 = run(write_server.save_travel_plan, "杭州", "计划一")
    r2 = run(write_server.save_travel_plan, "杭州", "计划二")
    assert "✅" in r1
    assert "✅" in r2

    files = sorted(outputs_dir.glob("travel_plan_杭州_20260101_120000*.md"))
    assert len(files) == 2
    contents = [f.read_text(encoding="utf-8") for f in files]
    assert "计划一" in contents[0]
    assert "计划二" in contents[1]
    assert contents[0] != contents[1]


def test_existing_outputs_not_deleted(outputs_dir):
    """修复后不得删除或改写用户已有输出。"""
    outputs_dir.mkdir()
    keep = outputs_dir / "旧计划.md"
    keep.write_text("旧内容", encoding="utf-8")

    run(write_server.save_travel_plan, "北京", "新计划")
    run(write_server.write_file, "笔记.md", "新笔记")

    assert keep.read_text(encoding="utf-8") == "旧内容"
    listing = run(write_server.list_files)
    assert "旧计划.md" in listing


# ---------------------------------------------------------------- 原子写入与竞态

_FROZEN = datetime(2026, 3, 4, 5, 6, 7)


def _freeze_datetime(monkeypatch, moment=_FROZEN):
    """固定 write_server.datetime.now()，让同一秒的候选文件名可预测。"""

    class FakeDatetime:
        @staticmethod
        def now():
            return moment

    monkeypatch.setattr(write_server, "datetime", FakeDatetime)


def test_save_travel_plan_does_not_overwrite_existing_same_name(outputs_dir, monkeypatch):
    """同名候选已存在（同一秒）时必须编号避开，原有内容一字不能动。"""
    _freeze_datetime(monkeypatch)
    outputs_dir.mkdir()
    existing = outputs_dir / "travel_plan_北京_20260304_050607.md"
    existing.write_text("ORIGINAL", encoding="utf-8")

    result = run(write_server.save_travel_plan, "北京", "新计划")
    assert "✅" in result

    assert existing.read_text(encoding="utf-8") == "ORIGINAL"
    created = outputs_dir / "travel_plan_北京_20260304_050607_1.md"
    assert created.exists()
    assert "新计划" in created.read_text(encoding="utf-8")


def test_save_travel_plan_concurrent_same_second_never_overwrites(outputs_dir, monkeypatch):
    """固定时间并发保存，每个结果都落到独立文件，内容互不覆盖。"""
    _freeze_datetime(monkeypatch)
    outputs_dir.mkdir()
    plans = [f"并发计划-{i}" for i in range(8)]

    def _save(plan):
        return asyncio.run(write_server.save_travel_plan("并发", plan))

    with ThreadPoolExecutor(max_workers=len(plans)) as pool:
        results = list(pool.map(_save, plans))

    assert all("✅" in r for r in results), results
    files = list(outputs_dir.glob("travel_plan_并发_20260304_050607*.md"))
    assert len(files) == len(plans), [f.name for f in files]
    stored = [f.read_text(encoding="utf-8") for f in files]
    for plan in plans:
        assert sum(1 for text in stored if plan in text) == 1, plan


def test_save_travel_plan_skips_dangling_symlink(outputs_dir, tmp_path, monkeypatch):
    """同名悬空符号链接不能被 open 跟随写出目录，应换编号创建新文件。"""
    _freeze_datetime(monkeypatch)
    outputs_dir.mkdir()
    outside = tmp_path / "outside_target.md"
    link = outputs_dir / "travel_plan_杭州_20260304_050607.md"
    try:
        os.symlink(outside, link)
    except (OSError, NotImplementedError):
        pytest.skip("当前环境无权限创建符号链接（Windows 需管理员权限或开发者模式）")

    assert not link.exists()          # 悬空链接：exists() 为假，旧实现会沿链接写出去
    assert os.path.lexists(link)

    result = run(write_server.save_travel_plan, "杭州", "计划")
    assert "✅" in result

    assert not outside.exists(), "不得沿悬空符号链接在输出目录外创建文件"
    assert os.path.islink(link)
    created = outputs_dir / "travel_plan_杭州_20260304_050607_1.md"
    assert created.exists()
    assert "计划" in created.read_text(encoding="utf-8")


def test_save_travel_plan_existing_directory_not_replaced(outputs_dir, monkeypatch):
    """同名路径是目录时也不能被当成文件覆盖。"""
    _freeze_datetime(monkeypatch)
    outputs_dir.mkdir()
    occupied = outputs_dir / "travel_plan_上海_20260304_050607.md"
    occupied.mkdir()

    result = run(write_server.save_travel_plan, "上海", "计划")
    assert "✅" in result
    assert occupied.is_dir()
    assert (outputs_dir / "travel_plan_上海_20260304_050607_1.md").exists()
