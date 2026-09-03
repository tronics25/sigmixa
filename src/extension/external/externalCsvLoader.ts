import { createReadStream } from 'fs';
import * as path from 'path';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import { CsvRowParser, ExternalCsvCollector, type ExternalCsvImportResult } from '../../core/external/csv';
import type { ExternalCsvSourceDefinition } from '../../core/project/schema';

export async function readExternalCsvHeader(filePath: string): Promise<readonly string[]> {
  const parser = new CsvRowParser();
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  try {
    for await (const chunk of stream) {
      const rows = parser.push(String(chunk));
      if (rows.length) return rows[0].values.map((value) => value.trim());
    }
    return parser.push('', true)[0]?.values.map((value) => value.trim()) ?? [];
  } finally {
    stream.destroy();
  }
}

export async function loadExternalCsv(source: ExternalCsvSourceDefinition, workspaceRoot: string): Promise<ExternalCsvImportResult> {
  const parser = new CsvRowParser();
  const collector = new ExternalCsvCollector(source);
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
