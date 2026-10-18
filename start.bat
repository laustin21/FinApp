@echo off
REM Starts Gatorstar locally: the backend (port 8000) and the frontend (port 8443)
REM in their own windows, then opens the app in your browser.
REM Double-click this file, or run start.bat from a terminal in this folder.
REM To stop: close the two windows that open.

cd /d "%~dp0"

if not exist venv\Scripts\python.exe (
  echo Setting up Python for the first time...
  python -m venv venv
  venv\Scripts\pip install -r requirements.txt
)
REM Pick up any new backend packages (quick when nothing is missing).
venv\Scripts\python.exe -m pip install -q -r requirements.txt

if not exist frontend\node_modules (
  echo Installing the frontend for the first time...
  pushd frontend
  call npm.cmd install
  popd
)

REM Free ports 8000 and 8443 in case an old copy is still running.
for %%P in (8000 8443) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr /R /C:":%%P .*LISTENING"') do taskkill /F /PID %%A >nul 2>&1
)

start "Gatorstar backend" cmd /k "venv\Scripts\python.exe server.py"
start "Gatorstar frontend" cmd /k "cd frontend && npm.cmd run dev"

echo Waiting for the app to start...
timeout /t 6 /nobreak >nul
REM ?signout: start at the login screen, not signed in to whoever used it last.
start "" "http://localhost:8443/?signout"
