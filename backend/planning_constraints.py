# -*- coding: utf-8 -*-
"""F2 规划约束的严格 wire 模型与纯 H/U 校验。

本模块只处理 ``POST /api/trips/plan`` 与 ``POST /api/trips/days/replan`` 的
可选 ``constraints`` 字段，不扩展 Trip v1 / DayReplanResponse，也不依赖
``travel_itinerary``，避免请求模型与领域模块之间出现循环 import。

边界：

- wire 字段、可空字段、scope、条数与 UTF-8 字节上限按
  ``docs/WORKSPACE_SIDECAR.md`` §11 定稿；可空字段必须显式 null。
- ``constraints`` 省略时调用方完全不进入这里，旧行为不变。
- 候选校验只做“有证据”的 H；时间占位、时长未知、跨日窗口、后段冻结段
  等无法由服务端确认的情况一律 U，不补 0、不声称已满足。
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from datetime import date as _date
from typing import Any, Literal, Mapping, Sequence

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_CONSTRAINT_ITEMS = 24
MAX_CONSTRAINTS_BYTES = 16 * 1024
MAX_CONSTRAINT_DAY = 7
MAX_CONSTRAINT_ID_LENGTH = 200
MAX_CONSTRAINT_TITLE_LENGTH = 120
MAX_CONSTRAINT_STOP_ID_LENGTH = 100
MAX_CONSTRAINT_FINGERPRINT_LENGTH = 64
MAX_CONSTRAINT_DURATION_MINUTES = 100_000
MAX_CONSTRAINT_PRIORITY = 3

CONSTRAINT_KINDS = ("must_visit", "fixed_window", "reminder")
CONSTRAINT_SCOPES = ("trip_plan", "day", "day_tail")
CONSTRAINT_UNVERIFIED_PREFIX = "约束未核实："
CONSTRAINT_HARD_FAILURE_PREFIX = "候选未满足硬约束："

_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u2028\u2029]")


def _require_int(
    value: Any, field_name: str, *, optional: bool = False
) -> int | None:
    if value is None and optional:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field_name} 必须是整数，不能是布尔值或字符串")
    return value


def _require_text(value: Any, field_name: str, *, max_length: int) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} 必须是字符串")
    if _CONTROL_CHARS.search(value) is not None:
        raise ValueError(f"{field_name} 不能包含控制字符")
    if not value.strip():
        raise ValueError(f"{field_name} 不能为空或全空白")
    if len(value) > max_length:
        raise ValueError(f"{field_name} 不能超过 {max_length} 字符")
    return value


def _optional_date(value: Any, field_name: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field_name} 必须是 YYYY-MM-DD 或 null")
    text = value.strip()
    if not text:
        raise ValueError(f"{field_name} 必须是 YYYY-MM-DD 或 null；空字符串请改用 null")
    if _DATE_RE.fullmatch(text) is None:
        raise ValueError(f"{field_name} 必须是 YYYY-MM-DD 或 null")
    try:
        return _date.fromisoformat(text).isoformat()
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} 必须是 YYYY-MM-DD 或 null") from exc


def _optional_time(value: Any, field_name: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field_name} 必须是 HH:MM 或 null")
    text = value.strip()
    if not text:
        raise ValueError(f"{field_name} 必须是 HH:MM 或 null；空字符串请改用 null")
    if _TIME_RE.fullmatch(text) is None:
        raise ValueError(f"{field_name} 必须是 HH:MM（24 小时制）或 null")
    return text


class PlanningConstraintItem(BaseModel):
    """wire 中的一条约束；可空字段没有默认值，省略即 422。"""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(..., min_length=1, max_length=MAX_CONSTRAINT_ID_LENGTH)
    kind: Literal["must_visit", "fixed_window", "reminder"]
    day: int | None = Field(..., ge=1, le=MAX_CONSTRAINT_DAY)
    stop_id: str | None = Field(..., min_length=1, max_length=MAX_CONSTRAINT_STOP_ID_LENGTH)
    title: str = Field(..., min_length=1, max_length=MAX_CONSTRAINT_TITLE_LENGTH)
    start_date: str | None
    end_date: str | None
    start_time: str | None
    end_time: str | None
    duration_minutes: int | None = Field(..., ge=0, le=MAX_CONSTRAINT_DURATION_MINUTES)
    priority: int = Field(..., ge=0, le=MAX_CONSTRAINT_PRIORITY)

    @field_validator("id", "title", mode="before")
    @classmethod
    def _check_text(cls, value: Any, info: Any) -> str:
        max_length = (
            MAX_CONSTRAINT_ID_LENGTH
            if info.field_name == "id"
            else MAX_CONSTRAINT_TITLE_LENGTH
        )
        return _require_text(value, info.field_name, max_length=max_length)

    @field_validator("stop_id", mode="before")
    @classmethod
    def _check_stop_id(cls, value: Any) -> str | None:
        if value is None:
            return None
        return _require_text(value, "stop_id", max_length=MAX_CONSTRAINT_STOP_ID_LENGTH)

    @field_validator("day", "duration_minutes", mode="before")
    @classmethod
    def _check_optional_int(cls, value: Any, info: Any) -> Any:
        return _require_int(value, info.field_name, optional=True)

    @field_validator("priority", mode="before")
    @classmethod
    def _check_required_int(cls, value: Any, info: Any) -> Any:
        return _require_int(value, info.field_name)

    @field_validator("start_date", "end_date", mode="before")
    @classmethod
    def _check_date(cls, value: Any, info: Any) -> str | None:
        return _optional_date(value, info.field_name)

    @field_validator("start_time", "end_time", mode="before")
    @classmethod
    def _check_time(cls, value: Any, info: Any) -> str | None:
        return _optional_time(value, info.field_name)

    @field_validator("priority")
    @classmethod
    def _check_priority(cls, value: int) -> int:
        if value > MAX_CONSTRAINT_PRIORITY:
            raise ValueError(f"priority 必须在 0..{MAX_CONSTRAINT_PRIORITY} 内")
        return value

    @model_validator(mode="after")
    def _check_kind_fields(self) -> "PlanningConstraintItem":
        if self.kind == "must_visit" and self.day is None:
            raise ValueError("must_visit.day 必填")
        return self


class PlanningConstraints(BaseModel):
    """请求里的可选 constraints 信封；内部结构严格 forbid。"""

    model_config = ConfigDict(extra="forbid")

    version: Literal[1]
    scope: Literal["trip_plan", "day", "day_tail"]
    day: int | None = Field(..., ge=1, le=MAX_CONSTRAINT_DAY)
    anchor_stop_id: str | None = Field(
        ..., min_length=1, max_length=MAX_CONSTRAINT_STOP_ID_LENGTH
    )
    # §11.2：fingerprint 是 wire 的必填不透明短索引；可空字段清单不含它。
    fingerprint: str = Field(
        ..., min_length=1, max_length=MAX_CONSTRAINT_FINGERPRINT_LENGTH
    )
    items: list[PlanningConstraintItem] = Field(..., max_length=MAX_CONSTRAINT_ITEMS)

    @field_validator("version", mode="before")
    @classmethod
    def _check_version(cls, value: Any) -> Any:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("version 只能是数字 1")
        return value

    @field_validator("day", mode="before")
    @classmethod
    def _check_day(cls, value: Any) -> Any:
        return _require_int(value, "day", optional=True)

    @field_validator("anchor_stop_id", mode="before")
    @classmethod
    def _check_anchor(cls, value: Any) -> str | None:
        if value is None:
            return None
        return _require_text(value, "anchor_stop_id", max_length=MAX_CONSTRAINT_STOP_ID_LENGTH)

    @field_validator("fingerprint", mode="before")
    @classmethod
    def _check_fingerprint(cls, value: Any) -> str:
        return _require_text(
            value, "fingerprint", max_length=MAX_CONSTRAINT_FINGERPRINT_LENGTH
        )

    @model_validator(mode="after")
    def _check_scope_fields(self) -> "PlanningConstraints":
        if self.scope == "trip_plan":
            if self.day is not None or self.anchor_stop_id is not None:
                raise ValueError("trip_plan 的 day / anchor_stop_id 必须为 null")
            for item in self.items:
                if item.stop_id is not None:
                    raise ValueError("trip_plan 的 items[].stop_id 必须为 null")
        elif self.scope == "day":
            if self.day is None:
                raise ValueError("day scope 的 day 必填")
            if self.anchor_stop_id is not None:
                raise ValueError("day scope 的 anchor_stop_id 必须为 null")
        else:  # day_tail
            if self.day is None:
                raise ValueError("day_tail scope 的 day 必填")
            if self.anchor_stop_id is None:
                raise ValueError("day_tail scope 的 anchor_stop_id 必填")

        if self.scope in ("day", "day_tail"):
            for item in self.items:
                if item.day is not None and item.day != self.day:
                    raise ValueError("items[].day 必须为 null 或等于 scope.day")
        if measure_constraints_wire_bytes(self) > MAX_CONSTRAINTS_BYTES:
            raise ValueError(
                f"constraints 超过 {MAX_CONSTRAINTS_BYTES} 字节上限；"
                "未发送，也没有丢弃部分约束"
            )
        return self


def measure_constraints_wire_bytes(value: Any) -> int:
    """按紧凑 UTF-8 wire JSON 测量 constraints 子对象字节数。"""

    if isinstance(value, PlanningConstraints):
        payload = value.model_dump(mode="json")
    elif isinstance(value, BaseModel):
        payload = value.model_dump(mode="json")
    elif isinstance(value, dict):
        payload = value
    else:
        raise ValueError("constraints 必须是对象")
    try:
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ValueError("constraints 必须是可序列化的 JSON 对象") from exc
    return len(encoded)


def check_constraints_wire_size(value: Any) -> Any:
    """请求字段的前置校验：超 16 KiB 整包拒绝，不截断、不丢条目。"""

    if value is None or isinstance(value, PlanningConstraints):
        return value
    size = measure_constraints_wire_bytes(value)
    if size > MAX_CONSTRAINTS_BYTES:
        raise ValueError(
            f"constraints 超过 {MAX_CONSTRAINTS_BYTES} 字节上限；"
            "未发送，也没有丢弃部分约束"
        )
    return value


def validate_trip_plan_constraints(constraints: PlanningConstraints) -> None:
    """初始规划没有 request.stops；scope 与所有 stop_id 都必须为空。"""

    if constraints.scope != "trip_plan":
        raise ValueError("初始规划只接受 constraints.scope='trip_plan'")
    if constraints.day is not None or constraints.anchor_stop_id is not None:
        raise ValueError("trip_plan 的 day / anchor_stop_id 必须为 null")
    for item in constraints.items:
        if item.stop_id is not None:
            raise ValueError("trip_plan 的 items[].stop_id 必须为 null")


def validate_day_replan_constraints(
    constraints: PlanningConstraints,
    *,
    day: int,
    stop_ids: Sequence[str],
) -> None:
    """整日 / 后段 replan 的 scope、day、anchor 与 stop 引用校验。"""

    if constraints.scope not in ("day", "day_tail"):
        raise ValueError("单日 replan 只接受 constraints.scope='day' 或 'day_tail'")
    if constraints.day != day:
        raise ValueError("constraints.day 必须等于 request.day")
    if constraints.scope == "day":
        if constraints.anchor_stop_id is not None:
            raise ValueError("day scope 的 anchor_stop_id 必须为 null")
    else:
        anchor = constraints.anchor_stop_id
        if anchor is None:
            raise ValueError("day_tail scope 的 anchor_stop_id 必填")
        if anchor not in stop_ids:
            raise ValueError("day_tail 的 anchor_stop_id 必须存在于 request.stops")
        if list(stop_ids).index(anchor) >= len(stop_ids) - 1:
            raise ValueError("day_tail 的 anchor_stop_id 之后必须还有可替换站点")

    known_ids = set(stop_ids)
    for item in constraints.items:
        if item.day is not None and item.day != day:
            raise ValueError("items[].day 必须为 null 或等于 request.day")
        if item.stop_id is not None and item.stop_id not in known_ids:
            raise ValueError("items[].stop_id 必须存在于 request.stops 且属于 request.day")


def render_constraints_prompt(constraints: PlanningConstraints) -> str:
    """把 constraints 渲染成独立 JSON 段；< / > 按现有 prompt 规则转义。"""

    payload = constraints.model_dump(mode="json")
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    text = text.replace("<", "\\u003c").replace(">", "\\u003e")
    return f"<constraints>\n{text}\n</constraints>"


def normalize_target_name(value: str) -> str:
    """§11.7：NFKC、trim、折叠空白、大小写归一；仅作解析线索。"""

    text = unicodedata.normalize("NFKC", value or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text.casefold()


@dataclass(frozen=True)
class ConstraintIssue:
    level: Literal["H", "U"]
    code: str
    constraint_id: str
    title: str
    message: str

    def safe_detail(self) -> str:
        constraint_id = (self.constraint_id or "").replace("\r", " ").replace("\n", " ")
        constraint_id = _CONTROL_CHARS.sub(" ", constraint_id).strip()
        if len(constraint_id) > 80:
            constraint_id = constraint_id[:80] + "…"
        title = (self.title or "").replace("\r", " ").replace("\n", " ")
        title = _CONTROL_CHARS.sub(" ", title).strip()
        if len(title) > 40:
            title = title[:40] + "…"
        return f"{constraint_id}「{title}」{self.message}"


def format_hard_failure(issues: Sequence[ConstraintIssue]) -> str:
    """H 级安全 detail：固定前缀 + 约束 id / 适度截断 title，不含 prompt。"""

    hard = [issue for issue in issues if issue.level == "H"]
    if not hard:
        return CONSTRAINT_HARD_FAILURE_PREFIX + "未知硬约束冲突"
    parts = [issue.safe_detail() for issue in hard[:3]]
    text = CONSTRAINT_HARD_FAILURE_PREFIX + "；".join(parts)
    if len(hard) > 3:
        text += f"；另有 {len(hard) - 3} 条硬约束冲突"
    if len(text) > 300:
        text = text[:299] + "…"
    return text


def format_unverified_warnings(issues: Sequence[ConstraintIssue]) -> list[str]:
    """U 级只走既有 warnings，固定前缀，不声称已满足。"""

    soft = [issue for issue in issues if issue.level == "U"]
    if not soft:
        return []
    parts = [issue.safe_detail() for issue in soft[:6]]
    text = CONSTRAINT_UNVERIFIED_PREFIX + "；".join(parts)
    if len(soft) > 6:
        text += f"；另有 {len(soft) - 6} 条未核实"
    if len(text) > 2000:
        text = text[:1999] + "…"
    return [text]


def _attr(value: Any, name: str, default: Any = None) -> Any:
    return getattr(value, name, default)


def _day_number(day: Any) -> int | None:
    number = _attr(day, "day")
    return number if isinstance(number, int) and not isinstance(number, bool) else None


def _day_date(day: Any) -> str | None:
    value = _attr(day, "date")
    return value if isinstance(value, str) else None


def _day_stops(day: Any) -> list[Any]:
    stops = _attr(day, "stops")
    return list(stops) if isinstance(stops, list) else []


def _day_legs(day: Any) -> list[Any]:
    legs = _attr(day, "legs")
    return list(legs) if isinstance(legs, list) else []


def _stop_id(stop: Any) -> str:
    value = _attr(stop, "id")
    return value if isinstance(value, str) else ""


def _stop_name(stop: Any) -> str:
    value = _attr(stop, "name")
    return value if isinstance(value, str) else ""


def _clock_minutes(value: Any) -> int | None:
    if not isinstance(value, str) or _TIME_RE.fullmatch(value) is None:
        return None
    hour, minute = value.split(":", 1)
    return int(hour) * 60 + int(minute)


def _date_value(value: Any) -> _date | None:
    if not isinstance(value, str) or _DATE_RE.fullmatch(value) is None:
        return None
    try:
        return _date.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def _duration_known(stop: Any) -> int | None:
    """候选 stop 的停留时长：只有非 bool 的非负整数才是已知值。"""

    value = _attr(stop, "duration_minutes")
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _incoming_transport_unknown(day: Any, target_stop: Any) -> bool:
    """目标站不是当日首站时，前一段交通耗时未知就不能声称到达可核。"""

    stops = _day_stops(day)
    target_index = next(
        (index for index, stop in enumerate(stops) if stop is target_stop),
        None,
    )
    if target_index is None or target_index == 0:
        return False
    legs = _day_legs(day)
    previous = stops[target_index - 1]
    leg = next(
        (
            entry
            for entry in legs
            if _attr(entry, "from_stop_id") == _stop_id(previous)
            and _attr(entry, "to_stop_id") == _stop_id(target_stop)
        ),
        None,
    )
    if leg is None and target_index - 1 < len(legs):
        leg = legs[target_index - 1]
    if leg is None:
        return True
    return _attr(leg, "route_type") != "navigation" or _attr(
        leg, "duration_minutes"
    ) is None


def _preceding_stop_evidence(
    day: Any, target_stop: Any, time_origins: Mapping[str, str]
) -> tuple[int | None, bool]:
    """返回 (目标站之前已知停留结束下界最大值, 是否存在未知前站)。

    未知前站不等于违规；它只说明无法用顺序证据做 H，必须降为 U。
    """

    stops = _day_stops(day)
    target_index = next(
        (index for index, stop in enumerate(stops) if stop is target_stop),
        None,
    )
    if target_index is None or target_index == 0:
        return None, False
    deepest: int | None = None
    unknown = False
    for stop in stops[:target_index]:
        if not _stop_time_is_model_known(stop, time_origins):
            unknown = True
            continue
        minutes = _clock_minutes(_attr(stop, "time"))
        duration = _duration_known(stop)
        if minutes is None or duration is None:
            unknown = True
            continue
        end = minutes + duration
        deepest = end if deepest is None else max(deepest, end)

    # 紧邻前一站到目标站若已有真实导航耗时，到达下界还要加上这段路程。
    immediate = stops[target_index - 1]
    if _stop_time_is_model_known(immediate, time_origins):
        minutes = _clock_minutes(_attr(immediate, "time"))
        duration = _duration_known(immediate)
        if minutes is not None and duration is not None:
            leg = next(
                (
                    entry
                    for entry in _day_legs(day)
                    if _attr(entry, "from_stop_id") == _stop_id(immediate)
                    and _attr(entry, "to_stop_id") == _stop_id(target_stop)
                ),
                None,
            )
            leg_duration = _duration_known(leg) if leg is not None else None
            if (
                leg is not None
                and _attr(leg, "route_type") == "navigation"
                and leg_duration is not None
            ):
                arrival = minutes + duration + leg_duration
                deepest = arrival if deepest is None else max(deepest, arrival)
    return deepest, unknown


def _stop_time_is_model_known(stop: Any, time_origins: Mapping[str, str]) -> bool:
    """只有归一化明确标记为 model 的 time 才能当已知证据。"""

    if _clock_minutes(_attr(stop, "time")) is None:
        return False
    return time_origins.get(_stop_id(stop)) == "model"


def _match_stops(stops: Sequence[Any], normalized_name: str) -> list[Any]:
    return [
        stop
        for stop in stops
        if normalize_target_name(_stop_name(stop)) == normalized_name
    ]


def _request_stop_by_id(request_stops: Sequence[Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for stop in request_stops:
        stop_id = _stop_id(stop)
        if stop_id:
            result[stop_id] = stop
    return result


def _frozen_request_stops(
    request_stops: Sequence[Any], anchor_stop_id: str | None
) -> list[Any]:
    if not anchor_stop_id:
        return []
    for index, stop in enumerate(request_stops):
        if _stop_id(stop) == anchor_stop_id:
            return list(request_stops[: index + 1])
    return []


def _target_day_for_item(
    item: PlanningConstraintItem, days: Sequence[Any]
) -> tuple[Any | None, str | None]:
    """返回 (day, unresolved_reason)。

    unresolved_reason 为 ``missing`` / ``ambiguous`` / ``date_unknown`` / ``unbound``。
    """

    if item.day is not None:
        matches = [day for day in days if _day_number(day) == item.day]
        if len(matches) == 1:
            return matches[0], None
        if len(matches) > 1:
            return None, "ambiguous"
        return None, "missing"

    if item.start_date is not None:
        matches = [day for day in days if _day_date(day) == item.start_date]
        if len(matches) == 1:
            return matches[0], None
        if len(matches) > 1:
            return None, "ambiguous"
        if any(_day_date(day) is not None for day in days):
            return None, "missing"
        return None, "date_unknown"

    return None, "unbound"


def _candidate_matches_across_days(
    days: Sequence[Any], normalized_name: str
) -> list[tuple[Any, Any]]:
    matches: list[tuple[Any, Any]] = []
    for day in days:
        for stop in _match_stops(_day_stops(day), normalized_name):
            matches.append((day, stop))
    return matches


def _issue(
    level: Literal["H", "U"],
    code: str,
    item: PlanningConstraintItem,
    message: str,
) -> ConstraintIssue:
    return ConstraintIssue(
        level=level,
        code=code,
        constraint_id=item.id,
        title=item.title,
        message=message,
    )


def _fixed_window_time_issues(
    item: PlanningConstraintItem,
    target_day: Any,
    target_stop: Any,
    time_origins: Mapping[str, str],
) -> list[ConstraintIssue]:
    """固定窗口的 H/U 判定；缺少必要端一律 U，不补 0。"""

    if (
        item.start_date is None
        or item.end_date is None
        or item.start_time is None
        or item.end_time is None
    ):
        return [_issue("U", "fixed_window_incomplete", item, "固定预约起止不完整，未核实")]

    start_date = _date_value(item.start_date)
    end_date = _date_value(item.end_date)
    start_minutes = _clock_minutes(item.start_time)
    end_minutes = _clock_minutes(item.end_time)
    day_date = _date_value(_day_date(target_day))
    if (
        start_date is None
        or end_date is None
        or start_minutes is None
        or end_minutes is None
        or day_date is None
    ):
        return [_issue("U", "fixed_window_date_unknown", item, "日期或时刻无法核实，未核实")]

    if start_date != end_date:
        return [_issue("U", "fixed_window_cross_day", item, "跨日预约窗口，需人工确认")]
    if day_date != start_date:
        # 日期是已知端，但目标日不是预约日：这是可确定的硬冲突，不是未知。
        return [
            _issue("H", "fixed_window_date_mismatch", item, "预约日期与目标日不一致")
        ]
    if end_minutes <= start_minutes:
        return [_issue("U", "fixed_window_window_invalid", item, "固定预约窗口起止不合法，未核实")]

    issues: list[ConstraintIssue] = []

    # 已知前一站结束下界晚于固定开始 = H；前站未知只降 U，不硬判。
    preceding_end, preceding_unknown = _preceding_stop_evidence(
        target_day, target_stop, time_origins
    )
    if preceding_end is not None and preceding_end > start_minutes:
        issues.append(
            _issue(
                "H",
                "fixed_window_sequence_violation",
                item,
                "前一站已知结束下界晚于固定预约开始",
            )
        )

    if not _stop_time_is_model_known(target_stop, time_origins):
        issues.append(
            _issue("U", "fixed_window_time_unknown", item, "站点时刻是占位或缺失值，未核实")
        )
        if not any(issue.level == "H" for issue in issues) and preceding_unknown:
            issues.append(
                _issue(
                    "U",
                    "fixed_window_predecessor_unknown",
                    item,
                    "前一站时刻或停留时长未知，无法核实顺序",
                )
            )
        return issues

    stop_minutes = _clock_minutes(_attr(target_stop, "time"))
    if stop_minutes is None:
        issues.append(
            _issue("U", "fixed_window_time_unknown", item, "站点时刻不是合法 HH:MM，未核实")
        )
        return issues

    if stop_minutes > start_minutes:
        issues.append(
            _issue("H", "fixed_window_start_violation", item, "到达时间晚于固定开始")
        )

    stop_duration = _duration_known(target_stop)
    if item.duration_minutes is None:
        # 约束停留时长是未知端：不能补 0，也不能硬判窗口结束。
        issues.append(
            _issue(
                "U",
                "fixed_window_duration_unknown",
                item,
                "约束停留时长为 null，无法核实窗口",
            )
        )
    elif stop_duration is None:
        # 候选停留时长未知时同样不能按 0 处理。
        issues.append(
            _issue(
                "U",
                "fixed_window_duration_unknown",
                item,
                "候选停留时长未知，无法核实窗口",
            )
        )
    else:
        required = max(item.duration_minutes, stop_duration)
        effective_start = max(stop_minutes, start_minutes)
        if effective_start + required > end_minutes:
            issues.append(
                _issue("H", "fixed_window_end_violation", item, "固定窗口内无法完成停留")
            )

    if not any(issue.level == "H" for issue in issues):
        if preceding_unknown:
            issues.append(
                _issue(
                    "U",
                    "fixed_window_predecessor_unknown",
                    item,
                    "前一站时刻或停留时长未知，无法核实顺序",
                )
            )
        if _incoming_transport_unknown(target_day, target_stop):
            issues.append(
                _issue(
                    "U",
                    "fixed_window_transport_unknown",
                    item,
                    "前一段交通耗时未知，未核实到达",
                )
            )
    return issues


def evaluate_candidate_constraints(
    *,
    constraints: PlanningConstraints,
    days: Sequence[Any],
    time_origins: Mapping[str, str] | None = None,
    request_stops: Sequence[Any] | None = None,
    anchor_stop_id: str | None = None,
) -> list[ConstraintIssue]:
    """按 §11.7 对候选做 H/U 证据检查。

    - 只按名称/日期/时刻等可见语义匹配；不按输出 stop id 当身份。
    - 零命中已知目标 = H；同名多站 / 多义 / 坐标无法确认 = U。
    - ``day_tail`` 的冻结前缀在服务端不可见，命中冻结段一律 U。
    """

    origins = time_origins or {}
    request_stops = list(request_stops or [])
    request_by_id = _request_stop_by_id(request_stops)
    frozen_stops = _frozen_request_stops(request_stops, anchor_stop_id)
    frozen_ids = {_stop_id(stop) for stop in frozen_stops if _stop_id(stop)}
    frozen_names = {
        normalize_target_name(_stop_name(stop)) for stop in frozen_stops if _stop_name(stop)
    }
    issues: list[ConstraintIssue] = []
    fixed_entries: list[tuple[PlanningConstraintItem, Any, Any]] = []

    for item in constraints.items:
        if item.kind == "reminder":
            continue

        if item.stop_id is not None and item.stop_id in frozen_ids:
            issues.append(
                _issue("U", "day_tail_frozen_target", item, "目标位于后段冻结范围，服务端不可见")
            )
            continue

        target_name: str
        if item.stop_id is not None:
            request_stop = request_by_id.get(item.stop_id)
            if request_stop is None:
                issues.append(
                    _issue("U", "request_stop_missing", item, "请求内的目标站点无法解析")
                )
                continue
            target_name = normalize_target_name(_stop_name(request_stop))
        else:
            target_name = normalize_target_name(item.title)

        # 未绑定 stop_id 且名称与冻结段重合：无法判断是新段同名站还是冻结站，只能 U。
        if item.stop_id is None and target_name in frozen_names:
            issues.append(
                _issue(
                    "U",
                    "day_tail_frozen_target",
                    item,
                    "目标名称与冻结段重合，服务端无法区分，需客户端复核",
                )
            )
            continue

        target_day, unresolved = _target_day_for_item(item, days)
        if target_day is None:
            if unresolved == "ambiguous":
                issues.append(_issue("U", "target_ambiguous", item, "目标日期不唯一，未核实"))
            elif unresolved == "date_unknown":
                issues.append(_issue("U", "target_date_unknown", item, "行程日期未知，未核实"))
            elif unresolved == "unbound":
                cross_matches = _candidate_matches_across_days(days, target_name)
                if len(cross_matches) == 1:
                    target_day, _ = cross_matches[0]
                elif len(cross_matches) > 1:
                    issues.append(_issue("U", "target_ambiguous", item, "同名多站，未核实"))
                    continue
                else:
                    if item.stop_id is None and frozen_names and target_name in frozen_names:
                        issues.append(
                            _issue(
                                "U",
                                "day_tail_frozen_target",
                                item,
                                "目标可能在冻结范围，服务端不可见",
                            )
                        )
                    else:
                        issues.append(
                            _issue("H", "target_missing", item, "已知目标在候选中缺失")
                        )
                    continue
            else:
                if item.stop_id is None and frozen_names and target_name in frozen_names:
                    issues.append(
                        _issue(
                            "U",
                            "day_tail_frozen_target",
                            item,
                            "目标可能在冻结范围，服务端不可见",
                        )
                    )
                else:
                    issues.append(_issue("H", "target_missing", item, "已知目标在候选中缺失"))
                continue

        matches = _match_stops(_day_stops(target_day), target_name)

        if item.kind == "must_visit":
            if len(matches) == 0:
                if item.stop_id is None and frozen_names and target_name in frozen_names:
                    issues.append(
                        _issue(
                            "U",
                            "day_tail_frozen_target",
                            item,
                            "目标可能在冻结范围，服务端不可见",
                        )
                    )
                else:
                    issues.append(
                        _issue("H", "must_visit_missing", item, "必去点在目标日缺失")
                    )
            elif len(matches) > 1:
                issues.append(
                    _issue("U", "must_visit_ambiguous", item, "同名多站，未核实是否满足")
                )
            continue

        # fixed_window
        if len(matches) == 0:
            if item.stop_id is None and frozen_names and target_name in frozen_names:
                issues.append(
                    _issue(
                        "U",
                        "day_tail_frozen_target",
                        item,
                        "目标可能在冻结范围，服务端不可见",
                    )
                )
            else:
                issues.append(
                    _issue("H", "fixed_window_target_missing", item, "固定预约目标在候选中缺失")
                )
            continue
        if len(matches) > 1:
            issues.append(
                _issue("U", "fixed_window_target_ambiguous", item, "同名多站，无法唯一确认预约目标")
            )
            continue

        target_stop = matches[0]
        fixed_entries.append((item, target_day, target_stop))
        issues.extend(
            _fixed_window_time_issues(item, target_day, target_stop, origins)
        )

    # 同日两个完整窗口重叠 = H；缺少端点的窗口已在上面标 U。
    complete_entries: list[tuple[PlanningConstraintItem, Any, Any, int, int, _date]] = []
    for item, target_day, target_stop in fixed_entries:
        if (
            item.start_date is None
            or item.end_date is None
            or item.start_time is None
            or item.end_time is None
        ):
            continue
        start_date = _date_value(item.start_date)
        end_date = _date_value(item.end_date)
        start_minutes = _clock_minutes(item.start_time)
        end_minutes = _clock_minutes(item.end_time)
        if (
            start_date is None
            or end_date is None
            or start_minutes is None
            or end_minutes is None
            or start_date != end_date
            or start_minutes >= end_minutes
        ):
            continue
        complete_entries.append(
            (item, target_day, target_stop, start_minutes, end_minutes, start_date)
        )

    for index, left in enumerate(complete_entries):
        for right in complete_entries[index + 1 :]:
            if left[5] != right[5]:
                continue
            if left[3] < right[4] and right[3] < left[4]:
                issues.append(
                    _issue("H", "fixed_window_overlap", left[0], "同日固定预约窗口重叠")
                )
                issues.append(
                    _issue("H", "fixed_window_overlap", right[0], "同日固定预约窗口重叠")
                )

    return issues
