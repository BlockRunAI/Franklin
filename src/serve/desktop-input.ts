import type { AgentInput, ImageSegment } from '../agent/types.js';

const MAX_IMAGE_BYTES = 4_000_000;
const MAX_DATA_URL_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64;

/** Accept only inline image bytes. Never turn a renderer-supplied path into a
 * server-side file read or URL fetch. Keep image data out of the text prompt. */
export function desktopInput(text: unknown, attachments: unknown): AgentInput {
  const prompt = typeof text === 'string' ? text.trim() : '';
  if (attachments === undefined || (Array.isArray(attachments) && attachments.length === 0)) {
    if (!prompt) throw new Error('empty input');
    return prompt;
  }
  if (!Array.isArray(attachments) || attachments.length !== 1) {
    throw new Error('Attach one image per message.');
  }
  const value = attachments[0]?.path;
  if (typeof value !== 'string' || value.length > MAX_DATA_URL_LENGTH) throw new Error('Image attachment exceeds the 4 MB limit.');
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error('Attach a PNG, JPEG, WebP or GIF image.');
  const [, mediaType, data] = match;
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== data) throw new Error('Invalid or oversized image attachment.');
  const valid = mediaType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mediaType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mediaType === 'image/webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    : /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6));
  if (!valid) throw new Error('Image attachment does not match its declared format.');
  const image: ImageSegment = { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  return { text: prompt || 'Describe the attached image.', images: [image] };
}
