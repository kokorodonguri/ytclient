$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$env:ANDROID_HOME = "C:\Users\i_fujita\AppData\Local\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:JAVA_HOME = "C:\Program Files\Android\openjdk\jdk-21.0.8"
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"

npm.cmd run android:sync
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Set-Location -LiteralPath (Join-Path $root "android")
.\gradlew.bat assembleDebug
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Set-Location -LiteralPath $root
New-Item -ItemType Directory -Path "dist" -Force | Out-Null
Copy-Item -LiteralPath "android\app\build\outputs\apk\debug\app-debug.apk" -Destination "dist\VSPO Client-debug.apk" -Force
Write-Host "APK: $root\dist\VSPO Client-debug.apk"
