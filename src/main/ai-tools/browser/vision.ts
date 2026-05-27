import { getBrowserWebContents } from '../../browser-pane-registry'
import { toolRegistry } from '../registry'
import { saveScreenshotToDisk } from './_helpers'

/**
 * Vision-grounded browser tools (Phase 4B). These wrap the existing
 * screenshot pipeline with a vision-model judge, closing the "did the
 * thing I just clicked actually do what I expected" loop. Without these,
 * browser_click + browser_get_content gives you the DOM but not what the
 * USER would see — which is often where bugs hide (an opaque cookie
 * banner over the form, an unreachable button, an unexpected modal).
 *
 *   browser_verify_visual_state — strict yes/no judge with explanation
 *   browser_describe_screen     — free-form description for "where am I?"
 *
 * Both require an AI provider with a vision model (or a dual-purpose
 * model like Claude or GPT-4o). When no vision helper is available
 * (ctx.vision undefined), the tools return an explicit error so the
 * model knows to fall back to DOM-based verification.
 */
export function registerBrowserVisionTools(): void {
  toolRegistry.register<
    { pane_id: string; expected_state: string },
    { success: boolean; verdict?: 'yes' | 'no' | 'unclear'; explanation?: string; screenshot_path?: string; error?: string }
  >({
    name: 'browser_verify_visual_state',
    description: 'Take a screenshot of the browser pane and ask a vision model whether the described state is visible. Returns yes/no/unclear plus a one-sentence reason. Use this AFTER an action to confirm it actually produced the expected UI change — DOM checks miss things like modals, overlays, and visual regressions.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        expected_state: { type: 'string', description: 'Free-form description of what should be visible. e.g. "the login form is replaced by a dashboard with the user\'s name in the top-right" or "an error toast says \'invalid password\'"' }
      },
      required: ['pane_id', 'expected_state']
    },
    run: async ({ pane_id, expected_state }, ctx) => {
      if (!ctx.vision) {
        return { success: false, error: 'No vision model available. Configure a provider with a visionModel field (or use a dual-purpose model like claude-3.5-sonnet or gpt-4o).' }
      }
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      try {
        const image = await wc.capturePage()
        const size = image.getSize()
        const shot = await saveScreenshotToDisk(image.toPNG(), size.width, size.height)
        const { verdict, explanation } = await ctx.vision.verify({
          imagePath: shot.path,
          question: expected_state
        })
        return {
          success: true,
          verdict,
          explanation,
          screenshot_path: shot.path
        }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  })

  toolRegistry.register<
    { pane_id: string; prompt?: string },
    { success: boolean; description?: string; screenshot_path?: string; error?: string }
  >({
    name: 'browser_describe_screen',
    description: 'Take a screenshot and ask a vision model to describe what is on screen — visible buttons, fields, modals, loading states. Useful when the page does not match expectations and you need to figure out where you are before acting.',
    parameters: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'The browser pane ID' },
        prompt: { type: 'string', description: 'Optional specific question. Default: a general "what is on screen" description.' }
      },
      required: ['pane_id']
    },
    run: async ({ pane_id, prompt }, ctx) => {
      if (!ctx.vision) {
        return { success: false, error: 'No vision model available.' }
      }
      const wc = getBrowserWebContents(pane_id)
      if (!wc) return { success: false, error: `No browser pane ${pane_id}` }
      try {
        const image = await wc.capturePage()
        const size = image.getSize()
        const shot = await saveScreenshotToDisk(image.toPNG(), size.width, size.height)
        const { description } = await ctx.vision.describe({
          imagePath: shot.path,
          prompt
        })
        return {
          success: true,
          description,
          screenshot_path: shot.path
        }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  })
}
