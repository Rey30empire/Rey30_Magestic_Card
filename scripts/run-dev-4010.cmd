@echo off
setlocal
cd /d "%~dp0\.."

if not exist "node_modules" (
  echo [%date% %time%] node_modules not found. running npm install...
  call npm install
  if errorlevel 1 (
    echo [%date% %time%] npm install failed.
    exit /b 1
  )
)

if "%PORT%"=="" set "PORT=4010"

if exist ".dev.out.log" del /q ".dev.out.log"
if exist ".dev.err.log" del /q ".dev.err.log"

echo [%date% %time%] starting dev on %PORT% > ".dev.out.log"
call npm run dev >> ".dev.out.log" 2>> ".dev.err.log"
