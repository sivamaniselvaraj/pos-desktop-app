/*
  Bluetooth Audio Controller — final control scheme
    Encoder turn   -> volume
    Encoder press  -> play / pause
    Button (GPIO12)-> previous track
    Button (GPIO13)-> next track
    Button (GPIO16)-> mute (hardware mute via the DAC's XSMT pin)
    Lit button     -> soft standby (screen off, audio paused, LED dims)
  Display: 1.8" ST7735R TFT, grey UI with real VU meters.

  Wiring:
    TFT (SPI):     VCC->3V3, GND->GND, SCK->GPIO18, MOSI->GPIO23,
                   RES->GPIO4, DC/A0->GPIO5, CS->GPIO15, LED->3V3
    DAC PCM5102A:  VIN->5V (!), GND->GND, SCK->GND (!),
                   BCK->GPIO14, LCK->GPIO32, DIN->GPIO33
    Encoder KY-040:GND->GND, +->3V3, CLK->GPIO25, DT->GPIO26, SW->GPIO27
    Buttons:       PREV: GPIO12 to GND    NEXT: GPIO13 to GND
                   MUTE: GPIO16 to GND
                   (no resistors needed - internal pull-ups used)
    DAC XSMT pin:  -> GPIO17  (hardware mute control)
    Standby btn:   switch leg -> GPIO2, other leg -> GND
                   LED anode  -> GPIO19 via 330R resistor, cathode -> GND

  Libraries: ESP32-A2DP + arduino-audio-tools (ZIP from GitHub),
             Adafruit ST7735/ST7789, Adafruit GFX, RotaryEncoder
  IDE: Board = ESP32 Dev Module, Partition = Huge APP (3MB No OTA)
*/

#include "AudioTools.h"
#include "BluetoothA2DPSink.h"
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <SPI.h>
#include <RotaryEncoder.h>

const char* BT_DEVICE_NAME = "BT-Audio-Controller";

// ---------- Display ----------
#define TFT_CS   15
#define TFT_DC    5
#define TFT_RST   4
Adafruit_ST7735 tft = Adafruit_ST7735(TFT_CS, TFT_DC, TFT_RST);

#define COL_BG     0xC618   // light grey background
#define COL_INK    0xFFFF   // white
#define COL_DIM    0x9CF3   // mid grey
#define COL_DARK   0x4208   // dark grey

// ---------- Audio ----------
I2SStream i2s;
BluetoothA2DPSink a2dp_sink(i2s);

// ---------- Controls ----------
const int PIN_CLK     = 25;
const int PIN_DT      = 26;
const int PIN_SW      = 27;   // encoder press = play/pause
const int PIN_PREV    = 12;   // tactile button
const int PIN_NEXT    = 13;   // tactile button
const int PIN_MUTE    = 16;   // tactile button - mute toggle
const int PIN_XSMT    = 17;   // DAC soft-mute pin (LOW = muted)
const int PIN_STANDBY = 2;    // illuminated button - switch leg
const int PIN_LED     = 19;   // illuminated button - LED (via 330R resistor)
RotaryEncoder encoder(PIN_DT, PIN_CLK, RotaryEncoder::LatchMode::FOUR3);

// LED brightness levels (PWM, 0-255)
const int LED_ACTIVE  = 255;  // full glow when running
const int LED_STANDBY = 18;   // dim ember when asleep

bool inStandby = false;
bool isMuted   = false;

int volume = 50;
const unsigned long DEBOUNCE_MS = 250;

// ---------- State ----------
volatile int peakL = 0, peakR = 0;
int dispL = 0, dispR = 0;
bool isPlaying = false;

int  drawnVolume = -1, drawnL = -1, drawnR = -1;
bool drawnPlaying = false, drawnConn = false, drawnMuted = false;

unsigned long lastFrame = 0;
const unsigned long FRAME_MS = 50;   // 20 fps

// VU geometry
const int VU_X_L = 88, VU_X_R = 108;
const int VU_Y = 40, VU_H = 92, VU_SEG = 4;
const int VU_SEGS = VU_H / VU_SEG;

void IRAM_ATTR readEncoder() { encoder.tick(); }

// ---------- Audio callback: sparse peak scan, no drawing ----------
void audioDataCallback(const uint8_t* data, uint32_t len) {
  const int16_t* s = (const int16_t*)data;
  uint32_t frames = len / 4;
  if (!frames) return;
  int pL = 0, pR = 0;
  const int STRIDE = 16;
  for (uint32_t i = 0; i < frames; i += STRIDE) {
    int l = s[2 * i], r = s[2 * i + 1];
    if (l < 0) l = -l;
    if (r < 0) r = -r;
    if (l > pL) pL = l;
    if (r > pR) pR = r;
  }
  peakL = pL; peakR = pR;
}

