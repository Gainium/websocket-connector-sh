import { APIMarket } from 'okx-api'

export const exchangeUrl = () => process.env.EXCHANGE_SERVICE_API_URL

export const OKXEnv = (): APIMarket => {
  return process.env.ENVOKX === 'sandbox' ? 'demo' : 'prod'
}
