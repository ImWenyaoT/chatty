import { z } from 'zod'

/**
 * A Playbook is a named business flow the agent can follow (PRD §14 "human
 * escalation playbooks", loop-plan §9). MVP keeps it as a declarative recipe of
 * tool calls and reply templates; orchestration is wired in a later step.
 */

export const playbookStepSchema = z.object({
  description: z.string().min(1),
  tool: z.string().optional(),
  replyTemplate: z.string().optional(),
})

export const playbookSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  trigger: z.string().min(1),
  description: z.string().min(1),
  steps: z.array(playbookStepSchema).min(1),
})

export type PlaybookStep = z.infer<typeof playbookStepSchema>
export type Playbook = z.infer<typeof playbookSchema>

/** "Size consultation" reference playbook, used in tests and as a template. */
export const SIZE_CONSULTATION_PLAYBOOK: Playbook = {
  id: 'size-consultation',
  name: '尺码咨询',
  trigger: '用户询问某款尺码 / 提供身高体重',
  description: '查询商品后校验库存并给出尺码建议回复。',
  steps: [
    { description: '查询商品信息', tool: 'get_product' },
    { description: '校验尺码库存', tool: 'check_availability' },
    {
      description: '给出尺码建议',
      replyTemplate: '根据您的身材，推荐 {suggestedSize} 码。如需确认可帮您转人工。',
    },
  ],
}
