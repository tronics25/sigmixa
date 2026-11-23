import test from 'node:test';
import assert from 'node:assert/strict';
import { reportAnalysis } from '../src/extension/report/reportAnalysis';

test('a CAN ID with too many frames to embed its times still gets its intervals, so a receive interval view can be added in the report', () => {
  const asked: unknown[] = [];
  const document = {
    reportFrameTiming: () => [{ key: 's:256', times: undefined }, { key: 's:512', times: [0, 0.1] }],
    reportFrameIntervals: (key: string, _range: unknown, budget?: number) => { asked.push([key, budget]); return { key, times: undefined, buckets: [] }; },
    reportStateTimeline: () => [], reportDistribution: () => [], newViewSignals: () => [],
  } as never;
  const notices: string[] = [];
  const result = reportAnalysis(document, { visualizeViews: [] }, { start: 0, end: 10 }, [], notices);
  // Only the CAN ID without embedded times needs its intervals; no notice, since no view shows them.
  assert.deepEqual(result.analysis?.intervals.map((item) => item.key), ['s:256']);
  assert.deepEqual(asked, [['s:256', 0]]);
  assert.deepEqual(notices, []);
});
