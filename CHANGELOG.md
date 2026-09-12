# Change Log

## 0.9.0

- Added CAN Frame multiplexing with per-Signal activation values and ranges, DBC import/export, and Multiplexer-aware decoding and bit-layout previews.
- Added English and Japanese UI localization based on the Visual Studio Code display language.
- Made Frame Definition changes apply automatically while preserving scroll position and sorting Signals by Byte and Bit when reopening the page.
- Improved Signal selection stability so Table and Time Series checkbox changes no longer jump to the top.
- Promoted BLF import from experimental status after validation with python-can fixtures and CANalyzer captures.

## 0.8.1

- Added Marketplace screenshots for Frame Definition, RAW Log, Signal Table, Time Series and 3D Trajectory workflows.
- Updated the Trajectory screenshot showcase to use synchronized vehicle Position X, Y and Z Signals.
- Excluded workspace-specific `.sigmixa` settings from packaged extensions.

## 0.8.0

- Added DBC import/export for Frame and Signal definitions, including Intel/Motorola byte order, signedness, Scale/Offset, limits, units and extended CAN IDs.
- Improved BLF compatibility using python-can fixtures and CANalyzer captures, including base-header LogContainers, cross-container objects, padding, file start timestamps and CAN FD 64-byte records.

## 0.7.0 (Pre-Release)

- Renamed the extension and workspace experience to SigMixa.
- Unified commands, Views, project settings and Plugin SDK names under SigMixa.
- Added virtual RAW Log, Signal Table, Time Series, and Trajectory views.
- Added frame-local Expression, Lookup Table, and Filter derived Signals.
- Added External CSV Signals and stateful Plugins.
- Added incremental ASC and BLF input.
