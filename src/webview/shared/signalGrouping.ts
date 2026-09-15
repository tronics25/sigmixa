import { resolveDisplayUnit } from '../../core/units/displayUnit';
import { t } from './i18n';

export type SignalGrouping = 'frame' | 'unit';

const families: Readonly<Record<string, readonly [string, string]>> = {
  length: ['Distance / length', '距離・長さ'], speed: ['Speed', '速度'],
  acceleration: ['Acceleration', '加速度'], jerk: ['Jerk', '躍度'],
  angle: ['Angle', '角度'], 'angular-speed': ['Angular speed', '角速度'],
  'angular-acceleration': ['Angular acceleration', '角加速度'], 'rotational-speed': ['Rotational speed', '回転速度'],
  mass: ['Mass', '質量'], force: ['Force', '力'], torque: ['Torque', 'トルク'],
  power: ['Power', '出力'], energy: ['Energy', 'エネルギー'], pressure: ['Pressure', '圧力'],
  flow: ['Flow rate', '流量'], voltage: ['Voltage', '電圧'], current: ['Current', '電流'],
  resistance: ['Resistance', '抵抗'], capacitance: ['Capacitance', '静電容量'],
  time: ['Time', '時間'], frequency: ['Frequency', '周波数'], area: ['Area', '面積'],
  volume: ['Volume', '体積'], temperature: ['Temperature', '温度'], percentage: ['Ratio', '割合'],
};

/** Use the same compatibility key as the graphs; descriptive units remain independent. */
export function signalUnitGroup(unit: string | undefined): { key: string; label: string; order: number } {
  const source = unit?.trim(); const conversion = resolveDisplayUnit(source);
  if (conversion) {
    const name = families[conversion.family];
    return { key: `family:${conversion.family}`, label: name ? t(name[0], name[1]) : conversion.family, order: conversion.order };
  }
  return source ? { key: `unit:${source.toLowerCase()}`, label: source, order: 10_000 }
    : { key: 'empty', label: t('No unit', '単位なし'), order: 20_000 };
}
