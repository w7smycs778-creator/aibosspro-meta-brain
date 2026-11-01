// Where a creative's files live. Local store: files under ./data/media/<id>/,
// refs are absolute paths (as before). Supabase store: a private Storage
// bucket, refs are "supabase://<bucket>/<id>/<file>" and the owner page gets a
// short-lived signed URL. Vercel's filesystem is read-only, so a hosted deploy
// never writes media to disk.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Env } from "../gateway/types";
import { DEFAULT_LOCAL_DIR } from "../storage";
import type { StorageBackend } from "../storage/types";

export const MEDIA_BUCKET = "creative-media";
/** Signed URLs for the owner page expire after this many seconds. */
export const SIGNED_URL_SECONDS = 300;

export interface MediaStore {
  readonly kind: "fs" | "supabase";
  ref(creativeId: string, file: string): string;
  put(ref: string, bytes: Buffer | string, contentType: string): Promise<void>;
  get(ref: string): Promise<Buffer | null>;
  /** The creative folder a ref belongs to, as a ref prefix (for sibling files). */
  sibling(ref: string, file: string): string;
  /** A URL the browser can load directly, or null when the route must stream the bytes. */
  signedUrl(ref: string): Promise<string | null>;
  /** True when the ref belongs to this store (and, for fs, lies inside its root). */
  owns(ref: string): boolean;
}

export function mediaRoot(env: Env = process.env): string {
  return resolve(env.STORAGE_DIR?.trim() || DEFAULT_LOCAL_DIR, "media");
}

export class FsMediaStore implements MediaStore {
  readonly kind = "fs" as const;
  constructor(readonly root: string = mediaRoot()) {}
  ref(creativeId: string, file: string): string {
    return join(this.root, creativeId, file);
  }
  async put(ref: string, bytes: Buffer | string, _contentType: string): Promise<void> {
    mkdirSync(dirname(ref), { recursive: true });
    writeFileSync(ref, bytes);
  }
  async get(ref: string): Promise<Buffer | null> {
    return existsSync(ref) ? readFileSync(ref) : null;
  }
  sibling(ref: string, file: string): string {
    return join(dirname(ref), file);
  }
  async signedUrl(): Promise<string | null> {
    return null;
  }
  owns(ref: string): boolean {
    return resolve(ref).startsWith(resolve(this.root) + sep);
  }
}

const PREFIX = "supabase://";

export class SupabaseMediaStore implements MediaStore {
  readonly kind = "supabase" as const;
  private bucketReady: Promise<void> | null = null;
  constructor(
    private readonly db: SupabaseClient,
    readonly bucket: string = MEDIA_BUCKET,
  ) {}

  static fromEnv(env: Env = process.env): SupabaseMediaStore {
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url?.startsWith("https://") || !key) throw new Error("Supabase media store needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    return new SupabaseMediaStore(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }));
  }

  ref(creativeId: string, file: string): string {
    return `${PREFIX}${this.bucket}/${creativeId}/${file}`;
  }
  private path(ref: string): string {
    if (!this.owns(ref)) throw new Error("not a ref of this media bucket");
    return ref.slice(`${PREFIX}${this.bucket}/`.length);
  }
  /** Creates the private bucket once per process; an existing bucket is fine. */
  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      const { data } = await this.db.storage.getBucket(this.bucket);
      if (data) return;
      const { error } = await this.db.storage.createBucket(this.bucket, { public: false });
      if (error && !/already exists/i.test(error.message)) throw new Error(`media bucket: ${error.message}`);
    })().catch((err) => {
      this.bucketReady = null;
      throw err;
    });
    return this.bucketReady;
  }
  async put(ref: string, bytes: Buffer | string, contentType: string): Promise<void> {
    await this.ensureBucket();
    const body = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
    const { error } = await this.db.storage.from(this.bucket).upload(this.path(ref), body, { contentType, upsert: true });
    if (error) throw new Error(`media upload failed: ${error.message}`);
  }
  async get(ref: string): Promise<Buffer | null> {
    const { data, error } = await this.db.storage.from(this.bucket).download(this.path(ref));
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  }
  sibling(ref: string, file: string): string {
    return ref.slice(0, ref.lastIndexOf("/") + 1) + file;
  }
  async signedUrl(ref: string): Promise<string | null> {
    const { data, error } = await this.db.storage.from(this.bucket).createSignedUrl(this.path(ref), SIGNED_URL_SECONDS);
    if (error || !data) return null;
    return data.signedUrl;
  }
  owns(ref: string): boolean {
    return ref.startsWith(`${PREFIX}${this.bucket}/`);
  }
}

/** The media store for a storage backend: disk locally, Supabase Storage when hosted. */
export function mediaStoreFor(backend: StorageBackend, opts: { mediaDir?: string; env?: Env } = {}): MediaStore {
  return backend === "supabase" ? SupabaseMediaStore.fromEnv(opts.env) : new FsMediaStore(opts.mediaDir ?? mediaRoot(opts.env));
}

export function contentTypeOf(file: string): string {
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}
