import { z } from "zod";

/**
 * Environment variable validation schema
 * All required environment variables are validated at startup
 */
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Authentication
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url("BETTER_AUTH_URL must be a valid URL"),

  // CORS
  CORS_ORIGIN: z.string().url("CORS_ORIGIN must be a valid URL"),

  // Cloudflare R2
  R2_ACCESS_KEY_ID: z.string().min(1, "R2_ACCESS_KEY_ID is required"),
  R2_SECRET_ACCESS_KEY: z.string().min(1, "R2_SECRET_ACCESS_KEY is required"),
  R2_BUCKET_NAME: z.string().min(1, "R2_BUCKET_NAME is required"),
  R2_ENDPOINT: z.string().url("R2_ENDPOINT must be a valid URL"),

  // Optional
  R2_PUBLIC_URL: z.string().url().optional(),
  STORAGE_LIMIT_BYTES: z.coerce.number().positive().optional(),
  RATE_LIMIT_PER_SECOND: z.coerce.number().positive().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates all required environment variables and throws if any are missing or invalid
 * Call this at application startup before any other operations
 */
export function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");

    throw new Error(
      `Environment validation failed:\n${errors}\n\nPlease check your .env file and ensure all required variables are set.`
    );
  }

  return result.data;
}

/**
 * Get validated environment variables
 * Throws if validation fails
 */
let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    _env = validateEnv();
  }
  return _env;
}
