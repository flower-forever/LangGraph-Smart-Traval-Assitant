# -*- coding: utf-8 -*-
"""F2 constraints 纯模型 / H-U 证据测试（无 HTTP、无外网）。"""

import json
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from planning_constraints import (
    MAX_CONSTRAINTS_BYTES,
    PlanningConstraints,
    check_constraints_wire_size,
    evaluate_candidate_constraints,
    format_hard_failure,
    normalize_target_name,
    validate_day_replan_constraints,
    validate_trip_plan_constraints,
)


def item(**overrides):
    data = {
        "id": "constraint-1",
        "kind": "must_visit",
        "day": 1,
        "stop_id": None,
        "title": "博物馆",
        "start_date": None,
        "end_date": None,
        "start_time": None,
        "end_time": None,
        "duration_minutes": None,
        "priority": 1,
    }
    data.update(overrides)
    return data


def constraints(items=None, *, scope="trip_plan", day=None, anchor_stop_id=None):
    return PlanningConstraints(
        version=1,
        scope=scope,
        day=day,
        anchor_stop_id=anchor_stop_id,
        fingerprint="a1b2c3d4",
        items=items if items is not None else [item()],
    )


def stop(stop_id, name, time="09:00", duration=60):
    return SimpleNamespace(
        id=stop_id,
        name=name,
        time=time,
        duration_minutes=duration,
        location=None,
    )


def day(number, date, stops):
    return SimpleNamespace(day=number, date=date, title="", summary="", stops=stops)


def by_level(issues, level):
    return [issue for issue in issues if issue.level == level]


def test_constraint_item_requires_explicit_nullable_fields():
    data = item()
    del data["start_date"]
    with pytest.raises(ValidationError):
        constraints(items=[data])


def test_constraint_item_rejects_bool_and_out_of_range():
    for override in ({"day": True}, {"duration_minutes": True}, {"priority": True}):
        with pytest.raises(ValidationError):
            constraints(items=[item(**override)])
    with pytest.raises(ValidationError):
        constraints(items=[item(day=8)])
    with pytest.raises(ValidationError):
        constraints(items=[item(duration_minutes=-1)])
    with pytest.raises(ValidationError):
        constraints(items=[item(priority=4)])


def test_trip_plan_scope_rejects_stop_binding():
    with pytest.raises(ValidationError):
        constraints(items=[item(stop_id="s1")])


def test_trip_plan_request_scope_validation():
    validate_trip_plan_constraints(constraints())
    with pytest.raises(ValueError):
        validate_trip_plan_constraints(constraints(scope="day", day=1))


def test_day_scope_requires_day_and_valid_stop_reference():
    good = constraints(
        items=[item(kind="must_visit", day=2, stop_id="s1")],
        scope="day",
        day=2,
    )
    validate_day_replan_constraints(good, day=2, stop_ids=["s1", "s2"])

    with pytest.raises(ValidationError):
        constraints(items=[item(kind="must_visit", day=3)], scope="day", day=2)
    with pytest.raises(ValueError):
        validate_day_replan_constraints(
            constraints(items=[item(kind="must_visit", day=2, stop_id="missing")], scope="day", day=2),
            day=2,
            stop_ids=["s1"],
        )
    with pytest.raises(ValueError):
        validate_day_replan_constraints(
            constraints(scope="day_tail", day=2, anchor_stop_id="s1"),
            day=2,
            stop_ids=["s1"],
        )


def test_byte_limit_uses_compact_utf8():
    payload = {
        "version": 1,
        "scope": "trip_plan",
        "day": None,
        "anchor_stop_id": None,
        "fingerprint": "a1b2c3d4",
        "items": [
            item(id="约" * 200, title="约" * 120) for _ in range(24)
        ],
    }
    assert len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_CONSTRAINTS_BYTES
    with pytest.raises(ValueError):
        check_constraints_wire_size(payload)
    with pytest.raises(ValidationError):
        PlanningConstraints(**payload)
    check_constraints_wire_size(constraints().model_dump(mode="json"))


def test_must_visit_zero_hit_is_hard():
    issues = evaluate_candidate_constraints(
        constraints=constraints(items=[item(title="博物馆", day=1)]),
        days=[day(1, "2026-11-02", [stop("s1", "西湖")])],
        time_origins={"s1": "model"},
    )
    assert [issue.code for issue in by_level(issues, "H")] == ["must_visit_missing"]


def test_must_visit_duplicate_names_is_unverified():
    issues = evaluate_candidate_constraints(
        constraints=constraints(items=[item(title="博物馆", day=1)]),
        days=[day(1, "2026-11-02", [stop("s1", "博物馆"), stop("s2", "博物馆")])],
        time_origins={"s1": "model", "s2": "model"},
    )
    assert not by_level(issues, "H")
    assert [issue.code for issue in by_level(issues, "U")] == ["must_visit_ambiguous"]


