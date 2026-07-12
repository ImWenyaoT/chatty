import { z } from "zod";

// Runtime validation lives only where untrusted input crosses the boundary:
// /api/playground request bodies. In-process TS contracts stay compile-time
// only (types.ts) — no zod mirrors for shapes that never leave the process.

export const jsonPrimitiveSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const legacyChatInputSchema = z
  .object({
    customerId: z.string().min(1),
    productId: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
    // 允许空字符串：用户可以只发图片不发文字，由下面的 refine 兜底
    question: z.string(),
    imageUrl: z.string().min(1).optional(),
    sessionContext: z.record(z.string(), jsonPrimitiveSchema).optional(),
  })
  // 与 legacy /chat 的校验语义保持一致：文字和图片至少要有一样
  .refine((data) => data.question.trim().length > 0 || data.imageUrl, {
    message: "question 或 imageUrl 至少要提供一项",
  });

/** Validates human trace review feedback at the API boundary. */
export const traceReviewInputSchema = z.object({
  traceId: z.string().min(1),
  label: z.enum(["pass", "fail", "flagged"]),
  reviewer: z.string().trim().min(1),
  note: z.string().trim().optional().default(""),
  tags: z
    .array(z.string())
    .optional()
    .default([])
    .transform((tags) =>
      [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].sort(),
    ),
});
