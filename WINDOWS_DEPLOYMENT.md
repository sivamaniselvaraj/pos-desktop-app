# 🖨️ Food Order Printer - Windows Export Package

## 📦 What's Included

### Build Files
- ✅ **build-windows.bat** - Automated build script (Command Prompt)
- ✅ **build-windows.ps1** - Automated build script (PowerShell)
- ✅ **BUILD_WINDOWS.md** - Comprehensive build documentation
- ✅ **WINDOWS_QUICKSTART.md** - 5-minute setup guide
- ✅ **package.json** - Pre-configured for Windows (NSIS + Portable)

### Assets
- ✅ **assets/ICON_GUIDE.md** - Icon setup instructions
- ✅ **assets/** - Placeholder for application icon

### Documentation
- ✅ **README.md** - General project info
- ✅ **.env.example** - Environment configuration template

### Source Code
- ✅ **src/** - Complete TypeScript/React source
- ✅ **db/** - Database schema and RPC functions
- ✅ **tsconfig files** - TypeScript configuration
- ✅ **eslint & prettier config** - Code quality tools

---

## 🚀 Quick Start (TL;DR)

```bash
# 1. Install Node.js (v18+) from https://nodejs.org/

# 2. Extract food-order-printer.zip

# 3. Double-click build-windows.bat
#    (or run build-windows.ps1 in PowerShell)

# 4. Wait for build to complete

# 5. In release/ folder, run: Food Order Printer-1.0.0.exe

# 6. Follow installer wizard

# 7. Configure printers in Settings tab

# Done! 🎉
```

---

## 📋 System Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| OS | Windows 7 SP1 | Windows 10/11 |
| Processor | Intel Core 2 | Intel Core i5 |
| RAM | 2 GB | 4 GB |
| Disk | 500 MB | 1 GB SSD |
| .NET | 4.5+ | 4.8 |

---

## 🔧 Building the Application

### Prerequisites

1. **Node.js** (v18+)
   - Download: https://nodejs.org/
   - Install to default location
   - Restart computer

2. **Visual C++ Build Tools** (optional, for native modules)
   - Download: https://visualstudio.microsoft.com/visual-cpp-build-tools/
   - Or install Visual Studio Community

3. **Thermal Printer** (for testing)
   - USB connection recommended
   - Or network printer available

### Build Steps

#### Option A: Automated (Recommended)

**Batch Script (Command Prompt):**
```
Double-click: build-windows.bat
```

**PowerShell Script:**
```
Right-click: build-windows.ps1
Select: Run with PowerShell
```

#### Option B: Manual

```bash
# Open Command Prompt in project folder
cd path\to\food-order-printer

# Install dependencies
npm install

# Build application
npm run build

# Create Windows packages
npm run package
```

### Output

After build completes, check `release/` folder:

```
release/
├── Food Order Printer-1.0.0.exe          (≈150 MB - Installer)
├── Food Order Printer-1.0.0-portable.exe (≈150 MB - Portable)
├── Food Order Printer 1.0.0.exe.blockmap
└── latest.yml
```

---

## 📦 Distribution Options

### Option 1: Installer (.exe) ⭐ Recommended

**Best for:** Most users, IT deployment, professional setup

**Advantages:**
- Professional installer experience
- Windows Start menu integration
- Desktop shortcut
- Easy uninstall
- System registry updates

**File:** `Food Order Printer-1.0.0.exe` (~150 MB)

**Installation:**
```
1. Double-click .exe
2. Follow wizard (Next → Finish)
3. App appears in Start menu
4. Create shortcuts as needed
```

**Silent Installation (for IT):**
```powershell
# PowerShell as Admin
& ".\Food Order Printer-1.0.0.exe" /S /D="C:\Program Files\FoodOrderPrinter"
```

### Option 2: Portable Executable (.exe)

**Best for:** USB distribution, testing, temporary use

**Advantages:**
- No installation required
- Run from USB drive
- No system changes
- Easy to move/delete
- Ideal for testing

**File:** `Food Order Printer-1.0.0-portable.exe` (~150 MB)

**Usage:**
```
1. Copy .exe to desired location
2. Double-click to run
3. No installation needed
4. Settings saved in app folder
```

### Option 3: Network Share

**Best for:** Enterprise, multiple locations

**Steps:**
```
1. Place .exe on network share
2. Users access via: \\server\share
3. Double-click to run or install
4. All instances connect to same Supabase
```

### Option 4: USB Drive Distribution

**Steps:**
```
1. Copy .exe file to USB
2. Distribute to locations
3. Users run installer from USB
4. Settings persist in Supabase
```

---

## ⚙️ Configuration

### Environment Variables

Create `.env.local` in application root:

```
# Supabase Connection
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key-here
SUPABASE_TABLE=orders

# HTTP Server
HTTP_PORT=5001
HTTP_HOST=0.0.0.0

# Optional: Default Printer
KITCHEN_PRINTER=
```

### Get Supabase Credentials

1. Go to: https://supabase.com
2. Open your project
3. Settings → API
4. Copy **Project URL** and **Anon Key**

### Configure Printers

**Via Settings UI (Recommended):**
1. Launch app
2. Settings tab
3. Add printer type + select device
4. Save

**Or via environment:**
```
KITCHEN_PRINTER=USB001
```

---

## 🖨️ Printer Setup

### Finding Printer Device Name

**Command Prompt (as Admin):**
```powershell
Get-Printer | Select-Object -ExpandProperty Name
```

**Example Output:**
```
USB Thermal Printer
Network Printer
HP LaserJet
Canon MF445dw
Zebra ZD420
```

### Common Device Names

| Type | Device Name |
|------|-------------|
| USB Thermal | USB001, Thermal_Printer |
| Serial/COM | COM1, COM3, COM4 |
| Parallel/LPT | LPT1 |
| Network | \\DESKTOP-ABC\PrinterName |
| Cloud | HTTPPrinter, GoogleCloud |

### Installing Printer Driver

1. **Connect printer** to USB/Network
2. **Windows auto-detects** most thermal printers
3. **If not detected:**
   - Visit manufacturer website
   - Download Windows driver
   - Install and restart
   - Printer appears in device list

---

## 🔐 Firewall Configuration

### Allow App Through Firewall

**Method 1: Windows Defender GUI**
1. Settings → Privacy & Security → Windows Defender Firewall
2. Allow app through firewall
3. Select "Food Order Printer"
4. Check "Private" and "Public"

**Method 2: PowerShell (as Admin)**
```powershell
New-NetFirewallRule -DisplayName "Food Order Printer" `
  -Direction Inbound -Program "C:\Program Files\FoodOrderPrinter\FoodOrderPrinter.exe" `
  -Action Allow
```

**Method 3: Open Port 5001**
1. Advanced Settings
2. Inbound Rules → New Rule
3. Port → TCP → 5001
4. Allow connections → Finish

---

## 🎯 Testing & Validation

### Pre-Production Checklist

- [ ] Install on test machine
- [ ] Verify startup
- [ ] Check Settings page loads
- [ ] Test printer detection
- [ ] Add test printer configuration
- [ ] Verify database connection
- [ ] Test with Android app
- [ ] Check print output
- [ ] Verify firewall rules
- [ ] Test auto-start
- [ ] Create system image

### Test Print Command

```bash
# From Command Prompt
echo Test Print | lpr -S printer-name
```

---

## 🚀 Auto-Start Configuration

### Windows Startup Folder

```
1. Press: Win + R
2. Type: shell:startup
3. Create shortcut to app
4. App launches on every boot
```

### Task Scheduler

```
1. Open Task Scheduler
2. Create Basic Task
3. Name: "Food Order Printer"
4. Trigger: At log on
5. Action: Start program
6. Program: C:\Program Files\FoodOrderPrinter\FoodOrderPrinter.exe
```

### Registry Method (Advanced)

```powershell
# PowerShell as Admin
$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$appPath = "C:\Program Files\FoodOrderPrinter\FoodOrderPrinter.exe"
New-ItemProperty -Path $regPath -Name "FoodOrderPrinter" -Value $appPath -Force
```

---

## 📊 Multi-Location Deployment

### Deploy to Multiple Machines

**Centralized Management via Supabase:**

1. **Install on all machines**
2. **All point to same Supabase**
3. **Printer configs sync automatically**
4. **Settings persist across locations**

**Example Setup:**
```
Location 1:
  - Kitchen Printer (USB001)
  - Cashier Printer (COM1)
  → All synced to Supabase

Location 2:
  - Kitchen Printer (USB002)
  - Cashier Printer (COM2)
  → Same Supabase project
```

**Add New Location:**
1. Install app on new machine
2. Connect to same Supabase
3. Automatically syncs all printer configs
4. Ready to use!

---

## 🆙 Updates & Upgrades

### Check for Updates

```bash
1. New version available?
2. Download food-order-printer-v1.1.0.zip
3. Follow same build process
4. Settings/configs preserved in Supabase
```

### Database Migrations

```bash
1. New schema changes in db/schema.sql?
2. Run migrations in Supabase SQL editor
3. All machines auto-detect updates
4. No downtime needed
```

---

## 🐛 Troubleshooting

### Common Issues

**"Node.js not found"**
- Install Node.js
- Restart computer
- Verify: `node --version`

**"Port 5001 already in use"**
- Change port in `.env.local`: `HTTP_PORT=5002`
- Restart application

**"Printer not showing"**
- Plug in thermal printer
- Wait 30 seconds
- Click refresh in Settings
- If still not shown: install driver

**"Cannot connect from Android"**
- Check firewall rules
- Verify IP address
- Test: `http://your-ip:5001/api/health`

**See WINDOWS_QUICKSTART.md for more troubleshooting**

---

## 📞 Support & Documentation

### Included Documentation

| File | Purpose |
|------|---------|
| **WINDOWS_QUICKSTART.md** | 5-minute setup guide |
| **BUILD_WINDOWS.md** | Detailed build instructions |
| **assets/ICON_GUIDE.md** | Custom icon setup |
| **README.md** | General information |
| **.env.example** | Configuration template |

### Getting Help

1. Check **WINDOWS_QUICKSTART.md** first
2. Review **BUILD_WINDOWS.md** for details
3. Check application logs
4. Email: support@example.com

---

## 📋 File Structure

```
food-order-printer/
├── src/                           # Application source code
│   ├── main/                      # Electron main process
│   ├── renderer/                  # React UI
│   └── preload.ts                 # IPC bridge
├── db/                            # Database
│   ├── schema.sql                 # Tables + RLS
│   └── functions.sql              # RPC functions
├── build-windows.bat              # Build script (CMD)
├── build-windows.ps1              # Build script (PowerShell)
├── BUILD_WINDOWS.md               # Build guide
├── WINDOWS_QUICKSTART.md          # Quick start
├── package.json                   # Dependencies & build config
├── tsconfig.json                  # TypeScript config
├── eslint.config.mjs              # Linting rules
├── .env.example                   # Environment template
└── assets/                        # Icons & resources
    └── ICON_GUIDE.md              # Icon setup

After build:
release/
├── Food Order Printer-1.0.0.exe   # Installer
└── Food Order Printer-1.0.0-portable.exe # Portable
```

---

## ✅ Ready to Deploy!

You now have everything needed to:
- ✅ Build the application on Windows
- ✅ Create professional installer
- ✅ Distribute to other machines
- ✅ Deploy in enterprise environments
- ✅ Manage multiple locations
- ✅ Scale to your needs

**Next Steps:**
1. Review **WINDOWS_QUICKSTART.md**
2. Double-click **build-windows.bat**
3. Follow build prompts
4. Deploy to Windows machines
5. Configure printers
6. Start receiving orders!

---

**Version:** 1.0.0  
**Release Date:** June 2026  
**Platform:** Windows 7+  
**License:** Proprietary

**🖨️ Happy Printing! 🖨️**
