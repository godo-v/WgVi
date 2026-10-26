// WagVitals collar: reference firmware sketch for the Nordic nRF52840.
//
// *** UNTESTED STARTING POINT. It has not been compiled or run on hardware. ***
// It shows the firmware half of docs/BLE_PROTOCOL.md so the app and collar
// teams agree on the data format. Replace the read*() stubs with real drivers.
//
// Board support: Adafruit nRF52 Arduino core (Adafruit Feather nRF52840 Sense,
// Seeed XIAO nRF52840 Sense with the Seeed nRF52 core, etc.). Teams using the
// nRF Connect SDK (Zephyr) can follow the same protocol with the NUS sample
// "peripheral_uart".

#include <bluefruit.h>

BLEUart bleuart;  // Nordic UART Service: all sensor data as text lines
BLEBas blebas;    // standard Battery Service
BLEDis bledis;    // standard Device Information Service

const uint32_t ACCEL_PERIOD_MS = 40;      // 25 Hz
const uint32_t HR_PERIOD_MS = 1000;       // 1 Hz
const uint32_t SLOW_PERIOD_MS = 5000;     // temperature + breathing
const uint32_t BATTERY_PERIOD_MS = 30000;

bool streaming = true;

// ---------- Sensor stubs: replace with real drivers ----------

void setupSensors() {
  // e.g. IMU (LSM6DS3 / LSM6DSOX / BMI270), heart rate (MAX30101 / MAX86141),
  // temperature (MAX30205 / TMP117), battery voltage divider on an ADC pin.
}

// Acceleration in g. Mount the IMU firmly on the collar.
void readAccelG(float &x, float &y, float &z) {
  x = 0.0f;
  y = -1.0f;
  z = 0.0f;
}

// Return false when no trustworthy beat was detected.
// quality: 0-100, e.g. from PPG signal amplitude / perfusion index.
bool readHeartRate(int &bpm, int &quality) {
  return false;
}

bool readTemperatureC(float &celsius) {
  return false;
}

bool readBreathingRate(int &breathsPerMin) {
  return false;
}

int readBatteryPercent() {
  return 100;
}

// ---------- BLE ----------

void sendLine(const char *line) {
  if (!streaming || !Bluefruit.connected()) return;
  bleuart.write((const uint8_t *)line, strlen(line));
}

// Commands from the app arrive on the UART RX characteristic, one per line.
void onCommand(uint16_t conn) {
  static char buf[32];
  static uint8_t len = 0;
  while (bleuart.available()) {
    char c = (char)bleuart.read();
    if (c != '\n' && len < sizeof(buf) - 1) {
      buf[len++] = c;
      continue;
    }
    buf[len] = '\0';
    len = 0;
    if (strcmp(buf, "START") == 0) {
      // The app sends START once it has subscribed, so this line is not lost.
      streaming = true;
      char info[48];
      snprintf(info, sizeof info, "I,%lu,fw=0.1.0,hz=%lu\n", (unsigned long)millis(), 1000UL / ACCEL_PERIOD_MS);
      sendLine(info);
    } else if (strcmp(buf, "STOP") == 0) streaming = false;
    else if (strcmp(buf, "PING") == 0) {
      char reply[32];
      snprintf(reply, sizeof reply, "I,%lu,pong\n", (unsigned long)millis());
      sendLine(reply);
    }
  }
}

void onConnect(uint16_t conn) {
  streaming = true;
}

void startAdvertising() {
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(bleuart);  // the app filters on this UUID...
  Bluefruit.ScanResponse.addName();           // ...or on the "WagVitals" name prefix
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);  // units of 0.625 ms
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);
}

void setup() {
  Serial.begin(115200);
  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);  // larger MTU for 25 Hz data
  Bluefruit.begin();
  Bluefruit.setName("WagVitals-Collar");
  Bluefruit.setTxPower(4);
  Bluefruit.Periph.setConnectCallback(onConnect);

  bledis.setManufacturer("WagVitals");
  bledis.setModel("Collar prototype");
  bledis.begin();
  bleuart.begin();
  bleuart.setRxCallback(onCommand);
  blebas.begin();
  blebas.write(readBatteryPercent());

  setupSensors();
  startAdvertising();
}

void loop() {
  static uint32_t nextAccel = 0, nextHr = 0, nextSlow = 0, nextBattery = 0;
  uint32_t now = millis();
  unsigned long t = (unsigned long)now;
  char line[64];

  if ((int32_t)(now - nextAccel) >= 0) {
    nextAccel = now + ACCEL_PERIOD_MS;
    float x, y, z;
    readAccelG(x, y, z);
    snprintf(line, sizeof line, "A,%lu,%d,%d,%d\n", t, (int)(x * 1000), (int)(y * 1000), (int)(z * 1000));
    sendLine(line);
  }

  if ((int32_t)(now - nextHr) >= 0) {
    nextHr = now + HR_PERIOD_MS;
    int bpm, quality;
    if (readHeartRate(bpm, quality)) {
      snprintf(line, sizeof line, "H,%lu,%d,%d\n", t, bpm, quality);
      sendLine(line);
    }
  }

  if ((int32_t)(now - nextSlow) >= 0) {
    nextSlow = now + SLOW_PERIOD_MS;
    float celsius;
    if (readTemperatureC(celsius)) {
      int c100 = (int)(celsius * 100);  // avoid %f: float printf is often disabled
      snprintf(line, sizeof line, "T,%lu,%d.%02d\n", t, c100 / 100, c100 % 100);
      sendLine(line);
    }
    int breaths;
    if (readBreathingRate(breaths)) {
      snprintf(line, sizeof line, "R,%lu,%d\n", t, breaths);
      sendLine(line);
    }
  }

  if ((int32_t)(now - nextBattery) >= 0) {
    nextBattery = now + BATTERY_PERIOD_MS;
    int pct = readBatteryPercent();
    blebas.write(pct);
    snprintf(line, sizeof line, "B,%lu,%d\n", t, pct);
    sendLine(line);
  }
}
