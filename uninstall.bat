@echo off
echo Removing After Effects MCP bridge from user Scripts folders...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$roots = Get-ChildItem -Path (Join-Path $env:APPDATA 'Adobe\After Effects') -Directory -ErrorAction SilentlyContinue; foreach ($r in $roots) { Remove-Item -Path (Join-Path $r.FullName 'Scripts\Startup\ae_bridge.jsx') -Force -ErrorAction SilentlyContinue; Remove-Item -Path (Join-Path $r.FullName 'Scripts\ae_bridge.jsx') -Force -ErrorAction SilentlyContinue }"
echo Done. If a prefs backup exists (*.ae-mcp-backup) you can restore it manually.
pause
