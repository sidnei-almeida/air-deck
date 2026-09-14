import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

export type { PDFDocumentProxy };

export class PdfError extends Error {
  kind: 'not-pdf' | 'password' | 'broken';

  constructor(message: string, kind: PdfError['kind']) {
    super(message);
    this.kind = kind;
  }
}

/** Opens a dropped or chosen file. The bytes come back too, so the deck can be kept for next time. */
export async function openPdf(file: File): Promise<{ doc: PDFDocumentProxy; bytes: Uint8Array }> {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) throw new PdfError('That file isn’t a PDF.', 'not-pdf');
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { doc: await openPdfBytes(bytes), bytes };
}

/** pdf.js takes ownership of the buffer it reads, so it gets a copy and the caller keeps the original. */
export async function openPdfBytes(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  try {
    return await getDocument({ data: bytes.slice() }).promise;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'PasswordException') {
      throw new PdfError('This PDF is password-protected. Remove the protection and try again.', 'password');
    }
    throw new PdfError('Couldn’t open this PDF. It may be damaged.', 'broken');
  }
}

/** Releases the document and its worker resources. */
export function closePdf(doc: PDFDocumentProxy) {
  doc.loadingTask.destroy().catch(() => {});
}

/** Largest canvas edge we allow; keeps memory sane on 4K screens with zoom. */
const MAX_EDGE = 4096;

/**
 * Renders a page so it fits the box, at enough pixel density for zoomed viewing.
 * Returns an ImageBitmap so the same render can be painted by several canvases.
 */
export async function renderPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  boxWidth: number,
  boxHeight: number,
  density: number,
): Promise<{ bitmap: ImageBitmap; aspect: number }> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const fit = Math.min(boxWidth / base.width, boxHeight / base.height);
  const scale = Math.min(fit * density, MAX_EDGE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  const bitmap = await createImageBitmap(canvas);
  canvas.width = canvas.height = 0;
  page.cleanup();
  return { bitmap, aspect: base.width / base.height };
}
