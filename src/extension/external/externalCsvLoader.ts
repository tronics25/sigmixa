import { createReadStream } from 'fs';
import * as path from 'path';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import { CsvRowParser, ExternalCsvCollector, type ExternalCsvImportResult } from '../../core/external/csv';
import type { ExternalCsvSourceDefinition } from '../../core/project/schema';
import type { TimeReference } from '../../core/time/timeFormat';

export async function readExternalCsvHeader(filePath: string): Promise<readonly string[]> {
  return (await readExternalCsvPreview(filePath)).headers;
}

/** The header row and the first data row (to tell how its times are written), reading no further. */
export async function readExternalCsvPreview(filePath: string): Promise<{ readonly headers: readonly string[]; readonly firstRow?: readonly string[] }> {
  const parser = new CsvRowParser();
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rows: string[][] = [];
  const take = (items: readonly { readonly values: string[] }[]) => { for (const item of items) if (rows.length < 2 && !(rows.length === 1 && item.values.length === 1 && item.values[0] === '')) rows.push(item.values.map((value) => value.trim())); };
  try {
    for await (const chunk of stream) { take(parser.push(String(chunk))); if (rows.length >= 2) break; }
    if (rows.length < 2) take(parser.push('', true));
    return { headers: rows[0] ?? [], ...(rows[1] ? { firstRow: rows[1] } : {}) };
  } finally {
    stream.destroy();
  }
}

export async function loadExternalCsv(source: ExternalCsvSourceDefinition, workspaceRoot: string, reference?: TimeReference): Promise<ExternalCsvImportResult> {
  const parser = new CsvRowParser();
  const collector = new ExternalCsvCollector(source, reference);
  const filePath = resolveExternalCsvPath(source.path, workspaceRoot);
  try {
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    for await (const chunk of stream) collector.accept(parser.push(String(chunk)));
    collector.accept(parser.push('', true));
    return collector.finish();
  } catch (error) {
    const diagnostic: Diagnostic = {
      id: `csv:${source.id}:CSV_READ_FAILED`, source: 'csv', code: 'CSV_READ_FAILED', severity: 'error',
      message: `External CSV could not be read: ${(error as Error).message}`,
      location: { sourceId: source.id }, details: { externalSourceId: source.id, filePath },
    };
    return { headers: [], series: [], diagnostics: [diagnostic], rowsRead: 0 };
  }
}

export function resolveExternalCsvPath(configuredPath: string, workspaceRoot: string): string {
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(workspaceRoot, configuredPath);
}
