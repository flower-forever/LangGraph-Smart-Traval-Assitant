import type { Trip } from '../../lib/api'

/** 测试用行程夹具：覆盖坐标缺失、三种 route_type、多日等情形 */
export const MOCK_TRIP: Trip = {
  id: 'trip-mock-1',
  source: 'example',
  destination: '杭州',
  title: '杭州三日漫步路书',
  summary: '一条覆盖西湖、运河与龙井的慢节奏路线，适合第一次来杭州的旅行者。',
  map_coordinate_system: 'WGS84',
  warnings: ['示例数据仅用于演示界面，实际行程请以规划结果为准。'],
  days: [
    {
      day: 1,
      date: '2026-04-03',
      title: '西湖环湖',
      summary: '从断桥出发，沿湖步行，傍晚在湖滨看日落。',
      stops: [
        {
          id: 's1',
          name: '断桥残雪',
          time: '09:00',
          duration_minutes: 40,
          description: '白堤东端，冬日雪后桥面半融半积，远望如断。',
          address: '杭州市西湖区白堤东端',
          location: { lng: 120.1576, lat: 30.2726 },
        },
        {
          id: 's2',
          name: '平湖秋月',
          time: '10:00',
          duration_minutes: 30,
          description: '湖面秋月之夜最胜，白日亦有开阔水景。',
          address: '杭州市西湖区孤山路',
          location: { lng: 120.1522, lat: 30.2631 },
        },
        {
          id: 's3',
          name: '湖滨晴雨',
          time: '11:30',
          duration_minutes: null,
          description: '商业街区与湖景交界，适合午饭休整。',
          address: '杭州市上城区湖滨路',
          location: null,
        },
      ],
      legs: [
        {
          from_stop_id: 's1',
          to_stop_id: 's2',
          mode: 'walking',
          route_type: 'navigation',
          distance_m: 1100,
          duration_minutes: 16,
          geometry: [
            { lng: 120.1576, lat: 30.2726 },
            { lng: 120.155, lat: 30.268 },
            { lng: 120.1522, lat: 30.2631 },
          ],
          description: '沿白堤步行。',
        },
        {
          from_stop_id: 's2',
          to_stop_id: 's3',
          mode: 'driving',
          route_type: 'straight_line',
          distance_m: 1800,
          duration_minutes: 12,
          geometry: [],
          description: '示意直线，仅表示方位。',
        },
      ],
    },
    {
      day: 2,
      date: '2026-04-04',
      title: '运河与老巷',
      summary: '拱宸桥一带的老杭州肌理。',
      stops: [],
      legs: [],
    },
    {
      day: 3,
      date: null,
      title: '龙井问茶',
      summary: '',
      stops: [
        {
          id: 's4',
          name: '龙井村',
          time: '10:00',
          duration_minutes: 120,
          description: '狮峰龙井核心产区，村中茶舍可小坐。',
          address: '杭州市西湖区龙井路',
          location: { lng: 120.1131, lat: 30.2226 },
        },
      ],
      legs: [],
    },
  ],
}

/** 仅有无坐标站点的一日，用于空态测试 */
export const MOCK_TRIP_NO_COORD: Trip = {
  ...MOCK_TRIP,
  id: 'trip-mock-2',
  source: 'agent',
  title: '无坐标测试行程',
  warnings: [],
  days: [
    {
      day: 1,
      date: null,
      title: '全程无坐标',
      summary: '测试用。',
      stops: [
        {
          id: 'n1',
          name: '某无名站点',
          time: '09:00',
          duration_minutes: null,
          description: '后端没给出坐标。',
          address: '地址未知',
          location: null,
        },
      ],
      legs: [],
    },
  ],
}
