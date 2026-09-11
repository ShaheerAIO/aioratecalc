// Client-side statement upload helpers, shared by the rep flow (UploadStep) and
// the public lead flow (LeadUploadStep). Both post the same
// { fileData, mediaType } payload to their own analyze route, and both used to
// do it with a bare fetch, no size limit, and a single `loading` boolean.
//
// Two jobs here:
//   1. prepareStatement() — downscale oversized photos before they go over the
//      wire, and reject files too big to be analyzable at all.
//   2. postStatement()    — the same POST, but over XHR so the caller gets real
//      upload progress. A merchant photographing a statement on their phone
//      spends most of the wait in the upload, not in the model.

// Claude's vision API scales any image down to a long edge of 1568px before the
// model sees it, so pixels beyond that cost upload time and buy no accuracy.
// Downscaling to exactly that bound is free in quality terms — we're doing on
// the client what the API would otherwise do after the bytes have already been
// sent. Do NOT lower this to save more bandwidth: statements are dense text and
// anything below the bound starts costing real extraction accuracy.
const MAX_IMAGE_EDGE = 1568;

// Statement photos are text. JPEG artifacts land hardest on small digits, which
// is exactly what we need read correctly, so stay high.
const IMAGE_QUALITY = 0.92;

// Below this an image isn't worth re-encoding — the decode/encode round trip
// costs more than the transfer it would save.
const DOWNSCALE_MIN_BYTES = 300 * 1024;

// Anthropic caps the whole request at 32MB and base64 inflates by 4/3, so a raw
// PDF has to stay comfortably under that ceiling. We can't compress a PDF
// client-side without pulling in a dependency, so oversized ones are refused
// with an actionable message instead.
const MAX_PDF_BYTES = 20 * 1024 * 1024;

// Images that can't be downscaled (decode failure, exotic format) fall back to
// being sent as-is, so they still need a ceiling of their own.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export type PreparedStatement = {
  /** base64 payload, no data: prefix — what the analyze routes expect. */
  data: string;
  /** media type of `data`, which may differ from the original after re-encoding. */
  mediaType: string;
  /** byte size of the payload actually being sent, for display. */
  bytes: number;
};

export class StatementTooLargeError extends Error {}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",")[1]);
    r.onerror = () => reject(new Error("Could not read that file"));
    r.readAsDataURL(blob);
  });
}

/**
 * Shrink an oversized statement photo to the bound Claude's vision API would
 * apply anyway. Returns null when the image is already small enough, or when
 * anything at all goes wrong — downscaling is an optimization, so a failure
 * here must fall back to sending the original rather than blocking the upload.
 */
async function downscaleImage(file: File): Promise<Blob | null> {
  if (file.size < DOWNSCALE_MIN_BYTES) return null;

  try {
    // `imageOrientation: "from-image"` applies the EXIF rotation a phone camera
    // records. Without it a sideways photo reaches the model sideways.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (longEdge <= MAX_IMAGE_EDGE) {
      bitmap.close();
      return null;
    }

    const scale = MAX_IMAGE_EDGE / longEdge;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(resolve, "image/jpeg", IMAGE_QUALITY)
    );
    // Re-encoding can lose on already-compressed sources; keep the original then.
    if (!blob || blob.size >= file.size) return null;
    return blob;
  } catch {
    return null;
  }
}

/**
 * Turn a picked file into the payload the analyze routes take, downscaling
 * oversized photos on the way. Throws StatementTooLargeError with a
 * merchant-readable message for files that can't be sent at all.
 */
export async function prepareStatement(file: File): Promise<PreparedStatement> {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

  if (isPdf) {
    if (file.size > MAX_PDF_BYTES) {
      throw new StatementTooLargeError(
        `That PDF is ${mb(file.size)} — the limit is ${mb(MAX_PDF_BYTES)}. ` +
        `Try uploading just the summary pages, or a photo of them.`
      );
    }
    return { data: await toBase64(file), mediaType: "application/pdf", bytes: file.size };
  }

  const downscaled = await downscaleImage(file);
  if (downscaled) {
    return { data: await toBase64(downscaled), mediaType: "image/jpeg", bytes: downscaled.size };
  }

  if (file.size > MAX_IMAGE_BYTES) {
    throw new StatementTooLargeError(
      `That image is ${mb(file.size)} — the limit is ${mb(MAX_IMAGE_BYTES)}. ` +
      `Try a smaller photo or a PDF.`
    );
  }
  return { data: await toBase64(file), mediaType: file.type, bytes: file.size };
}

/**
 * POST a prepared statement and resolve with the parsed JSON body.
 *
 * Uses XHR rather than fetch purely for `upload.onprogress` — it's the only way
 * to report the transfer honestly, and the transfer is the part of the wait we
 * can actually measure. `onUploadDone` fires when the last byte is sent, which
 * is the cue to stop showing a percentage and switch to an indeterminate
 * "analyzing" state, since server-side progress isn't observable.
 */
export function postStatement<T>(
  url: string,
  body: unknown,
  handlers: { onProgress?: (pct: number) => void; onUploadDone?: () => void } = {}
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", "application/json");

    xhr.upload.onprogress = e => {
      if (e.lengthComputable) handlers.onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.upload.onload = () => handlers.onUploadDone?.();

    xhr.onload = () => {
      let data: { error?: string } & Record<string, unknown>;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error("Analysis failed"));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.error || "Analysis failed"));
        return;
      }
      resolve(data as T);
    };
    xhr.onerror = () => reject(new Error("Network error — check your connection and try again"));
    xhr.ontimeout = () => reject(new Error("That took too long. Please try again."));

    xhr.send(JSON.stringify(body));
  });
}
