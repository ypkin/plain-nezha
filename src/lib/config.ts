import manifest from "../../theme.json"

export type ConfigField = {
  key: string
  type: string
  default: unknown
  options?: { value: string; label?: string }[]
  min?: number
  max?: number
  help?: string
  label?: string
}

function fits(field: ConfigField, value: unknown): boolean {
  if (value === undefined || value === null) return false
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean"
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        && value >= (field.min ?? -Infinity) && value <= (field.max ?? Infinity)
    case "select":
      return !!field.options?.some((option) => option.value === value)
    default:
      return typeof value === "string"
  }
}

export const fields = ((manifest as { config?: (ConfigField | { type: "title"; label: string })[] }).config ?? [])
  .filter((f): f is ConfigField => f.type !== "title")

/* Nezha v0 standalone build: there is no hub to hold the theme config, so
 * the "site default" lives in this browser's localStorage instead of the
 * hub's `/api/themes/<short>/config` endpoint. Same merge semantics: a
 * value equal to the field default is dropped, anything else overrides. */
const CONFIG_KEY = "design-nezha:config"

function readSaved(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}") as unknown
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function loadConfig(): Promise<Record<string, unknown>> {
  const saved = readSaved()
  const pick = (f: ConfigField) => (fits(f, saved[f.key]) ? saved[f.key] : f.default)
  return Object.fromEntries(fields.map((f) => [f.key, pick(f)]))
}

export async function saveConfig(values: Record<string, unknown>): Promise<void> {
  const next = readSaved()
  for (const f of fields) {
    if (values[f.key] === f.default) delete next[f.key]
    else if (values[f.key] !== undefined) next[f.key] = values[f.key]
  }
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(next))
  } catch {
    throw new Error("浏览器存储不可用，无法保存")
  }
}
