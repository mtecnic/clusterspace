import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'yaml'
import { app } from 'electron'
import { Persona, TaskTemplate, TaskStep, Skill } from '../shared/types'

interface ConfigFile {
  id: string
  metadata: Record<string, unknown>
  content: string
}

export class ConfigLoader {
  private userConfigDir: string
  private defaultsDir: string
  private isDev: boolean

  constructor() {
    this.isDev = !app.isPackaged

    // User config directory
    this.userConfigDir = path.join(app.getPath('userData'), 'fleet-term', 'config')

    // Defaults directory - different in dev vs packaged
    if (this.isDev) {
      this.defaultsDir = path.join(process.cwd(), 'resources', 'defaults')
    } else {
      this.defaultsDir = path.join(process.resourcesPath, 'defaults')
    }

    // Ensure directories exist
    this.ensureDirectories()
  }

  private ensureDirectories(): void {
    const dirs = [
      path.join(this.userConfigDir, 'personas'),
      path.join(this.userConfigDir, 'tasks'),
      path.join(this.userConfigDir, 'skills'),
      path.join(this.userConfigDir, 'memory')
    ]
    dirs.forEach(dir => {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (err) {
        console.error(`Failed to create directory ${dir}:`, err)
      }
    })
  }

  // Get user config directory (for external use)
  getUserConfigDir(): string {
    return this.userConfigDir
  }

