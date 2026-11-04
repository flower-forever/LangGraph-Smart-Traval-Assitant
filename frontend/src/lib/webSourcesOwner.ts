/**
 * web sources panel ownership snapshot (pure functions; no UI / network / storage).
 *
 * Unlike DayPoiSourcesPanel's weaker id/revision/coordinate check: every render
 * serializes the full trip content, current day, selected stop, source tri-state
 * and the raw query text into one key. The component layers object identity
 * (a new reference is a new owner) and a monotonic epoch on top. When the data
 * cannot be safely serialized the snapshot fails closed (not_serializable) and
 * the component disables querying and hides stale results.
 */

import type { Trip, TripDay } from './api'

export interface OwnerSnapshotInput {
  trip: Trip
  /** Current day; null when the panel has no day to show (no day content in key). */
  day: TripDay | null
  revision: number
  /** Raw user input; taken verbatim, no trim / normalization. */
  rawQuery: string
  /** Stop id currently picked in the panel dropdown; null when none. */
  selectedStopId: string | null
  /** App-level selected stop id (initial clue only, but part of ownership). */
  activeStopId?: string | null
  /** Source tri-state: true / false known, null unknown. */
  openedFromFile: boolean | null
}

export type OwnerSnapshotResult = { ok: true; key: string } | { ok: false }

export function serializeOwnerSnapshot(input: OwnerSnapshotInput): OwnerSnapshotResult {
  let tripJson: string
  let dayJson: string
  try {
    tripJson = JSON.stringify(input.trip)
    dayJson = JSON.stringify(
      input.day === null
        ? null
        : {
            day: input.day.day,
            date: input.day.date,
            title: input.day.title,
            summary: input.day.summary,
            stops: input.day.stops,
            legs: input.day.legs,
          },
    )
  } catch {
    return { ok: false }
  }
  // Scalars go through one JSON.stringify (escaped, unambiguous), then the two
  // JSON texts are appended; each is itself a complete JSON document, so the
  // segment boundaries are unambiguous without ad-hoc separators.
  const head = JSON.stringify([
    input.revision,
    input.openedFromFile,
    input.selectedStopId,
    input.activeStopId ?? null,
    input.rawQuery,
  ])
  return { ok: true, key: `${head}${tripJson}${dayJson}` }
}
