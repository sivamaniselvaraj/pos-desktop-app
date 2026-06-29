# Application Icon Setup

## Icon Requirements

Windows applications need icons in multiple formats:

### Required Files

1. **icon.ico** (256x256 or larger)
   - Used by Windows installer
   - Used by start menu
   - Used by taskbar

2. **icon.png** (512x512)
   - Alternative format
   - Used by portable executable

## Creating Icons

### Option 1: Online Icon Converter (Easiest)

1. Create icon design (PNG, SVG)
2. Visit: https://icoconvert.com/
3. Upload your PNG/SVG
4. Download as .ico
5. Save as `icon.ico` in this folder

### Option 2: Using GIMP (Free)

1. Download GIMP: https://www.gimp.org/
2. Create 256x256 PNG image
3. File → Export As → Save as .ico
4. Choose "Save as ICO" format
5. Save as `icon.ico` in this folder

### Option 3: Using ImageMagick (Command Line)

```bash
# Convert PNG to ICO
convert icon.png -define icon:auto-resize=256,128,96,64,48,32,16 icon.ico

# Or create from SVG
convert icon.svg -define icon:auto-resize=256 icon.ico
```

### Option 4: Using Online Tools

- **Favicon Generator**: https://www.favicon-generator.org/
- **Icon Converter**: https://cloudconvert.com/
- **ICO Convert**: https://icoconvert.com/

## Icon Design Suggestions

### For Food/Order Printer Application

**Color Scheme:**
- Primary: Green (#4CAF50) - Success/ready
- Accent: White - Clean, modern
- Background: Dark grey (#333) - Professional

**Design Elements:**
- Printer icon with receipt
- Receipt with food items
- Coffee cup with order number
- Checkmark over printer
- Simple, bold design

**File Format:**
- Keep padding/margins
- Simple shapes (circles, rectangles)
- High contrast
- Clear at small sizes (16x16)

## Current Setup

This folder contains:
- `icon.svg` - Vector version (for reference)
- `icon.png` - Raster version (512x512)
- `icon.ico` - Windows icon format

## Where Icons Are Used

1. **Windows Installer:**
   - Welcome screen icon
   - Uninstaller icon
   - Installation progress

2. **Start Menu:**
   - Application tile
   - Pinned shortcut
   - Quick launch

3. **Desktop:**
   - Shortcut icon

4. **Taskbar:**
   - Application button
   - Window preview

5. **File Manager:**
   - Executable icon

## Troubleshooting

### Icon Not Showing in Installer

1. Check file exists: `assets/icon.ico`
2. Ensure it's valid ICO format
3. Rebuild: `npm run package`

### Icon Blurry

1. Create icon from high-resolution source (1024x1024+)
2. Use PNG with transparency
3. Convert properly (multiple sizes)

### Icon Not on Desktop

1. Ensure installer creates desktop shortcut
2. Check `package.json` build config:
   ```json
   "nsis": {
     "createDesktopShortcut": true
   }
   ```

## Icon Resources

**Free Icon Sites:**
- https://www.flaticon.com/
- https://www.iconfinder.com/
- https://www.pixabay.com/

**Icon Design Tools:**
- https://www.canva.com/ (Free tier available)
- https://www.figma.com/ (Free tier)
- https://inkscape.org/ (Free, open-source)

## Professional Icon Creation

For production:
1. Hire designer ($50-200)
2. Specify: 256x256 SVG + PNG + ICO
3. Ensure multiple size variants
4. Test at different scales

## Icon Specifications

| Size | Use |
|------|-----|
| 16x16 | Window title bar, taskbar |
| 32x32 | File explorer, shortcuts |
| 64x64 | Start menu tiles |
| 128x128 | Desktop icons |
| 256x256 | High-DPI displays |

## Next Steps

1. Create or obtain icon (PNG or SVG)
2. Convert to ICO format
3. Place `icon.ico` in this folder
4. Run: `npm run package`
5. Installer will use the icon
