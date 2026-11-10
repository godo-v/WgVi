// WagVitals collar: reference firmware sketch for the Nordic nRF52840.
//
// *** UNTESTED. It has not been compiled or run on hardware. ***
// It implements the firmware half of docs/BLE_PROTOCOL.md. The accelerometer
// is a real LSM6DS3TR-C driver; the other read*() functions are still stubs.
//
// Libraries: Adafruit LSM6DS, Adafruit SPIFlash (Arduino Library Manager).
//
// Board support: Adafruit nRF52 Arduino core (Adafruit Feather nRF52840 Sense,
// Seeed XIAO nRF52840 Sense with the Seeed nRF52 core, etc.). Teams using the
// nRF Connect SDK (Zephyr) can follow the same protocol with the NUS sample
// "peripheral_uart".

#include <Wire.h>
#include <Adafruit_LSM6DS3TRC.h>  // must be the TRC class, not Adafruit_LSM6DS3
#include <Adafruit_SPIFlash.h>
#include <bluefruit.h>

// On-collar SPI flash for storing readings while out of range (SYNC is not
// implemented yet). Set FLASH_SELF_TEST to 0 once the flash is known good.
#define FLASH_CS_PIN 5
#define FLASH_SELF_TEST 1
Adafruit_FlashTransport_SPI flashTransport(FLASH_CS_PIN, &SPI);
Adafruit_SPIFlash flash(&flashTransport);
bool flashReady = false;

Adafruit_LSM6DS3TRC imu;
bool imuReady = false;

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
  // Still to add: heart rate (MAX30101 / MAX86141), temperature (MAX30205 /
  // TMP117), battery voltage divider on an ADC pin.
  imuReady = imu.begin_I2C();  // default I2C address 0x6A
  if (!imuReady) {
    // Do not halt: BLE still comes up, so the fault shows in the app's log.
    Serial.println("Failed to find LSM6DS3TR-C");
    return;
  }
  imu.setAccelRange(LSM6DS_ACCEL_RANGE_4_G);  // 2 g clips when a dog runs or shakes
  imu.setGyroRange(LSM6DS_GYRO_RANGE_250_DPS);
  imu.setAccelDataRate(LSM6DS_RATE_104_HZ);
  imu.setGyroDataRate(LSM6DS_RATE_104_HZ);
}

// Acceleration in g. Mount the IMU firmly on the collar.
// Returns false when the IMU is missing; never send made-up readings.
bool readAccelG(float &x, float &y, float &z) {
  if (!imuReady) return false;
  sensors_event_t accel, gyro, temp;
  imu.getEvent(&accel, &gyro, &temp);
  x = accel.acceleration.x / SENSORS_GRAVITY_STANDARD;  // m/s^2 -> g
  y = accel.acceleration.y / SENSORS_GRAVITY_STANDARD;
  z = accel.acceleration.z / SENSORS_GRAVITY_STANDARD;
  return true;
}

// ---------- Flash ----------

const uint32_t FLASH_SECTOR_BYTES = 4096;

void setupFlash() {
  flashReady = flash.begin();
  if (!flashReady) {
    Serial.println("SPI flash not found");
    return;
  }
#if FLASH_SELF_TEST
  // Write 10 accelerometer samples to the first sector and read them back.
  // Erase only that sector: eraseChip() takes many seconds on every boot and
  // wears the whole chip.
  if (!imuReady) return;
  flash.eraseSector(0);
  flash.waitUntilReady();
  uint32_t address = 0;
  for (int i = 0; i < 10; i++) {
    float sample[3];
    readAccelG(sample[0], sample[1], sample[2]);
    flash.writeBuffer(address, (uint8_t *)sample, sizeof sample);
    address += sizeof sample;
    delay(10);
  }
  for (uint32_t a = 0; a < address && a < FLASH_SECTOR_BYTES; a += 12) {
    float sample[3];
    flash.readBuffer(a, (uint8_t *)sample, sizeof sample);
    Serial.print(a);
    Serial.print(" ");
    Serial.print(sample[0], 3);
    Serial.print(" ");
    Serial.print(sample[1], 3);
    Serial.print(" ");
    Serial.println(sample[2], 3);
  }
#endif
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
  Serial.println("Connected");
}

void onDisconnect(uint16_t conn, uint8_t reason) {
  // 0x13 = the app/phone closed the link, 0x08 = signal lost (timeout),
  // 0x16 = the collar closed it, 0x3E = the connection was never established
  Serial.print("Disconnected, reason 0x");
  Serial.println(reason, HEX);
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
  // Wait briefly for a serial monitor, but never forever: on battery there is
  // no USB host and "while (!Serial)" would hang the collar here.
  for (uint32_t start = millis(); !Serial && millis() - start < 2000;) delay(10);

  // Sensors and flash first, so the collar is only connectable once it can
  // actually serve data.
  setupSensors();
  setupFlash();

  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);  // larger MTU for 25 Hz data
  Bluefruit.begin();
  Bluefruit.setName("WagVitals-Collar");
  Bluefruit.setTxPower(4);
  Bluefruit.Periph.setConnectCallback(onConnect);
  Bluefruit.Periph.setDisconnectCallback(onDisconnect);

  bledis.setManufacturer("WagVitals");
  bledis.setModel("Collar prototype");
  bledis.begin();
  bleuart.begin();
  bleuart.setRxCallback(onCommand);
  blebas.begin();
  blebas.write(readBatteryPercent());

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
    if (readAccelG(x, y, z)) {
      snprintf(line, sizeof line, "A,%lu,%d,%d,%d\n", t, (int)(x * 1000), (int)(y * 1000), (int)(z * 1000));
      sendLine(line);
    }
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

  delay(1);  // yield to the BLE stack and let the MCU sleep between samples
}
