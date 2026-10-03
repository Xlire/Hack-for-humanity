@echo off
rem ModalForge launcher (Windows). First run creates a virtual environment and installs dependencies.
cd /d "%~dp0"
if not exist .venv (
  echo Creating virtual environment...
  python -m venv .venv || goto :fail
  call .venv\Scripts\activate.bat
  python -m pip install --upgrade pip >nul
  pip install -r requirements.txt || goto :fail
) else (
  call .venv\Scripts\activate.bat
)
echo.
echo  ModalForge is running at  http://localhost:8000
echo  Press Ctrl+C to stop.
echo.
start "" http://localhost:8000
python -m uvicorn backend.server:app --port 8000
goto :eof
:fail
echo Setup failed. Check that Python 3.10+ is installed and on PATH.
pause