def test_request_stop_id_maps_to_request_name_not_output_id():
    # 输出 id 被重写成 replan-*，但名字仍是目标；必须按名字匹配成功。
    request_stops = [SimpleNamespace(id="old-id", name="博物馆", time=None, duration_minutes=None)]
    satisfied = evaluate_candidate_constraints(
        constraints=constraints(
            items=[item(kind="must_visit", day=1, stop_id="old-id")],
            scope="day",
            day=1,
        ),
        days=[day(1, "2026-11-02", [stop("replan-d1-abc-1", "博物馆")])],
        time_origins={"replan-d1-abc-1": "model"},
        request_stops=request_stops,
    )
    assert not by_level(satisfied, "H")
    assert not by_level(satisfied, "U")

    # 同名 id 但不同名字不能被当成满足。
    missing = evaluate_candidate_constraints(
        constraints=constraints(
            items=[item(kind="must_visit", day=1, stop_id="old-id")],
            scope="day",
            day=1,
        ),
        days=[day(1, "2026-11-02", [stop("old-id", "别处")])],
        time_origins={"old-id": "model"},
        request_stops=request_stops,
    )
    assert [issue.code for issue in by_level(missing, "H")] == ["must_visit_missing"]


def fixed_window(**overrides):
    data = item(
        kind="fixed_window",
        day=1,
        title="博物馆",
        start_date="2026-11-02",
        end_date="2026-11-02",
        start_time="14:00",
        end_time="16:00",
        duration_minutes=60,
    )
    data.update(overrides)
    return constraints(items=[data])


def test_placeholder_time_is_u_not_h():
    issues = evaluate_candidate_constraints(
        constraints=fixed_window(),
        days=[day(1, "2026-11-02", [stop("s1", "博物馆", time="09:00")])],
        time_origins={"s1": "placeholder"},
    )
    assert not by_level(issues, "H")
    assert [issue.code for issue in by_level(issues, "U")] == ["fixed_window_time_unknown"]


def test_duration_null_is_u_and_zero_is_known():
    unknown = evaluate_candidate_constraints(
        constraints=fixed_window(duration_minutes=None),
        days=[day(1, "2026-11-02", [stop("s1", "博物馆", time="14:00")])],
        time_origins={"s1": "model"},
    )
    assert [issue.code for issue in by_level(unknown, "U")] == ["fixed_window_duration_unknown"]
    assert not by_level(unknown, "H")

    zero = evaluate_candidate_constraints(
        constraints=fixed_window(duration_minutes=0),
        days=[day(1, "2026-11-02", [stop("s1", "博物馆", time="14:00")])],
        time_origins={"s1": "model"},
    )
    assert zero == []


def test_invalid_window_and_unknown_transport_are_u():
    invalid = evaluate_candidate_constraints(
        constraints=fixed_window(start_time="16:00", end_time="14:00"),
        days=[day(1, "2026-11-02", [stop("s1", "博物馆", time="14:00")])],
        time_origins={"s1": "model"},
    )
    assert [issue.code for issue in by_level(invalid, "U")] == [
        "fixed_window_window_invalid"
    ]

    transport = evaluate_candidate_constraints(
        constraints=fixed_window(),
        days=[
            day(
                1,
                "2026-11-02",
                [stop("s1", "西湖", time="09:00"), stop("s2", "博物馆", time="14:00")],
            )
        ],
        time_origins={"s1": "model", "s2": "model"},
    )
    assert "fixed_window_transport_unknown" in [issue.code for issue in by_level(transport, "U")]


def test_fixed_window_date_mismatch_is_hard():
    issues = evaluate_candidate_constraints(
        constraints=fixed_window(),
        days=[day(1, "2026-11-03", [stop("s1", "博物馆", time="14:00")])],
        time_origins={"s1": "model"},
    )
    assert [issue.code for issue in by_level(issues, "H")] == [
        "fixed_window_date_mismatch"
    ]


def test_candidate_duration_null_is_u_not_zero():
    issues = evaluate_candidate_constraints(
        constraints=fixed_window(duration_minutes=60),
        days=[
            day(
                1,
                "2026-11-02",
                [stop("s1", "博物馆", time="14:00", duration=None)],
            )
        ],
        time_origins={"s1": "model"},
    )
    assert not by_level(issues, "H")
    assert [issue.code for issue in by_level(issues, "U")] == [
        "fixed_window_duration_unknown"
    ]


def test_early_arrival_before_fixed_start_is_not_hard():
    issues = evaluate_candidate_constraints(
        constraints=fixed_window(),
        days=[day(1, "2026-11-02", [stop("s1", "博物馆", time="13:00")])],
        time_origins={"s1": "model"},
    )
    assert issues == []