void connection_state_changed(esp_a2d_connection_state_t st, void* p) {}
void audio_state_changed(esp_a2d_audio_state_t st, void* p) {
  isPlaying = (st == ESP_A2D_AUDIO_STATE_STARTED);
}

// ---------- Drawing ----------
void drawBTIcon(int x, int y, uint16_t c) {
  tft.drawLine(x + 4, y,      x + 4, y + 12, c);
  tft.drawLine(x + 4, y,      x + 8, y + 3,  c);
  tft.drawLine(x + 8, y + 3,  x + 1, y + 9,  c);
  tft.drawLine(x + 4, y + 12, x + 8, y + 9,  c);
  tft.drawLine(x + 8, y + 9,  x + 1, y + 3,  c);
}

void drawStatic() {
  tft.fillScreen(COL_BG);
  tft.fillRect(88, 6, 14, 14, COL_DARK);
  tft.fillRect(108, 6, 14, 14, COL_DARK);
  tft.setTextSize(1);
  tft.setTextColor(COL_INK);
  tft.setCursor(92, 10);  tft.print("L");
  tft.setCursor(112, 10); tft.print("R");

  tft.fillRect(6, 30, 72, 18, COL_DARK);

  for (int y = 54; y < 68; y += 2)
    for (int x = 6; x < 78; x += 2)
      tft.drawPixel(x + ((y / 2) % 2), y, COL_DIM);

  for (int i = 0; i < VU_SEGS; i++) {
    int y = VU_Y + VU_H - (i + 1) * VU_SEG;
    tft.fillRect(VU_X_L, y, 10, 2, COL_DIM);
    tft.fillRect(VU_X_R, y, 10, 2, COL_DIM);
  }
}

int peakToSegs(int peak) {
  long v = (long)peak * VU_SEGS / 26000;
  return (v > VU_SEGS) ? VU_SEGS : (int)v;
}

void drawVUColumn(int x, int nu, int old) {
  if (nu == old) return;
  if (nu > old) {
    for (int i = old; i < nu; i++)
      tft.fillRect(x, VU_Y + VU_H - (i + 1) * VU_SEG, 10, 2, COL_INK);
  } else {
    for (int i = nu; i < old; i++)
      tft.fillRect(x, VU_Y + VU_H - (i + 1) * VU_SEG, 10, 2, COL_DIM);
  }
}

void drawDynamic() {
  bool conn = a2dp_sink.is_connected();
  if (conn != drawnConn) {
    tft.fillRect(6, 4, 12, 16, COL_BG);
    drawBTIcon(6, 5, conn ? COL_INK : COL_DIM);
    drawnConn = conn;
  }

  if (isPlaying != drawnPlaying) {
    tft.fillRect(8, 32, 68, 14, COL_DARK);
    tft.fillRect(isPlaying ? 40 : 10, 32, 4, 14, COL_INK);
    drawnPlaying = isPlaying;
  }

  if (volume != drawnVolume || isMuted != drawnMuted) {
    tft.fillRect(6, 100, 116, 34, COL_BG);
    tft.setTextSize(4);
    tft.setTextColor(isMuted ? COL_DIM : COL_INK);
    tft.setCursor(6, 102);
    tft.print(volume);

    if (isMuted) {
      tft.setTextSize(1);
      tft.setTextColor(COL_INK);
      tft.setCursor(80, 118);
      tft.print("MUTE");
    }
    drawnVolume = volume;
    drawnMuted  = isMuted;
  }

  int sL = peakToSegs(dispL), sR = peakToSegs(dispR);
  drawVUColumn(VU_X_L, sL, drawnL < 0 ? 0 : drawnL);
  drawVUColumn(VU_X_R, sR, drawnR < 0 ? 0 : drawnR);
  drawnL = sL; drawnR = sR;
}

// ---------- Mute (hardware, via the DAC's XSMT pin) ----------
void setMute(bool on) {
  isMuted = on;
  digitalWrite(PIN_XSMT, on ? LOW : HIGH);   // LOW = muted, HIGH = unmuted
}

// ---------- Volume ----------
void handleVolume() {
  static long lastPos = 0;
  long pos = encoder.getPosition();
  if (pos == lastPos) return;

  if (inStandby) { lastPos = pos; return; }   // absorb turns, ignore them

  if (isMuted) setMute(false);                // turning the knob unmutes

  volume = constrain(volume + (int)(pos - lastPos), 0, 100);
  lastPos = pos;
  a2dp_sink.set_volume(map(volume, 0, 100, 0, 127));
}

// ---------- VU ballistics: fast attack, slow decay ----------
void updateVULevels() {
  int pl = peakL, pr = peakR;
  dispL = (pl > dispL) ? pl : dispL - (dispL >> 2);
  dispR = (pr > dispR) ? pr : dispR - (dispR >> 2);
  if (dispL < 0) dispL = 0;
  if (dispR < 0) dispR = 0;
}

