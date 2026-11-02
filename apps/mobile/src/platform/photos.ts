// Incident photos on the phone (ARCH §12 step 3, D-18): every photo, from the in-app camera or the
// system photo picker, is re-encoded here as a JPEG (long edge ≤ 2,048 px, quality 0.8) into the app's
// private storage, which also drops its metadata, the GPS position included (INV-08). The upload is
// a PUT of exactly those bytes to the signed link the server gave.
import { sha256 } from '@noble/hashes/sha2.js';
import { File, Paths, UploadType } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import type { PhotoPort, PreparedPhoto } from '../core/ports.ts';

const LONG_EDGE_PX = 2048;
const QUALITY = 0.8;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function prepare(
  sourceUri: string,
  width: number,
  height: number,
  name: string,
): Promise<PreparedPhoto> {
  const context = ImageManipulator.manipulate(sourceUri);
  if (Math.max(width, height) > LONG_EDGE_PX) {
    context.resize(width >= height ? { width: LONG_EDGE_PX } : { height: LONG_EDGE_PX });
  }
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: QUALITY });
  // Kept with the app's own files until the server has it; never in the shared gallery.
  const target = new File(Paths.document, `incident-photo-${name}.jpg`);
  // A retry after the app was killed half-way may find the file there already.
  await new File(saved.uri).move(target, { overwrite: true });
  const bytes = await target.bytes();
  return { uri: target.uri, sizeBytes: bytes.length, sha256: hex(sha256(bytes)), contentType: 'image/jpeg' };
}

async function upload(uri: string, url: string, headers: Readonly<Record<string, string>>): Promise<number> {
  const result = await new File(uri).upload(url, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    headers: { ...headers },
  });
  return result.status;
}

function remove(uri: string): Promise<void> {
  const file = new File(uri);
  if (file.exists) file.delete();
  return Promise.resolve();
}

export const expoPhotos: PhotoPort = { prepare, upload, remove };

/**
 * The system photo picker (D-18, SEC §16.2): the guard chooses one image; the app never browses the
 * library and asks for no storage permission (Android's photo picker, iOS's PHPicker).
 */
export async function pickFromGallery(): Promise<{ uri: string; width: number; height: number } | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: false,
    exif: false,
    quality: 1,
  });
  const asset = result.canceled ? null : result.assets[0];
  return asset ? { uri: asset.uri, width: asset.width, height: asset.height } : null;
}