def test_previous_known_end_after_fixed_start_is_hard():
    issues = evaluate_candidate_constraints(
        constraints=fixed_window(),
        days=[
            day(
                1,
                "2026-11-02",
                [
                    stop("s1", "西湖", time="13:00", duration=120),
                    stop("s2", "博物馆", time="14:00", duration=60),
                ],
            )
        ],
        time_origins={"s1": "model", "s2": "model"},
    )
    assert "fixed_window_sequence_violation" in [
        issue.code for issue in by_level(issues, "H")
    ]


def test_previous_unknown_time_is_u_not_h():
    issues = evaluate_candidate_constraints(
        constraints=fixed_window(),
        days=[
            day(
                1,
                "2026-11-02",
                [
                    stop("s1", "西湖", time="09:00", duration=60),
                    stop("s2", "博物馆", time="14:00", duration=60),
                ],
            )
        ],
        time_origins={"s1": "placeholder", "s2": "model"},
    )
    assert not by_level(issues, "H")
    assert "fixed_window_predecessor_unknown" in [
        issue.code for issue in by_level(issues, "U")
    ]


def test_fingerprint_is_required():
    payload = constraints().model_dump(mode="json")
    del payload["fingerprint"]
    with pytest.raises(ValidationError):
        PlanningConstraints(**payload)
    with pytest.raises(ValidationError):
        PlanningConstraints(**{**constraints().model_dump(mode="json"), "fingerprint": None})


def test_cross_day_window_is_u():
    issues = evaluate_candidate_constraints(
        constraints=fixed_window(end_date="2026-11-03"),
        days=[day(1, "2026-11-02", [stop("s1", "博物馆", time="14:00")])],
        time_origins={"s1": "model"},
    )
    assert not by_level(issues, "H")
    assert [issue.code for issue in by_level(issues, "U")] == ["fixed_window_cross_day"]


def test_overlap_and_start_violation_are_hard():
    overlap = evaluate_candidate_constraints(
        constraints=PlanningConstraints(
            version=1,
            scope="trip_plan",
            day=None,
            anchor_stop_id=None,
            fingerprint="a1b2c3d4",
            items=[
                item(
                    id="a",
                    kind="fixed_window",
                    day=1,
                    title="博物馆",
                    start_date="2026-11-02",
                    end_date="2026-11-02",
                    start_time="14:00",
                    end_time="16:00",
                    duration_minutes=60,
                ),
                item(
                    id="b",
                    kind="fixed_window",
                    day=1,
                    title="美术馆",
                    start_date="2026-11-02",
                    end_date="2026-11-02",
                    start_time="15:00",
                    end_time="17:00",
                    duration_minutes=60,
                ),
            ],
        ),
        days=[
            day(
                1,
                "2026-11-02",
                [stop("s1", "博物馆", time="14:00"), stop("s2", "美术馆", time="15:00")],
            )
        ],
        time_origins={"s1": "model", "s2": "model"},
    )
    assert "fixed_window_overlap" in [issue.code for issue in by_level(overlap, "H")]

    late = evaluate_candidate_constraints(
        constraints=fixed_window(),
        days=[day(1, "2026-11-02", [stop("s1", "博物馆", time="15:00")])],
        time_origins={"s1": "model"},
    )
    assert "fixed_window_start_violation" in [issue.code for issue in by_level(late, "H")]


def test_day_tail_frozen_target_is_u():
    request_stops = [
        SimpleNamespace(id="anchor", name="西湖", time="09:00", duration_minutes=60),
        SimpleNamespace(id="tail", name="博物馆", time="11:00", duration_minutes=60),
    ]
    issues = evaluate_candidate_constraints(
        constraints=constraints(
            items=[item(kind="must_visit", day=2, stop_id="anchor")],
            scope="day_tail",
            day=2,
            anchor_stop_id="anchor",
        ),
        days=[day(2, "2026-11-02", [stop("new", "新景点")])],
        time_origins={"new": "model"},
        request_stops=request_stops,
        anchor_stop_id="anchor",
    )
    assert not by_level(issues, "H")
    assert [issue.code for issue in by_level(issues, "U")] == ["day_tail_frozen_target"]


def test_hard_failure_detail_is_bounded_and_safe():
    issues = evaluate_candidate_constraints(
        constraints=constraints(items=[item(title="博物馆")]),
        days=[day(1, "2026-11-02", [stop("s1", "西湖")])],
        time_origins={"s1": "model"},
    )
    detail = format_hard_failure(issues)
    assert detail.startswith("候选未满足硬约束：")
    assert "constraint-1" in detail
    assert "博物馆" in detail
    assert len(detail) <= 300


def test_normalize_target_name_is_nfkc_whitespace_casefolded():
    assert normalize_target_name("　西湖\tA  ") == "西湖 a"
