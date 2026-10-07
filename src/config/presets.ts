import type { PresetGroup, Weekday } from '../lib/tradingWindow'

const MON_FRI: Weekday[] = [1, 2, 3, 4, 5]
const SUN_THU: Weekday[] = [7, 1, 2, 3, 4]

export const PRESET_GROUPS: PresetGroup[] = [
  {
    name: 'Forex sessions',
    windows: [
      { name: 'Sydney', start: '07:00', end: '16:00', timeZone: 'Australia/Sydney', days: MON_FRI, color: '#f59e0b' },
      { name: 'Tokyo', start: '09:00', end: '18:00', timeZone: 'Asia/Tokyo', days: MON_FRI, color: '#ef4444' },
      { name: 'London', start: '08:00', end: '17:00', timeZone: 'Europe/London', days: MON_FRI, color: '#3b82f6' },
      { name: 'New York', start: '08:00', end: '17:00', timeZone: 'America/New_York', days: MON_FRI, color: '#22c55e' },
    ],
  },
  {
    name: 'NYSE',
    windows: [
      { name: 'NYSE regular hours', start: '09:30', end: '16:00', timeZone: 'America/New_York', days: MON_FRI, color: '#8b5cf6' },
    ],
  },
  {
    name: 'CME equity futures',
    windows: [
      // Runs 18:00 -> 17:00 next day; the 17:00-18:00 gap is the daily break.
      // Starts Sun-Thu evening, so the last session ends Friday 17:00.
      { name: 'CME equity futures', start: '18:00', end: '17:00', timeZone: 'America/New_York', days: SUN_THU, color: '#14b8a6' },
    ],
  },
  {
    name: 'ICT killzones',
    windows: [
      { name: 'Asian', start: '20:00', end: '00:00', timeZone: 'America/New_York', days: SUN_THU, color: '#f97316' },
      { name: 'London Open', start: '02:00', end: '05:00', timeZone: 'America/New_York', days: MON_FRI, color: '#0ea5e9' },
      { name: 'New York AM', start: '07:00', end: '10:00', timeZone: 'America/New_York', days: MON_FRI, color: '#10b981' },
      { name: 'London Close', start: '10:00', end: '12:00', timeZone: 'America/New_York', days: MON_FRI, color: '#ec4899' },
    ],
  },
]
