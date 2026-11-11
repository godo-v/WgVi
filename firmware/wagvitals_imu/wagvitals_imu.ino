// WagVitals collar: the team's IMU + flash sketch, plus Bluetooth sending.
//
// Everything is the team's original code except the lines marked "ADDED",
// which stream the accelerometer to the app over the Nordic UART Service
// in the format of docs/BLE_PROTOCOL.md:  A,<millis>,<x>,<y>,<z>  (milli-g).
//
// *** UNTESTED: not compiled or run on hardware. ***

#include <Wire.h>
#include <Adafruit_LSM6DS3TRC.h> // Refer to imu as LSMDS3TRC in code not LSM6DS3 other wise will not work
#include <bluefruit.h>
#include <Adafruit_FlashCache.h>
#include <Adafruit_FlashTransport.h>
#include <Adafruit_SPIFlash.h>
#include <Adafruit_SPIFlashBase.h>
#include <flash_devices.h>
#define FLASH_CS_PIN 5
Adafruit_FlashTransport_SPI flashTransport(FLASH_CS_PIN, &SPI);
Adafruit_SPIFlash flash(&flashTransport);

BLEService myService = BLEService(0x180D);
BLEUart bleuart;                            // ADDED: Nordic UART Service, carries the data to the app
const uint32_t SEND_PERIOD_MS = 40;         // ADDED: 25 Hz, the rate the app's activity detection expects

Adafruit_LSM6DS3TRC lsm6ds; // Or Adafruit_LSM6DS3 for the regular LSM6DS3
float xaccel, yaccel, zaccel;
uint32_t dataaddress = 0x000000;

void setup() {

  //Flash Setup
  flash.begin();
  flash.eraseChip();

  // Start of BLE intialization, seems to be a step in the right direction
  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX); // ADDED: larger packets for streaming
  Bluefruit.begin();
  Bluefruit.setName("Wagvitals");
  myService.begin();
  bleuart.begin();                              // ADDED
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(myService);
  Bluefruit.Advertising.addService(bleuart);    // ADDED
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244); // 20ms fast / 152.5ms slow (units of 0.625ms)
  Bluefruit.Advertising.setFastTimeout(30);   // Fast mode for 30 seconds
  Bluefruit.Advertising.start(0);
  // end BLE setup

  Serial.begin(115200);
  while (!Serial) delay(10);

  Serial.println("LSM6DS3 Test");

  // Initialize I2C and the sensor (default I2C address is 0x6A)
  if (!lsm6ds.begin_I2C()) {
    Serial.println("Failed to find LSM6DS3 chip");
    while (1) {
      delay(10);
    }
  }

  Serial.println("LSM6DS3 Found!");

  // Configure IMU ranges if desired
  lsm6ds.setAccelRange(LSM6DS_ACCEL_RANGE_2_G);
  lsm6ds.setGyroRange(LSM6DS_GYRO_RANGE_250_DPS);
  lsm6ds.setAccelDataRate(LSM6DS_RATE_104_HZ);
  lsm6ds.setGyroDataRate(LSM6DS_RATE_104_HZ);
for(int i = 0; i < 10; i++)
  {
    readimu();
    uploaddata();
    Serial.print(xaccel);
    Serial.print(" ");
    Serial.print(yaccel);
    Serial.print(" ");
    Serial.println(zaccel);
    wait(10);
  }
  uint32_t Address = 0x000000;
  uint32_t data = 0;
  while ( Address < 0x000FFF)
  {
    char readBuffer[32] = {0};
    data = flash.read32(Address);
    Serial.print(Address);
    Serial.print(" ");
    Serial.print(data, HEX);
    Serial.print(" ");
    Serial.print(data);
    Serial.print(" ");
    Serial.println(data, BIN);
    Address = Address + 4;
  }
}

void loop() {
  // ADDED: read the IMU every 40 ms and send it to the app while connected.
  static uint32_t nextSend = 0;
  uint32_t now = millis();
  if ((int32_t)(now - nextSend) >= 0) {
    nextSend = now + SEND_PERIOD_MS;
    readimu();
    if (Bluefruit.connected() && bleuart.notifyEnabled()) {
      // m/s^2 -> milli-g as whole numbers (printf of floats is often disabled)
      char line[48];
      snprintf(line, sizeof line, "A,%lu,%d,%d,%d\n", (unsigned long)now,
               (int)(xaccel * 1000.0f / 9.80665f),
               (int)(yaccel * 1000.0f / 9.80665f),
               (int)(zaccel * 1000.0f / 9.80665f));
      bleuart.write((const uint8_t *)line, strlen(line));
    }
  }
  delay(1); // ADDED: let the BLE stack run
}

void readimu()
{
  sensors_event_t accel;
  sensors_event_t gyro;
  sensors_event_t temp;
  lsm6ds.getEvent(&accel, &gyro, &temp);
  xaccel = accel.acceleration.x;
  yaccel = accel.acceleration.y;
  zaccel = accel.acceleration.z;
}

void uploaddata()
{
  uint8_t floatbuffer[4] = {0};
  memcpy(floatbuffer, &xaccel, sizeof(xaccel));
  flash.writeBuffer(dataaddress, floatbuffer, sizeof(xaccel));
  dataaddress = dataaddress + 4;
  memcpy(floatbuffer, &yaccel, sizeof(yaccel));
  flash.writeBuffer(dataaddress, floatbuffer, sizeof(yaccel));
  dataaddress = dataaddress + 4;
  memcpy(floatbuffer, &zaccel, sizeof(zaccel));
  flash.writeBuffer(dataaddress, floatbuffer, sizeof(zaccel));
  dataaddress = dataaddress + 4;
}

void wait(int waittime)
{
  int endtime = millis() + waittime;
  while (millis() <  endtime)
  {}
}
