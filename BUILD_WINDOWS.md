# Building for Windows

This guide explains how to build and package the Food Order Printer application for Windows machines.

## Prerequisites

1. **Node.js & npm**
   - Download from: https://nodejs.org/
   - Recommended: LTS version (v18+)
   - Verify installation: `node --version` and `npm --version`

2. **Visual C++ Build Tools** (for Windows)
   - Some native dependencies require compilation
   - Download from: https://visualstudio.microsoft.com/visual-cpp-build-tools/
   - Or install Visual Studio Community with C++ workload

3. **Git** (optional, for version control)
   - Download from: https://git-scm.com/

## Installation

1. **Extract the project:**
   ```bash
   # Extract food-order-printer.zip to a folder
   cd food-order-printer
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment:**
   - Copy `.env.example` to `.env.local`
   - Update with your Supabase credentials:
     ```
     SUPABASE_URL=https://your-project.supabase.co
     SUPABASE_ANON_KEY=your-anon-key
     SUPABASE_TABLE=orders
     HTTP_PORT=5001
     HTTP_HOST=0.0.0.0
     KITCHEN_PRINTER=
     ```

## Building

### Option 1: NSIS Installer (Recommended)

Creates a professional installer that users can run to install the app.

```bash
# Build and create installer
npm run package

# Output: release/Food Order Printer-1.0.0.exe
```

**Features:**
- Welcome screen
- License agreement
- Destination folder selection
- Start menu shortcuts
- Desktop shortcut
- Uninstaller included
- Automatic dependency installation

**Install:**
- Users double-click the `.exe` file
- Follow the installation wizard
- App automatically added to Start menu

### Option 2: Portable Executable

Creates a single standalone `.exe` that runs without installation.

```bash
# Build and create portable version
npm run package

# Output: release/Food Order Printer-1.0.0-portable.exe
```

**Features:**
- No installation required
- Run directly from USB drive
- No system registry changes
- Easy to distribute

**Run:**
- Double-click the `.exe` file
- App launches immediately

## Complete Build Process

```bash
# 1. Install dependencies
npm install

# 2. Lint and type-check
npm run lint
npx tsc -p tsconfig.main.json --noEmit
npx tsc -p tsconfig.json --noEmit

# 3. Build application
npm run build

# 4. Create Windows packages (NSIS + Portable)
npm run package

