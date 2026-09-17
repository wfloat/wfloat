# Known Samsung battery-current issue

Some Samsung firmware returns **milliamps** through Android's API documented
in **microamps**. Using the documented conversion then displays current
**1,000× too small**. Our offline inspection confirmed this path in Galaxy S23
**SM-S911U1 / S911U1UES3CXD7** firmware; reports on other Samsung models show the
problem is broader, without establishing every affected model or build.

The app preserves the OS integer and uses Android's documented conversion for
all devices. It applies **no automatic correction**. The `rawMicroamps` field
is named for the API contract, not independently verified firmware units.

Evidence: [Home Assistant's S21 report](https://github.com/home-assistant/android/issues/2846),
[AccuBattery's explanation](https://accubattery.zendesk.com/hc/en-us/articles/210480245-Calibration-not-working-about-power-measurements),
and the [S23 firmware inspected](https://samfw.com/firmware/SM-S911U1/XAA/S911U1UES3CXD7).
Home Assistant's [fix](https://github.com/home-assistant/android/pull/2848)
adds an app setting; it does not establish a Samsung firmware fix.
