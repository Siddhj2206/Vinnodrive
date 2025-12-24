import "dotenv/config";
import { trpcServer } from "@hono/trpc-server";
import { createContext } from "@Vinnodrive/api/context";
import { getEnv } from "@Vinnodrive/api/env";
import { appRouter } from "@Vinnodrive/api/routers/index";
import { auth } from "@Vinnodrive/auth";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

// Validate environment variables at startup - will throw if missing/invalid
const env = getEnv();

const app = new Hono();

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: (_opts, context) => {
      return createContext({ context });
    },
  }),
);

app.get("/", (c) => {
  return c.text("OK");
});

export default app;
