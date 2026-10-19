@echo off
chcp 65001 >nul
rem Start the workbench. Keep this file ASCII-only: Chinese text breaks cmd.exe parsing.
cd /d "%~dp0"
where pnpm >nul 2>nul
if errorlevel 1 goto nopnpm
if exist node_modules goto run
echo First run: installing dependencies, this takes a few minutes...
call pnpm install
if errorlevel 1 goto fail
:run
echo Starting... the browser opens http://localhost:5173 in a few seconds.
echo Close this window to stop the server.
start "" /min cmd /c "timeout /t 8 >nul & start http://localhost:5173"
call pnpm dev
goto end
:nopnpm
echo pnpm was not found. Install Node.js 22.19 or newer from https://nodejs.org , then run: npm i -g pnpm
goto fail
:fail
echo.
echo Startup failed. See the messages above.
:end
pause
