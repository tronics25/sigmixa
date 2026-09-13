export interface DisplayUnitConversion {
  readonly family: string;
  readonly order: number;
  readonly displayUnit: string;
  readonly sourceUnit: string;
  readonly converted: boolean;
  convert(value: number): number;
}

export interface CommonDisplayUnit {
  readonly unit: string;
  readonly family?: string;
}

interface UnitRule {
  readonly family: string;
  readonly order: number;
  readonly displayUnit: string;
  readonly scale: number;
  readonly offset?: number;
}

const exactRules = new Map<string, UnitRule>();
const foldedRules = new Map<string, UnitRule | null>();
const familyOrder = new Map([
  'length', 'speed', 'acceleration', 'jerk',
  'angle', 'angular-speed', 'angular-acceleration', 'rotational-speed',
  'mass', 'force', 'torque', 'power', 'energy',
  'pressure', 'flow', 'voltage', 'current', 'resistance', 'capacitance',
  'time', 'frequency', 'area', 'volume', 'temperature', 'percentage',
].map((family, index) => [family, index]));

function register(family: string, displayUnit: string, aliases: readonly [string, number, number?][]): void {
  for (const [alias, scale, offset] of aliases) {
    const rule = { family, order: familyOrder.get(family) ?? 1_000, displayUnit, scale, offset }; const exact = normalize(alias); const folded = exact.toLowerCase();
    exactRules.set(exact, rule);
    const existing = foldedRules.get(folded);
    foldedRules.set(folded, existing === undefined || sameRule(existing, rule) ? rule : null);
  }
}

// Spatial quantities
register('length', 'm', [['m', 1], ['meter', 1], ['meters', 1], ['metre', 1], ['metres', 1], ['nm', 1e-9], ['µm', 1e-6], ['um', 1e-6], ['mm', 1e-3], ['cm', 1e-2], ['km', 1e3], ['in', 0.0254], ['inch', 0.0254], ['inches', 0.0254], ['ft', 0.3048], ['feet', 0.3048], ['yd', 0.9144], ['mi', 1609.344], ['mile', 1609.344], ['miles', 1609.344]]);
register('area', 'm²', [['m²', 1], ['m^2', 1], ['m2', 1], ['mm²', 1e-6], ['mm^2', 1e-6], ['cm²', 1e-4], ['cm^2', 1e-4], ['km²', 1e6], ['km^2', 1e6], ['in²', 0.00064516], ['in^2', 0.00064516], ['ft²', 0.09290304], ['ft^2', 0.09290304]]);
register('volume', 'L', [['L', 1], ['liter', 1], ['liters', 1], ['litre', 1], ['litres', 1], ['mL', 1e-3], ['ml', 1e-3], ['cc', 1e-3], ['cm³', 1e-3], ['cm^3', 1e-3], ['m³', 1e3], ['m^3', 1e3], ['in³', 0.016387064], ['in^3', 0.016387064], ['gal', 3.785411784]]);

// Motion
register('speed', 'm/s', [['m/s', 1], ['m/sec', 1], ['mps', 1], ['meter/second', 1], ['metre/second', 1], ['mm/s', 1e-3], ['cm/s', 1e-2], ['km/h', 1 / 3.6], ['km/hr', 1 / 3.6], ['kmh', 1 / 3.6], ['kmph', 1 / 3.6], ['kph', 1 / 3.6], ['mph', 0.44704], ['MPH', 0.44704], ['kn', 0.514444444], ['knot', 0.514444444], ['knots', 0.514444444]]);
register('acceleration', 'm/s²', [['m/s²', 1], ['m/s^2', 1], ['m/s2', 1], ['m/sec²', 1], ['m/sec^2', 1], ['mps2', 1], ['mm/s²', 1e-3], ['mm/s^2', 1e-3], ['cm/s²', 1e-2], ['cm/s^2', 1e-2], ['km/h/s', 1 / 3.6], ['g', 9.80665], ['G', 9.80665]]);
register('jerk', 'm/s³', [['m/s³', 1], ['m/s^3', 1], ['m/s3', 1], ['mps3', 1], ['mm/s³', 1e-3], ['mm/s^3', 1e-3]]);
register('angle', 'deg', [['deg', 1], ['degree', 1], ['degrees', 1], ['°', 1], ['rad', 180 / Math.PI], ['radian', 180 / Math.PI], ['radians', 180 / Math.PI], ['mrad', 0.18 / Math.PI]]);
register('angular-speed', 'deg/s', [['deg/s', 1], ['degree/s', 1], ['degrees/s', 1], ['°/s', 1], ['deg/sec', 1], ['rad/s', 180 / Math.PI], ['radian/s', 180 / Math.PI], ['radians/s', 180 / Math.PI]]);
register('rotational-speed', 'rpm', [['rpm', 1], ['rev/min', 1], ['r/min', 1], ['rps', 60], ['rev/s', 60]]);
register('angular-acceleration', 'deg/s²', [['deg/s²', 1], ['deg/s^2', 1], ['degree/s²', 1], ['°/s²', 1], ['rad/s²', 180 / Math.PI], ['rad/s^2', 180 / Math.PI]]);