// ---------- Fixed-rate screen refresh ----------
void refreshDisplay() {
  if (inStandby) return;                      // screen stays blank
  if (millis() - lastFrame < FRAME_MS) return;
  lastFrame = millis();
  updateVULevels();
  drawDynamic();
}

// ---------- Standby ----------
void enterStandby() {
  inStandby = true;
  if (isPlaying) a2dp_sink.pause();
  digitalWrite(PIN_XSMT, LOW);    // silence the DAC while asleep

  tft.fillScreen(ST77XX_BLACK);   // blank the screen
  analogWrite(PIN_LED, LED_STANDBY);

  // Force a full repaint when we wake
  drawnVolume = -1; drawnL = -1; drawnR = -1;
  drawnConn = false; drawnPlaying = false; drawnMuted = !isMuted;
}

void exitStandby() {
  inStandby = false;
  digitalWrite(PIN_XSMT, isMuted ? LOW : HIGH);   // restore prior mute state
  analogWrite(PIN_LED, LED_ACTIVE);
  drawStatic();                    // rebuild the UI
}

// ---------- Buttons ----------
void handleButtons() {
  static unsigned long lastPrev = 0, lastNext = 0, lastPlay = 0,
                       lastStby = 0, lastMute = 0;
  static bool pPrev = HIGH, pNext = HIGH, pPlay = HIGH,
              pStby = HIGH, pMute = HIGH;

  // Standby button always works, even while asleep
  bool bStby = digitalRead(PIN_STANDBY);
  if (pStby == HIGH && bStby == LOW && millis() - lastStby > DEBOUNCE_MS) {
    if (inStandby) exitStandby();
    else           enterStandby();
    lastStby = millis();
  }
  pStby = bStby;

  if (inStandby) return;          // ignore all other controls while asleep

  bool bPrev = digitalRead(PIN_PREV);
  bool bNext = digitalRead(PIN_NEXT);
  bool bPlay = digitalRead(PIN_SW);
  bool bMute = digitalRead(PIN_MUTE);

  if (pMute == HIGH && bMute == LOW && millis() - lastMute > DEBOUNCE_MS) {
    setMute(!isMuted);
    lastMute = millis();
  }
  pMute = bMute;

  if (pPrev == HIGH && bPrev == LOW && millis() - lastPrev > DEBOUNCE_MS) {
    a2dp_sink.previous();
    lastPrev = millis();
  }
  if (pNext == HIGH && bNext == LOW && millis() - lastNext > DEBOUNCE_MS) {
    a2dp_sink.next();
    lastNext = millis();
  }
  if (pPlay == HIGH && bPlay == LOW && millis() - lastPlay > DEBOUNCE_MS) {
    if (isPlaying) a2dp_sink.pause();
    else           a2dp_sink.play();
    lastPlay = millis();
  }

  pPrev = bPrev; pNext = bNext; pPlay = bPlay;
}

void setup() {
  Serial.begin(115200);
  delay(300);

  tft.initR(INITR_BLACKTAB);   // try INITR_GREENTAB if offset appears
  tft.setRotation(0);
  drawStatic();

  pinMode(PIN_SW,      INPUT_PULLUP);
  pinMode(PIN_PREV,    INPUT_PULLUP);
  pinMode(PIN_NEXT,    INPUT_PULLUP);
  pinMode(PIN_MUTE,    INPUT_PULLUP);
  pinMode(PIN_STANDBY, INPUT_PULLUP);
  pinMode(PIN_XSMT,    OUTPUT);
  digitalWrite(PIN_XSMT, HIGH);       // unmuted on boot
  pinMode(PIN_LED,     OUTPUT);
  analogWrite(PIN_LED, LED_ACTIVE);   // lit on boot
  attachInterrupt(digitalPinToInterrupt(PIN_CLK), readEncoder, CHANGE);
  attachInterrupt(digitalPinToInterrupt(PIN_DT),  readEncoder, CHANGE);

  auto cfg = i2s.defaultConfig(TX_MODE);
  cfg.pin_bck = 14; cfg.pin_ws = 32; cfg.pin_data = 33;
  cfg.sample_rate = 44100; cfg.bits_per_sample = 16; cfg.channels = 2;
  i2s.begin(cfg);

  a2dp_sink.set_on_data_received(audioDataCallback);
  a2dp_sink.set_on_connection_state_changed(connection_state_changed);
  a2dp_sink.set_on_audio_state_changed(audio_state_changed);
  a2dp_sink.start(BT_DEVICE_NAME);
  a2dp_sink.set_volume(map(volume, 0, 100, 0, 127));

  Serial.print("Pair with: ");
  Serial.println(BT_DEVICE_NAME);
}

void loop() {
  handleVolume();
  handleButtons();
  refreshDisplay();
}
