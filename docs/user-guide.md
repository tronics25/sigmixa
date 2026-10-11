# SigMixa User Guide

SigMixa analyzes CAN captures locally inside Visual Studio Code. A typical workflow:

1. Open the folder that holds your logs.
2. Define Frames, or import them from DBC.
3. Open a log and inspect it in **RAW Log**, **Table** and **Visualize**.
4. Cut out the intervals you care about as Clips, then compare logs and Clips.
5. Group logs that share an analysis, so they share definitions and views.

To try every step with prepared data, open the [sample workspace](../sample/README.md).

## 1. Workspace, analysis groups and logs

Open the folder that contains your logs, then select the SigMixa icon in the Activity Bar. The sidebar has three panes:

- **ANALYSIS GROUPS** shows the workspace as it is on disk: analysis groups, folders, logs and each log's Clips.
- **FRAME DEFINITIONS** holds the workspace's definitions, which every log uses.
- **PLUGINS** lists registered Plugins.

### Analysis groups

An analysis group bundles Frame definitions and view settings for one thing you analyse, such as brake behaviour. It applies them to every log it holds.

- **A group is a folder that contains a `.sigmixa` folder.** The workspace itself is the top level: its definitions apply to every log.
- **Create a group:** use **Add Analysis Group** (a new folder), or **Make Folder an Analysis Group** on an existing folder in the pane or in the Explorer.
- **Which logs a group holds:** a log belongs to the nearest group above it on disk.
- **Definitions build up level by level.** A group's own Frame definitions override the ones above it that have the same CAN ID. Everything else comes from the levels above.
- **Open CAN Log** on a group or folder opens logs from anywhere, even outside the workspace. For a log that is not in that place yet, you choose how it gets there: **Add as a link**, **Move** or **Copy** (see below); then it opens there. **Open CAN Log** in the pane's title bar does the same for the workspace itself; a log already in the workspace just opens.
- **Use a log in more than one analysis.** A log added as a link stays where it is and also appears in the group, like a shortcut. Opened from the group, it uses that group's definitions and views; opened from its own place, it uses that place's. **Remove from This Group** takes it off the group's list without touching the file.
- **Every path inside `.sigmixa` is relative to its folder.** To share or back up a group, copy its folder.
- **Move, copy or link logs.** Drag logs onto a group or folder (from this pane, from the Explorer, or from Finder or File Explorer), or use **Move or Copy…**, then choose: **Add as a link** (the file stays and is also shown in the destination group), **Move** (the file goes to the destination folder, with its Clips, view settings and links) or **Copy** (the file is copied with its Clips, and the copy uses the destination group's settings). Nothing is overwritten. What cannot be done is reported and left as it is: a link cannot be moved (move the log where it is), a Clip cannot be moved (it follows its log, so move the log), and a log that is not found cannot be moved, copied or linked. Log files copied in Finder or File Explorer can also be pasted: select a group or folder and press ⌘V / Ctrl+V, or choose **Paste Logs**.
- **Right-click an item to manage it.** Logs can be opened, renamed, moved to the trash and have their path copied; Clips can be opened, renamed and deleted; groups and folders can be renamed, and **Remove Analysis Group** turns a group back into a plain folder, keeping its logs. F2 renames the selected item and Delete (⌘⌫ on macOS) deletes it. Renaming keeps Clips, view settings and references from other groups; moving a log to the trash also deletes its Clips and view settings, after a confirmation.

Each level stores its settings in its own `.sigmixa/project.json`. Workspaces from SigMixa 1.x load as the workspace level.

Logs are ASC or BLF files with Classic CAN or CAN FD records. Parsing progress, cancellation and diagnostics appear in the log view.

## 2. Define Frames and Signals

Use **FRAME DEFINITIONS → +** to register a Frame, or use the database button to import a DBC file. CAN IDs use hexadecimal text:

- `123` is a standard 11-bit ID.
- IDs longer than three hexadecimal digits are extended automatically.
- Add `x` to a short ID that must be extended, such as `5A0x`.

To define Frames for one analysis only, open **Group Frame Definitions** on a group. **+ Add Frame** on a CAN ID that a level above already defines starts from that definition.

The group's list shows how each Frame relates to the level above: new, or overriding. **↑ Promote** moves selected definitions one level up. If a CAN ID conflicts there, you choose for each one whether to override it or keep the definition above.

Frame edits apply immediately. The Signal tables can be filled in with the keyboard alone, as in a spreadsheet: ↑/↓ and Enter/Shift+Enter move within a column (Enter in the last row adds a row), Tab/Shift+Tab move along a row and on to the next one, Esc puts back the value a cell had, and ←/→ change the choice in a cell with choices. Hover, focus or select a Signal to highlight its bits, MSB and LSB in the layout. Double-click a column boundary to fit its contents. Cells copied in a spreadsheet can be pasted: they fill the table from the focused cell, across the columns as shown and down the rows, adding rows after the last one. A value a cell cannot take is left as it was and reported under the table. Ctrl+D (⌘D) copies the cell above.

For a directly decoded Signal, set Name, Unit, Byte, Bit, Length, signedness, byte order, Scale, Offset and optional Min/Max. Scale may be positive or negative. Power-of-two Scale values shift the integer RAW value exactly before Offset is added; decimal Scale values use exact rational conversion until the final result.

The value-label action names specific RAW integers, for example `0 = Off` and `1 = On`. The number stays available for calculations and CSV; decoded views show the name beside it.

Enable Multiplexing on a Frame to show **ACTIVE WHEN**. One Signal is the `Multiplexer`; others are `Always`, a value such as `1`, or ranges such as `2-4`. Use the arrows above the layout to inspect each Multiplexer value.

A Frame may set an **expected period**. The trace then shows how far each interval deviates from it.

## 3. Add Derived Signals

Derived Signals are calculated from Signals of the same Frame:

- **Expression** combines Signals and earlier Derived Signals. Type `[` to choose a name.
- **Linear interpolation** maps one input through editable points and shows the resulting curve.
- **Filter** applies a Low-pass or Moving Average window and shows an example step response.

In the RAW Log's Decoded display, hover or focus a value to see how it was obtained:

- Direct Signals show their payload bits and the Scale/Offset conversion.
- Derived Signals show the expression and its input values, the interpolation points, or the filter settings and history used for that Frame.

Use **Signal flow** to see a Derived Signal's upstream dependencies and jump to a definition.

## 4. Inspect the RAW Log

The RAW Log handles large captures without slowing down. Filter with a keyword or a regular expression, then narrow by direction, decode state, channel or time.

- **Choose the content.** **RAW** displays the payload bytes. **Decoded** displays Signal values; a Frame with no definition shows its RAW bytes.
- **Select and copy rows.** Click or drag to select rows. Copy writes tab-separated values for spreadsheets. Right-click and choose **Open Row in Text Editor** to open the selected rows in a VS Code text editor.
- **Check diagnostics.** Parser and decoding problems are counted and listed per kind, for example a Frame shorter than its definition.

## 5. Use the Table

The Table shows selected Signals at their original event timestamps.

- Select Signals by Frame or by unit system.
- The Signal lists show the Signals the open log contains, plus any already chosen. When a log's view settings are **Shared in group**, the filter button beside the search box is lit while the list is narrowed; click it to also list and choose a Signal that only another log of the group has.
- Reorder columns by dragging their headers, and resize them.
- Copy rows or export CSV.
- Changed values are highlighted by how much they changed; state changes stand out on their own.
- Select a continuous range of rows and use **Create Clip from selection** to save it as a Clip.

## 6. Visualize: graphs, trajectories and the trace

**Visualize** holds any number of graph and trajectory views, one below another. All views share one time position.

- **Add views.** Use **Add graph** to add a graph or a trajectory. Each view has its own Signals and settings. A view shows its name and legend on one row; point at a view, or select it, to show its actions (settings, move up, duplicate, delete). Click the name to rename it. A graph none of whose Signals are in the log shrinks to one line.
- **Change a view's settings.** Click a view, or choose **Graph settings**, to open its settings beside the views: Signals, axes and display options.

### Graphs

- **Unit systems.** Compatible units are converted onto one axis. For example, km/h from CAN and m/s from a CSV file share one speed axis. When all Signals already use one unit, that unit is kept. A graph shows up to two unit systems on real-value axes; with more, choose normalized display, or let SigMixa split the extra unit systems into further graphs.
- **Gaps.** **Connect gaps** draws continuous lines between samples taken at different times or periods. It changes only the drawing, not the measured values.
- **Values.** Hover to read values along the line. Click to pin a marker, which snaps to the original measured samples. A compact offset such as `@-3ms` marks a sample taken at a different time from the marker. Hover a legend entry to emphasize that Signal's line and values.
- **One time axis.** Every graph shows the same time span. Zoom with the buttons at the top right of Visualize, or zoom and scroll with the wheel on any graph: all graphs follow.
- **Time ranges.** Drag over a time range in any graph. The range belongs to the whole log, so its controls appear at the top right of Visualize: adjust its edges by CAN Timestamp, zoom to it, create a Clip from it, or clear it.

### Trajectories

- **Series.** A trajectory draws X, Y and optional Z Signals from one source. Without Z it is 2D. One view can draw several series at once, for example four wheel positions, or a vehicle and an obstacle.
- **Camera.** The default coordinates are X forward, Y right and Z up. **Top**, **Front** and **Side** change the camera without changing the data. Drag to rotate and scroll to zoom.
- **Inspection.** Show data points, inspect coordinates, or select two points to measure elapsed time, coordinate differences, straight distance, path length and average speed.

### The trace

- **Values at the time position.** The trace below the views lists each CAN ID's latest values at the current time position: last time, age, receive count, intervals and the deviation from an expected period. A Frame that has stopped arriving is marked.
- **Playing and following.** Play, step or drag the time position; graphs and trajectories follow it.
- **Arranging rows.** Pin CAN IDs to keep them at the top. Switch rows between RAW and decoded. Right-click to choose columns.

### External CSV

**External CSV** adds reference Signals to graphs. Choose the timestamp column, its unit (seconds, milliseconds or microseconds) and the value columns. Removing the last imported Signal removes the CSV source from the project; the file itself is kept.

### Where view settings are saved

In an analysis group, **View settings** chooses where a log's view settings are saved: **This file** or **Shared in group**. Shared settings make every log of the group open with the same views.

### Export

Use **Export** to save the views as SVG or PNG, or as an HTML report. The report is a single file that works offline, with interactive graphs and tables. Choose **Standard** (data thinned evenly where there is a lot, and the report says what was thinned) or **All samples**. The report of a log also marks the log's Clips on its graphs.

## 7. Clips and comparison

A Clip is a time range of a log: a name with a start and an end. It stores only a reference to the log and the range; the log itself is never copied or changed.

- **A Clip follows its log.** Wherever the log is shown, in its own folder and in every group it was added to, the same Clips are listed. Opened from a place, a Clip uses that place's Frame definitions and view settings, limited to its time range; it has no view settings of its own. Renaming or deleting a Clip applies everywhere.

- **When to use a Clip:** when one recording holds several trials, cut each out as a Clip. Keep separately recorded logs as files and put them in an analysis group.
- **Seeing Clips on the log:** when the log itself is open, each graph marks its Clips' time ranges with a faint band and, above the plot, a span marker with the Clip's name. Clips that overlap are shown on separate rows.
- **Creating Clips:** from a time range in a graph, or from selected Table rows. Clips appear under their log in **ANALYSIS GROUPS**. **Open Source Log** opens the log a Clip came from.
- **Changing a Clip's range:** on a graph of the log, drag the bar at either end of the Clip's span marker (Esc cancels the drag). For exact times, right-click the Clip in **ANALYSIS GROUPS** and choose **Change Range…**. An open Clip is reopened with its new range.

To compare, select two or more logs or Clips in **ANALYSIS GROUPS** and choose **Compare Selected Logs/Clips**. Logs and Clips can be mixed.

- **Shift in time.** Each target can be shifted either way, to line up an event. Drag its time shift, use the wheel (one CAN Timestamp per notch) or ◀/▶, and double-click to reset it to 0. The shift snaps to the target's own CAN Timestamps.
- **Line style.** Each target has its own line style in the graphs.
- **Signal lists.** Signals that only some targets have are listed separately.
- **One time axis.** As in Visualize, every graph of a comparison shows the same span of time. Zoom with **Zoom in**, **Zoom out** and **Reset** at the top, or with the wheel on any graph. Drag over a time range in any graph to select it on all of them; **Zoom to range** and **Clear** then appear at the top. A graph's own buttons appear on its top edge while the pointer is over it.
- **Saving.** Comparisons are not saved. Export them as SVG, PNG or an HTML report.

## 8. Import and export DBC

DBC import supports:

- Frame and Signal names, standard and extended CAN IDs
- Intel/Motorola byte order, signedness, Scale/Offset, Min/Max and units
- Multiplexing and direct `VAL_` value labels

Existing matching CAN IDs require confirmation before they are replaced.

DBC export writes the same directly decoded Signal properties. Derived Signals have no standard DBC representation, so SigMixa reports them and leaves them out. DBC-only metadata such as comments, attributes and named value tables is not kept.

## 9. Use Plugins safely

Plugins extend decoding with local CommonJS packages. Register a package from **PLUGINS → +**, then manage its enabled state, Frame bindings and settings. A Plugin may keep state across Frames, for example to pair requests with responses.

An analysis group can only use a Plugin that is registered and enabled with the same version and configuration; otherwise its logs open without that Plugin's decoding, and SigMixa says so.

Plugins execute locally in the VS Code Extension Host, so install only code you trust. See the [Plugin SDK](plugin-sdk.md).

## Compatibility and limits

- External CSV Signals appear in graphs, not in the Table or in trajectories.
- A trajectory needs X/Y/Z samples from one source with matching timestamps; it does not resample unmatched series.
- Large captures use memory in proportion to the parsed Frames and decoded Signals.
- Graphs thin the drawn points for responsiveness; pinned markers read the original samples.
- Plugins run synchronously and are not sandboxed; a slow Plugin delays analysis.
- Clips and added logs refer to their files. Moving or renaming a file inside VS Code updates them. Moving it outside VS Code, for example in Finder or File Explorer, leaves them marked **Not found**.
- The main workflows are available in English and Japanese; some low-level diagnostics remain in English.
