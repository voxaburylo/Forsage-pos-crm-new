/** Fixed, audited helper: no downloaded commands, no ExecutionPolicy override, no process termination.
 * The job is local JSON passed in an environment variable; every output path is derived again here.
 * File.Replace is the sole operation that mutates the installed EXE, with an atomic recovery copy.
 */
export const PORTABLE_UPDATE_POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ForsageUpdateFile {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info info);
  public static string Identity(string path) {
    using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
      Info i; if (!GetFileInformationByHandle(file.SafeFileHandle, out i)) throw new IOException("Cannot inspect update file");
      if (i.Links != 1 || (i.Attributes & 0x400) != 0) throw new IOException("Linked update file rejected");
      return i.Volume+":"+i.IndexHigh+":"+i.IndexLow+":"+i.CreationHigh+":"+i.CreationLow;
    }
  }
}
'@
function LocalPath([string]$p) {
  if ($p -notmatch '^[A-Za-z]:\\' -or $p.Substring(2).Contains(':') -or $p.Length -gt 240) { throw 'Invalid local update path' }
  $full = [IO.Path]::GetFullPath($p)
  if (-not [string]::Equals($full, $p, [StringComparison]::OrdinalIgnoreCase)) { throw 'Noncanonical update path' }
  return $full
}
function DirectorySafe([string]$p) {
  $p = LocalPath $p
  while ($p) {
    $item = Get-Item -LiteralPath $p -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Redirected update directory' }
    $parent = [IO.Directory]::GetParent($p)
    if ($null -eq $parent) { break }; $p = $parent.FullName
  }
}
function FileSafe([string]$p) {
  $p = LocalPath $p; DirectorySafe ([IO.Path]::GetDirectoryName($p))
  $item = Get-Item -LiteralPath $p -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Redirected update file' }
  return [ForsageUpdateFile]::Identity($p)
}
function Hash([string]$p) {
  $identity = FileSafe $p
  $file = [IO.File]::Open($p, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $value = ([BitConverter]::ToString($sha.ComputeHash($file))).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose(); $file.Dispose() }
  if ((FileSafe $p) -ne $identity) { throw 'Update file changed during hashing' }
  return $value
}
function ExeSafe([string]$p, [string]$hash, [long]$size) {
  $identity = FileSafe $p
  $file = [IO.File]::Open($p, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($file.Length -lt 2 -or $file.Length -gt 536870912 -or ($size -gt 0 -and $file.Length -ne $size)) { throw 'Invalid executable size' }
    if ($file.ReadByte() -ne 77 -or $file.ReadByte() -ne 90) { throw 'Invalid executable header' }
  } finally { $file.Dispose() }
  if ((Hash $p) -ne $hash -or (FileSafe $p) -ne $identity) { throw 'Executable checksum mismatch' }
  return $identity
}
function CopyNew([string]$source, [string]$destination) {
  $identity = FileSafe $source; DirectorySafe ([IO.Path]::GetDirectoryName($destination))
  $read = [IO.File]::Open($source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $write = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $read.CopyTo($write, 524288); $write.Flush($true) } finally { $write.Dispose() }
  } finally { $read.Dispose() }
  if ((FileSafe $source) -ne $identity) { throw 'Copy source changed' }
  return FileSafe $destination
}
function RemoveOwned([string]$p, [string]$identity) {
  if (-not [IO.File]::Exists($p)) { return }
  if (-not $identity -or (FileSafe $p) -ne $identity) { throw 'Cleanup ownership changed' }
  [IO.File]::Delete($p)
}
function ShopClosed {
  $processes = @(Get-CimInstance Win32_Process)
  $open = @($processes | Where-Object {
    $_.ProcessId -eq $job.parentPid -or $_.Name -match '^Forsage(?:-.*)?\.exe$' -or
    ($_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $target, [StringComparison]::OrdinalIgnoreCase))
  })
  return $open.Count -eq 0
}
$job = $null; $lockIdentity = $null; $targetLockIdentity = $null; $pendingIdentity = $null; $backupIdentity = $null
$replaced = $false; $swapAttempted = $false; $keepRecovery = $false; $result = $null
try {
  $job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:FORSAGE_UPDATE_JOB)) | ConvertFrom-Json
  if ($job.protocol -ne 1 -or $job.jobId -notmatch '^[a-f0-9-]{36}$' -or $job.sha256 -notmatch '^[a-f0-9]{64}$' -or $job.previousHash -notmatch '^[a-f0-9]{64}$' -or $job.releaseId -notmatch '^\d{8}T\d{6}-[a-f0-9]{12}$') { throw 'Invalid local update job' }
  if ($job.parentPid -lt 1 -or $job.size -lt 2 -or $job.size -gt 536870912) { throw 'Invalid local update bounds' }
  $root = LocalPath ([string]$job.root); DirectorySafe $root
  $target = LocalPath ([string]$job.destination)
  if ([IO.Path]::GetExtension($target) -ine '.exe') { throw 'Invalid update destination' }
  $stage = Join-Path $root ($job.sha256 + '.exe')
  if ([string]::Equals($stage, $target, [StringComparison]::OrdinalIgnoreCase)) { throw 'Update target aliases stage' }
  $lockPath = Join-Path $root 'install.lock'; $lockIdentity = FileSafe $lockPath
  $lock = [IO.File]::ReadAllText($lockPath) | ConvertFrom-Json
  if ($lock.jobId -ne $job.jobId) { throw 'Installation lock belongs to another job' }
  $targetLock = $target + '.update-lock'; $targetLockIdentity = FileSafe $targetLock
  $lock = [IO.File]::ReadAllText($targetLock) | ConvertFrom-Json
  if ($lock.jobId -ne $job.jobId) { throw 'Executable lock belongs to another job' }
  $outcome = Join-Path $root ($job.jobId + '.result.json')
  if ([IO.File]::Exists($outcome)) { throw 'Update outcome already exists; manual inspection required' }
  $pending = $target + '.forsage-pending-' + $job.jobId
  $backup = $target + '.forsage-backup-' + $job.jobId
  $rollback = Join-Path $root ('rollback-' + $job.previousHash + '.exe')
  foreach ($p in @($pending,$backup)) { if ([IO.File]::Exists($p) -or [IO.Directory]::Exists($p)) { throw 'Previous installation file exists' } }
  $null = ExeSafe $stage $job.sha256 $job.size
  $targetIdentity = ExeSafe $target $job.previousHash 0
  $deadline = [DateTimeOffset]::Parse($job.deadline)
  if ($deadline -gt [DateTimeOffset]::UtcNow.AddMinutes(6)) { throw 'Invalid update wait deadline' }
  while (-not (ShopClosed)) {
    if ([DateTimeOffset]::UtcNow -ge $deadline) { throw 'Program is still open; update was not installed' }
    Start-Sleep -Milliseconds 500
  }
  if ([DateTimeOffset]::UtcNow -ge $deadline) { throw 'Update wait expired' }
  if ((FileSafe $lockPath) -ne $lockIdentity -or (FileSafe $target) -ne $targetIdentity) { throw 'Update ownership changed' }
  $pendingIdentity = CopyNew $stage $pending
  $null = ExeSafe $pending $job.sha256 $job.size
  $null = ExeSafe $target $job.previousHash 0
  if (-not (ShopClosed)) { throw 'Program reopened; update was not installed' }
  # Windows refuses replacement of an in-use executable. This check also catches non-executable locks.
  $probe = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); $probe.Dispose()
  DirectorySafe ([IO.Path]::GetDirectoryName($target))
  if ((FileSafe $target) -ne $targetIdentity -or (FileSafe $lockPath) -ne $lockIdentity -or (FileSafe $targetLock) -ne $targetLockIdentity) { throw 'Update ownership changed' }
  $swapAttempted = $true
  [IO.File]::Replace($pending, $target, $backup, $false)
  $replaced = $true; $pendingIdentity = $null; $backupIdentity = FileSafe $backup
  $null = ExeSafe $target $job.sha256 $job.size
  $null = ExeSafe $backup $job.previousHash 0
  if ([IO.File]::Exists($rollback)) { $null = ExeSafe $rollback $job.previousHash 0 }
  else { $null = CopyNew $backup $rollback; $null = ExeSafe $rollback $job.previousHash 0 }
  RemoveOwned $backup $backupIdentity; $backupIdentity = $null
  $result = @{ protocol=1; jobId=$job.jobId; state='installed'; releaseId=$job.releaseId; sha256=$job.sha256; previousHash=$job.previousHash; finishedAt=[DateTimeOffset]::UtcNow.ToString('o') }
} catch {
  $message = $_.Exception.Message
  $state = 'failed'
  if ($swapAttempted -and -not $replaced) { $state = 'unknown'; $keepRecovery = $true; $message = 'Unconfirmed atomic replacement; manual inspection required' }
  if ($replaced) {
    try {
      if (-not $backupIdentity -or (FileSafe $backup) -ne $backupIdentity) { throw 'Verified recovery file unavailable' }
      $null = ExeSafe $backup $job.previousHash 0
      $null = ExeSafe $target $job.sha256 $job.size
      if (-not (ShopClosed)) { throw 'Program reopened before recovery' }
      [IO.File]::Replace($backup, $target, $null, $false)
      $backupIdentity = $null
      $null = ExeSafe $target $job.previousHash 0
      $state = 'rolled-back'
    } catch { $state = 'unknown'; $keepRecovery = $true; $message = 'Update outcome requires manual inspection: ' + $_.Exception.Message }
  }
  if ($null -ne $job) { $result = @{ protocol=1; jobId=$job.jobId; state=$state; releaseId=$job.releaseId; message=$message; finishedAt=[DateTimeOffset]::UtcNow.ToString('o') } }
} finally {
  if ($null -ne $result -and $lockIdentity) {
    try {
      if (-not $keepRecovery -and $pendingIdentity) { RemoveOwned $pending $pendingIdentity }
      DirectorySafe $root
      $json = $result | ConvertTo-Json -Compress
      $bytes = [Text.Encoding]::UTF8.GetBytes($json)
      $resultStream = [IO.File]::Open($outcome, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $resultStream.Write($bytes,0,$bytes.Length); $resultStream.Flush($true) } finally { $resultStream.Dispose() }
      if (-not $keepRecovery) { RemoveOwned $targetLock $targetLockIdentity; RemoveOwned $lockPath $lockIdentity }
    } catch { # Keep the lock and recovery files. An unconfirmed result must never be retried automatically.
    }
  }
}
`
