# SigMixa for VS Code

<img src="media/sigmixa-logo.png" alt="SigMixa" width="620">

[![Version](https://vsmarketplacebadges.dev/version-short/tronics25.sigmixa.svg)](https://marketplace.visualstudio.com/items?itemName=tronics25.sigmixa)
[![Installs](https://vsmarketplacebadges.dev/installs-short/tronics25.sigmixa.svg)](https://marketplace.visualstudio.com/items?itemName=tronics25.sigmixa)
[![Rating](https://vsmarketplacebadges.dev/rating-short/tronics25.sigmixa.svg)](https://marketplace.visualstudio.com/items?itemName=tronics25.sigmixa)
[![License: MIT](https://img.shields.io/github/license/tronics25/sigmixa)](LICENSE)

**Open-source CAN / CAN FD log analyzer that runs locally inside VS Code.**

Decode ASC, BLF, MF4 or MDF captures with DBC, open CSV measurements alongside them, plot Signals, compare intervals across recordings and replay 2D/3D trajectories. SigMixa's built-in analysis runs offline and does not upload your captures.

[![SigMixa in VS Code: define Signals and watch the bit layout, zoom and scroll a graph linked to a 3D trajectory and the trace, check frame timing, receive intervals, states and distributions, then create and compare Clips](media/demo.gif)](media/demo.mp4)

[Watch the video](media/demo.mp4)

A free, open-source alternative for offline CAN log analysis.

## Features

- Import Vector ASC and BLF for Classic CAN and CAN FD, ASAM MDF (MF4 CAN bus logging and measured signals, MDF 3 measured signals) and CSV files of measured values. Large logs load on several threads, with progress, cancellation and diagnostics.
- Define Signals visually with Intel/Motorola byte order, signed values, Scale/Offset, value labels and Multiplexing; import or export DBC definitions.
- Create Derived Signals with expressions, linear interpolation, low-pass filters and moving averages.
- Inspect RAW Logs and Signal Tables with filtering, multi-row copy, VS Code text-editor integration and CSV export.
- Visualize any number of graphs and 2D/3D trajectories in one view, with unit conversion, pinned values and a trace of every CAN ID's latest values, intervals and expected periods.
- Check frame timing and receive intervals per CAN ID, follow states on a timeline, and read the distribution and statistics of Signals over the time span shown.
- Manage logs per analysis with **analysis groups**: folders that share Frame definitions and view settings, overlaid on the workspace's definitions.
- Cut intervals out as Clips and compare logs and Clips side by side, shifting each target in time.
- Export views as SVG/PNG or as an interactive, offline HTML report.
- Extend decoding through local Plugins, including stateful ones, with schema-generated settings.
- Use English or Japanese UI according to your VS Code display language.

## See SigMixa in action

### Define Frames and Signals visually

Configure CAN IDs, frame lengths, bit layouts and Signal decoding rules in one editor, or import the definitions from DBC. Hover or edit a Signal to highlight its bits and MSB/LSB; click a bit to find its definition. Colors follow Signals when rows are reordered. Changes apply automatically. Multiplexed Frames show per-Signal activation rules and a switchable bit-layout preview.

Expand a Derived Signal to edit its linear-interpolation table alongside the curve, or inspect a filter's example step response. Editing a table point highlights the matching curve point without reordering the input rows. Double-click a column boundary to fit its contents.

[![SigMixa Frame Definition editor showing a CAN FD bit layout and Signal definitions](media/screenshots/frame-definition.png)](media/screenshots/frame-definition.png)

### Inspect and decode every frame

Filter Classic CAN and CAN FD Frames by keyword or regular expression, direction, channel and time. Switch CONTENT between RAW bytes and decoded Signals; undefined Frames retain their RAW payload. Select or drag across rows to copy into Excel or open them in a VS Code text editor.

[![SigMixa RAW Log showing decoded CAN frames](media/screenshots/raw-log.png)](media/screenshots/raw-log.png)

### Compare decoded Signals as a table

Choose Signals by Frame or by the channel group of an MF4, MDF or CSV log and inspect their values at their original timestamps, in time order. Reorder or resize columns, copy selected rows, or export the displayed Signals to CSV.

[![SigMixa Signal Table showing decoded vehicle data](media/screenshots/signal-table.png)](media/screenshots/signal-table.png)

### Visualize graphs, trajectories and timing together

**Visualize** stacks any number of views that share one time position: graphs, trajectories, frame timing, receive intervals, state timelines, and distribution and statistics. Zoom, scroll or play, and every view follows.

#### Graphs

Overlay Signals on one time axis and compare them in common units, for example km/h and m/s on one speed axis. Hover or pin markers to read the original samples, so you can check exactly when and by how much a value changed. **Connect gaps** joins samples taken at different periods without changing the measured values.

[![SigMixa Visualize: a speed graph with a state timeline below and the trace](media/screenshots/time-series.png)](media/screenshots/time-series.png)

#### Trajectories

A trajectory is drawn by combining three (or two) values within a frame. Follow a driven path or a moving position in 2D or 3D, rotate and zoom it, and measure the distance and average speed between two points.

[![SigMixa 3D trajectory of a car park drive: rear axle and GNSS antenna](media/screenshots/trajectory.png)](media/screenshots/trajectory.png)

#### Frame timing

Each CAN ID's frames are lined up on the time axis, and stretches without frames are marked. See at a glance whether frames arrive at their period and where they stopped.

[![SigMixa frame timing: periodic CAN IDs and a marked gap in reception](media/screenshots/frame-timing.png)](media/screenshots/frame-timing.png)

#### Receive interval

The time between frames is plotted against the period and a ±10 % band. Check how far and how often reception drifts or is delayed, with the statistics alongside.

[![SigMixa receive intervals of two CAN IDs with their periods, a delayed frame and statistics](media/screenshots/receive-interval.png)](media/screenshots/receive-interval.png)

#### State timeline

Signals with value labels, such as gear or mode, are shown as bands of states. See when each state changed and how long it lasted, on the same time axis as the graphs.

[![SigMixa state timeline of road type and gear below a speed graph](media/screenshots/state-timeline.png)](media/screenshots/state-timeline.png)

#### Distribution and statistics

For the time span shown, or a selected range, see how each Signal's values are spread, with their minimum, maximum, mean and standard deviation. Compare tendencies and spread between sections of a log.

[![SigMixa distribution and statistics of speed, engine speed and accelerator over a selected range](media/screenshots/distribution.png)](media/screenshots/distribution.png)

#### Trace

Below the views, the **trace** lists every CAN ID's latest values at the time position, with receive count, intervals and the deviation from an expected period. Play or step through time and every view follows. Export the views as SVG/PNG or as an HTML report.

### Analysis groups, Clips and comparison

An analysis group is a folder with a `.sigmixa` folder: it holds the Frame definitions and view settings for one analysis and applies them to every log in it, on top of the workspace's definitions. Add a log stored elsewhere to a group and it appears there as well as where it is, using the definitions of the place it is opened from. Copy a group's folder to share it.

When one recording holds several trials, cut each out as a Clip. Select logs and Clips in **ANALYSIS GROUPS** and compare them. CAN, MF4 and CSV logs can be compared side by side, and each one can be shifted in time to line up events.

[![SigMixa comparison of three Clips, shifted in time to line up the brake application](media/screenshots/clip-comparison.png)](media/screenshots/clip-comparison.png)

### Signal flow

In Frame Definition, use **Signal flow** beside a Derived Signal name. Only its upstream dependencies are shown. Select a node to focus its definition; unresolved inputs are marked rather than connected to an unrelated Signal.

## Getting started

1. Install **SigMixa** from the VS Code Marketplace. A downloaded VSIX can also be installed from **Extensions → … → Install from VSIX…**.
2. Open the folder containing your log files in VS Code.
3. Open the SigMixa icon in the Activity Bar.
4. In **ANALYSIS GROUPS**, use **Open CAN Log**, or select a log already in the folder.
5. Add or edit definitions under **FRAME DEFINITIONS**, then use RAW Log, Table and Visualize.

For a guided tour of each analysis view, see the [User Guide](docs/user-guide.md). To explore every main workflow with prepared data and settings, open the [sample workspace](sample).

Use the database button in **FRAME DEFINITIONS** to import `BO_`/`SG_` definitions from
a DBC file. The export button writes one selected Frame or all registered Frames
back to DBC. Existing CAN IDs are never overwritten without confirmation.

Settings are saved in `.sigmixa/project.json`: the workspace root's file holds the workspace's definitions, Plugin registrations, added logs, Clips and view settings, and each analysis group's folder has its own. Workspaces from SigMixa 1.x open as they are.

## CAN ID notation

- Standard IDs use hexadecimal text such as `123` or `7FF`.
- IDs longer than three hexadecimal digits are treated as extended automatically.
- Add `x` to a short ID when it must be treated as extended, for example `5A0x`.

## Plugins

Use **PLUGINS → +** to select a Plugin package directory. Open a registered Plugin to enable or disable it, manage Frame bindings, edit its settings, reload it or unregister it.

Plugin authors can use the [SigMixa Plugin SDK](docs/plugin-sdk.md). Plugins are local executable code, so install only packages you trust.

## Sample workspace

Open the [`sample`](sample) directory as a VS Code workspace. `basic/sigmixa-basic.asc` (or `.blf`, `.mf4`) shows decoding, Plugins, time series and the trace. `basic/sigmixa-basic-decoded.csv` (or `.mdf`) is a log of values converted from CAN data (speed and temperature), which you can view next to a CAN log on the comparison screen. `brake-analysis/` shows analysis groups and Clips, and `parking-drive/` shows 3D and 2D trajectories. See the [sample guide](sample/README.md).

## Compatibility notes

- DBC Signal value labels (`VAL_`) are imported and exported. Edit them from the value-label button beside a Signal name; labels match RAW integers before Scale/Offset. RAW Log, Table and chart markers show the label alongside the numeric value. CSV exports remain numeric.
- DBC Frame/Signal definitions, standard/extended IDs, Intel/Motorola byte order, signedness, Scale/Offset, limits, units, Multiplexing, value labels, floating-point Signals, the expected period (`GenMsgCycleTime`) and CAN FD are supported. Comments, attributes other than `GenMsgCycleTime`, named value tables (`VAL_TABLE_`) and node names are not retained.

## License

SigMixa, including its original logo and icon assets, is available under the
[MIT License](LICENSE). See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for
third-party components.
