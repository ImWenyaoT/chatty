import { z } from 'zod'

const identifier = z.string().min(1)
const nullableString = z.string().nullable()

export const KnowledgeRecordSchema = z
  .object({
    id: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    summary: z.string().min(1).max(2_000),
    body: z.string().min(1).max(20_000),
    source: z.string().min(1).max(2_000),
    tags: z.array(z.string()).max(20),
  })
  .strict()

export const CustomerMemorySchema = z
  .object({
    memory_id: identifier,
    customer_id: identifier,
    fact: z.string(),
    source_id: identifier,
    created_at: z.string(),
  })
  .strict()

export const MemoryEventSchema = z
  .object({
    tool: z.string(),
    memories: z.array(CustomerMemorySchema),
  })
  .strict()

export const RunResponseSchema = z
  .object({
    reply: z.string(),
    customer_id: identifier,
    session_id: identifier,
    trace_id: identifier,
    request_id: identifier,
    status: z.enum(['completed', 'not_completed', 'responded', 'needs_human']),
    business_outcome: z.enum(['verified', 'not_completed', 'not_applicable']),
    completion_evidence: nullableString,
    knowledge_search_results: z.array(KnowledgeRecordSchema),
    memory_events: z.array(MemoryEventSchema),
    needs_human: z.boolean(),
    support_request_id: nullableString,
  })
  .strict()
  .superRefine((run, context) => {
    const invalid = (message: string) =>
      context.addIssue({ code: 'custom', message })
    if (run.status === 'needs_human') {
      if (
        !run.needs_human ||
        run.business_outcome !== 'not_completed' ||
        run.support_request_id === null ||
        run.completion_evidence !== `handoff:${run.support_request_id}`
      ) {
        invalid('needs_human run must include a matching handoff receipt')
      }
      return
    }
    if (run.needs_human || run.support_request_id !== null) {
      invalid('non-handoff run cannot include a support request')
      return
    }
    if (
      run.status === 'completed' &&
      (run.business_outcome !== 'verified' || run.completion_evidence === null)
    ) {
      invalid('completed run must include verified evidence')
    } else if (
      run.status === 'not_completed' &&
      (run.business_outcome !== 'not_completed' ||
        run.completion_evidence === null)
    ) {
      invalid('not_completed run must include failure evidence')
    } else if (
      run.status === 'responded' &&
      (run.business_outcome !== 'not_applicable' ||
        run.completion_evidence !== null)
    ) {
      invalid('responded run cannot claim a business outcome')
    }
  })

export const ArtifactStatusSchema = z.enum([
  'draft',
  'review_failed',
  'review_pending',
  'approved',
  'exported',
])
const ArtifactBaseShape = {
  id: identifier,
  owner_id: identifier,
  session_id: identifier,
  title: z.string(),
  status: ArtifactStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
}
export const ResearchClaimSchema = z
  .object({
    id: identifier,
    text: z.string(),
    source_ids: z.array(identifier).min(1),
  })
  .strict()
export const IndustryNodeSchema = z
  .object({ id: identifier, label: z.string(), kind: z.string() })
  .strict()
export const IndustryRelationSchema = z
  .object({
    from: identifier,
    to: identifier,
    type: z.string(),
    claim_id: identifier,
  })
  .strict()
export const ContentChannelSchema = z
  .object({
    channel: z.enum(['xiaohongshu', 'douyin', 'wechat']),
    title: z.string(),
    body: z.string(),
    claim_ids: z.array(identifier).min(1),
  })
  .strict()

export const ArtifactSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...ArtifactBaseShape,
      kind: z.literal('research'),
      summary: z.string(),
      claims: z.array(ResearchClaimSchema),
      nodes: z.array(IndustryNodeSchema),
      relations: z.array(IndustryRelationSchema),
      unknowns: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      ...ArtifactBaseShape,
      kind: z.literal('content'),
      research_artifact_id: identifier,
      channels: z.array(ContentChannelSchema).min(1),
    })
    .strict(),
])
export const ArtifactListSchema = z.array(ArtifactSchema)
export const ArtifactApprovalSchema = z
  .object({
    id: identifier,
    artifact_id: identifier,
    actor_id: identifier,
    decision: z.literal('approved'),
    created_at: z.string(),
  })
  .strict()

export type RunResponse = z.infer<typeof RunResponseSchema>
export type Artifact = z.infer<typeof ArtifactSchema>
