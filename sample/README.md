# SigMixa sample workspace

Open this `sample` directory as a VS Code workspace, then open `sigmixa-showcase.asc`. It is one continuous fictional vehicle scenario designed to exercise SigMixa without switching between separate projects. The vehicle accelerates, cruises, turns, brakes and stops while mixed-rate Frames provide powertrain, braking, body, environmental, ADAS and position data.

The workspace is ready to use: Frame definitions, Signal selections, colors, graph layout, Clips, External CSV and two generic sample Plugins are stored in `.sigmixa/project.json`.

## Suggested tour

1. Open `sigmixa-showcase.asc` from **ログファイル / LOG FILES**.
2. In **RAW Log**, search for `2A0`, switch RAW/Decoded content, combine direction or channel filters, and inspect the two deliberate parser diagnostics near 12.345 seconds.
3. Open **Table** to see numeric changes and state transitions highlighted. Copy several rows to a spreadsheet or open them as text.
4. Open **Time Series**. Switch the Signal tree between Frame and Unit system, edit **Graph Layout**, pin measured values, select a range, zoom to it or save it as a Clip. Save the result as SVG or PNG.
5. Open **Trajectory**. The prepared X/Y/Z Signals form a three-dimensional path. Try the Top, Front and Side views, inspect points and measure between two points.
6. In **クリップ / CLIPS**, compare **Acceleration** and **Braking**. Adjust their CAN Timestamp alignment and customize the comparison graph.
7. Open **CANフレーム / CAN FRAMES**. Inspect the Bit Layout for `2A0`, state labels in `310`, and the switchable Multiplexer layouts in `320`.
8. Import `sigmixa-showcase.dbc`, then export its Frames again to inspect the DBC round trip.

## Included coverage

- Standard, short extended and long extended CAN IDs
- Classic CAN, CAN FD, Rx, Tx and remote frames
- RAW Log keyword/regular-expression filtering and deliberately malformed ASC rows for diagnostics
- Unsigned, signed, Intel/Little Endian, Motorola/Big Endian and packed-bit Signal Definitions
- Positive Scale, fractional Scale, Offset, state value labels and Multiplexing
- DBC import/export with value labels and Multiplexing
- Expression, linear-interpolation, Low-pass and Moving Average Derived Signals
- Multiple generic Plugins bound to one Frame, including one intentional isolated Plugin error
- External CSV overlay from `reference-signals.csv`
- Synchronized X/Y/Z data for 2D and 3D Trajectory
- Prepared Clips and multi-Clip comparison

## Automotive Frames

| CAN ID | Frame | Example Signals |
|---|---|---|
| `2A0` | Vehicle Powertrain Status | speed, voltage, engine speed, torque, temperatures and odometer |
| `300` | Brake and Wheel Speed | pressure, pedal and independent wheel speeds |
| `310` | Body Control Status | lamps, horn, doors, seatbelt, gear and cabin temperature |
| `320` | Multiplexed Drive Status | Multiplexer, named drive state, torque, power and regeneration limit |
| `184` | Vehicle Position and Motion | X/Y/Z, heading, yaw rate and lateral acceleration |
| `18FF50E5` | Environmental Status | ambient temperature, pressure and voltage |
| `5A0x` | ADAS Object Summary | distance, relative speed, angle and confidence |

`sigmixa-showcase.blf` contains the same supported CAN data as the ASC showcase. ASC-only malformed rows and remote frames are not represented in BLF.

`sigmixa-showcase.dbc` can be imported from the **CAN FRAMES** database button. It contains standard and extended Frames, Intel/Little Endian and Motorola/Big Endian Signals, state value labels and a Multiplexed Frame.

The sample is synthetic and contains no proprietary vehicle definitions or communication protocols.
