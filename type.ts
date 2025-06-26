export const skipReason = [
  'WebSocket was closed before the connection was established',
  '(wallet,order)',
  '(wallet)',
  '(order)',
  'Ping error',
  'failed to subscribe',
  'Kucoin WS Error',
  'Redis Client Error',
  'write EPIPE',
].map((r) => r.toLowerCase())

export const rabbitUsersStreamKey = 'usersStreamAction'
export const serviceLogRedis = 'serviceLog'
