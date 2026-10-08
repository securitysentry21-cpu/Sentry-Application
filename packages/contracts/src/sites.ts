// Sites (D-38) and checkpoints with QR labels (ARCH §11.1) — dashboard ↔ API contract.
import { z } from 'zod';

import { latitudeSchema, longitudeSchema, SITE_GEOMETRY, siteBoundarySchema } from './geo.ts';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const SITE_STATUSES = ['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;

export const siteSchema = z.object({
  id: uuid,
  name: z.string(),
  clientName: z.string().nullable(),
  addressLine1: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string(),
  timezone: z.string(),
  boundary: siteBoundarySchema,
  /** The map pin: the circle's centre or the polygon's centroid. */
  center: z.object({ lat: z.number(), lng: z.number() }).meta(SITE_GEOMETRY),
  status: z.enum(SITE_STATUSES),
  notes: z.string().nullable(),
  checkpointCount: z.int(),
  version: z.int(),
  createdAt: instant,
  updatedAt: instant,
});
export type Site = z.infer<typeof siteSchema>;

export const siteListResponseSchema = z.object({ sites: z.array(siteSchema) });

export const siteCreateRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  clientName: optionalText(120),
  addressLine1: optionalText(200),
  city: optionalText(120),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .default('PK'),
  timezone: z.string().min(1).max(64).default('Asia/Karachi'),
  boundary: siteBoundarySchema,
  notes: optionalText(4000),
});

export const sitePatchRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    clientName: optionalText(120),
    addressLine1: optionalText(200),
    city: optionalText(120),
    timezone: z.string().min(1).max(64).optional(),
    boundary: siteBoundarySchema.optional(),
    status: z.enum(SITE_STATUSES).optional(),
    notes: optionalText(4000),
    version: z.int().min(1),
  })
  .refine((v) => Object.keys(v).length > 1, 'nothing to change');

export const checkpointSchema = z.object({
  id: uuid,
  siteId: uuid,
  name: z.string(),
  description: z.string().nullable(),
  location: z.object({ lat: z.number(), lng: z.number() }).meta(SITE_GEOMETRY).nullable(),
  verificationRadiusM: z.int(),
  qrVersion: z.int(),
  qrRotatedAt: instant.nullable(),
  status: z.enum(SITE_STATUSES),
  version: z.int(),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

export const checkpointListResponseSchema = z.object({ checkpoints: z.array(checkpointSchema) });

const location = z.strictObject({ lat: latitudeSchema, lng: longitudeSchema }).meta(SITE_GEOMETRY).nullable();

export const checkpointCreateRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: optionalText(4000),
  location: location.optional(),
  verificationRadiusM: z.int().min(10).max(500).default(30),
});

export const checkpointPatchRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    description: optionalText(4000),
    location: location.optional(),
    verificationRadiusM: z.int().min(10).max(500).optional(),
    status: z.enum(SITE_STATUSES).optional(),
    version: z.int().min(1),
  })
  .refine((v) => Object.keys(v).length > 1, 'nothing to change');

/** The print sheet carries the QR contents; it is audited (CHECKPOINT_QR_PRINTED). */
export const printSheetResponseSchema = z.object({
  site: z.object({ id: uuid, name: z.string() }),
  labels: z.array(
    z.object({ checkpointId: uuid, name: z.string(), qrContent: z.string(), qrVersion: z.int() }),
  ),
});
