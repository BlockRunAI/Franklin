// Client-side image prep for uploads (reference images for image-to-image, and
// chat vision attachments). Ported verbatim from franklin-run — pure browser
// canvas code, no web/Next dependency. Mirrors the Franklin CLI's hard size cap
// (REFERENCE_IMAGE_MAX_BYTES).

const MAX_DIM = 1536;
const RECOMPRESS_OVER_BYTES = 1_000_000;
const HARD_CAP_BYTES = 4_000_000;

export class ImageTooLargeError extends Error {}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
    r.onerror = () => reject(r.error ?? new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode image"));
    img.src = src;
  });
}

function dataUrlBytes(dataUrl: string): number {
  const i = dataUrl.indexOf(",");
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

const MB = (n: number) => (n / 1_000_000).toFixed(1);

export async function prepareImageForUpload(file: File): Promise<string> {
  const original = await readAsDataURL(file);

  let img: HTMLImageElement;
  try {
    img = await loadImage(original);
  } catch {
    if (file.size > HARD_CAP_BYTES) {
      throw new ImageTooLargeError(`Image is ${MB(file.size)}MB; the limit is ${MB(HARD_CAP_BYTES)}MB.`);
    }
    return original;
  }

  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  const needsResize = longest > MAX_DIM;
  const needsRecompress = file.size > RECOMPRESS_OVER_BYTES;

  if (!needsResize && !needsRecompress) {
    if (file.size > HARD_CAP_BYTES) {
      throw new ImageTooLargeError(`Image is ${MB(file.size)}MB; the limit is ${MB(HARD_CAP_BYTES)}MB.`);
    }
    return original;
  }

  const scale = needsResize ? MAX_DIM / longest : 1;
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return original;
  ctx.drawImage(img, 0, 0, w, h);

  let quality = 0.85;
  let out = canvas.toDataURL("image/jpeg", quality);
  while (dataUrlBytes(out) > HARD_CAP_BYTES && quality > 0.4) {
    quality -= 0.15;
    out = canvas.toDataURL("image/jpeg", quality);
  }
  if (dataUrlBytes(out) > HARD_CAP_BYTES) {
    throw new ImageTooLargeError(`Image is too large even after compression (> ${MB(HARD_CAP_BYTES)}MB). Crop it first.`);
  }
  return out;
}
