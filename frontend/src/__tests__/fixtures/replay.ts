/**
 * S7 回放 / 语音测试夹具。
 *
 * 一天 5 站，四种路段各出现一次：
 * - 第 2 站：navigation 带完整折线；
 * - 第 3 站：straight_line（只连两端）；
 * - 第 4 站：unavailable（不画线）；
 * - 第 5 站：navigation 但没有 geometry（降级成示意直线，明确不是导航）。
 * 另附「第 2 站无坐标」与空日，用于缺失降级。
 */
import type { TripDay, TripLeg, TripStop } from '../../lib/api'

function stop(
  id: string,
  name: string,
  time: string,
  duration: number | null,
  lng: number | null,
  lat: number | null,
  description = '',
  address = '',
): TripStop {
  return {
    id,
    name,
    time,
    duration_minutes: duration,
    description,
    address,
    location: lng === null || lat === null ? null : { lng, lat },
  }
}

function leg(
  from: string,
  to: string,
  routeType: TripLeg['route_type'],
  geometry: TripLeg['geometry'],
  patch: Partial<TripLeg> = {},
): TripLeg {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode: 'walking',
    route_type: routeType,
    distance_m: 800,
    duration_minutes: 15,
    geometry,
    description: '',
    ...patch,
  }
}

export const REPLAY_DAY: TripDay = {
  day: 1,
  date: '2026-04-03',
  title: '回放测试日',
  summary: '',
  stops: [
    stop('r1', '断桥残雪', '09:00', 40, 120.1576, 30.2726, '白堤东端，冬日雪后桥面半融半积。', '杭州市西湖区白堤东端'),
    stop('r2', '平湖秋月', '10:00', 30, 120.1522, 30.2631, '湖面开阔，白日亦有水景。', '杭州市西湖区孤山路'),
    stop('r3', '湖滨晴雨', '11:30', null, 120.1651, 30.2567, '商业街区与湖景交界。', '杭州市上城区湖滨路'),
    stop('r4', '灵隐寺', '14:00', 60, 120.1012, 30.2408, '飞来峰下的古刹。', '杭州市西湖区法云弄'),
    stop('r5', '龙井村', '16:30', 90, 120.1131, 30.2226, '狮峰龙井核心产区。', '杭州市西湖区龙井路'),
  ],
  legs: [
    leg('r1', 'r2', 'navigation', [
      { lng: 120.1576, lat: 30.2726 },
      { lng: 120.155, lat: 30.268 },
      { lng: 120.1522, lat: 30.2631 },
    ]),
    leg('r2', 'r3', 'straight_line', [], { distance_m: 1600, duration_minutes: 12 }),
    leg('r3', 'r4', 'unavailable', [], { distance_m: null, duration_minutes: null }),
    leg('r4', 'r5', 'navigation', [], { distance_m: 2100, duration_minutes: 28 }),
  ],
}

export const REPLAY_DAY_NO_COORD: TripDay = {
  day: 2,
  date: '2026-04-04',
  title: '缺坐标日',
  summary: '',
  stops: [
    stop('n1', '有坐标的站', '09:00', 20, 120.15, 30.27, '', ''),
    stop('n2', '没有坐标的站', '10:00', null, null, null, '', ''),
  ],
  legs: [leg('n1', 'n2', 'navigation', [{ lng: 120.15, lat: 30.27 }])],
}

export const REPLAY_DAY_EMPTY: TripDay = {
  day: 3,
  date: null,
  title: '空日',
  summary: '',
  stops: [],
  legs: [],
}

export const REPLAY_DAYS: readonly TripDay[] = [REPLAY_DAY, REPLAY_DAY_NO_COORD, REPLAY_DAY_EMPTY]
