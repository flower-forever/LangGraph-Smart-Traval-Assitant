# -*- coding: utf-8 -*-
"""坐标转换与高德 polyline 解析测试。"""

import pytest

from travel_itinerary import (
    gcj02_to_wgs84,
    out_of_china,
    parse_amap_polyline,
    wgs84_to_gcj02,
)


def test_china_detection():
    assert out_of_china(116.39, 39.90) is False
    assert out_of_china(-73.98, 40.75) is True


def test_gcj_round_trip_is_close_in_beijing():
    lng, lat = 116.3913, 39.9075
    gcj_lng, gcj_lat = wgs84_to_gcj02(lng, lat)

    # 北京城区 GCJ-02 相对 WGS84 有几公里的偏移，不是原值。
    assert abs(gcj_lng - lng) > 0.001
    assert abs(gcj_lat - lat) > 0.0005

    back_lng, back_lat = gcj02_to_wgs84(gcj_lng, gcj_lat)
    assert back_lng == pytest.approx(lng, abs=1e-4)
    assert back_lat == pytest.approx(lat, abs=1e-4)


def test_outside_china_coordinates_are_not_shifted():
    lng, lat = -73.9857, 40.7484
    assert gcj02_to_wgs84(lng, lat) == (lng, lat)
    assert wgs84_to_gcj02(lng, lat) == (lng, lat)


def test_polyline_keeps_lng_lat_order():
    points = parse_amap_polyline("116.397,39.908;116.398,39.909")

    assert len(points) == 2
    assert points[0].lng == pytest.approx(116.397)
    assert points[0].lat == pytest.approx(39.908)
    # 经度在前：如果解析时交换了经纬度，lng 会变成 39.x，明显不合法。
    assert points[1].lng > 100
    assert points[1].lat < 90


def test_polyline_skips_bad_points_and_empty_input():
    points = parse_amap_polyline("116.397,39.908;bad;999,39.9;116.4,39.91")
    assert [round(point.lng, 3) for point in points] == [116.397, 116.4]
    assert parse_amap_polyline("") == []
    assert parse_amap_polyline(None) == []
