// Object storage for incident photos (ARCH §12, SEC §12). Objects are private and keyed by
// organization; they are reached only through short-lived signed links issued after authorization.
// S3 in AWS; a local folder in development and tests.

export type SignedLink = { readonly url: string; readonly expiresAt: Date };
export type SignedUpload = SignedLink & {
  readonly method: 'PUT';
  /** Headers the upload must carry exactly; they are part of the signature. */
  readonly headers: Readonly<Record<string, string>>;
};

export interface ObjectStore {
  readonly kind: 'local' | 's3';
  /**
   * A PUT limited to this content type and exactly this length (SEC §12). It never overwrites: the
   * upload must carry `if-none-match: *`, so once an original is there it stays the evidence, even
   * while the link is still valid.
   */
  signUpload(
    key: string,
    contentType: string,
    contentLength: number,
    expiresInS: number,
  ): Promise<SignedUpload>;
  /** A GET of the object; `downloadName` makes the browser save it rather than show it. */
  signDownload(key: string, expiresInS: number, downloadName?: string): Promise<SignedLink>;
  /** The object's size, or null when it doesn't exist. */
  size(key: string): Promise<number | null>;
  /** The object's bytes, or null when it doesn't exist; refuses objects larger than maxBytes. */
  read(key: string, maxBytes: number): Promise<Buffer | null>;
  write(key: string, body: Buffer, contentType: string): Promise<void>;
}

/** The conditional write that keeps an uploaded original from being replaced (S3: 412 if it exists). */
export const NO_OVERWRITE = { 'if-none-match': '*' } as const;

/** SEC §12: upload links live at most 15 minutes, download links at most 5. */
export const UPLOAD_LINK_TTL_S = 15 * 60;
export const DOWNLOAD_LINK_TTL_S = 5 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `org/{orgId}/incidents/{incidentId}/{attachmentId}/original` and `…/view.jpg` (ARCH §12). */
export function attachmentKeys(organizationId: string, incidentId: string, attachmentId: string) {
  for (const id of [organizationId, incidentId, attachmentId]) {
    if (!UUID.test(id)) throw new RangeError('object keys are built from UUIDs only');
  }
  const prefix = `org/${organizationId}/incidents/${incidentId}/${attachmentId}`;
  return { original: `${prefix}/original`, view: `${prefix}/view.jpg` };
}

/** Keys are ours, never a client's: letters, digits, '/', '.', '_' and '-', no "..". */
export function isSafeKey(key: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9/._-]{0,299}$/.test(key) && !key.includes('..') && !key.includes('//');
}
