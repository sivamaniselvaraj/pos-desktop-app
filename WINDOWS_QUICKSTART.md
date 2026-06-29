# Food Order Printer - Windows Quick Start

Welcome! This guide will help you get Food Order Printer running on Windows in 5 minutes.

## ⚡ 5-Minute Setup

### Step 1: Install Node.js (2 minutes)

1. Visit: https://nodejs.org/
2. Download **LTS version** (e.g., v20.x)
3. Run installer
4. Accept default settings
5. Restart your computer

**Verify installation:**
```
Open Command Prompt and type:
  node --version
  npm --version
```

### Step 2: Extract Application (1 minute)

1. Extract `food-order-printer.zip`
2. Open folder (e.g., `C:\FoodOrderPrinter`)

### Step 3: Build Application (2 minutes)

**Option A: Batch Script (Easiest)**
```
1. Open: build-windows.bat
2. Follow prompts
3. Wait for completion
```

**Option B: PowerShell**
```
1. Right-click PowerShell
2. Select "Run as Administrator"
3. Type: powershell -ExecutionPolicy Bypass -File build-windows.ps1
4. Press Enter
```

**Option C: Manual**
```
1. Open Command Prompt
2. cd C:\FoodOrderPrinter
3. npm install
4. npm run build
5. npm run package
```

### Step 4: Install Application

In `release/` folder, double-click:
- `Food Order Printer-1.0.0.exe` (Recommended)

Follow the installation wizard.

### Step 5: Configure

1. Launch application
2. Go to Settings tab
3. Add printer: "Kitchen Printer" → Select your device
4. Save

**Done!** Application is ready to use.

---

## 📋 Pre-Build Checklist

- [ ] Windows 7 SP1 or later
- [ ] 2+ GB RAM available
- [ ] 1+ GB disk space
- [ ] Thermal printer connected/available
- [ ] Internet connection (for Supabase sync)

---

## 🖨️ Printer Setup

### Connect USB Thermal Printer

1. Plug printer into USB port
2. Wait 10-30 seconds
3. Windows installs driver automatically
4. Check: Settings app → Devices → Printers

**If not detected:**
1. Visit printer manufacturer website
2. Download Windows driver
3. Install manually
4. Restart computer

### Find Printer Device Name

Open Command Prompt and run:
```powershell
Get-Printer
```

Look for your printer name (e.g., "USB001", "Thermal Printer").

---

## 🔑 Configure Supabase

**Essential:** Get these from your Supabase project:

1. Go to: https://supabase.com
2. Open your project
3. Settings → API
4. Copy:
   - **Project URL** → `SUPABASE_URL`
   - **Anon Key** → `SUPABASE_ANON_KEY`

**Add to application:**

Option A: Edit `.env.local`
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_TABLE=orders
HTTP_PORT=5001
HTTP_HOST=0.0.0.0
```

Option B: Via application Settings UI (after first launch)

---

## ▶️ Running the Application

### After Installation

1. **From Start Menu:**
   - Press `Win` key
   - Type "Food Order Printer"
   - Press Enter

2. **From Desktop:**
   - Double-click desktop shortcut

3. **From Portable:**
   - Double-click `Food Order Printer-1.0.0-portable.exe`

### First Launch

1. Sign in with credentials
2. Check server status (green = ready)
3. Go to Settings
4. Add printers
5. Ready to receive orders!

---

## 📱 Android Integration

To send orders from Android app:

**Configure Android App:**
```
Server: http://<your-computer-ip>:5001
```

**Find your computer IP:**
```
Open Command Prompt and run:
  ipconfig

