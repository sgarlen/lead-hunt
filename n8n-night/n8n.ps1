# Runs the n8n CLI against the isolated instance in this folder (never touches ~/.n8n).
# Usage: ./n8n.ps1 import:workflow --input=workflows/01-uptime.json
$env:N8N_USER_FOLDER = $PSScriptRoot
$env:N8N_RESTRICT_FILE_ACCESS_TO = Join-Path $PSScriptRoot 'out'
$env:N8N_PORT = '5680'
$env:N8N_DIAGNOSTICS_ENABLED = 'false'
$env:N8N_VERSION_NOTIFICATIONS_ENABLED = 'false'
New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot 'out') | Out-Null
n8n @args
