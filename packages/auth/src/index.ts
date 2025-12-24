import { db } from "@Vinnodrive/db";
import * as schema from "@Vinnodrive/db/schema/auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

const corsOrigin = process.env.CORS_ORIGIN;
if (!corsOrigin) {
  throw new Error("CORS_ORIGIN environment variable is required");
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: schema,
  }),
  trustedOrigins: [corsOrigin],
  emailAndPassword: {
    enabled: true,
  },
  advanced: {
    defaultCookieAttributes: {
      sameSite: "none",
      secure: true,
      httpOnly: true,
    },
  },
});
