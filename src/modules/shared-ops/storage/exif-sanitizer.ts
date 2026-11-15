import { createHash } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import { StorageError } from '@/core/ports/storage.port';

export const MAX_PUBLIC_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MiB
export const MAX_PUBLIC_IMAGE_PIXELS = 40_000_000; // 40 million decoded pixels
export const PUBLIC_MEDIA_CONTENT_TYPE = 'image/webp' as const;

export const ALLOWED_PUBLIC_IMAGE_FORMATS = ['jpeg', 'png', 'webp'] as const;
const ALLOWED_FORMAT_SET: ReadonlySet<string> = new Set(
  ALLOWED_PUBLIC_IMAGE_FORMATS,
);

/**
 * Fixed WebP encoding parameters for deterministic public image output.
 * Default sharp output omits EXIF, GPS, XMP, IPTC, and ICC metadata.
 */
export const PUBLIC_WEBP_ENCODE_OPTIONS = {
  quality: 82,
  effort: 4,
} as const;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function hasPngAnimationControlChunk(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) {
    return false;
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return false;
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const chunkLength = view.getUint32(offset, false);
    const chunkType = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    if (chunkType === 'acTL') {
      return true;
    }
    if (chunkType === 'IDAT' || chunkType === 'IEND') {
      return false;
    }
    const nextOffset = offset + 12 + chunkLength;
    if (nextOffset <= offset || nextOffset > bytes.byteLength) {
      return false;
    }
    offset = nextOffset;
  }
  return false;
}

function isPixelLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /pixel limit/i.test(error.message);
}

/**
 * Creates a detached byte copy so caller buffer mutations cannot affect stored or hashed bytes.
 */
export function copyBytes(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array)) {
    throw new StorageError(
      'STORAGE_INVALID_INPUT',
      'Payload must be a Uint8Array or Node Buffer.',
    );
  }
  return Uint8Array.from(bytes);
}

/**
 * Computes a deterministic lowercase 64-character SHA-256 hex digest over exact byte contents.
 */
export function computeSha256Hex(bytes: Uint8Array): string {
  const snapshot = copyBytes(bytes);
  return createHash('sha256').update(snapshot).digest('hex');
}

/**
 * Enforces RULE-MKT-002 on public marketplace media uploads:
 * - Accepts only still JPEG, PNG, and WebP images within 20 MiB and 40M pixels.
 * - Rejects empty, corrupt, truncated, unsupported, or animated/multipage images.
 * - Applies EXIF orientation to pixels and re-encodes fresh metadata-free WebP bytes.
 * - Performs no file, database, clock, random, or network I/O.
 */
export async function sanitizePublicImageToWebp(
  image: Uint8Array,
): Promise<Uint8Array> {
  if (!(image instanceof Uint8Array)) {
    throw new StorageError(
      'STORAGE_INVALID_IMAGE',
      'Public part media image must be a Uint8Array or Node Buffer.',
    );
  }

  if (image.byteLength === 0) {
    throw new StorageError(
      'STORAGE_INVALID_IMAGE',
      'Public part media image must not be empty.',
    );
  }

  if (image.byteLength > MAX_PUBLIC_IMAGE_BYTES) {
    throw new StorageError(
      'STORAGE_PAYLOAD_TOO_LARGE',
      `Public part media image exceeds maximum size of ${MAX_PUBLIC_IMAGE_BYTES} bytes.`,
    );
  }

  const inputSnapshot = Uint8Array.from(image);

  let metadata: Metadata;
  try {
    metadata = await sharp(inputSnapshot, {
      failOn: 'error',
      limitInputPixels: false,
      animated: false,
    }).metadata();
  } catch (error) {
    if (isPixelLimitError(error)) {
      throw new StorageError(
        'STORAGE_PAYLOAD_TOO_LARGE',
        `Public part media image exceeds maximum decoded pixel limit of ${MAX_PUBLIC_IMAGE_PIXELS}.`,
      );
    }
    throw new StorageError(
      'STORAGE_INVALID_IMAGE',
      'Public part media image could not be decoded as a supported image.',
    );
  }

  if (!metadata.format || !ALLOWED_FORMAT_SET.has(metadata.format)) {
    throw new StorageError(
      'STORAGE_INVALID_IMAGE',
      'Public part media image must be a still JPEG, PNG, or WebP image.',
    );
  }

  if (
    (metadata.pages !== undefined && metadata.pages > 1) ||
    (metadata.format === 'png' && hasPngAnimationControlChunk(inputSnapshot))
  ) {
    throw new StorageError(
      'STORAGE_INVALID_IMAGE',
      'Animated or multipage images are not permitted for public part media.',
    );
  }

  if (
    typeof metadata.width !== 'number' ||
    typeof metadata.height !== 'number' ||
    !Number.isSafeInteger(metadata.width) ||
    !Number.isSafeInteger(metadata.height) ||
    metadata.width <= 0 ||
    metadata.height <= 0
  ) {
    throw new StorageError(
      'STORAGE_INVALID_IMAGE',
      'Public part media image has invalid or missing dimensions.',
    );
  }

  if (metadata.width * metadata.height > MAX_PUBLIC_IMAGE_PIXELS) {
    throw new StorageError(
      'STORAGE_PAYLOAD_TOO_LARGE',
      `Public part media image exceeds maximum decoded pixel limit of ${MAX_PUBLIC_IMAGE_PIXELS}.`,
    );
  }

  try {
    const encoded = await sharp(inputSnapshot, {
      failOn: 'error',
      limitInputPixels: MAX_PUBLIC_IMAGE_PIXELS,
    })
      .rotate()
      .webp(PUBLIC_WEBP_ENCODE_OPTIONS)
      .toBuffer();

    if (encoded.byteLength === 0) {
      throw new StorageError(
        'STORAGE_INVALID_IMAGE',
        'Sanitized WebP image output is empty.',
      );
    }

    return Uint8Array.from(encoded);
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    if (isPixelLimitError(error)) {
      throw new StorageError(
        'STORAGE_PAYLOAD_TOO_LARGE',
        `Public part media image exceeds maximum decoded pixel limit of ${MAX_PUBLIC_IMAGE_PIXELS}.`,
      );
    }
    throw new StorageError(
      'STORAGE_INVALID_IMAGE',
      'Public part media image failed decode/sanitization.',
    );
  }
}
