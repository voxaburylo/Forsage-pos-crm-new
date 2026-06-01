import { TerminalAdapter, FiscalAdapter } from './interfaces.js'
import { MockTerminalAdapter, PrivatBankTerminalAdapter } from './terminalAdapters.js'
import { MockFiscalAdapter, KashalotFiscalAdapter } from './fiscalAdapters.js'

export * from './interfaces.js'

export function getTerminalAdapter(settings: any): TerminalAdapter | null {
  if (!settings || !settings.bank_terminal_enabled) {
    return null
  }
  const provider = settings.terminal_provider ?? 'mock'
  if (provider == 'manual') {
    return null
  }
  if (provider == 'privatbank') {
    return new PrivatBankTerminalAdapter({
      ip: settings.privatbank_terminal_ip ?? '127.0.0.1',
      port: settings.privatbank_terminal_port ?? 8082,
      merchant_id: settings.merchant_id ?? settings.privatbank_merchant_id ?? 'MOCK_MERCHANT',
    })
  }
  return new MockTerminalAdapter()
}

export function getFiscalAdapter(settings: any): FiscalAdapter {
  const prroProvider = settings?.prro_provider ?? 'mock'
  if (prroProvider == 'kashalot' && settings?.kashalot_license_key && settings?.kashalot_pin) {
    return new KashalotFiscalAdapter({
      license_key: settings.kashalot_license_key,
      pin: settings.kashalot_pin,
      active_shift: settings.kashalot_active_shift,
    })
  }
  return new MockFiscalAdapter()
}