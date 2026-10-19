# Signs one file in place with the Authenticode certificate held by SSL.com
# eSigner, through CodeSignTool (installed in CODESIGN_TOOL_DIR, default
# C:\CodeSignTool, with a JRE). Credentials come from CODESIGN_USERNAME,
# CODESIGN_PASSWORD, CODESIGN_CREDENTIAL_ID and CODESIGN_TOTP_SECRET.
#   pwsh -File scripts/sign-windows.ps1 path\to\file.exe
# Called by scripts/release-windows.sh for the helpers and by Tauri
# (bundle.windows.signCommand) for the app and the installer.
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
$tool = if ($env:CODESIGN_TOOL_DIR) { $env:CODESIGN_TOOL_DIR } else { 'C:\CodeSignTool' }
$name = Split-Path $Path -Leaf
$signArgs = @(
  'sign'
  "-input_file_path=$Path"
  "-credential_id=$env:CODESIGN_CREDENTIAL_ID"
  "-username=$env:CODESIGN_USERNAME"
  "-password=$env:CODESIGN_PASSWORD"
  "-totp_secret=$env:CODESIGN_TOTP_SECRET"
  '-override=true'
)
# eSigner refuses bursts (QuotaExceeded, rate limits) and times out now and
# then: a bounded number of tries, waiting longer each time.
for ($try = 1; $try -le 5; $try++) {
  Push-Location $tool
  try {
    $out = & .\CodeSignTool.bat @signArgs 2>&1 | Out-String
    $code = $LASTEXITCODE
  } finally { Pop-Location }
  if ($code -eq 0 -and $out -notmatch 'Error:') { break }
  Write-Host "signing $name, try $try failed (exit $code):"
  Write-Host $out
  if ($try -eq 5) { throw "could not sign $name" }
  Start-Sleep -Seconds (30 * $try)
}
$sig = Get-AuthenticodeSignature $Path
if ($sig.Status -ne 'Valid') { throw "signature on ${name}: $($sig.Status)" }
Write-Host "signed $name [$($sig.SignerCertificate.Subject)]"
