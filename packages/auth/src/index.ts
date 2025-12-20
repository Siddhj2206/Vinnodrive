import { db } from "@Vinnodrive/db";
import * as schema from "@Vinnodrive/db/schema/auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",

    schema: schema,
  }),
  trustedOrigins: [process.env.CORS_ORIGIN || ""],
  emailAndPassword: {
    enabled: true,
    sendResetPassword: async ({ user, url, token }) => {
      // TODO: Replace with actual email sending service (e.g., Resend, SendGrid, etc.)
      console.log(`[Password Reset] To: ${user.email}`);
      console.log(`[Password Reset] URL: ${url}`);
      console.log(`[Password Reset] Token: ${token}`);
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url, token }) => {
      // TODO: Replace with actual email sending service (e.g., Resend, SendGrid, etc.)
      console.log(`[Email Verification] To: ${user.email}`);
      console.log(`[Email Verification] URL: ${url}`);
      console.log(`[Email Verification] Token: ${token}`);
    },
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
  },
  advanced: {
    defaultCookieAttributes: {
      sameSite: "none",
      secure: true,
      httpOnly: true,
    },
  },
});
