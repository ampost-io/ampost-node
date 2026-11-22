import type { RawResponse } from "./client.js";
import type { RequestOptions, Transport } from "./core.js";
import { AmpostError, MediaUploadError } from "./errors.js";
import { Media } from "./generated/resources.js";
import type { MediaUpload, UploadedMedia } from "./generated/types.js";

/** A file to upload: a path (Node), a `Blob`/`File`, or raw bytes. */
export type UploadSource = string | Blob | ArrayBuffer | ArrayBufferView;

export interface UploadOptions extends RequestOptions {
  /** Name at the end of the file URL. Default: the path's or File's name, else `file`. */
  fileName?: string;
  /** MIME type, e.g. `video/mp4`. Default: the Blob's type, else guessed from the file name. */
  contentType?: string;
  /** How often to check whether Ampost has processed the file. Default 2000 ms. */
  pollIntervalMs?: number;
  /** How long to wait for processing before giving up. Default 120 000 ms. */
  waitTimeoutMs?: number;
}

export interface WaitOptions extends RequestOptions {
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
}

type Send = (url: string, init: RequestInit, options?: RequestOptions) => Promise<RawResponse>;

const MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** Large videos take a while to send; the API's per-request timeout would be too short. */
const UPLOAD_TIMEOUT_MS = 15 * 60_000;

export class MediaResource extends Media {
  constructor(
    transport: Transport,
    private readonly send: Send,
  ) {
    super(transport);
  }

  /**
   * Uploads one image or video and returns it as a `media[]` item for `posts.create`:
   *
   *   const video = await client.media.upload("./launch.mp4");
   *   await client.posts.create({ text: "We launched", media: [video], targets: [{ platforms: ["tiktok"] }] });
   *
   * Steps: `createUpload`, a PUT of the bytes to the returned `uploadUrl` (straight to storage; your API
   * key is not sent there), then `getUpload` until Ampost has checked the file.
   */
  async upload(source: UploadSource, options: UploadOptions = {}): Promise<UploadedMedia> {
    const file = await readSource(source, options);
    const created = await this.createUpload({ fileName: file.fileName }, options);
    const response = await this.send(
      created.uploadUrl,
      {
        method: created.method,
        headers: { ...created.headers, "x-content-type": file.contentType },
        body: file.body,
      },
      { ...options, timeoutMs: options.timeoutMs ?? UPLOAD_TIMEOUT_MS },
    );
    if (!response.ok) {
      throw new MediaUploadError(
        `Storage refused the file: HTTP ${response.status} ${response.text.slice(0, 300)}`.trim(),
        "upload_rejected",
        created.id,
      );
    }
    const upload = await this.waitForUpload(created.id, options);
    const [uploaded] = upload.files;
    if (!uploaded) throw new MediaUploadError("The upload completed without a file", "failed", created.id);
    return uploaded;
  }

  /**
   * Polls an upload until it is `completed` and returns it; throws `MediaUploadError` when it `failed` or
   * `expired`, or is still pending after `waitTimeoutMs`. Use it after showing `uploadPageUrl` to a user.
   */
  async waitForUpload(uploadId: string, options: WaitOptions = {}): Promise<MediaUpload> {
    const interval = options.pollIntervalMs ?? 2_000;
    const deadline = Date.now() + (options.waitTimeoutMs ?? 120_000);
    for (;;) {
      const upload = await this.getUpload(uploadId, options);
      if (upload.status === "completed") return upload;
      if (upload.status === "failed") {
        throw new MediaUploadError(`The upload failed: ${upload.error ?? "the file was refused"}`, "failed", uploadId);
      }
      if (upload.status === "expired") {
        throw new MediaUploadError("The upload expired before a file arrived; create a new one", "expired", uploadId);
      }
      if (Date.now() + interval > deadline) {
        throw new MediaUploadError("The upload is still being processed; check it later with getUpload", "timeout", uploadId);
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

async function readSource(source: UploadSource, options: UploadOptions) {
  let body: Blob | ArrayBuffer | Uint8Array<ArrayBuffer>;
  let name: string | undefined;
  let type: string | undefined;
  if (typeof source === "string") {
    const fs = await import("node:fs");
    const path = await import("node:path");
    // openAsBlob (Node 20+) streams the file; Node 18 reads it into memory.
    const openAsBlob = (fs as { openAsBlob?: (path: string) => Promise<Blob> }).openAsBlob;
    body = openAsBlob ? await openAsBlob(source) : new Uint8Array(await fs.promises.readFile(source));
    name = path.basename(source);
  } else if (typeof Blob !== "undefined" && source instanceof Blob) {
    body = source;
    name = (source as { name?: string }).name || undefined;
    type = source.type || undefined;
  } else if (source instanceof ArrayBuffer) {
    body = source;
  } else if (ArrayBuffer.isView(source)) {
    // A copy: fetch takes no SharedArrayBuffer-backed views.
    body = new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
  } else {
    throw new TypeError("upload() takes a file path, a Blob/File, an ArrayBuffer or a Uint8Array/Buffer");
  }
  const fileName = options.fileName ?? name ?? "file";
  const contentType = options.contentType ?? type ?? guessContentType(fileName);
  if (!contentType) {
    throw new AmpostError(`Cannot tell the MIME type of ${JSON.stringify(fileName)}: pass { contentType }`);
  }
  return { body, fileName, contentType };
}

export function guessContentType(fileName: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  return extension ? MIME_TYPES[extension] : undefined;
}
