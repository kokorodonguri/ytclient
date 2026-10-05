param(
  [string]$BaseUrl = "http://127.0.0.1:8010",
  [string]$ApiKey = $env:VSPO_API_KEY
)

$ErrorActionPreference = "Stop"
$headers = @{}
if ($ApiKey) {
  $headers["X-API-Key"] = $ApiKey
}

# readiness is public regardless of the key; health always succeeds and would
# miss a feed that never loaded or went stale.
$checkPath = "/api/v1/readiness"
$uri = $BaseUrl.TrimEnd("/") + $checkPath
$response = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 5
if ($response.status -notin @("success", "ready", "degraded")) {
  throw "Health check failed: $($response | ConvertTo-Json -Compress)"
}

"healthy: $BaseUrl"
