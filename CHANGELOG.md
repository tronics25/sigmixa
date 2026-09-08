# Change Log

## 0.8.1

- Added Marketplace screenshots for Frame Definition, RAW Log, Signal Table, Time Series and 3D Trajectory workflows.
- Updated the Trajectory screenshot showcase to use synchronized vehicle Position X, Y and Z Signals.
- Excluded workspace-specific `.sigmixa` settings from packaged extensions.

## 0.8.0

- Added DBC import/export for Frame and Signal definitions, including Intel/Motorola byte order, signedness, Scale/Offset, limits, units and extended CAN IDs.
- Improved BLF compatibility using python-can fixtures, including base-header LogContainers, cross-container objects, padding, file start timestamps and CAN FD 64-byte records.

BLF support is verified with python-can compatibility fixtures but remains
experimental until files produced by multiple CANoe/CANalyzer versions have
been tested.

## 0.7.0 (Pre-Release)

- Renamed the extension and workspace experience to SigMixa.
- Unified commands, Views, project settings and Plugin SDK names under SigMixa.
- Added virtual RAW Log, Signal Table, Time Series, and Trajectory views.
- Added frame-local Expression, Lookup Table, and Filter derived Signals.
- Added External CSV Signals and stateful Plugins.
- Added incremental ASC and experimental BLF input.
