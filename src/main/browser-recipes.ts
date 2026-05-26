// A recipe is a serializable list of tool calls executed sequentially with
// optional retries. Recipes can be passed inline by the AI or saved by name
// in electron-store and replayed.

import Store from 'electron-store'
import { v4 as uuidv4 } from 'uuid'

export interface RecipeStep {
  tool: string
  args: Record<string, unknown>
  retry?: number              // retry count on failure (default 0)
  retry_delay_ms?: number     // delay between retries (default 500)
  on_fail?: 'stop' | 'continue' // default 'stop'
  description?: string
}

export interface Recipe {
  id?: string
  name: string
  description?: string
  steps: RecipeStep[]
}

export interface RecipeStepResult {
  step: number
  tool: string
  ok: boolean
  attempts: number
  durationMs: number
  result?: unknown
  error?: string
}

export interface RecipeRunResult {
  ok: boolean
  steps: RecipeStepResult[]
  abortedAt?: number
}

interface RecipeStoreSchema {
  recipes: Recipe[]
}

let _instance: RecipeStore | null = null
export function getRecipeStore(): RecipeStore {
  if (!_instance) _instance = new RecipeStore()
  return _instance
}

export class RecipeStore {
  private store: Store<RecipeStoreSchema>

  constructor() {
    this.store = new Store<RecipeStoreSchema>({
      name: 'fleet-term-recipes',
      defaults: { recipes: [] }
    })
  }

  list(): Recipe[] { return this.store.get('recipes', []) }

  get(idOrName: string): Recipe | undefined {
    const all = this.list()
    return all.find(r => r.id === idOrName || r.name === idOrName)
  }

  save(recipe: Recipe): Recipe {
    const all = this.list()
    if (!recipe.id) recipe.id = uuidv4()
    const idx = all.findIndex(r => r.id === recipe.id)
    if (idx === -1) all.push(recipe)
    else all[idx] = recipe
    this.store.set('recipes', all)
    return recipe
  }

  delete(idOrName: string): boolean {
    const all = this.list()
    const next = all.filter(r => r.id !== idOrName && r.name !== idOrName)
    if (next.length === all.length) return false
    this.store.set('recipes', next)
    return true
  }
}

export type StepDispatcher = (tool: string, args: Record<string, unknown>) => Promise<unknown>

export async function runRecipe(recipe: Recipe, dispatch: StepDispatcher): Promise<RecipeRunResult> {
  const stepResults: RecipeStepResult[] = []
  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i]
    const maxAttempts = (step.retry ?? 0) + 1
    const delay = step.retry_delay_ms ?? 500
    let lastError: string | undefined
    let attempts = 0
    let success = false
    let result: unknown
    const start = Date.now()
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      attempts = attempt + 1
      try {
        result = await dispatch(step.tool, step.args)
        const ok = (result && typeof result === 'object' && 'success' in (result as object))
          ? !!(result as { success: boolean }).success
          : true
        if (ok) { success = true; break }
        lastError = (result as { error?: string })?.error ?? 'tool returned success: false'
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      if (attempt + 1 < maxAttempts) await new Promise(r => setTimeout(r, delay))
    }
    stepResults.push({ step: i, tool: step.tool, ok: success, attempts, durationMs: Date.now() - start, result, error: success ? undefined : lastError })
    if (!success && (step.on_fail ?? 'stop') === 'stop') {
      return { ok: false, steps: stepResults, abortedAt: i }
    }
  }
  return { ok: stepResults.every(s => s.ok), steps: stepResults }
}
