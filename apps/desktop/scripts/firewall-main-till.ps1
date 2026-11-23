# Доступ ПК менеджера до головного ПК каси через брандмауер Windows (23.11.2026).
#
# Якщо при першому запуску каси у вікні Windows «Дозволити доступ до мережі» натиснули «Скасувати»,
# Windows створює правило «Блокувати» для програми каси, і ПК менеджера не може підключитись
# («помилка з'єднання», статистика не відкривається). Заборона в Windows сильніша за будь-який дозвіл.
#
#   powershell -ExecutionPolicy Bypass -File firewall-main-till.ps1
#
# Прибирає лише заборони для програми каси й дозволяє їй вхідні підключення. Інших правил не чіпає.
param([string]$AppPath = '')

$App = if ($AppPath) { $AppPath } else { Join-Path $env:LOCALAPPDATA 'Forsage\app\Forsage.exe' }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-AppPath', "`"$App`"") | Out-Null
  exit 0
}

try {
  $ErrorActionPreference = 'Stop'
  $blocked = @(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -and ($_.Program -ieq $App) } | Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' })
  $blocked | Remove-NetFirewallRule
  Write-Output ("Прибрано заборон для каси: {0}" -f $blocked.Count)
  Remove-NetFirewallRule -DisplayName 'Forsage main till' -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName 'Forsage main till' -Direction Inbound -Action Allow -Program $App -Profile Any | Out-Null
  Write-Output 'Дозвіл для каси додано. Перезапустіть програму на ПК менеджера.'
} catch {
  Write-Host ('ПОМИЛКА: ' + $_.Exception.Message) -ForegroundColor Red
}
Read-Host 'Натисніть Enter'
