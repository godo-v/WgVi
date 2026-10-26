# How WagVitals detects activity

The app combines the **accelerometer** and the **heart-rate sensor** to decide
every second whether the dog is **sleeping, resting, doing light activity
(sniffing, pottering), walking, running or playing**. All the thresholds live
in `app/js/config.js`.

> **Status:** the thresholds were chosen from published collar-accelerometer
> work and tuned against the built-in simulator. They have **not** been
> validated on real dogs yet. Calibrate them with labelled recordings from the
> real collar (section 6) before relying on the results.

## 1. Pipeline

```
collar ──BLE──▶ parser ──▶ SensorHub ──every 1 s──▶ features (last 4 s of accel)
                                                        │
                       heart rate ÷ resting HR ─────────┤
                                                        ▼
                                   ActivityClassifier: accel scores × HR fit
                                                        │ smoothing, sleep logic
                                                        ▼
                 activity ─▶ today's minutes, gait, alerts, cloud summary, CSV
```

Code: `app/js/analysis/` (`features.js`, `activity.js`, `engine.js`).

## 2. Accelerometer features (4-second window)

| Feature | What it measures | Walking | Running | Playing | Resting |
| --- | --- | --- | --- | --- | --- |
| **VeDBA** (g) | how much the dog moves: mean of \|acceleration − gravity\| | 0.12–0.4 | > 0.5 | > 0.2 | < 0.02 |
| **Periodicity** (0–1) | how rhythmic: autocorrelation peak of the acceleration magnitude | high | high | low–medium | — |
| **Cadence** (Hz) | step frequency at the collar | ~1–2.6 | > 2.5 | irregular | — |
| **Burstiness** | stop-and-go: variation of movement between 0.5 s slices | low | low | high | — |

Gravity is removed per axis and the rhythm is taken from the acceleration
magnitude, so it doesn't matter how the collar has rotated around the neck.

## 3. Sensor fusion

1. **The accelerometer proposes.** Each activity gets a 0–1 score from fuzzy
   ramps on the features above, e.g.
   `walking = intensity_in_walk_range × rhythmic × steady × cadence_fit`,
   `playing = intensity × max(irregular, stop-and-go)`.
2. **Heart rate confirms.** Heart rate is expressed as a multiple of the dog's
   resting rate (`ratio = HR / resting HR`) and each activity has an expected
   band (walking ≈ 1.15–1.6×, running ≥ 1.8×, resting ≤ 1.15×). Each score is
   multiplied by `(1 − w) + w × hr_fit` with `w = hrWeight = 0.5`.
   - When the accelerometer is unsure (brisk walk vs. easy run), heart rate
     decides.
   - Heart rate alone can never invent an activity: a dog lying still with a
     racing heart stays **resting**, and that mismatch raises an alert instead.
   - Heart rate lags movement by 10–30 s, which is another reason it only
     re-weights the accelerometer.
   - Readings with quality < 30 (motion artefacts) or older than 5 s are
     ignored, and the classifier falls back to the accelerometer alone.
3. **Smoothing.** Scores are averaged over time (EMA, factor 0.5) so the label
   doesn't flicker; confidence = top score ÷ sum of scores.
4. **Sleep.** Resting becomes **sleeping** after 2 minutes of near-total
   stillness (VeDBA < 0.012 g) with the heart at or below its resting rate.
   Small twitches don't wake the dog up; real movement or a rising heart does.
5. **Personal baseline.** The app starts from a typical resting heart rate for
   the dog's size and age (dog profile), then **learns the dog's own resting
   rate** from readings taken after at least a minute of accelerometer-confirmed
   rest. Readings above the normal resting range are ignored so stress
   doesn't become "normal".

## 4. Gait analysis (experimental)

WagVitals' first product focuses on gait: gradual changes in how a dog walks
can be an early sign of arthritis. From a collar the clearest gait signal is
the **head bob**. A dog favouring a front leg bobs differently on alternate
steps (the "head nod" of lameness). While the dog walks, the app computes
(after Moe-Nilssen & Helbostad, *J Biomech* 2004):

- **regularity** = autocorrelation at one stride (two steps)
- **symmetry** = step regularity ÷ stride regularity (≈ 100 % sound, lower = uneven)

A symmetry below 85 % raises an informational alert. The simulator's
**Walking with a limp** scenario shows it. This is a proxy, not a diagnosis.
Vets and real gait data are needed to set meaningful limits.

## 5. Alerts

| Alert | Rule | Sensors combined |
| --- | --- | --- |
| Heat-stroke range | temperature ≥ 40.5 °C for 10 s | temp |
| High / low temperature | ≥ 39.5 °C or ≤ 37.5 °C for 10 s | temp |
| Racing heart at rest | resting/asleep and HR > normal resting max for 30 s | accel + HR |
| Very high heart rate | HR > max for the dog's size | HR |
| Fast breathing at rest | resting/asleep and > 30 breaths/min for 30 s | accel + breathing |
| Uneven gait | gait symmetry < 85 % | accel |
| Low battery / signal lost | battery ≤ 15 %, no data for 10 s | collar |

Collar temperature sensors read skin/fur temperature, not core temperature.
Measure the offset against a rectal thermometer and set `VITALS.tempOffsetC`.

## 6. Calibrating with real data

1. Put the collar on a dog and open **Record data** in the app.
2. Pick what the dog is really doing (e.g. *walking*), press **Start
   recording**, and change the label whenever the activity changes. Aim for a
   few minutes of each activity, on several dogs of different sizes.
3. **Export CSV.** Rows with `channel = activity` hold the app's decision and
   features (`v1` detected, `v2` confidence, `v3` VeDBA, `v4` periodicity,
   `v5` cadence). Raw `accel` rows let you recompute any feature offline.
4. Compare, for example in Python:

   ```python
   import pandas as pd
   df = pd.read_csv("wagvitals-2026-10-26T12-00-00.csv")
   act = df[df.channel == "activity"].copy()
   for col, name in [("v3", "vedba"), ("v4", "periodicity"), ("v5", "cadence_hz")]:
       act[name] = pd.to_numeric(act[col])
   print(act.groupby("label")[["vedba", "periodicity", "cadence_hz"]].describe())
   print(pd.crosstab(act.label, act.v1))  # confusion matrix: true label vs detected
   ```

5. Move the ramps in `ACTIVITY_THRESHOLDS` so each activity's typical values
   fall in its band, then run `npm test`. Update the simulator if the real
   signals look different from it, so the tests keep matching reality.

Once a few hours of labelled data exist, the same features can train a small
machine-learning model (e.g. a random forest) that replaces the hand-set
ramps while keeping the rest of the app unchanged.

## References

- Moe-Nilssen R. & Helbostad J.L. (2004). Estimation of gait cycle
  characteristics by trunk accelerometry. *Journal of Biomechanics* 37(1).
- [Use of a Collar-Mounted Triaxial Accelerometer to Predict Speed and Gait in Dogs](https://www.mdpi.com/2076-2615/11/5/1262), *Animals* 2021.
- VeDBA/ODBA as a proxy for movement and energy use: Qasem et al. (2012),
  *PLoS ONE*; Wilson et al. (2006), *Journal of Animal Ecology*.
- Normal canine vital-sign ranges used in `config.js` are typical textbook
  values. WagVitals' veterinary advisors should confirm them.
