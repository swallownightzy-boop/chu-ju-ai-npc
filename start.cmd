@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".env" (
    echo.
    echo   [!] .env not found.
    echo.
    echo   Copy .env.example to .env, then fill in your DeepSeek API Key:
    echo       copy .env.example .env
    echo.
    pause
    exit /b 1
)

echo.
echo   Starting local server ...
echo.

node --env-file=.env proxy.js

if errorlevel 1 (
    echo.
    echo   [!] Failed to start.
    echo       - Is Node.js 18+ installed?  https://nodejs.org/
    echo       - Is DEEPSEEK_API_KEY filled in .env?
    echo.
    pause
)
