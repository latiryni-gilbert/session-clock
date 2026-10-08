import type { PresetGroup, Weekday } from '../lib/tradingWindow'

const MON_FRI: Weekday[] = [1, 2, 3, 4, 5]
const SUN_THU: Weekday[] = [7, 1, 2, 3, 4]

export const PRESET_GROUPS: PresetGroup[] = [
  {
    name: 'Forex sessions',
    shortName: 'Forex',
    windows: [
      { id: 'forex-sydney', name: 'Sydney', shortName: 'SYD', start: '07:00', end: '16:00', timeZone: 'Australia/Sydney', days: MON_FRI, color: '#f59e0b' },
      { id: 'forex-tokyo', name: 'Tokyo', shortName: 'TKY', start: '09:00', end: '18:00', timeZone: 'Asia/Tokyo', days: MON_FRI, color: '#ef4444' },
      { id: 'forex-london', name: 'London', shortName: 'LDN', start: '08:00', end: '17:00', timeZone: 'Europe/London', days: MON_FRI, color: '#3b82f6' },
      { id: 'forex-new-york', name: 'New York', shortName: 'NY', start: '08:00', end: '17:00', timeZone: 'America/New_York', days: MON_FRI, color: '#22c55e' },
    ],
  },
  {
    name: 'NYSE',
    shortName: 'NYSE',
    windows: [
      { id: 'nyse-regular', name: 'NYSE regular hours', shortName: 'NYSE', start: '09:30', end: '16:00', timeZone: 'America/New_York', days: MON_FRI, color: '#8b5cf6' },
    ],
  },
  {
    name: 'CME equity futures',
    shortName: 'CME',
    windows: [
      // Runs 18:00 -> 17:00 next day; the 17:00-18:00 gap is the daily break.
      // Starts Sun-Thu evening, so the last session ends Friday 17:00.
      { id: 'cme-equity-futures', name: 'CME equity futures', shortName: 'CME', start: '18:00', end: '17:00', timeZone: 'America/New_York', days: SUN_THU, color: '#14b8a6' },
    ],
  },
  {
    name: 'ICT killzones',
    shortName: 'ICT',
    windows: [
      { id: 'ict-asian', name: 'Asian', shortName: 'Asia', start: '20:00', end: '00:00', timeZone: 'America/New_York', days: SUN_THU, color: '#f97316' },
      { id: 'ict-london', name: 'London', shortName: 'LDN', start: '02:00', end: '05:00', timeZone: 'America/New_York', days: MON_FRI, color: '#0ea5e9' },
      { id: 'ict-new-york-am', name: 'New York AM', shortName: 'AM', start: '08:30', end: '11:00', timeZone: 'America/New_York', days: MON_FRI, color: '#10b981' },
      { id: 'ict-new-york-pm', name: 'New York PM', shortName: 'PM', start: '13:30', end: '16:00', timeZone: 'America/New_York', days: MON_FRI, color: '#ec4899' },
    ],
  },
]