// Time and frequency
register('time', 's', [['s', 1], ['sec', 1], ['second', 1], ['seconds', 1], ['ns', 1e-9], ['µs', 1e-6], ['μs', 1e-6], ['us', 1e-6], ['microsecond', 1e-6], ['microseconds', 1e-6], ['ms', 1e-3], ['millisecond', 1e-3], ['milliseconds', 1e-3], ['min', 60], ['minute', 60], ['minutes', 60], ['h', 3600], ['hr', 3600], ['hour', 3600], ['hours', 3600]]);
register('frequency', 'Hz', [['Hz', 1], ['hz', 1], ['hertz', 1], ['kHz', 1e3], ['khz', 1e3], ['MHz', 1e6], ['mhz', 1e6], ['GHz', 1e9], ['ghz', 1e9]]);

// Mechanical and fluid quantities
register('mass', 'kg', [['kg', 1], ['kilogram', 1], ['kilograms', 1], ['gram', 1e-3], ['grams', 1e-3], ['mg', 1e-6], ['tonne', 1e3], ['tonnes', 1e3], ['lb', 0.45359237], ['lbs', 0.45359237]]);
register('force', 'N', [['N', 1], ['newton', 1], ['newtons', 1], ['kN', 1e3], ['kgf', 9.80665], ['lbf', 4.4482216153]]);
register('torque', 'Nm', [['Nm', 1], ['N·m', 1], ['N*m', 1], ['N m', 1], ['newton-meter', 1], ['newton-metre', 1], ['kNm', 1e3], ['kN·m', 1e3], ['kgf·m', 9.80665], ['kgf*m', 9.80665], ['lb-ft', 1.3558179483], ['ft-lb', 1.3558179483], ['lbf·ft', 1.3558179483]]);
register('pressure', 'kPa', [['Pa', 1e-3], ['pascal', 1e-3], ['pascals', 1e-3], ['hPa', 0.1], ['kPa', 1], ['MPa', 1e3], ['bar', 100], ['mbar', 0.1], ['psi', 6.894757293], ['mmHg', 0.1333223874], ['inHg', 3.386389]]);
register('power', 'kW', [['W', 1e-3], ['watt', 1e-3], ['watts', 1e-3], ['mW', 1e-6], ['kW', 1], ['MW', 1e3], ['hp', 0.745699872], ['PS', 0.73549875]]);
register('energy', 'kJ', [['J', 1e-3], ['joule', 1e-3], ['joules', 1e-3], ['kJ', 1], ['MJ', 1e3], ['Wh', 3.6], ['kWh', 3600], ['cal', 0.004184], ['kcal', 4.184]]);
register('flow', 'L/min', [['L/min', 1], ['l/min', 1], ['L/s', 60], ['l/s', 60], ['mL/min', 1e-3], ['ml/min', 1e-3], ['m³/s', 60_000], ['m^3/s', 60_000], ['m³/h', 1000 / 60], ['m^3/h', 1000 / 60], ['gal/min', 3.785411784]]);

