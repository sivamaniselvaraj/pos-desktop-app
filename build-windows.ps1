#!/usr/bin/env pwsh
# Food Order Printer - Windows Build Script (PowerShell version)
# Usage: powershell -ExecutionPolicy Bypass -File build-windows.ps1

$ErrorActionPreference = "Continue"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Food Order Printer - Windows Build" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if Node.js is installed
try {
    $nodeVersion = node --version
    $npmVersion = npm --version
    Write-Host "[✓] Node.js is installed" -ForegroundColor Green
    Write-Host "    Node: $nodeVersion"
    Write-Host "    npm: $npmVersion"
} catch {
    Write-Host "[✗] Node.js is not installed!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please download and install Node.js from:" -ForegroundColor Yellow
    Write-Host "  https://nodejs.org/" -ForegroundColor Cyan
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "[1/5] Installing dependencies..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "[✗] Failed to install dependencies!" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "[✓] Dependencies installed" -ForegroundColor Green
Write-Host ""

Write-Host "[2/5] Type-checking main process..." -ForegroundColor Cyan
npx tsc -p tsconfig.main.json --noEmit
if ($LASTEXITCODE -ne 0) {
    Write-Host "[⚠] TypeScript errors detected (continuing...)" -ForegroundColor Yellow
}
Write-Host ""

Write-Host "[3/5] Building application..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[✗] Build failed!" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "[✓] Application built" -ForegroundColor Green
Write-Host ""

Write-Host "[4/5] Creating Windows installer and portable executable..." -ForegroundColor Cyan
npm run package
if ($LASTEXITCODE -ne 0) {
    Write-Host "[✗] Failed to create packages!" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "[✓] Packages created" -ForegroundColor Green
Write-Host ""

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  BUILD COMPLETE!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Output files created in:" -ForegroundColor Yellow
Write-Host "  .\release\" -ForegroundColor Cyan
Write-Host ""
Write-Host "Files:" -ForegroundColor Yellow
Write-Host "  - Food Order Printer-1.0.0.exe (Installer)" -ForegroundColor Cyan
Write-Host "  - Food Order Printer-1.0.0-portable.exe (Portable)" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Test the executable on this machine" -ForegroundColor Gray
Write-Host "  2. Distribute to other Windows machines" -ForegroundColor Gray
Write-Host "  3. Or run: explorer .\release" -ForegroundColor Gray
Write-Host ""
Write-Host "For more information, see: BUILD_WINDOWS.md" -ForegroundColor Gray
Write-Host ""

# Optional: Open release folder
$response = Read-Host "Open release folder now? (y/n)"
if ($response -eq "y" -or $response -eq "Y") {
    explorer ".\release"
}
