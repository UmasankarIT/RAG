import { createClient } from "@supabase/supabase-js";
import { config } from "./config";

/**
 * The file-storage boundary — every uploaded-document read/write/delete goes
 * through here. Supabase Storage (hosted, free tier, no local disk usage) —
 * same "one boundary, swap the provider in one file" principle as
 * lib/llm.ts and lib/embeddings.ts. Uses the service_role key: these calls
 * run only in trusted server code (route handlers, the ingest pipeline),
 * never exposed to the browser, so bypassing row-level security here is
 * correct, not a shortcut.
 */

let client: ReturnType<typeof createClient> | null = null;
function supabase() {
  return (client ??= createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY));
}

function bucket() {
  return supabase().storage.from(config.SUPABASE_BUCKET);
}

export async function uploadFile(key: string, buffer: Buffer, contentType?: string): Promise<void> {
  const { error } = await bucket().upload(key, buffer, { contentType, upsert: true });
  if (error) throw new Error(`storage upload failed for "${key}": ${error.message}`);
}

export async function downloadFile(key: string): Promise<Buffer> {
  const { data, error } = await bucket().download(key);
  if (error || !data) throw new Error(`storage download failed for "${key}": ${error?.message ?? "no data"}`);
  return Buffer.from(await data.arrayBuffer());
}

/** No-op (not an error) if the key doesn't exist — mirrors the old `rm({ force: true })` behavior. */
export async function deleteFile(key: string): Promise<void> {
  await bucket().remove([key]);
}

export async function deleteFiles(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await bucket().remove(keys);
}
