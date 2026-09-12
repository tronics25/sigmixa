const japanese =
  typeof document !== 'undefined' && document.documentElement.lang.toLowerCase().startsWith('ja');

export function t(english: string, japaneseText: string): string {
  return japanese ? japaneseText : english;
}
