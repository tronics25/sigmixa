import * as path from 'node:path';
import * as vscode from 'vscode';

export interface RenderedImage {
  readonly pngDataUrl: string;
  readonly svg: string;
}

/** HTML reports can contain only a table, with no renderable graph image. */
export function requireRenderedImage(image: Partial<RenderedImage>): image is RenderedImage {
  if (image.pngDataUrl && image.svg) return true;
  void vscode.window.showInformationMessage(vscode.env.language.toLowerCase().startsWith('ja')
    ? '画像に出力できるグラフがありません。テーブルはHTMLレポートで出力できます。'
    : 'There are no graphs to export as an image. Export the table as an HTML report.');
  return false;
}

export interface SaveRenderedImageOptions {
  readonly title: string;
  readonly japaneseTitle: string;
  readonly defaultBasePath?: string;
  readonly image: RenderedImage;
  /** Already chosen (e.g. from the combined export menu); otherwise the user picks SVG or PNG. */
  readonly format?: 'svg' | 'png';
}

/** One export menu for a whole screen: the combined image as SVG or PNG, or the interactive HTML report. */
export async function chooseExportFormat(title: string, japaneseTitle: string): Promise<'svg' | 'png' | 'html' | undefined> {
  const japanese = vscode.env.language.toLowerCase().startsWith('ja');
  const choice = await vscode.window.showQuickPick([
    { label: 'SVG', description: japanese ? 'すべてのグラフを1枚のベクター画像に' : 'All graphs on one vector image', format: 'svg' as const },
    { label: 'PNG', description: japanese ? 'すべてのグラフを1枚の画像に' : 'All graphs on one image', format: 'png' as const },
    { label: japanese ? 'HTMLレポート' : 'HTML report', description: japanese ? 'ブラウザで操作できるレポート' : 'Interactive report for a browser', format: 'html' as const },
  ], { placeHolder: japanese ? '出力形式を選択' : 'Select export format', title: japanese ? japaneseTitle : title });
  return choice?.format;
}

export async function saveRenderedImage({ title, japaneseTitle, defaultBasePath, image, format }: SaveRenderedImageOptions): Promise<void> {
  const japanese = vscode.env.language.toLowerCase().startsWith('ja'); const displayTitle = japanese ? japaneseTitle : title;
  const choice = format ? { format } : await vscode.window.showQuickPick([
    { label: 'SVG', description: japanese ? 'ベクター画像 · 拡大や資料への貼り付けに最適' : 'Vector image · best for scaling and documents', format: 'svg' as const },
    { label: 'PNG', description: japanese ? 'ラスター画像 · そのまま共有する場合に最適' : 'Raster image · best for direct sharing', format: 'png' as const },
  ], { placeHolder: japanese ? '画像形式を選択' : 'Select image format', title: displayTitle });
  if (!choice) return;
  const bytes = choice.format === 'svg' ? svgBytes(image.svg) : pngBytes(image.pngDataUrl);
  if (!bytes?.length || bytes.length > 30 * 1024 * 1024) { void vscode.window.showErrorMessage(japanese ? `生成された${japaneseTitle}が空、無効、または大きすぎます。` : `The generated ${title} is empty, invalid, or too large.`); return; }
  const extension = choice.format; const target = await vscode.window.showSaveDialog({
    title: displayTitle,
    defaultUri: defaultBasePath ? vscode.Uri.file(`${defaultBasePath}.${extension}`) : undefined,
    filters: choice.format === 'svg' ? { 'SVG vector image': ['svg'] } : { 'PNG image': ['png'] },
    saveLabel: japanese ? '画像を保存' : 'Save Image',
  });
  if (!target) return;
  try { await vscode.workspace.fs.writeFile(target, bytes); void vscode.window.showInformationMessage(japanese ? `${path.basename(target.fsPath)} を保存しました。` : `Saved ${path.basename(target.fsPath)}`); }
  catch (error) { void vscode.window.showErrorMessage(japanese ? `${japaneseTitle}を保存できませんでした: ${(error as Error).message}` : `Could not save ${title}: ${(error as Error).message}`); }
}

function pngBytes(dataUrl: string): Buffer | undefined {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl); return match ? Buffer.from(match[1], 'base64') : undefined;
}
function svgBytes(svg: string): Buffer | undefined { return /^<\?xml[^>]*><svg\b[\s\S]*<\/svg>$/.test(svg) ? Buffer.from(svg, 'utf8') : undefined; }
