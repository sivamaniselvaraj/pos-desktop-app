@echo off
REM Food Order Printer - Windows Build Script
REM This script builds the application and creates Windows installer

setlocal enabledelayedexpansion

echo.
echo ========================================
echo   Food Order Printer - Windows Build
echo ========================================
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed!
    echo.
    echo Please download and install Node.js from:
    echo   https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [1/5] Checking Node.js version...
node --version
npm --version
echo.

echo [2/5] Installing dependencies...
call npm install
if errorlevel 1 (
    echo [ERROR] Failed to install dependencies!
    pause
    exit /b 1
)
echo.

echo [3/5] Type-checking code...
call npx tsc -p tsconfig.main.json --noEmit
if errorlevel 1 (
    echo [WARNING] TypeScript errors detected!
    echo Continuing anyway...
)
call npx tsc -p tsconfig.json --noEmit
if errorlevel 1 (
    echo [WARNING] TypeScript errors detected!
    echo Continuing anyway...
)
echo.

echo [4/5] Building application...
call npm run build
if errorlevel 1 (
    echo [ERROR] Build failed!
    pause
    exit /b 1
)
echo.

echo [5/5] Creating Windows installer and portable executable...
call npm run package
if errorlevel 1 (
    echo [ERROR] Failed to create packages!
    pause
    exit /b 1
)
echo.

echo ========================================
echo   BUILD COMPLETE!
echo ========================================
echo.
echo Output files created in: release/
echo.
echo Files:
echo   - Food Order Printer-1.0.0.exe (Installer)
echo   - Food Order Printer-1.0.0-portable.exe (Portable)
echo.
echo Next steps:
echo   1. Test the executable on this machine
echo   2. Distribute to other Windows machines
echo   3. Or run: start release
echo.
echo For more information, see: BUILD_WINDOWS.md
echo.
pause