// Electrical quantities
register('voltage', 'V', [['V', 1], ['volt', 1], ['volts', 1], ['µV', 1e-6], ['uV', 1e-6], ['mV', 1e-3], ['kV', 1e3]]);
register('current', 'A', [['A', 1], ['amp', 1], ['amps', 1], ['ampere', 1], ['amperes', 1], ['µA', 1e-6], ['uA', 1e-6], ['mA', 1e-3], ['kA', 1e3]]);
register('resistance', 'Ω', [['Ω', 1], ['ohm', 1], ['ohms', 1], ['mΩ', 1e-3], ['mohm', 1e-3], ['kΩ', 1e3], ['kohm', 1e3], ['MΩ', 1e6], ['Mohm', 1e6]]);
register('capacitance', 'µF', [['µF', 1], ['uF', 1], ['nF', 1e-3], ['pF', 1e-6], ['mF', 1e3], ['F', 1e6], ['farad', 1e6], ['farads', 1e6]]);

// Temperature and ratios
register('temperature', '°C', [['°C', 1], ['C', 1], ['degC', 1], ['celsius', 1], ['K', 1, -273.15], ['kelvin', 1, -273.15], ['°F', 5 / 9, -32 * 5 / 9], ['Fahrenheit', 5 / 9, -32 * 5 / 9]]);
register('percentage', '%', [['%', 1], ['percent', 1], ['percentage', 1], ['‰', 0.1], ['permille', 0.1], ['ppm', 1e-4]]);

export function resolveDisplayUnit(unit: string | undefined): DisplayUnitConversion | undefined {
  const sourceUnit = unit?.trim(); if (!sourceUnit) return undefined;
  const normalized = normalize(sourceUnit); const rule = ruleFor(sourceUnit); if (!rule) return undefined;
  return {
    family: rule.family,
    order: rule.order,
    displayUnit: rule.displayUnit,
    sourceUnit,
    converted: normalized !== normalize(rule.displayUnit),
    convert: (value) => value * rule.scale + (rule.offset ?? 0),
  };
}

/** Keeps a shared source unit as-is and falls back to the family's canonical unit only when conversion is required. */
export function preferredDisplayUnit(units: readonly (string | undefined)[]): string | undefined {
  const sources = units.map((unit) => unit?.trim()).filter((unit): unit is string => Boolean(unit));
  if (!sources.length) return undefined;
  if (sources.every((unit) => normalize(unit) === normalize(sources[0]))) return sources[0];
  const conversions = sources.map(resolveDisplayUnit);
  const family = conversions[0]?.family;
  return family && conversions.every((conversion) => conversion?.family === family) ? conversions[0]!.displayUnit : sources[0];
}

/** Returns a common unit only when every selected axis can be compared safely. */
export function commonDisplayUnit(units: readonly (string | undefined)[]): CommonDisplayUnit | undefined {
  const sources = units.map((unit) => unit?.trim()); if (!sources.length || sources.some((unit) => !unit)) return undefined;
  const present = sources as string[];
  if (present.every((unit) => normalize(unit) === normalize(present[0]))) return { unit: present[0], family: resolveDisplayUnit(present[0])?.family };
  const conversions = present.map(resolveDisplayUnit); const family = conversions[0]?.family;
  return family && conversions.every((conversion) => conversion?.family === family) ? { unit: preferredDisplayUnit(present)!, family } : undefined;
}

/** Converts between compatible units; unknown or incompatible units are left unchanged. */
export function convertDisplayUnit(value: number, sourceUnit: string | undefined, targetUnit: string | undefined): number {
  if (!sourceUnit) return value;
  const source = ruleFor(sourceUnit); if (!source) return value;
  const canonical = value * source.scale + (source.offset ?? 0);
  if (!targetUnit) return canonical;
  const target = ruleFor(targetUnit);
  if (!target || source.family !== target.family) return value;
  return (canonical - (target.offset ?? 0)) / target.scale;
}

function normalize(unit: string): string {
  return unit.trim().replace(/\s+/g, ' ').replace(/μ/g, 'µ').replace(/[⋅∙]/g, '·');
}

function ruleFor(unit: string): UnitRule | undefined {
  const normalized = normalize(unit);
  return exactRules.get(normalized) ?? foldedRules.get(normalized.toLowerCase()) ?? undefined;
}

function sameRule(left: UnitRule | null, right: UnitRule): boolean {
  return Boolean(left && left.family === right.family && left.order === right.order && left.displayUnit === right.displayUnit && left.scale === right.scale && left.offset === right.offset);
}
