# Фоновий режим головної каси (22.11.2026, рішення власника).
#
# Після ввімкнення ПК, ще до входу у Windows, програма каси запускається без вікна й тримає базу:
# веб працює через головний ПК, навіть коли касу не відкрито. Відкрили касу на екрані — фон сам
# відпускає базу вікну; закрили касу — фон запускається знову.
#
#   Увімкнути:  powershell -ExecutionPolicy Bypass -File background-task.ps1 install
#   Вимкнути:   powershell -ExecutionPolicy Bypass -File background-task.ps1 remove
#   Стан:       powershell -ExecutionPolicy Bypass -File background-task.ps1 status
#
# Увімкнення просить пароль облікового запису Windows (його вводить власник; скрипт його ніде не зберігає —
# зберігає сам планувальник Windows, як для будь-якого завдання «виконувати без входу користувача»).
# Потрібні права адміністратора (запуск «під час завантаження системи»): Windows спитає дозвіл.
param([ValidateSet('install', 'remove', 'status')][string]$Action = 'status', [string]$AppPath = '')

$ErrorActionPreference = 'Stop'
# 23.11.2026: вікно адміністратора закривалось одразу після помилки — власник її не бачив.
# Тепер помилка лишається на екрані й записується у файл, який може прочитати підтримка.
$LogFile = Join-Path $env:LOCALAPPDATA 'Forsage\logs\background-task.log'
trap {
  $text = "{0} {1}: {2}" -f (Get-Date -Format 's'), $Action, ($_ | Out-String)
  try { New-Item -ItemType Directory -Force (Split-Path $LogFile) | Out-Null; Add-Content -Path $LogFile -Value $text -Encoding UTF8 } catch { }
  Write-Host ('ПОМИЛКА: ' + $_.Exception.Message) -ForegroundColor Red
  Read-Host 'Натисніть Enter'
  exit 1
}
$TaskPath = '\Forsage\'
$TaskName = 'TillBackground'
$App = if ($AppPath) { $AppPath } else { Join-Path $env:LOCALAPPDATA 'Forsage\app\Forsage.exe' }

function Test-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Action -ne 'status' -and -not (Test-Admin)) {
  # Перезапуск із правами адміністратора; шлях до LOCALAPPDATA передаємо, щоб узяти програму саме цього користувача.
  Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", $Action, '-AppPath', "`"$App`"") | Out-Null
  exit 0
}

if ($Action -eq 'status') {
  $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { Write-Output 'Фоновий режим каси вимкнено.'; exit 0 }
  $info = Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $TaskName
  Write-Output ("Фоновий режим каси увімкнено. Стан: {0}. Останній запуск: {1}. Результат: {2}." -f $task.State, $info.LastRunTime, $info.LastTaskResult)
  exit 0
}

if ($Action -eq 'remove') {
  Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output 'Фоновий режим каси вимкнено. Якщо фонова копія ще працює, вона закриється при наступному відкритті каси.'
  Read-Host 'Натисніть Enter'
  exit 0
}

if (-not (Test-Path $App)) { throw "Програму каси не знайдено: $App. Спершу встановіть касу в постійну теку." }
$user = "$env:USERDOMAIN\$env:USERNAME"
$credential = Get-Credential -UserName $user -Message 'Пароль облікового запису Windows, від якого працює каса (потрібен, щоб каса запускалась до входу у Windows)'
# Не $action: PowerShell не розрізняє регістр, і це був би параметр $Action (install/remove/status).
$taskAction = New-ScheduledTaskAction -Execute $App -Argument '--background' -WorkingDirectory (Split-Path $App)
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT1M'  # хвилина після ввімкнення: мережа й диск устигають піднятися
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings `
  -User $credential.UserName -Password $credential.GetNetworkCredential().Password -RunLevel Limited `
  -Description 'Форсаж: база головного ПК у фоні, щоб веб працював і без відкритої каси. Вимкнути: background-task.ps1 remove' -Force | Out-Null
try { Add-Content -Path $LogFile -Value ("{0} install: ok" -f (Get-Date -Format 's')) -Encoding UTF8 } catch { }
Write-Output 'Фоновий режим каси увімкнено. Він запуститься після наступного ввімкнення ПК або після закриття каси на екрані.'
Read-Host 'Натисніть Enter'