# Output folder: release/
# - Food Order Printer-1.0.0.exe (Installer)
# - Food Order Printer-1.0.0-portable.exe (Portable)
```

## Deployment

### For IT Department / System Administrators

**Group Policy Deployment (NSIS):**
```bash
# Silent installation (no user interaction)
"Food Order Printer-1.0.0.exe" /S /D=C:\Program Files\FoodOrderPrinter
```

**Environment Variables for Deployment:**
Create a deployment package with:
- `.env.local` pre-configured
- Startup scripts
- Printer mappings
- Firewall rules

### For End Users

1. **Installer Version:**
   - Send `Food Order Printer-1.0.0.exe`
   - User runs installer
   - App appears in Start menu
   - Create shortcut to Desktop

2. **Portable Version:**
   - Send `Food Order Printer-1.0.0-portable.exe`
   - User saves to desired location
   - Double-click to run (no installation)
   - Can move to USB or network drive

## Configuration on Windows

### 1. Configure Printers

**Via Settings UI:**
- Open Food Order Printer app
- Go to Settings tab
- Add printers (Kitchen, Cashier, Waiter, etc.)
- Select device from dropdown
- Save

**Store Printers in Database:**
- Configured printers automatically saved to Supabase
- Settings persist across machines
- Synced to local config as fallback

### 2. Environment Variables

**Set via .env.local:**
```
SUPABASE_URL=<your-supabase-url>
SUPABASE_ANON_KEY=<your-anon-key>
HTTP_PORT=5001
KITCHEN_PRINTER=<device-name>
```

**Or via Windows Environment Variables:**
```
setx SUPABASE_URL "https://your-project.supabase.co"
setx SUPABASE_ANON_KEY "your-key"
setx HTTP_PORT "5001"
```

### 3. Printer Setup

**Find Printer Device Names:**
```powershell
# PowerShell command to list printers
Get-Printer | Select-Object -ExpandProperty Name
```

**Common Windows Printer Names:**
- `USB001` (USB thermal printer)
- `COM1`, `COM3` (Serial printer)
- `LPT1` (Parallel printer)
- `\\DESKTOP-ABC\PrinterName` (Network printer)

## Troubleshooting

### App Won't Start

1. **Check Node.js installation:**
   ```bash
   node --version
   npm --version
   ```

2. **Verify dependencies:**
   ```bash
   npm install
   ```

3. **Check ports:**
   - Ensure port 5001 (or configured port) is not in use
   ```bash
   netstat -ano | findstr :5001
   ```

### Printer Not Connecting

1. **Check printer device name:**
   ```powershell
   Get-Printer
   ```

2. **Test USB connection:**
   - Plug in thermal printer
   - Check Device Manager → Ports (COM & LPT)

3. **Verify printer driver:**
   - Visit printer manufacturer website
   - Download latest Windows driver
   - Install driver

4. **Check application permissions:**
   - Run app as Administrator if needed
   - Right-click app → Properties → Advanced → "Run as administrator"

### Firewall Issues

If app can't receive orders from Android:

1. **Windows Firewall:**
   ```bash
   # Allow app through firewall (PowerShell as Admin)
   New-NetFirewallRule -DisplayName "Food Order Printer" `
     -Direction Inbound -Program "C:\Program Files\FoodOrderPrinter\FoodOrderPrinter.exe" `
     -Action Allow
   ```

2. **Or open port manually:**
   - Windows Defender Firewall → Advanced Settings
   - Inbound Rules → New Rule
   - Port: 5001 (or your HTTP_PORT)
   - Allow connections

## Auto-Start on Windows Boot

### Method 1: Startup Folder

1. Press `Win + R`, type: `shell:startup`
2. Create shortcut to `Food Order Printer.exe`
3. App launches on every boot

### Method 2: Task Scheduler

1. Open Task Scheduler
2. Create Basic Task
3. Name: "Food Order Printer"
4. Trigger: "At log on"
5. Action: Start program → `C:\Program Files\FoodOrderPrinter\FoodOrderPrinter.exe`

### Method 3: Registry (Advanced)

```powershell
# PowerShell as Admin
$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$appPath = "C:\Program Files\FoodOrderPrinter\FoodOrderPrinter.exe"
New-ItemProperty -Path $regPath -Name "FoodOrderPrinter" -Value $appPath -Force
```

## Updating the Application

1. **Check for new version:**
   - Download latest `food-order-printer.zip`
   - Extract to new folder

2. **Update database schema (if needed):**
   - Run new SQL migrations from `db/schema.sql`
   - In Supabase SQL editor

3. **Reinstall:**
   - Uninstall old version (Control Panel → Programs)
   - Run new installer
   - Settings/printers persist in database

## System Requirements

**Minimum:**
- Windows 7 SP1 or later
- Intel Core 2 or equivalent
- 2 GB RAM
- 500 MB disk space
- .NET Framework 4.5+ (for some components)

**Recommended:**
- Windows 10/11
- Intel Core i5 or equivalent
- 4 GB RAM
- SSD (1 GB)
- USB 2.0 for printer connection

## Support & Troubleshooting

### Log Files

Logs stored at:
```
C:\Users\<YourUsername>\AppData\Roaming\Food Order Printer\logs
```

### Contact Support

- Email: support@example.com
- Documentation: See README.md
- GitHub Issues: (if applicable)

## Advanced Configuration

### Multiple Machines

**Store configuration centrally:**

1. **Configure on one machine**
2. **Export settings:**
   - Copy `.env.local`
   - Export printer configs from Settings UI
3. **Deploy to other machines:**
   - Place `.env.local` in app directory
   - Or manually add via Settings UI

### Database Sync

All printer settings automatically sync via Supabase:
- Machine A adds "Kitchen Printer"
- Machine B automatically sees it
- Real-time sync across locations

## License

This application is proprietary. Redistribution without permission is prohibited.

---

**Version:** 1.0.0  
**Last Updated:** June 2026  
**Platform:** Windows 7+
