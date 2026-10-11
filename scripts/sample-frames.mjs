// Frame definitions shared by the sample generators (canId as a number; the generators format it when saving).

export const extracted = (id, name, unit, byteOffset, lengthBits, scale, offset = 0, options = {}) => ({
  id, name, unit, byteOffset, bitOffset: options.bitOffset ?? 0, lengthBits,
  signedness: options.signedness ?? 'unsigned', byteOrder: options.byteOrder ?? 'little',
  conversion: { type: 'scale-offset', lsb: scale, lsbText: options.scaleText ?? String(scale), offset },
  ...(options.valueLabels ? { valueLabels: options.valueLabels } : {}),
  ...(options.multiplexing ? { multiplexing: options.multiplexing } : {}),
});
const signed = { signedness: 'signed' };
const manual = (id, canId, name, signals, extra = {}) => ({ id, canId, extended: false, name, frameLength: 8, origin: { type: 'manual' }, signals, derivedSignals: [], ...extra });

/** The car park log (sample/parking-drive): every position is that of the sensor's own mounting point. */
export const parkingFrames = () => {
  const position = (prefix, name) => [
    extracted(`sig-${prefix}-x`, `${name} X`, 'm', 0, 16, 0.01, 0, signed), extracted(`sig-${prefix}-y`, `${name} Y`, 'm', 2, 16, 0.01, 0, signed), extracted(`sig-${prefix}-z`, `${name} Z`, 'm', 4, 16, 0.01, 0, signed),
  ];
  const wheel = (id, canId, prefix, name) => manual(id, canId, `Wheel ${name}`, [...position(prefix, name), extracted(`sig-${prefix}-speed`, `${name} Wheel Speed`, 'km/h', 6, 16, 0.01)], { expectedPeriodMs: 50 });
  return [
    manual('ff-1a0', 0x1a0, 'Vehicle Pose (Rear Axle)', [...position('pose', 'Rear Axle'), extracted('sig-pose-heading', 'Heading', 'deg', 6, 16, 0.01)], { expectedPeriodMs: 50 }),
    manual('ff-1a1', 0x1a1, 'Vehicle Motion', [
      extracted('sig-motion-speed', 'Vehicle Speed (Motion)', 'km/h', 0, 16, 0.01), extracted('sig-motion-yaw-rate', 'Yaw Rate (Motion)', 'deg/s', 2, 16, 0.01, 0, signed),
      extracted('sig-steering-angle', 'Steering Angle', 'deg', 4, 16, 0.1, 0, signed), extracted('sig-road-grade', 'Road Grade', '%', 6, 16, 0.01, 0, signed),
    ], { expectedPeriodMs: 50 }),
    wheel('ff-1b0', 0x1b0, 'wheel-fl', 'Front Left'), wheel('ff-1b1', 0x1b1, 'wheel-fr', 'Front Right'),
    wheel('ff-1b2', 0x1b2, 'wheel-rl', 'Rear Left'), wheel('ff-1b3', 0x1b3, 'wheel-rr', 'Rear Right'),
    manual('ff-1c0', 0x1c0, 'IMU Dead Reckoning', [...position('imu', 'IMU'), extracted('sig-imu-heading', 'IMU Heading', 'deg', 6, 16, 0.01)], { expectedPeriodMs: 50 }),
    manual('ff-1c1', 0x1c1, 'GNSS Antenna', [...position('gnss', 'GNSS Antenna'),
      extracted('sig-gnss-satellites', 'GNSS Satellites', '', 6, 8, 1), extracted('sig-gnss-fix', 'GNSS Fix', '', 7, 8, 1, 0, { valueLabels: { 0: 'No Fix', 1: 'Fix' } })], { expectedPeriodMs: 100 }),
    manual('ff-5b0', 0x5b0, 'Obstacle Outline (World)', [...position('obstacle', 'Obstacle Corner'), extracted('sig-obstacle-distance', 'Obstacle Distance', 'm', 6, 16, 0.01)]),
  ];
};

/** Frame 300 as the common level defines it. */
export const brakeFrame = () => manual('ff-300', 0x300, 'Brake and Wheel Speed', [
  extracted('sig-brake-pressure', 'Brake Pressure', 'bar', 0, 16, 0.1),
  extracted('sig-pedal', 'Brake Pedal Position', '%', 2, 16, 0.1),
  extracted('sig-wheel-speed-fl', 'Front Left Wheel Speed', 'km/h', 4, 16, 0.01),
  extracted('sig-wheel-speed-fr', 'Front Right Wheel Speed', 'km/h', 6, 16, 0.01),
]);

/** Saved form: canId as text (`5A0x` for a short extended ID). */
export const persistFrame = ({ canId, extended, ...frame }) => ({ ...frame, canId: `${canId.toString(16).toUpperCase()}${extended && canId <= 0x7ff ? 'x' : ''}` });
