import { protectedProcedure, publicProcedure, router } from "../index";
import { todoRouter } from "./todo";
import { storageRouter } from "./storage";

export const appRouter = router({
  healthCheck: publicProcedure.query(() => {
    return "OK";
  }),
  privateData: protectedProcedure.query(({ ctx }) => {
    return {
      message: "This is private",
      user: ctx.session.user,
    };
  }),
  todo: todoRouter,
  storage: storageRouter,
});
export type AppRouter = typeof appRouter;
