import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getRepos } from '@/lib/db'

const orderPlacementSchema = z.object({
  customerId: z.string().min(1),
  productId: z.string().optional(),
  conversationId: z.string().optional(),
  orderNo: z.string().min(1),
})

/**
 * Restores the legacy manual-order binding behavior for the seller console.
 * The route records an orderPlacement patch in the current conversation memory
 * and returns the updated snapshot shape that old panels expect.
 */
export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = orderPlacementSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const productId = parsed.data.productId ?? 'general'
  const conversationId = parsed.data.conversationId ?? `${parsed.data.customerId}:${productId}`
  const { memory } = getRepos()
  const prior = memory.snapshot({
    customerId: parsed.data.customerId,
    productId,
    conversationId,
  })
  const priorProfile =
    prior.conversationProfile && typeof prior.conversationProfile === 'object'
      ? (prior.conversationProfile as Record<string, unknown>)
      : {}
  const nextProfile = {
    ...priorProfile,
    orderPlacement: {
      orderNo: parsed.data.orderNo,
      placedAt: new Date().toISOString(),
      source: 'manual',
    },
    orderReadiness: {
      readyToOrder: false,
      nextStep: '已下单待跟进',
      needReviewCheck: true,
    },
    orchestration: {
      stage: 'post_order_followup',
      currentGoal: '订单已提交，继续完成复核',
      nextAction: 'confirm_review',
    },
  }

  memory.commitTurn(
    {
      customerId: parsed.data.customerId,
      productId,
      conversationId,
    },
    {
      conversationProfile: nextProfile as import('@rental/shared').JsonValue,
      appendMessages: [
        {
          role: 'system',
          content: `订单号已记录：${parsed.data.orderNo}`,
        },
      ],
    },
  )

  const snapshot = memory.snapshot({
    customerId: parsed.data.customerId,
    productId,
    conversationId,
  })

  return NextResponse.json({
    ok: true,
    orderNo: parsed.data.orderNo,
    memory: {
      customerId: snapshot.customerId,
      conversationId: snapshot.conversationId,
      conversationProfile: snapshot.conversationProfile,
      productSummary: snapshot.summary,
      recentMessages: snapshot.recentMessages,
    },
  })
}
