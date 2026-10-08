# Real-device matrix (ARCH §21.3)

Humans run these tests. Claude Code prepares the builds, checklists and instrumentation; results are marked **pending human verification** until someone records them here.

## Devices

Pick the Android devices from the pilot customer's device census: the brands and Android versions its guards actually carry. Include at least one aggressive-manufacturer phone and the oldest Android version supported (D-20).

| #   | Device                       | OS / skin           | Why it is in the matrix                |
| --- | ---------------------------- | ------------------- | -------------------------------------- |
| 1   | Pixel-class (stock Android)  |                     | baseline                               |
| 2   | Samsung mid-range            | One UI              | common                                 |
| 3   | Xiaomi / Redmi               | HyperOS / MIUI      | aggressive background killing          |
| 4   | Oppo or Realme               | ColorOS             | aggressive                             |
| 5   | Vivo                         | Funtouch / OriginOS | aggressive                             |
| 6   | Infinix or Tecno             | XOS / HiOS          | very common at the low end in Pakistan |
| 7   | Low-RAM device               |                     | memory pressure                        |
| 8   | iPhone (owner's test device) | latest iOS          | iOS baseline                           |

## Scenarios

foreground · background · screen locked · 12-hour overnight soak on battery with the screen off · stationed guard (standing still at a post) · roaming patrol (on foot, motorbike, vehicle) · poor GPS (indoors, basement) · poor network · no network · captive Wi-Fi · battery saver / low-power mode · location services off · permission downgraded to "while using" mid-shift · precise → approximate mid-shift · notifications disabled · app swiped from recents · force-stop / force-quit · reboot mid-shift · app update mid-shift · manual clock change ±2 h · timezone change · low storage · SOS with the screen locked · SOS in airplane mode, then reconnect

## Results

| Date | Device | OS  | Build | Scenario | Result                     | Gaps (count / longest) | Battery %/h | Data MB/shift | Tester | Notes |
| ---- | ------ | --- | ----- | -------- | -------------------------- | ---------------------- | ----------- | ------------- | ------ | ----- |
|      |        |     |       |          | pending human verification |                        |             |               |        |       |
