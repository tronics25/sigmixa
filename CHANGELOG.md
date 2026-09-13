# Change Log

## 0.10.0

- Added persistent Clips with scoped RAW Log, Table, Time Series and Trajectory views, source navigation, deletion and multi-Clip comparison.
- Added Signal selection and CAN Timestamp alignment to Clip comparison, plus exact hover values and multiple removable capture markers in both chart views.
- Improved large-log responsiveness with virtualized views, bounded series payloads and indexed Clip alignment navigation.
- Added standard RAW Log row selection, Excel-compatible HTML/TSV clipboard copy and opening selected rows in a VS Code text editor.
- Completed RAW Log usability with accurate filtered-result counts and empty states, unloaded-row range selection, selection/copy feedback, sticky identity columns, keyboard navigation, viewport-aware column growth and display-mode-aware keyword matching.
- Completed Signal Table usability with explicit loading and empty states, resizable Signal selection, group-aware search, result-scoped bulk actions, reorderable columns, multi-row selection, Excel-compatible copy and opening rows in a text editor.
- Simplified Signal Table sizing with automatic content and viewport fitting, responsive resizing and double-click content sizing instead of manual sizing buttons.
- Fixed Clip-range table caching, stale decoded search results after Plugin reload and silent view-setting save failures.
- Cleaned binary floating-point tails from exported CSV Timestamps and Signal values while preserving useful precision.
- Unified RAW Log filtering into one keyword field with a VS Code-style regular-expression toggle and removable active-filter chips, added RAW/Decoded CONTENT modes with RAW fallback for undecoded Frames, replaced manual column-sizing actions with automatic initial sizing and double-click fitting, and improved filter validation, empty-state actions, responsive toolbars, Signal selector state retention, localization and keyboard accessibility.
- Refined Time Series and Clip Comparison with broad engineering-unit conversion and notation aliases, stable physical-quantity ordering independent of Signal selection order, paired left/right Y axes for up to two unit families per graph, visible/whole-file/manual Y-axis ranges with optional zero inclusion, gap-connection controls backed by pre-downsampling discontinuity detection, exact sample-time offsets in hover and marker values, per-graph expanding legends, fixed-height scrollable graph panels, clearer loading states, stable zoom during Signal changes, smoother wheel and trackpad navigation, CAN Timestamp-snapped Clip ranges, collision-aware capture markers and screen-size-independent PNG export.
- Added drag-and-drop graph composition, timestamp/value labels and fixed-resolution image export to Time Series and Clip Comparison.
- Improved Trajectory with X-forward/Y-right/Z-up camera presets, correctly inverted axes and grid values, optional data points and gap connection, coordinate inspection, two-point measurements and fixed-resolution PNG export.
- Replaced all five workflow screenshots and added a Clip Comparison screenshot; refreshed the README for the new analysis workflows.

## 0.9.1

- Renamed the Derived Signal Lookup Table type to Linear interpolation and removed the redundant single-option interpolation selector.

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
