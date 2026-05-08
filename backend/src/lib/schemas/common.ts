import { z } from "@hono/zod-openapi";

export const ErrorResponse = z
  .object({
    success: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
    }),
  })
  .openapi("ErrorResponse");

export const PaginationMeta = z
  .object({
    page: z.number(),
    pageSize: z.number(),
    total: z.number(),
    hasMore: z.boolean(),
  })
  .openapi("PaginationMeta");
