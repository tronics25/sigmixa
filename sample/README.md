# SigMixa sample workspace

Open this directory as a VS Code workspace, then open `sigmixa-showcase.asc`. It is one continuous fictional vehicle scenario designed to demonstrate SigMixa's features without switching between separate log files.

The vehicle accelerates, cruises, turns, brakes and stops. Mixed-rate frames provide powertrain, brake, wheel-speed, body, environmental, ADAS and position data.

## Included coverage

- Standard, short extended and long extended CAN IDs
- Classic CAN, CAN FD, Rx, Tx and remote frames
- RAW Log search, filters and deliberately malformed rows for diagnostics
- Unsigned, signed and packed-bit Signal Definitions
- Scale and Offset conversions
- Expression, Lookup Table, Low-pass and Moving Average Derived Signals
- Multiple Plugins bound to the same Frame, including one intentional isolated Plugin error
- External CSV overlay from `reference-signals.csv`
- Synchronized X/Y/Z data for 2D and 3D Trajectory

## Automotive Frames

| CAN ID | Frame | Example Signals |
|---|---|---|
| `2A0` | Vehicle Powertrain Status | speed, voltage, engine speed, torque, temperatures and odometer |
| `300` | Brake and Wheel Speed | pressure, pedal and independent wheel speeds |
| `310` | Body Control Status | lamps, horn, doors, seatbelt, gear and cabin temperature |
| `184` | Vehicle Position and Motion | X/Y/Z, heading, yaw rate and lateral acceleration |
| `18FF50E5` | Environmental Status | ambient temperature, pressure and voltage |
| `5A0x` | ADAS Object Summary | distance, relative speed, angle and confidence |

The `.sigmixa/project.json` file already contains useful Signal definitions and view selections. The Plugin settings use fictional data.

`sigmixa-showcase.blf` contains the same supported CAN data as the ASC showcase for checking the experimental BLF importer. ASC-only malformed rows and remote frames are not represented in BLF.
