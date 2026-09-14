import { useEffect, useRef } from 'react';

interface Props {
  bitmap: ImageBitmap;
  width: number | string;
  height: number | string;
  className?: string;
}

/** Paints a pre-rendered page bitmap at its full pixel density, scaled by CSS. */
export function SlideCanvas({ bitmap, width, height, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    try {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    } catch {
      // Bitmap was released by the page cache before this paint; the next render replaces it.
    }
  }, [bitmap]);

  return <canvas ref={ref} className={className} style={{ width, height }} />;
}
