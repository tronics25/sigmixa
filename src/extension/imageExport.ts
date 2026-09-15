import * as path from 'node:path';
import * as vscode from 'vscode';

export interface RenderedImage {
  readonly pngDataUrl: string;
  readonly svg: string;
}

export interface SaveRenderedImageOptions {
  readonly title: string;
  readonly japaneseTitle: string;
  readonly defaultBasePath?: string;
  readonly image: RenderedImage;
}

export async function saveRenderedImage({ title, japaneseTitle, defaultBasePath, image }: SaveRenderedImageOptions): Promise<void> {
  const japanese = vscode.env.language.toLowerCase().startsWith('ja'); const displayTitle = japanese ? japaneseTitle : title;
  const choice = await vscode.window.showQuickPick([
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
