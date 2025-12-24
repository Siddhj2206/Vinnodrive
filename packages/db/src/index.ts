import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is required");
}

export const db = drizzle(databaseUrl, { schema });
