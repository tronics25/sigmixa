// The little of the browser that chart painting reads: text widths, theme colours (none, so the defaults) and the language.
const measuring = { font: '', measureText: (text: string) => ({ width: text.length * 6 }) };
Object.assign(globalThis, {
  document: { documentElement: { lang: 'en' }, createElement: () => ({ getContext: () => measuring }) },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
});
