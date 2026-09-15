# SigMixa User Guide

SigMixa analyzes CAN captures locally inside Visual Studio Code. A normal workflow is: open a log, define or import Frames, inspect Signals, isolate an interval as a Clip, and export the result you need.

## 1. Open a project and log

Open the folder that contains your logs. SigMixa stores project settings in `.sigmixa/project.json`, so keep the folder open when you want Frame definitions, Plugins, External CSV sources, Clips and view selections to persist together.

Select the SigMixa icon in the Activity Bar, then use **LOG FILES → Open CAN Log**. ASC and BLF files containing Classic CAN or CAN FD records open in the SigMixa editor. Parsing progress, cancellation and diagnostics appear in the log view.

## 2. Define Frames and Signals

Use **CAN FRAMES → +** to create a Frame, or use the database button to import a DBC file. CAN IDs use hexadecimal text:

- `123` is a standard 11-bit ID.
- IDs longer than three hexadecimal digits are extended automatically.
- Add `x` to a short ID that must be extended, such as `5A0x`.

Frame edits apply immediately. Signal rows are ordered by Byte and Bit when the editor opens. Hover, focus or select a Signal to highlight its occupied bits, MSB and LSB in the Bit Layout. Double-click a column boundary to fit its contents.

For a directly decoded Signal, set Name, Unit, Byte, Bit, Length, signedness, BIG/LITTLE byte order, Scale, Offset and optional Min/Max. Scale may be positive or negative. Power-of-two Scale values use exact integer shifting before Offset; decimal Scale values use exact rational conversion before the final numeric result.

The value-label action assigns names to specific RAW integers, for example `0 = Off` and `1 = On`. The numeric value remains available for calculations and CSV, while decoded views show the state name beside it.

Enable Multiplexing on a Frame to show **ACTIVE WHEN**. Exactly one Signal acts as the `Multiplexer`; other Signals may be `Always`, a value such as `1`, or ranges such as `2-4`. Use the arrows above the Bit Layout to inspect each Multiplexer value.

## 3. Add Derived Signals

Derived Signals operate on Signals defined earlier in the same Frame:

- **Expression** combines Signals and earlier Derived Signals. Type `[` to choose an available name.
- **Linear interpolation** maps one input through editable points and shows the resulting curve.
- **Filter** applies a Low-pass or Moving Average window and shows an example step response.

Use **Signal flow** to visualize the selected Derived Signal's upstream dependencies and jump to a definition.

## 4. Inspect the RAW Log

The RAW Log is virtualized so the view does not create one browser element per Frame. Filter with one keyword or a regular expression, then narrow by direction, decode state, channel or time. Active filters appear as removable chips.

Choose **RAW** to display bytes. Choose **Decoded** to display Signal values; a Frame with no definition falls back to RAW bytes. Horizontal scrolling preserves the complete CONTENT value instead of silently discarding hidden bytes or Signals.

Click or drag to select rows. Copy writes spreadsheet-friendly tab-separated values, and **Open as Text** creates a normal VS Code text document for further editing.

## 5. Use the Signal Table

The Table shows selected Signals at their original event timestamps. Select Signals by Frame or Unit system, reorder columns by dragging their headers, resize columns, copy rows or export CSV. Changed values are emphasized according to relative change; discrete state transitions remain visually distinct.

## 6. Analyze Time Series

Select Signals from the left pane by Frame or Unit system. Compatible units can share an axis and are converted only when necessary; when all selected Signals already use one unit, that original unit is retained.

Use **Graph Layout** to drag Unit families between graphs and axes. A graph accepts up to two Unit families. Additional graphs have a fixed height and the view scrolls vertically.

Hover shows smooth values along the rendered line. Click to pin a marker; fixed markers snap to original measured samples. A compact timestamp offset such as `@-3ms` indicates that a Signal sample differs from the reference line time. **Connect gaps** changes only line drawing, not measured values.

Drag over a time range to reveal contextual actions. You can adjust each edge by CAN Timestamp, zoom to the range, create a Clip or clear it. Save the complete graph area and legends as SVG or PNG.

External CSV adds reference Signals to Time Series. Choose its timestamp column, seconds/milliseconds/microseconds and the value columns to import. Removing the final imported Signal removes that CSV source from the project but does not delete the file.

## 7. Create and compare Clips

A Clip stores a source-log path, start/end CAN Timestamps and selected Signals. It does not duplicate or modify the original capture. Open a Clip's RAW Log, Table, Time Series or Trajectory from **CLIPS**, or navigate back to its source file.

Select multiple Clips and choose **Compare Clips**. Each Clip uses time relative to its alignment anchor. Adjust alignment by clicking, holding, scrolling or dragging; the final position snaps to a CAN Timestamp. Solid and dashed line styles identify Clips in both the graph and value labels. Comparison charts support Graph Layout, fixed measured markers and SVG/PNG export.

## 8. Replay a Trajectory

Choose synchronized X, Y and optional Z Signals from one source. The default coordinate system is X forward, Y right and Z up. Top, Front and Side presets change the camera without changing the data. Axis inversion also reverses its arrow and grid values.

Show data points when inspecting sparse motion, choose whether gaps connect, and use two selected points to measure elapsed time, coordinate deltas, straight distance, path length and average speed. Save the current view as SVG or PNG.

## 9. Import and export DBC

DBC import supports Frame and Signal names, standard/extended CAN IDs, Intel/Motorola byte order, signedness, Scale/Offset, Min/Max, Units, Multiplexing and direct `VAL_` value labels. Existing matching CAN IDs require confirmation before replacement.

DBC export writes the same directly decoded Signal properties. Derived Signal expressions, interpolation tables and filters have no standard DBC representation, so SigMixa reports them and leaves them out. DBC-only metadata such as comments, attributes and reusable named value tables is not retained in the SigMixa project model.

## 10. Use Plugins safely

Plugins extend decoding with local CommonJS packages. Register a package from **PLUGINS → +**, then manage its enabled state, Frame bindings and schema-generated settings. Plugins execute locally in the VS Code Extension Host, so install only code you trust. See the [Plugin SDK](plugin-sdk.md) for the public contract.

## Compatibility and operational limits

- External CSV Signals are available in Time Series, not in the event-row Table or Trajectory.
- Trajectory requires X/Y/Z samples from one source with exactly matching timestamps; it does not resample unmatched series.
- Very large captures still consume memory proportional to the parsed Frames and decoded Signals. Views and chart payloads are bounded, but the complete analysis store is currently in memory.
- Charts reduce display points for responsiveness. Fixed markers inspect the original stored samples.
- Plugins run synchronously and are not sandboxed; slow Plugin processing can delay analysis.
- Clips reference their source files. Moving, renaming or replacing a source file affects the saved Clip.
- UI localization covers the main English and Japanese workflows; some low-level diagnostics remain English.

For a prepared walkthrough, use the [sample workspace](../sample/README.md).
