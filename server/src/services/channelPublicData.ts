export function channelPublicData(channel: Record<string, unknown>) {
  const { credentials: _credentials, ...safe } = channel
  return { ...safe, credentials: { token: '********' } }
}
