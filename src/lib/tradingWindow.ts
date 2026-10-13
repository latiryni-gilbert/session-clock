/** ISO weekday numbers, matching Luxon: 1 = Monday ... 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

/** Clock time as "HH:mm" in 24-hour format, e.g. "09:30". */
export type TimeOfDay = string

export interface TradingWindow {
  /** Unique, stable, readable identifier, e.g. "forex-london". Names can repeat across groups; ids can't. */
  id: string
  name: string
  /** Compact label for tight spaces such as the timeline, e.g. "LDN". Needn't be unique across groups. */
  shortName: string
  /** Wall-clock start in the home time zone. */
  start: TimeOfDay
  /**
   * Wall-clock end in the home time zone. If `end` is earlier than or equal
   * to `start`, the window runs overnight and ends on the following day.
   */
  end: TimeOfDay
  /** IANA time zone the start/end times are defined in, e.g. "America/New_York". */
  timeZone: string
  /**
   * Days the window STARTS on, in the home time zone. An overnight window
   * that starts on Sunday and ends on Monday is listed as Sunday.
   */
  days: Weekday[]
  /** CSS color for display, e.g. "#3b82f6". */
  color: string
  /** Optional market holidays. A closed day has no session; an early-close day ends at the calendar's early-close time. */
  holidays?: HolidayCalendar
}

export type HolidayType = 'closed' | 'early-close'

export interface Holiday {
  /** Calendar date "yyyy-MM-dd" in the calendar's time zone. */
  date: string
  name: string
  /** "closed": no session that day. "early-close": the session ends at the calendar's early-close time. */
  type: HolidayType
}

/** Days a market is closed or closes early. Dates are matched against the day a window STARTS on, in its home zone. */
export interface HolidayCalendar {
  id: string
  name: string
  /** Time zone the dates and `earlyCloseTime` are in. Must match the home zone of any window it is attached to. */
  timeZone: string
  /** Closing time on an early-close day, "HH:mm". */
  earlyCloseTime: string
  /** The last date this data covers ("yyyy-MM-dd"). Beyond it the calendar knows nothing, so every day looks like a normal trading day. */
  coversThrough: string
  holidays: Holiday[]
}

export interface PresetGroup {
  name: string
  /** Compact label for tight spaces, e.g. "Forex". */
  shortName: string
  windows: TradingWindow[]
}
