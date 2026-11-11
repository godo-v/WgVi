# WagVitals collar ↔ app Bluetooth protocol (v0.1)

This is the contract between the collar firmware (Nordic nRF52840) and the app.
If the firmware follows it, the app will connect and show data without code
changes. The parser lives in `app/js/ble/protocol.js`; a reference firmware
sketch is in `firmware/wagvitals_collar/`.

## 1. Connection

The collar is a Bluetooth LE **peripheral**. It must advertise **either**:

- a device name starting with `WagVitals` (e.g. `WagVitals-Collar`), **or**
- the Nordic UART Service UUID below.

All WagVitals data uses the **Nordic UART Service (NUS)**, the standard
"serial port over BLE" service on Nordic chips (`peripheral_uart` sample in the
nRF Connect SDK, `BLEUart` in the Adafruit Arduino core):

| Role | UUID | Properties |
| --- | --- | --- |
| NUS service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | |
| TX: collar → app | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | Notify |
| RX: app → collar | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | Write / Write without response |

The app also subscribes to these **optional** standard services if they exist,
so off-the-shelf sensors and sample code work too:

| Service | Characteristic | Used for |
| --- | --- | --- |
| Heart Rate `0x180D` | Heart Rate Measurement `0x2A37` | heart rate (sensor-contact bits → quality) |
| Health Thermometer `0x1809` | Temperature Measurement `0x2A1C` | temperature |
| Battery `0x180F` | Battery Level `0x2A19` | battery % |

A service the collar advertises must contain its characteristics. A bare
service (for example Heart Rate `0x180D` with no Heart Rate Measurement) gives
the app nothing to subscribe to, and it will refuse the device with "has none
of the WagVitals services".

Pairing is not required. If pairing is enabled, use "Just Works".

## 2. Collar → app messages

> **Current scope: accelerometer only.** The app ignores `H`, `T` and `R`
> lines and the standard Heart Rate / Health Thermometer characteristics.
> Heart rate, temperature and breathing are simulated in the app, chosen from
> the dropdown on each card. Only `A` lines are needed from the collar.

One ASCII line per reading, terminated by `\n` (`\r\n` is fine):

```
<TYPE>,<device_ms>,<value>[,<value>...]\n
```

`device_ms` is the collar's `millis()` since boot. The app uses it for precise
sample spacing, so send the time the sample was **taken**, not sent. It may be
left empty (`H,,72`) if unknown.

| Type | Format | Units | Suggested rate | Example |
| --- | --- | --- | --- | --- |
| `A` accelerometer | `A,ms,x,y,z` | milli-g, integers | **25 Hz** (20–50 Hz) | `A,123456,-12,-981,35` |
| `G` gyroscope (optional) | `G,ms,x,y,z` | degrees/s | with `A` | `G,123456,1.5,-20,0` |
| `H` heart rate | `H,ms,bpm[,quality]` | beats/min; quality 0–100 (default 100) | 1 Hz | `H,123500,92,85` |
| `T` temperature | `T,ms,celsius` | °C, decimals allowed | every 5–30 s | `T,125000,38.62` |
| `R` breathing rate | `R,ms,breaths_per_min` | breaths/min | every 5–30 s | `R,125000,22` |
| `B` battery | `B,ms,percent` | 0–100 | every 30–60 s | `B,130000,81` |
| `W` body weight | `W,ms,kg` | kg | when measured (smart bed, future) | `W,0,24.3` |
| `I` info | `I,ms,free text` | firmware version, sample rate… | on connect | `I,0,fw=0.1.0,hz=25` |
| `#` comment | `# anything` | ignored (debug output) | | `# imu ok` |

Rules:

- Lines longer than 256 characters without a newline are dropped.
- Values outside sane ranges are dropped (accel ±16 g, heart rate 20–400 bpm,
  temperature 20–46 °C, battery 0–100 %, quality 0–100).
- Heart-rate readings with quality below 30 are ignored by the analysis. Report
  low quality when the optical sensor sees motion artefacts or loses contact.
  Don't invent a number.
- Lines can be split across BLE notifications, and one notification can carry
  several lines. The app reassembles them.

### Plain numbers (Bluefruit Plotter style)

The app also accepts what the Bluefruit Connect **Plotter** accepts: a line of
bare numbers separated by commas, semicolons, spaces or tabs, for example
`0.12 -9.81 0.35`. The first three numbers are read as accelerometer x, y, z.
There is no timestamp, so the app uses the arrival time. The unit is worked out
from gravity over the first 10 lines: about 9.8 means m/s² (what the Adafruit
LSM6DS library reports), about 1 means g, about 1000 means milli-g. The
Bluetooth log says which one it picked. Prefer the `A,ms,x,y,z` format when you
can: its timestamps make the activity analysis more accurate.

Bluefruit Connect's **Controller → Accelerometer** screen shows the **phone's**
accelerometer, not the collar's, and only appears when the collar has the
Nordic UART service.

## 3. App → collar commands

Written to the RX characteristic, newline-terminated:

| Command | Meaning |
| --- | --- |
| `START` | start streaming (sent automatically after connecting) |
| `STOP` | stop streaming (sent before a user disconnect) |
| `PING` | optional: reply `I,<ms>,pong` |
| `SYNC` | *planned:* send history stored while out of range (WagVitals' collar keeps up to 7 days) |
| `RATE,<hz>` | *planned:* change the accelerometer rate |

Unknown commands should be ignored.

## 4. Bandwidth and battery

25 Hz × ~22 bytes ≈ 550 bytes/s plus vitals, well within BLE 5 throughput.
Ask for a large MTU (247) and a 15–50 ms connection interval. If battery life
becomes a problem, the next steps are: batch several samples per notification,
switch to a binary format, or compute the activity features on the collar
itself and send only the results.

## 5. Testing the firmware without the app

1. Install **nRF Connect for Mobile** (Android/iOS).
2. Scan, connect to the collar, open the Nordic UART Service.
3. Enable notifications on TX (`6e400003…`): the lines above should scroll by.
4. Write `START` / `STOP` to RX to test commands.

Then open the WagVitals app, click **Connect collar**, and expand
**Bluetooth log** to see exactly what the app receives.
