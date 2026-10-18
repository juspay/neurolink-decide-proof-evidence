// Reproducible gzip: same input bytes, same output bytes on every run.
// The header is rewritten so no timestamp (bytes 4-7 are 0) and no platform code (byte 9 is 255) is in it;
// neither is covered by the CRC, so every gzip reader still accepts the file.
//
//   const gz = gzipReproducible(Buffer.from(text));   // Buffer
//   const raw = gunzipIfGzip(fileBytes);               // Buffer, returned as is when not gzip
import { gunzipSync, gzipSync } from "node:zlib";

export const gzipReproducible = (input) => {
  const out = gzipSync(input, { level: 9 });
  out.fill(0, 4, 8);
  out[9] = 255;
  return out;
};

export const isGzip = (buf) => buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;

export const gunzipIfGzip = (buf) => (isGzip(buf) ? gunzipSync(buf) : buf);
