# Change Log

## 2.3.0 - 2026-10-31

- Time-series graphs can now show lanes: a strip for each Signal below the graph, on the same time axis. Each lane shows only the shape of its Signal, scaled to the time span on screen, so a change stands out even when it looks flat on the graph. Read the values on the graph above.
- Click the round button at the lower left of a graph to open or close its lanes. You can hover, click, drag and scroll on the lanes just as on the graph.
- Lanes are also available on the comparison screen and in HTML reports, and open lanes appear in saved images.

## 2.2.1 - 2026-10-30

- Times can be shown as the recorded date and time ([#1](https://github.com/tronics25/sigmixa/issues/1)). BLF logs showed raw Unix epoch seconds such as 1735654183.491113, and ASC logs seconds from the start. Both now show the time of day in the RAW Log, Table, Trace and graphs, and copies and Signal CSV exports hold the full date and time (2024-12-31 14:09:43.491113). Right-click the TIME heading of the RAW Log or Table to switch to seconds from the start. The start is read from the BLF file header and the ASC `date` line; a log that does not record it is shown in seconds as before. No time zone is converted: BLF and ASC record none.
- External CSV import asks how the CSV's times are written: date and time, elapsed from the start, or Unix time (with a unit for numbers), so they line up with the log. CSV files added by earlier versions are read as before.

## 2.2.0 - 2026-10-25

- Analysis Groups pane: the + and Open CAN Log buttons at the top act where the selection is, as in the Explorer: inside a selected group or folder; for a selected log or Clip, inside the group or folder its row is shown in (for a log added to a group, that group); and on the top level of the workspace when nothing is selected, for example after clicking empty space in the pane. In 2.1.0 they always acted on the top level.
- Analysis Groups pane: right-clicking a log or Clip also offers Add Analysis Group, Open CAN Log and Paste Logs, and dropping logs on a log or Clip adds them to the group or folder its row is shown in. Dropping on a Clip failed before.
- Analysis Groups pane: a group you add is selected and scrolled into view.
- Analysis Groups pane: ⌘C / Ctrl+C copies the paths of the selected logs, and ⌘V / Ctrl+V pastes them into the group or folder of the selection.
- Analysis Groups pane: Delete (⌘⌫ on macOS), ⌘C and ⌘V no longer act on the tree while you type in its filter box.
- Fixed deleting logs and Clips together asking twice, where cancelling one dialog still ran the other. One confirmation now covers the whole selection, and Cancel changes nothing, including links to added logs, which were removed before even when the trash was cancelled.
- Fixed the 3D trajectory's camera buttons mirroring the view: the same data at the same angle could look mirrored or not depending on the last button pressed. The buttons now only move the camera. A view saved mirrored by an earlier version opens unmirrored.
- The 3D camera buttons are now **X**, **Y** and **Z** (formerly Top, Front and Side) and look along that axis from its + side, with the − side going away.
- 3D trajectories have a new **Coordinate system** setting: Right-handed (default) or Left-handed, for axes such as X forward, Y right and Z up. It applies to every view of the graph, to the comparison screen and to exported images and reports; when Left-handed, a sideways drag still turns the view in the direction you drag. If your data looked right with Top, Front and Side before, choose Left-handed.
- **X**, **Y**, **Z** and **Reset view** fit the whole trajectory to the view, using its full width and height, also for data far from the origin. The fit follows when the view is resized or a series is added, until you zoom, pan or rotate. Zooming in now goes up to 10,000× (before, 200×), also on the comparison screen, so that long, thin data can fill the view. A camera saved by an earlier version keeps its angle, but its size and position can differ, because the scale now follows the data instead of axis ranges that include the origin; for data far from the origin it can look much larger.
- Fixed the Table showing “No events were found for the selected Signals.” with no Signal checked. This happened when the saved choice held only Signals the current list lacks, such as deleted or renamed ones. The Table, Visualize graphs and comparison graphs now count only the Signals shown checked and ask you to select Signals; the saved choice is kept, so those Signals are checked again if they come back.
- Fixed axis labels with rounding noise, such as 0.6000000000000001, on graphs, comparison graphs and HTML reports. Tick values are now exact decimals.

## 2.1.0 - 2026-10-17

- Graphs and trajectories of long logs miss fewer short peaks and dips when they are drawn with fewer points: each stretch keeps its first, lowest, highest and last sample (before, samples were taken at even spacing).
- HTML reports hold every sample and every table row. The data is packed without loss, which makes the file smaller (how much depends on the data), and rebuilt exactly when the report opens. The choice between Standard (thinned to 20,000 points and rows) and All samples is no longer asked.
- HTML report: the table now holds every Signal the report shows, including the Signals of the graphs and trajectories and those from external CSV files, not only the ones chosen in the Table. Its columns follow the order of the Table, and a Signal the log has no data of is marked instead of looking like data.
- Fixed the + and Open CAN Log buttons at the top of the Analysis Groups pane acting inside the selected group even when the pane was not in use. They now always act on the top level of the workspace; to add a group or open a log inside a group, use the buttons on the group's row or its right-click menu. Likewise, the Frame Definitions pane's + and Export buttons no longer depend on the selected Frame.
- Frame definitions: ⌘Z / Ctrl+Z undoes edits, such as a deleted Signal, and ⇧⌘Z / Ctrl+Y redoes them. Inside a text box, ⌘Z undoes typing as usual.
- ⌘F / Ctrl+F moves to the search box of a log or comparison; pages without one (Frame definitions, Plugin settings) open VS Code's find bar.
- Frame Definitions and Plugins panes: select several items, press Delete (⌘⌫ on macOS) to delete Frames or unregister Plugins, and F2 to rename a Frame. Opening an item from these panes keeps the focus in the pane, as in the Explorer.
- Breadcrumbs: every step above the current page is a link. A group's or a Frame's page links to the Frame definitions of the workspace and of each group above; a Clip links to its whole log. The workspace now has its own Frame definitions page, like a group. The log page no longer repeats the location under VS Code's own breadcrumb.
- VS Code's breadcrumb shows a Clip as its place, log and Clip (brake-analysis › road-test.asc › Stop 1), and a log added to a group under that group, instead of the full path from the root of the disk.

## 2.0.1 - 2026-10-12

- Fixed Signal values of two CAN IDs being mixed: a Frame that a group overrides and the definition it overrides must stay on the same CAN ID, and saving a change that separates them is now refused with the reason.
- Fixed Clips of a copied group folder being changed or deleted together with the Clips they were copied from. A Clip is now identified by its log together with its ID, so the original and the copy are separate Clips and nothing is renamed.
- Fixed a link to a log outside the workspace being lost when it was the only thing set up in the workspace.
- Fixed a group's links to logs and CSV files outside it pointing elsewhere after the group's folder was moved to another depth.
- HTML report: a table row now shows its own value label where the same value has different labels over time.
- HTML report: the time shift of a target steps the same way as on the comparison screen, also to before its first sample.

## 2.0.0 - 2026-10-12

- **Analysis groups.** Several logs can now share graph views and the Frame definitions of one analysis. A group is a folder with a `.sigmixa` folder: it applies its Frame definitions and view settings to every log in it, on top of the workspace's definitions; groups can be nested. Logs from elsewhere can be added to a group and appear there as well as where they are, using the definitions of the place they are opened from. Copy a group's folder to share it. 1.x workspaces open unchanged.
- **Managing logs from the sidebar.** Right-click a log to open, rename or move it to the trash, or to copy its path; rename Clips, groups and folders; remove a group while keeping its folder and logs. F2 renames and Delete deletes the selected item. Drag logs onto a group or folder, open them from there, or paste log files copied in Finder or File Explorer, to add them as links, move them or copy them.
- **Group Frame definitions.** Override a Frame of the workspace or of a group above for one group (starting from the definition above), and promote definitions one level up with per-CAN-ID conflict choices.
- **Visualize.** Any number of graph and 2D/3D trajectory views in one tab, sharing one time position and one time axis: zooming or scrolling any graph moves them all, and zoom, the selected range and Clip creation are at the top of the tab. A trajectory can draw several XYZ series at once.
- **Signal lists.** The lists that choose Signals for graphs, tables and trajectories show the Signals the log contains instead of every defined Signal. Where view settings are shared in a group, a filter button beside the search box lists the others too.
- **Trace.** Every CAN ID's latest values at the time position, with receive count, intervals, an optional expected period per Frame and its deviation, pinned rows and RAW/decoded display.
- **Comparison.** Whole logs can be compared, not only Clips: select logs and Clips in the sidebar and compare them together, shifting each target in either direction by drag, wheel or ◀/▶. All graphs of a comparison share one time axis.
- **Clips.** Create a Clip from a graph's time range or from selected Table rows. A Clip is a named time range that follows its log: it is listed wherever the log is shown and opens with that place's Frame definitions and view settings. The log's graphs mark each Clip's range; click its name to open the Clip, drag either end to change the range, or type an exact range from the sidebar.
- **HTML report.** Export views as one interactive, offline HTML file. The report of a log marks its Clips.
- **Frame definition tables.** Signals can be entered with the keyboard alone, as in a spreadsheet: arrow keys, Enter and Tab move between cells, Esc restores a cell, Ctrl+D (⌘D) copies the cell above, and cells copied in a spreadsheet can be pasted. A new Signal starts from the one above it.
- **Legend emphasis.** Hovering a legend entry emphasizes its line and values.
- **Quieter interface.** Fewer notifications and hover texts: results that are visible on screen are no longer announced, and tooltips name the action instead of explaining it. Export uses the familiar “out of the tray” icon.
- **Plugins.** Output samples may carry a value label. The sample adds a stateful request/response Plugin.
- **Sample workspace.** Reorganised by feature: `sigmixa-basic` (decoding, Plugins, time series, trace), `brake-analysis/` (analysis groups and Clips) and `parking-drive/` (3D and 2D trajectories).

## 1.0.1 - 2026-09-21

- Restored the Version, Installs, and Rating badges after the previous Marketplace badge endpoints were retired.
- Improved Marketplace banner contrast by using light text on the dark SigMixa banner color.

## 1.0.0 - 2026-09-21

- Completed the initial SigMixa feature set for offline CAN and CAN FD analysis in VS Code.
- Added compact CAN ID, channel, direction and Timestamp indexes for large logs. Filter caches now retain compact Frame ordinals instead of duplicate object references.
- Added differential Signal reanalysis: editing an unbound Frame definition decodes only its affected CAN IDs and atomically replaces those results while preserving unrelated Signals, Plugins and External CSV data. Stateful Plugin, Binding and External CSV changes safely fall back to a full rebuild.
- Finalized the transparent, theme-independent SigMixa wordmark and Marketplace icon.
- Expanded Marketplace metadata and refreshed the README with badges and a real VS Code workflow video covering Frame definition, chart inspection, Clips, comparison and 3D Trajectory.
- Corrected the bundled Codicons attribution and license notices.

## 0.11.0 - 2026-09-16

- Replaced the SigMixa wordmark, Marketplace icon and Activity Bar icon with the new hexagonal signal design.
- Matched Time Series and Clip Comparison value-label borders to each plotted line's color and solid/dashed pattern, including pinned markers.
- Made hover values follow the rendered line smoothly with synchronous interpolation, while fixed markers still snap to full-resolution measured samples.
- Consolidated Time Series navigation into one contextual row: selecting a range replaces the ordinary zoom controls with CAN Timestamp edge adjustment, zoom-to-range, Clip creation, and clear actions.
- Expanded Clip Comparison alignment controls with press-and-hold stepping, wheel scrubbing, live drag adjustment, and nearest-CAN-Timestamp snapping on release.
- Standardized press-and-hold repetition across zoom, pan, selected-range edge and Clip-alignment controls, and compacted contextual range and reset actions without adding permanent labels.
- Added true vector SVG export alongside PNG for Time Series, Clip Comparison and Trajectory without adding another permanent toolbar control.
- Removed redundant L/R badges from on-screen and exported chart legends while preserving left/right Y-axis layout behavior.
- Reorganized Time Series, Clip Comparison and Trajectory toolbars into persistent analysis controls and compact right-aligned icon actions with localized tooltips and accessible names.
- Kept marker-clear actions in a stable toolbar position and toned them down as disabled until a marker exists.
- Signal Table highlights changed cells by relative numeric change, named-state transitions and discrete recovery indicators, without altering exported values.
- Added Frame / Unit system grouping to Signal lists in Time Series, Table and Clip Comparison, with selection counts and preserved source actions.
- Made Frame Definition names and expressions responsive while keeping numeric and selection columns compact; narrow layouts scroll within the table, and numeric detail controls no longer stretch with the preview.
- Added clickable Derived Signal dependency diagrams with upstream traversal and unresolved-reference indicators.
- Added DBC Signal value-label (`VAL_`) import/export and per-Signal label editing. State labels follow original RAW integers through decoding and appear beside numeric values in RAW Log, Table, Time Series and Clip Comparison; calculations and CSV values remain numeric.
- RAW Log decoded values now reveal their source bytes and exact bit masks on hover or keyboard focus, without adding permanent panels.
- Signal Table column headers and Signal selection now highlight together; Trajectory axis selectors use the matching axis colors.
- Linked Frame Signal rows and Bit Layout on hover, keyboard focus and selection, with stable Signal colors and MSB/LSB indicators. Editor focus follows Signal identity across redraws.
- Simplified Frame Definition controls and added inline linear-interpolation and filter previews in expandable Derived Signal definitions. Lookup edits preserve row order.
- Linked Time Series and Clip Comparison legends and Signal lists to the corresponding plotted lines.
- Enabled negative Scale in Frame definitions and DBC import/export, including correct exported minimum/maximum bounds.

- Scale now selects arithmetic automatically: power-of-two values shift integer RAW before Offset; other values such as `0.01` retain fractional values. Direct Signal conversion uses exact integer/rational arithmetic until final numeric output, without blanket fractional truncation or an additional Frame setting.
- Time Series and Clip Comparison hover labels and pinned markers now inspect nearest original samples instead of interpolating the reduced plot. Reference lines snap to original sample timestamps, shown below the graph. Value labels omit matching timestamps and show compact signed offsets such as `@-3ms` only for asynchronous samples. Sample dots use their actual positions; gap connection remains a drawing-only option.
- Coalesced measurement requests keep rapid cursor movement bounded, and PNG export waits for pinned-marker measurements.
- Refreshed the README and user documentation, and expanded the single sample workspace with value-label and Multiplexing scenarios for stable release.

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
