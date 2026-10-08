/** ISO weekday numbers, matching Luxon: 1 = Monday ... 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

/** Clock time as "HH:mm" in 24-hour format, e.g. "09:30". */
export type TimeOfDay = string

export interface TradingWindow {
  /** Unique, stable, readable identifier, e.g. "forex-london". Names can repeat across groups; ids can't. */
  id: string
  name: string
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
}

export interface PresetGroup {
  name: string
  windows: TradingWindow[]
}
