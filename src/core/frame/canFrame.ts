export type Timestamp = number;
export type FrameDirection = 'Rx' | 'Tx';

export interface CanFrame {
  readonly id: string;
  readonly sourceId: string;
  readonly timestamp: Timestamp;
  readonly canId: number;
  readonly extended: boolean;
  readonly direction: FrameDirection;
  readonly channel: number;
  readonly dlcCode: number;
  readonly dataLength: number;
  readonly data: Uint8Array;
}

export function assertCanFrame(frame: CanFrame): void {
  if (!Number.isFinite(frame.timestamp)) throw new Error('Frame timestamp must be finite.');
  const maxId = frame.extended ? 0x1fffffff : 0x7ff;
  if (!Number.isInteger(frame.canId) || frame.canId < 0 || frame.canId > maxId) {
    throw new Error(`CAN ID is outside the ${frame.extended ? '29' : '11'}-bit range.`);
  }
  if (!Number.isInteger(frame.channel) || frame.channel < 0) throw new Error('Channel must be a non-negative integer.');
  if (!Number.isInteger(frame.dlcCode) || frame.dlcCode < 0 || frame.dlcCode > 15) {
    throw new Error('DLC code must be between 0 and 15.');
  }
  if (frame.dataLength !== frame.data.byteLength || frame.dataLength < 0 || frame.dataLength > 64) {
    throw new Error('Frame data length must match its payload and be at most 64 bytes.');
  }
}