Look for IPv4 Address (e.g., 192.168.1.100)
```

**Allow through Windows Firewall:**
1. Windows Defender Firewall
2. Allow app through firewall
3. Select Food Order Printer
4. Allow on Private/Public networks

---

## ❓ Troubleshooting

### Application Won't Start

**Error: "node is not recognized"**
- Node.js not installed
- Restart computer after install
- Reinstall Node.js

**Error: "Port 5001 already in use"**
- Another app using port
- In `.env.local`, change: `HTTP_PORT=5002`
- Restart app

### Printer Issues

**Printer not showing in dropdown:**
```
1. Plug in printer
2. Wait 30 seconds
3. In Settings, click "Refresh Printers"
4. Printer should appear
```

**Printing fails:**
1. Check printer power/connection
2. Print test page from Windows
3. In Settings, test with small job
4. Check firewall rules

**Device name not found:**
```
1. Open Command Prompt (as Admin)
2. Type: wmic logicaldisk get name
3. Use device name from printer settings
```

### Cannot Connect to Android

**Check firewall:**
```
1. Go to Settings → Network & Internet
2. Firewall & network protection
3. Allow app through firewall
4. Select Food Order Printer
5. Check "Private" and "Public"
```

**Check IP address:**
```
1. Open Command Prompt
2. Type: ipconfig
3. Find IPv4 Address (192.168.x.x)
4. Use this in Android app
```

**Test connection:**
```
1. On Android: Try http://192.168.1.100:5001/api/health
2. Should return: {"status":"ok"}
```

---

## 🔧 Advanced Settings

### Auto-Start on Boot

**Method 1: Startup Folder (Easiest)**
1. Press `Win + R`
2. Type: `shell:startup`
3. Create shortcut to app
4. Done!

**Method 2: Task Scheduler**
1. Press `Win` key, type "Task Scheduler"
2. Create Basic Task
3. Name: "Food Order Printer"
4. Trigger: "At log on"
5. Action: Start → App path
6. Finish

### Multiple Printers

Each printer has its own device mapping:
```
Kitchen Printer → USB001
Cashier Printer → COM1
Waiter Printer → /dev/usb/lp0
```

All synced to Supabase automatically.

### Change Port

In `.env.local`:
```
HTTP_PORT=5001     # Default
HTTP_PORT=8080     # Alternative
HTTP_PORT=3000     # Another option
```

Restart application.

---

## 📦 Deployment to Other Machines

### Method 1: Direct File Share

1. Copy `release/Food Order Printer-1.0.0.exe` to USB
2. Share USB with colleagues
3. Each person runs installer
4. All connect to same Supabase

### Method 2: Network Share

```
1. Share folder on network
2. Copy .exe file there
3. Others access via \\computer\share
4. Double-click to run
```

### Method 3: Group Policy (Enterprise)

For IT admins:
```
1. Place .exe in group policy directory
2. Create GPO to deploy
3. All machines auto-install
4. Central management via Supabase
```

---

## 🆘 Getting Help

### Check Logs

Logs are stored at:
```
C:\Users\YourUsername\AppData\Roaming\Food Order Printer\logs
```

### Common Issues & Solutions

| Problem | Solution |
|---------|----------|
| App won't open | Reinstall Node.js, rebuild app |
| Port in use | Change HTTP_PORT to 5002 |
| Printer not found | Plug in, wait 30s, refresh |
| Can't connect from Android | Check firewall, verify IP address |
| Database connection fails | Check Supabase URL and key |

### Contact Support

- Email: support@example.com
- Check: BUILD_WINDOWS.md (detailed guide)
- See: README.md (general info)

---

## 🚀 Next Steps

1. ✅ Install Node.js
2. ✅ Extract application
3. ✅ Run build script
4. ✅ Install application
5. ✅ Configure Supabase
6. ✅ Add printers
7. ✅ Test with Android app
8. ✅ Configure auto-start
9. ✅ Deploy to other machines

---

## 📚 Documentation

- **BUILD_WINDOWS.md** - Detailed build instructions
- **README.md** - General information
- **assets/ICON_GUIDE.md** - Custom icon setup

---

**Version:** 1.0.0  
**Last Updated:** June 2026  
**Platform:** Windows 7+

**Enjoy using Food Order Printer! 🖨️**
