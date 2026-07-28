import { describe, expect, it } from 'vitest'
import {
  nextSettingsRowUpdatedAt,
  normalizeSyncUpdatedAt,
  prepareLabelSettingsUpdate,
} from '../labelSettingsConflict.js'

const SERVER_RECEIVED_AT = '2026-07-28T12:00:02.000Z'

describe('label settings conflict guard', () => {
  it('adds sync_updated_at for an old client payload', () => {
    const result = prepareLabelSettingsUpdate({
      incoming: { width_mm: 50 },
      incomingFallbackUpdatedAt: '2026-07-28T12:00:00.000Z',
      current: null,
      currentRowUpdatedAt: null,
      serverReceivedAt: SERVER_RECEIVED_AT,
    })

    expect(result.shouldApply).toBe(true)
    expect(result.normalizedIncoming).toEqual({
      width_mm: 50,
      sync_updated_at: '2026-07-28T12:00:00.000Z',
    })
  })

  it('does not let an older offline layout replace a newer server layout', () => {
    const result = prepareLabelSettingsUpdate({
      incoming: {
        width_mm: 40,
        sync_updated_at: '2026-07-28T10:00:00.000Z',
      },
      incomingFallbackUpdatedAt: '2026-07-28T10:00:01.000Z',
      current: {
        width_mm: 58,
        sync_updated_at: '2026-07-28T11:00:00.000Z',
      },
      currentRowUpdatedAt: '2026-07-28T11:00:02.000Z',
      serverReceivedAt: SERVER_RECEIVED_AT,
    })

    expect(result.shouldApply).toBe(false)
    expect(result.currentUpdatedAt).toBe('2026-07-28T11:00:00.000Z')
  })

  it('uses the row timestamp for layouts saved before sync metadata existed', () => {
    const result = prepareLabelSettingsUpdate({
      incoming: { width_mm: 40 },
      incomingFallbackUpdatedAt: '2026-07-28T10:00:00.000Z',
      current: { width_mm: 58 },
      currentRowUpdatedAt: '2026-07-28T11:00:00.000Z',
      serverReceivedAt: SERVER_RECEIVED_AT,
    })

    expect(result.shouldApply).toBe(false)
  })

  it('accepts a newer layout and keeps its explicit save timestamp', () => {
    const result = prepareLabelSettingsUpdate({
      incoming: {
        width_mm: 58,
        sync_updated_at: '2026-07-28T12:00:00+00:00',
      },
      incomingFallbackUpdatedAt: '2026-07-28T12:00:01.000Z',
      current: {
        width_mm: 40,
        sync_updated_at: '2026-07-28T11:00:00.000Z',
      },
      currentRowUpdatedAt: '2026-07-28T11:00:02.000Z',
      serverReceivedAt: SERVER_RECEIVED_AT,
    })

    expect(result.shouldApply).toBe(true)
    expect(result.normalizedIncoming?.sync_updated_at).toBe('2026-07-28T12:00:00.000Z')
  })

  it('advances the row CAS timestamp even inside the same millisecond', () => {
    expect(nextSettingsRowUpdatedAt(
      '2026-07-28T12:00:00.000Z',
      new Date('2026-07-28T12:00:00.000Z'),
    )).toBe('2026-07-28T12:00:00.001Z')
  })

  it('ignores invalid timestamps', () => {
    expect(normalizeSyncUpdatedAt('not-a-date')).toBeNull()
    expect(normalizeSyncUpdatedAt(null)).toBeNull()
  })

  it('clamps a future incoming client timestamp to the fixed server receive time', () => {
    const result = prepareLabelSettingsUpdate({
      incoming: {
        width_mm: 58,
        sync_updated_at: '2099-01-01T00:00:00.000Z',
      },
      incomingFallbackUpdatedAt: '2026-07-28T12:00:00.000Z',
      current: {
        width_mm: 40,
        sync_updated_at: '2026-07-28T11:00:00.000Z',
      },
      currentRowUpdatedAt: '2026-07-28T11:00:02.000Z',
      serverReceivedAt: SERVER_RECEIVED_AT,
    })

    expect(result.shouldApply).toBe(true)
    expect(result.incomingUpdatedAt).toBe(SERVER_RECEIVED_AT)
    expect(result.normalizedIncoming?.sync_updated_at).toBe(SERVER_RECEIVED_AT)
  })

  it('does not let an already stored future timestamp lock out another device', () => {
    const result = prepareLabelSettingsUpdate({
      incoming: {
        width_mm: 58,
        sync_updated_at: '2026-07-28T12:00:00.000Z',
      },
      incomingFallbackUpdatedAt: '2026-07-28T12:00:00.000Z',
      current: {
        width_mm: 40,
        sync_updated_at: '2099-01-01T00:00:00.000Z',
      },
      currentRowUpdatedAt: '2099-01-01T00:00:01.000Z',
      serverReceivedAt: SERVER_RECEIVED_AT,
    })

    expect(result.shouldApply).toBe(true)
    expect(result.currentUpdatedAt).toBe(SERVER_RECEIVED_AT)
    expect(result.normalizedIncoming?.sync_updated_at).toBe('2026-07-28T12:00:00.000Z')
  })
  it('keeps an ordinary concurrent timestamp newer during CAS retries', () => {
    const result = prepareLabelSettingsUpdate({
      incoming: {
        width_mm: 40,
        sync_updated_at: '2026-07-28T12:00:00.000Z',
      },
      incomingFallbackUpdatedAt: '2026-07-28T12:00:00.000Z',
      current: {
        width_mm: 58,
        sync_updated_at: '2026-07-28T12:00:03.000Z',
      },
      currentRowUpdatedAt: '2026-07-28T12:00:03.000Z',
      serverReceivedAt: SERVER_RECEIVED_AT,
    })

    expect(result.shouldApply).toBe(false)
    expect(result.currentUpdatedAt).toBe('2026-07-28T12:00:03.000Z')
  })
})
