# Imports workflow files into the isolated instance and executes each once.
# Usage: ./run.ps1 01-uptime 02-rss-digest   (no arguments = all)
param([Parameter(ValueFromRemainingArguments)][string[]]$Names)
if (-not $Names) { $Names = Get-ChildItem "$PSScriptRoot/workflows/*.json" | ForEach-Object BaseName }
foreach ($name in $Names) {
  $file = Join-Path $PSScriptRoot "workflows/$name.json"
  $id = (Get-Content $file -Raw | ConvertFrom-Json).id
  & "$PSScriptRoot/n8n.ps1" import:workflow "--input=$file" | Out-Null
  $out = & "$PSScriptRoot/n8n.ps1" execute "--id=$id" 2>&1 | Out-String
  if ($out -match 'Execution was successful') { "OK    $name" }
  else {
    "FAIL  $name"
    $out -split "`n" | Where-Object { $_ -match '"message"|"description"|Error|error' -and $_ -notmatch 'Error tracking|Python' } | Select-Object -First 6 | ForEach-Object { $_.Trim().Substring(0, [Math]::Min(220, $_.Trim().Length)) }
  }
}
