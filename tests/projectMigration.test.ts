import test from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_PROJECT_SCHEMA_VERSION, migrateProject, parseProjectJson, serializeProject } from '../src/core/project/schema';

test('schema 1 numeric CAN IDs migrate to schema 2 string IDs without losing extended state', () => {
  const project = migrateProject({ schemaVersion: 1, frames: [{ id: 'f', canId: 0x321, extended: true, name: 'Legacy', frameLength: 8, signals: [], derivedSignals: [] }] });
  assert.equal(project.schemaVersion, CURRENT_PROJECT_SCHEMA_VERSION); assert.equal(project.frames[0].extended, true);
  const stored = serializeProject(project) as { frames: { canId: string; extended?: boolean }[] };
  assert.equal(stored.frames[0].canId, '321x'); assert.equal('extended' in stored.frames[0], false);
});

test('corrupt and future project data fail explicitly so ProjectStore can preserve a recovery copy', () => {
  assert.throws(() => parseProjectJson('{broken'), /Project JSON is invalid/);
  assert.throws(() => migrateProject({ schemaVersion: 999 }), /Unsupported project schema version/);
});
