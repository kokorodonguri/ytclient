param(
  [string]$BaseUrl = "http://127.0.0.1:8010",
  [string]$ApiKey = $env:VSPO_API_KEY
)

$ErrorActionPreference = "Stop"
$headers = @{}
if ($ApiKey) {
  $headers["X-API-Key"] = $ApiKey
}

$checkPath = if ($ApiKey) { "/api/v1/readiness" } else { "/api/v1/health" }
$uri = $BaseUrl.TrimEnd("/") + $checkPath
$response = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 5
if ($response.status -notin @("success", "ready", "degraded")) {
  throw "Health check failed: $($response | ConvertTo-Json -Compress)"
}

"healthy: $BaseUrl"
