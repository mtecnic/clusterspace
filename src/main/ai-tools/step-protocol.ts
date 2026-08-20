import { toolRegistry } from './registry'

/**
 * Step protocol: forces the model to declare intent before acting and
 * verify the result after. State (`currentStep`) lives on ctx.state so
 * multiple tool calls can coordinate within an AIManager instance.
 */

export function registerStepProtocolTools(): void {
  toolRegistry.register<{
    step_number: number
    title: string
    action: string
    success_criteria: string
  }, string>({
    name: 'declare_step',
    description: 'Declare what you are about to do and how you will verify success, before a terminal write or browser action. Strongly recommended always; for goals whose policy sets requireStepProtocol, mutating tool calls are actually rejected until this is called first.',
    parameters: {
      type: 'object',
      properties: {
        step_number: { type: 'number', description: 'Sequential step number (1, 2, 3...)' },
        title: { type: 'string', description: 'Brief title (e.g., "List directory contents")' },
        action: { type: 'string', description: 'The tool call you will make' },
        success_criteria: { type: 'string', description: 'How to know if it worked' }
      },
      required: ['step_number', 'title', 'action', 'success_criteria']
    },
    run: ({ step_number, title, action, success_criteria }, ctx) => {
      ctx.state.currentStep = {
        number: step_number,
        title,
        action,
        successCriteria: success_criteria
      }
      // Echo the original task back on every declared step — on a long
      // repeated-action loop (e.g. "like posts with no engagement, one
      // every 30s, for 20 minutes"), the model's own operational shorthand
      // for satisfying that criterion can quietly drift from what was
      // actually asked as the loop grinds on, well past the point the
      // original message is still fresh in its attention. Re-surfacing it
      // verbatim here — not the model's own paraphrase of it — gives each
      // step a fresh chance to notice the drift instead of compounding it.
      const intentReminder = ctx.state.originalIntent
        ? `\n\nOriginal task (verbatim — re-check this step actually satisfies it, not just what worked on a prior step): "${ctx.state.originalIntent}"`
        : ''
      return `✓ Step ${step_number} declared: "${title}"\n` +
             `  Action: ${action}\n` +
             `  Success criteria: ${success_criteria}${intentReminder}\n\n` +
             `You may now execute this step. After execution, call verify_step to confirm results.`
    }
  })

  toolRegistry.register<{
    step_number: number
    passed: boolean
    observation: string
    next_action: string
  }, string>({
    name: 'verify_step',
    description: 'Verify a declared step\'s results after executing it, before moving on. Clears the declared step — for requireStepProtocol goals, the next mutating action will need a fresh declare_step call.',
    parameters: {
      type: 'object',
      properties: {
        step_number: { type: 'number', description: 'Step being verified' },
        passed: { type: 'boolean', description: 'Did it succeed based on success_criteria?' },
        observation: { type: 'string', description: 'What you observed in the output - be specific!' },
        next_action: { type: 'string', description: 'What you will do next (or "done" if complete)' }
      },
      required: ['step_number', 'passed', 'observation', 'next_action']
    },
    run: ({ step_number, passed, observation, next_action }, ctx) => {
      const current = ctx.state.currentStep
      if (!current || current.number !== step_number) {
        return `⚠️ Error: Step ${step_number} was not declared. Use declare_step first before executing actions.`
      }
      const result = passed ? '✓ PASSED' : '✗ FAILED'
      const response = `Step ${step_number} verification: ${result}\n` +
                       `  Title: ${current.title}\n` +
                       `  Observation: ${observation}\n` +
                       `  Next: ${next_action}`
      ctx.state.currentStep = null
      return response
    }
  })
}
