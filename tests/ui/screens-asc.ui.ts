// Every press on the log screen (RAW Log, Table, Visualize with every view type, Trace, Clips, view settings). The log
// screens are split over a few files, which run side by side.
import test from 'node:test';
import { pressLog } from './check';

test('every press on the screen of basic/sigmixa-basic.asc does something, without an error', () => pressLog('basic/sigmixa-basic.asc', 'en'));

test('every press on the screen of basic/sigmixa-basic.asc in Japanese does something, without an error', () => pressLog('basic/sigmixa-basic.asc', 'ja'));
