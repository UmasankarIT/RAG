import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

const client = postgres(config.DATABASE_URL, {
  max: 10,
  // Full-text queries emit harmless "only stop words" notices; don't log them.
  onnotice: () => {},
});

export const db = drizzle(client, { schema });
export { schema };

export async function closeDb(): Promise<void> {
  await client.end();
}
