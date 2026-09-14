/** Picks an ink and laser color that stands out on the slide being shown. */
export type Surface = 'light' | 'dark';

/** Amber reads on dark slides; on white it washes out, so light slides get vermilion. */
export const INK_ON_DARK = '#FFB23E';
export const INK_ON_LIGHT = '#E5432A';

/** Whether a rendered slide is mostly light or dark, from its mean luminance sampled small. */
export function slideSurface(bitmap: ImageBitmap): Surface {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 18;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 'light';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  return sum / (data.length / 4) > 0.55 ? 'light' : 'dark';
}

/** The preference `auto` becomes the contrasting color for the surface; any other choice is kept. */
export function resolveInk(choice: string, surface: Surface) {
  return choice === 'auto' ? (surface === 'light' ? INK_ON_LIGHT : INK_ON_DARK) : choice;
}