  // Parse .md file with YAML frontmatter
  private parseMarkdownFile(filePath: string): ConfigFile | null {
    try {
      if (!fs.existsSync(filePath)) return null

      const content = fs.readFileSync(filePath, 'utf-8')
      const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)

      if (match) {
        const metadata = yaml.parse(match[1])
        return {
          id: metadata.id || path.basename(filePath, '.md'),
          metadata,
          content: match[2].trim()
        }
      }

      // No frontmatter - treat whole file as content
      return {
        id: path.basename(filePath, '.md'),
        metadata: {},
        content: content.trim()
      }
    } catch (err) {
      console.error(`Failed to parse ${filePath}:`, err)
      return null
    }
  }

  // Build Persona from config file
  private buildPersona(file: ConfigFile): Persona {
    const meta = file.metadata
    return {
      id: file.id,
      name: (meta.name as string) || file.id,
      description: (meta.description as string) || '',
      capabilities: (meta.capabilities as string[]) || [],
      tools: (meta.tools as string[]) || [],
      systemPrompt: file.content,
      temperature: meta.temperature as number | undefined,
      maxTokens: meta.maxTokens as number | undefined
    }
  }

  // Build TaskTemplate from config file
  private buildTaskTemplate(file: ConfigFile): TaskTemplate {
    const meta = file.metadata

    // Parse steps from markdown content
    const steps: TaskStep[] = []
    const stepRegex = /^### Step (\d+): (.+)\n([\s\S]*?)(?=^### Step|\Z)/gm
    let match
    while ((match = stepRegex.exec(file.content)) !== null) {
      steps.push({
        number: parseInt(match[1]),
        title: match[2].trim(),
        action: '', // Could parse from content
        successCriteria: '' // Could parse from content
      })
    }

    return {
      id: file.id,
      name: (meta.name as string) || file.id,
      category: (meta.category as string) || 'general',
      description: (meta.description as string) || '',
      assignedPersonas: (meta.assignedPersonas as string[]) || [],
      steps,
      successCriteria: (meta.successCriteria as string) || ''
    }
  }

  // Build Skill from config file
  private buildSkill(file: ConfigFile): Skill {
    const meta = file.metadata
    return {
      id: file.id,
      name: (meta.name as string) || file.id,
      domain: (meta.domain as string) || 'general',
      description: (meta.description as string) || '',
      prerequisites: (meta.prerequisites as string[]) || [],
      usage: file.content
    }
  }

  // List files in a directory (both user and defaults)
  private listFiles(subdir: string): string[] {
    const files = new Set<string>()

    // User files (higher priority)
    const userDir = path.join(this.userConfigDir, subdir)
    if (fs.existsSync(userDir)) {
      fs.readdirSync(userDir)
        .filter(f => f.endsWith('.md'))
        .forEach(f => files.add(path.basename(f, '.md')))
    }

    // Default files
    const defaultDir = path.join(this.defaultsDir, subdir)
    if (fs.existsSync(defaultDir)) {
      fs.readdirSync(defaultDir)
        .filter(f => f.endsWith('.md'))
        .forEach(f => files.add(path.basename(f, '.md')))
    }

    return Array.from(files)
  }

  // Load with user override priority
  loadPersona(id: string): Persona | null {
    const userPath = path.join(this.userConfigDir, 'personas', `${id}.md`)
    const defaultPath = path.join(this.defaultsDir, 'personas', `${id}.md`)

    const file = fs.existsSync(userPath)
      ? this.parseMarkdownFile(userPath)
      : this.parseMarkdownFile(defaultPath)

    return file ? this.buildPersona(file) : null
  }

  // List all available personas
  listPersonas(): Persona[] {
    const ids = this.listFiles('personas')
    return ids.map(id => this.loadPersona(id)).filter((p): p is Persona => p !== null)
  }

  // Load task template
  loadTask(id: string, category?: string): TaskTemplate | null {
    // Tasks can be in subdirectories by category
    const searchPaths = category
      ? [
          path.join(this.userConfigDir, 'tasks', category, `${id}.md`),
          path.join(this.defaultsDir, 'tasks', category, `${id}.md`)
        ]
      : [
          path.join(this.userConfigDir, 'tasks', `${id}.md`),
          path.join(this.defaultsDir, 'tasks', `${id}.md`)
        ]

    for (const searchPath of searchPaths) {
      const file = this.parseMarkdownFile(searchPath)
      if (file) return this.buildTaskTemplate(file)
    }

    // Search in subdirectories
    const userTasksDir = path.join(this.userConfigDir, 'tasks')
    const defaultTasksDir = path.join(this.defaultsDir, 'tasks')

    for (const baseDir of [userTasksDir, defaultTasksDir]) {
      if (!fs.existsSync(baseDir)) continue

      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const filePath = path.join(baseDir, entry.name, `${id}.md`)
          const file = this.parseMarkdownFile(filePath)
          if (file) return this.buildTaskTemplate(file)
        }
      }
    }

    return null
  }

  // List all task templates
  listTasks(): TaskTemplate[] {
    const tasks: TaskTemplate[] = []

    const searchDirs = [
      path.join(this.userConfigDir, 'tasks'),
      path.join(this.defaultsDir, 'tasks')
    ]

    const seenIds = new Set<string>()

    for (const baseDir of searchDirs) {
      if (!fs.existsSync(baseDir)) continue

      // Direct files
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const id = path.basename(entry.name, '.md')
          if (!seenIds.has(id)) {
            const task = this.loadTask(id)
            if (task) {
              tasks.push(task)
              seenIds.add(id)
            }
          }
        } else if (entry.isDirectory()) {
          // Subdirectory - scan it too
          const subDir = path.join(baseDir, entry.name)
          for (const subEntry of fs.readdirSync(subDir)) {
            if (subEntry.endsWith('.md')) {
              const id = path.basename(subEntry, '.md')
              if (!seenIds.has(id)) {
                const task = this.loadTask(id, entry.name)
                if (task) {
                  tasks.push(task)
                  seenIds.add(id)
                }
              }
            }
          }
        }
      }
    }

    return tasks
  }

  // Load skill
  loadSkill(id: string): Skill | null {
    const userPath = path.join(this.userConfigDir, 'skills', `${id}.md`)
    const defaultPath = path.join(this.defaultsDir, 'skills', `${id}.md`)

    const file = fs.existsSync(userPath)
      ? this.parseMarkdownFile(userPath)
      : this.parseMarkdownFile(defaultPath)

    return file ? this.buildSkill(file) : null
  }

  // List all skills
  listSkills(): Skill[] {
    const ids = this.listFiles('skills')
    return ids.map(id => this.loadSkill(id)).filter((s): s is Skill => s !== null)
  }
}
