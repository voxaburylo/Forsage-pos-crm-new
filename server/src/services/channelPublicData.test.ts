import { describe, expect, it } from 'vitest'
import { channelPublicData } from './channelPublicData.js'

describe('channel response credentials', () => {
  it('never returns a bot token or credential extras after a mutation', () => {
    const input = { id: 'channel', is_active: false, credentials: { token: 'private-token', password: 'private-password' } }
    expect(channelPublicData(input)).toEqual({ id: 'channel', is_active: false, credentials: { token: '********' } })
    expect(input.credentials.token).toBe('private-token')
  })
})
