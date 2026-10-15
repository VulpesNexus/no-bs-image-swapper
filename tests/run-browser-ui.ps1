param([string]$ScreenshotPath = '', [string]$WindowSize = '1000,900')
$ErrorActionPreference = 'Stop'
if ($WindowSize -notmatch '^\d{3,4},\d{3,4}$') { throw 'Invalid window size' }
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$fixture = Join-Path $PSScriptRoot 'browser-ui.html'
if (!(Test-Path -LiteralPath $edge) -or !(Test-Path -LiteralPath $fixture)) {
  throw 'Edge or browser fixture missing'
}
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$profile = Join-Path $tempRoot ('no-bs-image-swapper-browser-' + [guid]::NewGuid().ToString('N'))
if (![IO.Path]::GetFullPath($profile).StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Unsafe profile path'
}
New-Item -ItemType Directory -Path $profile | Out-Null
try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $edge
  $psi.Arguments = '--headless=new --disable-gpu --disable-background-networking --disable-background-timer-throttling --disable-renderer-backgrounding --run-all-compositor-stages-before-draw --no-proxy-server --no-first-run --no-default-browser-check --disable-extensions --window-size=' + $WindowSize + ' --virtual-time-budget=15000 --dump-dom --user-data-dir="' + $profile + '"'
  if ($ScreenshotPath) {
    $screenshot = [IO.Path]::GetFullPath($ScreenshotPath)
    $psi.Arguments += ' --screenshot="' + $screenshot + '"'
  }
  $psi.Arguments += ' "' + ([Uri]$fixture).AbsoluteUri + '"'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($psi)
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (!$process.WaitForExit(30000)) { $process.Kill(); throw 'Edge timed out' }
  $dom = $stdout.Result
  $errorText = $stderr.Result
  $acceptance = [regex]::Match($dom, '<body[^>]*data-acceptance="([^"]*)"').Groups[1].Value
  $errorMessage = [regex]::Match($dom, '<body[^>]*data-error="([^"]*)"').Groups[1].Value
  Write-Output ('Edge exit: ' + $process.ExitCode)
  Write-Output ('Browser UI: ' + $acceptance)
  if ($errorMessage) { Write-Output ('Assertion: ' + $errorMessage) }
  if ($ScreenshotPath -and (Test-Path -LiteralPath $screenshot)) { Write-Output ('Screenshot: ' + $screenshot) }
  if ($process.ExitCode -ne 0 -or $acceptance -ne 'PASS') {
    if ($errorText) { Write-Output ('Edge stderr: ' + $errorText.Substring(0, [Math]::Min(1200, $errorText.Length))) }
    throw 'Browser UI acceptance failed'
  }
} finally {
  if (Test-Path -LiteralPath $profile) {
    $resolved = (Resolve-Path -LiteralPath $profile).Path
    if ($resolved -ne [IO.Path]::GetFullPath($profile)) { throw 'Unsafe cleanup target' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
