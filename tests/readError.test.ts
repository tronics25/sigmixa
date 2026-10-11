import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLogReadError, uncHost } from '../src/core/io/readError';

test('UNC hosts are recognised in both slash styles; local and device paths are not', () => {
  assert.equal(uncHost('\\\\fileserver\\logs\\run-001.asc'), 'fileserver');
  assert.equal(uncHost('//fileserver/logs/run-001.asc'), 'fileserver');
  assert.equal(uncHost('C:\\logs\\run-001.asc'), undefined);
  assert.equal(uncHost('\\\\?\\C:\\logs\\run-001.asc'), undefined);
});

test('read failures are classified so the message can say what to do', () => {
  const unc = '\\\\fileserver\\logs\\run.asc';
  assert.equal(classifyLogReadError(new Error("UNC host 'fileserver' access is not allowed. Please update the 'security.allowedUNCHosts' setting if you want to allow this host."), unc), 'unc-not-allowed');
  assert.equal(classifyLogReadError(Object.assign(new Error('EPERM: operation not permitted, open'), { code: 'EPERM' }), unc), 'access-denied');
  assert.equal(classifyLogReadError(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }), unc), 'not-found');
  assert.equal(classifyLogReadError(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }), unc), 'busy');
  assert.equal(classifyLogReadError(Object.assign(new Error('The network name cannot be found.'), { code: 'UNKNOWN' }), unc), 'network');
  assert.equal(classifyLogReadError(new Error('Unexpected'), 'C:\\a.asc'), 'other');
});
