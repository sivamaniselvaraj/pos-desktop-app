/**
 * The business's brand colour. One colour is chosen in Settings > Appearance; the other
 * colours the screens need (hover, light tints, text on the colour, the colour as readable
 * text) are worked out from it here, so any colour an admin picks stays usable.
 * Screens only use the CSS variables set below (see styles/globals.css), never the hex.
 */

export const DEFAULT_BRAND = '#4caf50';

/** Ready-made colours offered in Settings; any other colour can be typed in. */
export const BRAND_PRESETS: { name: string; hex: string }[] = [
  { name: 'Green', hex: '#4caf50' },
  { name: 'Blue', hex: '#2563eb' },
  { name: 'Teal', hex: '#0d9488' },
  { name: 'Purple', hex: '#7c3aed' },
  { name: 'Orange', hex: '#ea580c' },
  { name: 'Red', hex: '#dc2626' },
  { name: 'Pink', hex: '#db2777' },
  { name: 'Slate', hex: '#475569' },
];

export function isValidBrand(hex: string | null | undefined): hex is string {
  return typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex.trim());
}

type RGB = [number, number, number];

function toRgb(hex: string): RGB {
  const n = parseInt(hex.trim().slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

/** Mix `a` with `b`; `t` is the share of `b` (0 to 1). */
function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function luminance([r, g, b]: RGB): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

export interface BrandTokens {
  brand: string;
  dark: string;
  soft: string;
  softer: string;
  text: string;
  onBrand: string;
}

export function deriveBrand(hex: string): BrandTokens {
  const base = toRgb(hex);
  // The brand as text or a thin line on white: darken until it reads (WCAG AA, 4.5:1).
  let text = base;
  for (let i = 0; i < 20 && contrast(text, WHITE) < 4.5; i++) text = mix(text, BLACK, 0.08);
  return {
    brand: toHex(base),
    dark: toHex(mix(base, BLACK, 0.15)),
    soft: toHex(mix(base, WHITE, 0.88)),
    softer: toHex(mix(base, WHITE, 0.95)),
    text: toHex(text),
    // White text on most colours; dark text when the colour is light (yellow, light green...).
    onBrand: luminance(base) > 0.45 ? '#1f2937' : '#ffffff',
  };
}

/** Why a colour cannot be used as the brand colour (null = fine). Near-white colours vanish on the white screens. */
export function brandProblem(hex: string): string | null {
  if (!isValidBrand(hex)) return 'Enter a colour as # and six letters or digits, for example #4caf50.';
  if (contrast(toRgb(hex.trim()), WHITE) < 1.4) return 'This colour is too light to see on the white screens. Choose a darker one.';
  return null;
}

const VARS: [keyof BrandTokens, string][] = [
  ['brand', '--brand'],
  ['dark', '--brand-dark'],
  ['soft', '--brand-soft'],
  ['softer', '--brand-softer'],
  ['text', '--brand-text'],
  ['onBrand', '--on-brand'],
];

/** Set the brand colour for the whole app. Null or an invalid value goes back to the default. */
export function applyBrand(hex: string | null | undefined): void {
  const root = document.documentElement;
  if (!isValidBrand(hex) || hex.trim().toLowerCase() === DEFAULT_BRAND) {
    for (const [, v] of VARS) root.style.removeProperty(v);
    return;
  }
  const t = deriveBrand(hex.trim());
  for (const [k, v] of VARS) root.style.setProperty(v, t[k]);
}
