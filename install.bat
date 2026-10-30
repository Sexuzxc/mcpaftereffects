@echo off
echo Installing After Effects MCP Server...
python "%~dp0install.py" %*
if errorlevel 1 (
  echo.
  echo Python not found or installer failed. Install Python 3.10+ from python.org and re-run.
  pause
  exit /b 1
)
pause
