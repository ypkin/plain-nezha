import { startTransition, useEffect, useState } from "react"

export type Metrics = {
  uptime: number
  cpu: number
  load: [number, number, number]
  mem_total: number
  mem_used: number
  swap_total: number
  swap_used: number
  disk_total: number
  disk_used: number
  net_rx: number
  net_tx: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  tcp: number
  udp: number
  procs: number
}

export type Node = {
  id: number
  name: string
  sort: number
  public: boolean
  online: boolean
  /** ISO 3166-1 alpha-2, or empty when the hub could not locate the address. */
  country: string
  last_seen: number
  metrics: Metrics | null
  os: string
  kernel: string
  arch: string
  virt: string
  cpu_name: string
  cpu_cores: number
  mem_total: number
  swap_total: number
  disk_total: number
  agent_version: string
  price: number
  currency: string
  billing_cycle: string
  expires_at: string | null
  /** Remaining days to expiration calculated by hub date. 0 is today, negative is expired, null is no expiration. */
  expires_in?: number | null
  /** Group name set by admin on panel. Empty string or undefined means ungrouped. */
  group?: string
  traffic_limit: number
  traffic_mode: string
  traffic_reset_day: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  /** This period's usage as the plan meters it (`traffic_mode`). Absent on older hubs. */
  month_used?: number
  month_start: string
  day_rx: number
  day_tx: number
  /** Panel only. */
  hostname?: string
  ip?: string
  remark?: string
}

class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/* =====================================================================
 * Nezha v0 adapter.
 *
 * This build runs as a standalone frontend in front of a Nezha v0
 * (nezha-zero) dashboard instead of a Monitor Hub:
 *  - live data comes from the dashboard's `/ws` push ({now, servers}),
 *  - the initial snapshot, billing notes (PublicNote) and the site name
 *    come from the dashboard home page, which embeds the same payload
 *    plus each server's PublicNote (the WS push omits it),
 *  - month/day traffic is accumulated locally from the lifetime
 *    counters, because the v0 feed has no monthly counters,
 *  - metric history is accumulated locally from the live stream,
 *    because the v0 public API exposes no per-server history.
 * ===================================================================== */

type V0Host = {
  Platform?: string
  PlatformVersion?: string
  CPU?: string[]
  MemTotal?: number
  DiskTotal?: number
  SwapTotal?: number
  Arch?: string
  Virtualization?: string
  CountryCode?: string
  Version?: string
}

type V0State = {
  CPU?: number
  MemUsed?: number
  SwapUsed?: number
  DiskUsed?: number
  NetInTransfer?: number
  NetOutTransfer?: number
  NetInSpeed?: number
  NetOutSpeed?: number
  Uptime?: number
  Load1?: number
  Load5?: number
  Load15?: number
  TcpConnCount?: number
  UdpConnCount?: number
  ProcessCount?: number
}

type V0Server = {
  ID: number
  Name?: string
  Tag?: string
  DisplayIndex?: number
  HideForGuest?: boolean
  Host?: V0Host
  State?: V0State
  LastActive?: string
  PublicNote?: string
}

type Note = {
  country?: string
  price: number
  currency: string
  cycle: string
  expiresAt: string | null
  trafficLimit: number
  trafficMode: string
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)

function parseNote(raw: string | undefined): Note | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as {
      billingDataMod?: { startDate?: string; endDate?: string; cycle?: string; amount?: string }
      planDataMod?: { trafficVol?: string; trafficType?: string }
      countryCode?: string
    }
    const billing = parsed.billingDataMod ?? {}
    const plan = parsed.planDataMod ?? {}
    const amountText = String(billing.amount ?? "")
    const amount = Number.parseFloat(amountText.replace(/[^0-9.]/g, ""))
    const currency = /[￥¥]/.test(amountText) ? "CNY" : amountText.includes("€") ? "EUR" : amountText.includes("£") ? "GBP" : "USD"
    const cycles: Record<string, string> = {
      "月": "monthly", "月付": "monthly", "年": "yearly", "年付": "yearly",
      "季": "quarterly", "季度": "quarterly", "半年": "semiannual",
      "两年": "biennial", "三年": "triennial", "一次性": "once",
    }
    const volText = String(plan.trafficVol ?? "").trim()
    const vol = /^([\d.]+)\s*([KMGT])?B?$/i.exec(volText)
    const unitPow = vol?.[2] ? "KMGT".indexOf(vol[2].toUpperCase()) + 1 : 0
    // -1 marks an unlimited plan ("Unlimited" / 不限量 in the note).
    const trafficLimit = /unlimited|不限/i.test(volText) ? -1 : vol ? Math.round(Number.parseFloat(vol[1]) * 1024 ** unitPow) : 0
    const end = String(billing.endDate ?? "")
    return {
      country: parsed.countryCode ? parsed.countryCode.toLowerCase() : undefined,
      price: Number.isFinite(amount) ? amount : 0,
      currency,
      cycle: cycles[String(billing.cycle ?? "")] ?? String(billing.cycle ?? ""),
      expiresAt: /^\d{4}-\d{2}-\d{2}$/.test(end) && end !== "0000-00-00" ? end : null,
      trafficLimit,
      // The plan's own metering, surfaced in the details. trafficType per
      // the official note generator: 1 = upload only, 2 = both ways,
      // 3 = max(in, out). (The mapping in the upstream theme was off by one.)
      trafficMode: ({ "1": "up", "2": "sum", "3": "max" } as Record<string, string>)[String(plan.trafficType ?? "")] ?? "",
    }
  } catch {
    return null
  }
}

function mapServer(sv: V0Server, note: Note | null, notes: Map<number, Note | null>, nowMs: number): Node {
  const host = sv.Host ?? {}
  const state = sv.State ?? {}
  const lastActiveMs = sv.LastActive ? Date.parse(sv.LastActive) : NaN
  const agoSec = Number.isFinite(lastActiveMs) ? Math.max(0, (nowMs - lastActiveMs) / 1000) : null
  const online = agoSec !== null && agoSec <= 20
  const cpuRaw = (host.CPU ?? []).join(" ").trim()
  const cores = /(\d+)\s+(?:Physical|Virtual)\s+Core/i.exec(cpuRaw)
  const platform = (host.Platform ?? "").trim()
  const osBase = platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : ""
  const own = note ?? notes.get(sv.ID) ?? null
  const monthStart = new Date()
  monthStart.setDate(1)
  const pad = (n: number) => String(n).padStart(2, "0")
  return {
    id: sv.ID,
    name: sv.Name ?? String(sv.ID),
    // The app sorts ascending by `sort`; Nezha's DisplayIndex is
    // higher-first, so it is negated to keep the panel's order.
    sort: -(sv.DisplayIndex ?? 0),
    public: !sv.HideForGuest,
    online,
    country: own?.country || (host.CountryCode ?? "").toLowerCase(),
    group: sv.Tag || undefined,
    last_seen: Number.isFinite(lastActiveMs) ? Math.floor(lastActiveMs / 1000) : 0,
    metrics: {
      uptime: num(state.Uptime),
      cpu: typeof state.CPU === "number" && Number.isFinite(state.CPU) ? Math.max(0, state.CPU) : 0,
      load: [num(state.Load1), num(state.Load5), num(state.Load15)],
      mem_total: num(host.MemTotal),
      mem_used: num(state.MemUsed),
      swap_total: num(host.SwapTotal),
      swap_used: num(state.SwapUsed),
      disk_total: num(host.DiskTotal),
      disk_used: num(state.DiskUsed),
      net_rx: num(state.NetInSpeed),
      net_tx: num(state.NetOutSpeed),
      total_rx: num(state.NetInTransfer),
      total_tx: num(state.NetOutTransfer),
      month_rx: 0,
      month_tx: 0,
      tcp: num(state.TcpConnCount),
      udp: num(state.UdpConnCount),
      procs: num(state.ProcessCount),
    },
    os: [osBase, host.PlatformVersion].filter(Boolean).join(" "),
    kernel: "",
    arch: host.Arch ?? "",
    virt: host.Virtualization ?? "",
    cpu_name: cpuRaw.replace(/\s*\d+\s+(?:Physical|Virtual)\s+Core.*$/i, "").trim(),
    cpu_cores: cores ? Number.parseInt(cores[1], 10) : (host.CPU ?? []).length,
    mem_total: num(host.MemTotal),
    swap_total: num(host.SwapTotal),
    disk_total: num(host.DiskTotal),
    agent_version: host.Version ?? "",
    price: own?.price ?? 0,
    currency: own?.currency ?? "USD",
    billing_cycle: own?.cycle ?? "",
    expires_at: own?.expiresAt ?? null,
    traffic_limit: own?.trafficLimit ?? 0,
    traffic_mode: own?.trafficMode ?? "",
    traffic_reset_day: 0,
    total_rx: num(state.NetInTransfer),
    total_tx: num(state.NetOutTransfer),
    month_rx: 0,
    month_tx: 0,
    month_start: `${monthStart.getFullYear()}-${pad(monthStart.getMonth() + 1)}-01`,
    day_rx: 0,
    day_tx: 0,
  }
}

/* ---------- panel snapshot (PublicNote, site name, fallback data) ---------- */

const notesById = new Map<number, Note | null>()
let siteName = ""
let snapshotAt = 0
let snapshotNodes: Node[] | null = null
let snapshotFlight: Promise<Node[]> | null = null

/** Decode a single-quoted JS string literal body (Go template escaping). */
function decodeJsString(raw: string): string {
  let out = ""
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c !== "\\") { out += c; continue }
    const e = raw[++i]
    if (e === "u" && raw[i + 1] === "{") {
      const end = raw.indexOf("}", i + 2)
      out += String.fromCodePoint(Number.parseInt(raw.slice(i + 2, end), 16))
      i = end
    } else if (e === "u") {
      out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 5), 16))
      i += 4
    } else if (e === "x") {
      out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" }
      out += simple[e] ?? e
    }
  }
  return out
}

function extractSnapshot(html: string): { now: number; servers: V0Server[] } | null {
  const marker = "JSON.parse('"
  let from = 0
  for (;;) {
    const at = html.indexOf(marker, from)
    if (at < 0) return null
    let j = at + marker.length
    let raw = ""
    while (j < html.length) {
      const c = html[j]
      if (c === "\\") { raw += c + (html[j + 1] ?? ""); j += 2; continue }
      if (c === "'") break
      raw += c; j++
    }
    try {
      const data = JSON.parse(decodeJsString(raw)) as { now?: number; servers?: V0Server[] }
      if (data && Array.isArray(data.servers)) return { now: data.now ?? Date.now(), servers: data.servers }
    } catch { /* not the payload; keep scanning */ }
    from = j + 1
  }
}

async function fetchSnapshot(signal?: AbortSignal): Promise<Node[]> {
  const res = await fetch("/panel-snapshot", { signal })
  if (!res.ok) throw new ApiError(res.status, (await res.text()) || res.statusText)
  const html = await res.text()
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1]?.trim()
  if (title) siteName = title
  const snap = extractSnapshot(html)
  if (!snap) throw new Error("Failed to parse the panel snapshot")
  const nowMs = snap.now || Date.now()
  const nodes = snap.servers.map((sv) => {
    const note = parseNote(sv.PublicNote)
    notesById.set(sv.ID, note)
    return mapServer(sv, note, notesById, nowMs)
  })
  snapshotAt = Date.now()
  snapshotNodes = nodes
  return nodes
}

function ensureSnapshot(maxAgeMs: number, signal?: AbortSignal): Promise<Node[]> {
  if (snapshotNodes && Date.now() - snapshotAt < maxAgeMs) return Promise.resolve(snapshotNodes)
  if (!snapshotFlight) {
    snapshotFlight = fetchSnapshot(signal).finally(() => { snapshotFlight = null })
  }
  return snapshotFlight
}

/* ---------- streaming/AI unlock (IPQuality results, server-set) ----------
   The panel has no unlock field, so the results live on a small service
   behind ``/unlock/`` (sailor, see unlock.py): GET / returns nodes keyed
   by nezha node id, POST /test starts a background IPQuality run
   (a few minutes; the frontend polls until checked_at changes).
   Only sailor has data so far; other nodes render "暂无数据". */

export type UnlockService = {
  status: "unlocked" | "blocked" | "partial" | "unknown"
  region: string | null
}
export type UnlockIp = {
  ip?: string
  ip_type?: string
  usage?: string
  registration?: string
  checked_at?: string | null
  source?: string
  status?: string
  note?: string
  services?: Record<string, UnlockService>
}
export type UnlockNode = {
  checked_at?: string
  ipv4?: UnlockIp
  ipv6?: UnlockIp
}
let unlockNodes: Record<string, UnlockNode> = {}
let unlockFetchAt = 0
export async function fetchUnlock(id: number): Promise<UnlockNode | null> {
  try {
    if (Date.now() - unlockFetchAt > 60000 || !unlockNodes[String(id)]) {
      const res = await fetch("/unlock/", { signal: AbortSignal.timeout(5000) })
      if (res.ok) {
        const data = await res.json() as { nodes?: unknown }
        if (data.nodes && typeof data.nodes === "object") {
          unlockNodes = data.nodes as Record<string, UnlockNode>
          unlockFetchAt = Date.now()
        }
      }
    }
  } catch { /* server unreachable: keep whatever was cached */ }
  return unlockNodes[String(id)] ?? null
}
export async function requestUnlockTest(): Promise<"started" | "running" | "cooldown" | "failed"> {
  try {
    const res = await fetch("/unlock/test", { method: "POST", signal: AbortSignal.timeout(10000) })
    if (res.status === 429) return "cooldown"
    if (!res.ok) return "failed"
    const data = await res.json() as { status?: unknown }
    if (data.status === "running") return "running"
    if (data.status === "started") return "started"
    return "failed"
  } catch { return "failed" }
}
export function invalidateUnlockCache() {
  unlockFetchAt = 0
}

/* ---------- deployed-services live check (server-set, exact-de side) ----------
   The static list in lib/services only says what a node is supposed to
   run. The live statuses live on a small service behind ``/services/``
   (exact-de, same compose project as design-cal): GET / returns nodes
   keyed by nezha node id, POST /test queues a node for its next
   5-minute poll (the node then runs check-services.py and reports),
   and the frontend polls until checked_at changes. Home nodes have
   no checker, so they keep the static list and no button. */

export type ServicesNode = {
  node_id?: number
  checked_at?: string
  services?: Record<string, string>
}
let servicesNodes: Record<string, ServicesNode> = {}
let servicesFetchAt = 0
let servicesFlight: Promise<Record<string, ServicesNode>> | null = null
export async function fetchServicesAll(): Promise<Record<string, ServicesNode>> {
  try {
    if (Date.now() - servicesFetchAt > 60000 || Object.keys(servicesNodes).length === 0) {
      if (!servicesFlight) {
        servicesFlight = (async () => {
          const res = await fetch("/services/", { signal: AbortSignal.timeout(5000) })
          if (res.ok) {
            const data = await res.json() as { nodes?: unknown }
            if (data.nodes && typeof data.nodes === "object") {
              servicesNodes = data.nodes as Record<string, ServicesNode>
              servicesFetchAt = Date.now()
            }
          }
          return servicesNodes
        })().finally(() => { servicesFlight = null })
      }
      return await servicesFlight
    }
  } catch { /* server unreachable: keep whatever was cached */ }
  return servicesNodes
}
export async function fetchServices(id: number): Promise<ServicesNode | null> {
  const all = await fetchServicesAll()
  return all[String(id)] ?? null
}
export async function requestServicesTest(id: number): Promise<"queued" | "cooldown" | "failed"> {
  try {
    const res = await fetch("/services/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_id: id }),
      signal: AbortSignal.timeout(10000),
    })
    if (res.status === 429) return "cooldown"
    if (!res.ok) return "failed"
    const data = await res.json() as { status?: unknown }
    if (data.status === "queued") return "queued"
    return "failed"
  } catch { return "failed" }
}
export function invalidateServicesCache() {
  servicesFetchAt = 0
}

/* ---------- month/day traffic accumulation (local, from lifetime counters) ---------- */

type TrafficBase = { m: string; mrx: number; mtx: number; d: string; drx: number; dtx: number }
const TRAFFIC_KEY = "design-nezha:traffic:v1"
let trafficBases: Record<string, TrafficBase> = {}
try {
  trafficBases = JSON.parse(localStorage.getItem(TRAFFIC_KEY) ?? "{}") as Record<string, TrafficBase>
} catch { trafficBases = {} }
let trafficSaveAt = 0

/* ---------- per-node traffic calibration (server-set) ----------
   The local period meter starts from zero at first sight, which rarely
   matches the provider's own counter. The user can pin the current
   period's start date and the provider's current reading; the meter then
   tracks from there and rolls monthly on the anchor day.

   The record used to live only in this browser's localStorage, so a
   different browser, computer, or cleared site data lost it. It now
   lives on the server behind ``/cal/`` (same origin, proxied to the
   design-cal service): the server is authoritative, localStorage keeps
   the same keys as a migration source and an offline fallback. On
   load, a browser that still has a local calibration and finds the
   server empty uploads it once; afterwards the server's record wins
   on every fetch. Calibration edits are password-protected on the
   server exactly like the Prism usage store: the first edit may set a
   password, later edits must match it, and only a PBKDF2 hash is kept
   server-side. */

export type TrafficCal = {
  /** Anchor date (YYYY-MM-DD) the user picked as this period's start. */
  start: string
  /** Provider's metered reading for this period, in bytes. */
  offset: number
  /** Lifetime counters captured when the calibration was saved. */
  baseRx: number
  baseTx: number
  /** Cycle start (YYYY-MM-DD) the base belongs to. */
  period: string
}
const TRAFFIC_CAL_KEY = "design-nezha:traffic-cal:v1"
const TRAFFIC_CAL_MIGRATED_KEY = "design-nezha:traffic-cal-migrated:v1"
let trafficCals: Record<string, TrafficCal> = {}
try {
  trafficCals = JSON.parse(localStorage.getItem(TRAFFIC_CAL_KEY) ?? "{}") as Record<string, TrafficCal>
} catch { trafficCals = {} }

function saveTrafficCals() {
  try { localStorage.setItem(TRAFFIC_CAL_KEY, JSON.stringify(trafficCals)) } catch { /* storage may be blocked */ }
}
export function getTrafficCal(id: number): TrafficCal | null {
  return trafficCals[String(id)] ?? null
}

/* ---------- server calibration store ---------- */

let serverCalsReached = false
let serverCalsFetchAt = 0
let serverPasswordSet: boolean | null = null
export function calPasswordSet(): boolean | null { return serverPasswordSet }

function isCal(v: unknown): v is TrafficCal {
  if (!v || typeof v !== "object") return false
  const c = v as Record<string, unknown>
  return typeof c.start === "string" && typeof c.offset === "number" &&
    typeof c.baseRx === "number" && typeof c.baseTx === "number" &&
    typeof c.period === "string"
}

async function postCal(path: string, body: unknown): Promise<number> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
    return res.status
  } catch { return 0 }
}

async function fetchServerCals(): Promise<void> {
  try {
    const res = await fetch("/cal/", { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return
    const data = await res.json() as { cals?: unknown; password_set?: unknown }
    serverCalsReached = true
    serverCalsFetchAt = Date.now()
    if (typeof data.password_set === "boolean") serverPasswordSet = data.password_set
    if (!data.cals || typeof data.cals !== "object") return
    const incoming: Record<string, TrafficCal> = {}
    for (const [k, v] of Object.entries(data.cals as Record<string, unknown>)) {
      // The server stores snake_case (base_rx/base_tx); the frontend
      // type is camelCase (baseRx/baseTx). Normalizing here is what
      // makes a server record loadable at all: without it isCal()
      // rejects every server record, fetchServerCals() wipes the
      // local calibrations, and a just-saved calibration appears
      // to "not save" on the next refresh.
      const c = (v ?? {}) as Record<string, unknown>
      const normalized: Record<string, unknown> = {
        start: c.start,
        offset: c.offset,
        baseRx: typeof c.baseRx === "number" ? c.baseRx : c.base_rx,
        baseTx: typeof c.baseTx === "number" ? c.baseTx : c.base_tx,
        period: c.period,
      }
      if (isCal(normalized)) incoming[k] = normalized as TrafficCal
    }
    let migrated = false
    try { migrated = localStorage.getItem(TRAFFIC_CAL_MIGRATED_KEY) === "1" } catch { migrated = false }
    if (Object.keys(incoming).length === 0 && !migrated && Object.keys(trafficCals).length > 0) {
      // One-time migration: the server has no record yet, this browser
      // does. Upload it (no password: the server has none set yet in
      // this state, or the upload 403s and the local record stays).
      let pushed = false
      for (const [k, cal] of Object.entries(trafficCals)) {
        const status = await postCal("/cal/calibrate", {
          id: k, start: cal.start, offset: cal.offset, base_rx: cal.baseRx, base_tx: cal.baseTx,
        })
        if (status === 200) pushed = true
      }
      if (pushed) {
        try { localStorage.setItem(TRAFFIC_CAL_MIGRATED_KEY, "1") } catch { /* storage may be blocked */ }
      }
      return
    }
    // Server wins, except a rolled-over local record that is newer
    // than the server's stale period: keep it for this session, it is
    // re-saved through /calibrate on the next edit or rollover post.
    const now = new Date()
    const next: Record<string, TrafficCal> = {}
    for (const [k, cal] of Object.entries(incoming)) {
      const local = trafficCals[k]
      if (local && local.period === cycleStart(local.start, now) && cal.period !== cycleStart(cal.start, now)) {
        next[k] = local
      } else {
        next[k] = cal
      }
    }
    trafficCals = next
    saveTrafficCals()
  } catch {
    // Server unreachable: keep the local records.
  }
}
void fetchServerCals()

export async function saveTrafficCal(
  id: number, start: string, offset: number, baseRx: number, baseTx: number,
  password: string, newPassword: string,
): Promise<"ok" | "wrong-password" | "failed"> {
  const cal: TrafficCal = { start, offset, baseRx, baseTx, period: cycleStart(start, new Date()) }
  if (!serverCalsReached) {
    // Server never reached (dev, or the service down): local fallback,
    // migration will try to upload it when the server appears.
    trafficCals[String(id)] = cal
    saveTrafficCals()
    return "ok"
  }
  const status = await postCal("/cal/calibrate", {
    id: String(id), start, offset, base_rx: baseRx, base_tx: baseTx,
    ...(password ? { password } : {}),
    ...(newPassword ? { new_password: newPassword } : {}),
  })
  if (status === 403) return "wrong-password"
  if (status !== 200) return "failed"
  trafficCals[String(id)] = cal
  saveTrafficCals()
  if (newPassword) serverPasswordSet = true
  return "ok"
}

export async function clearTrafficCal(id: number, password: string): Promise<"ok" | "wrong-password" | "failed"> {
  if (!serverCalsReached) {
    delete trafficCals[String(id)]
    saveTrafficCals()
    return "ok"
  }
  const status = await postCal("/cal/clear", {
    id: String(id),
    ...(password ? { password } : {}),
  })
  if (status === 403) return "wrong-password"
  if (status !== 200) return "failed"
  delete trafficCals[String(id)]
  saveTrafficCals()
  return "ok"
}

/** Start (YYYY-MM-DD) of the monthly cycle containing `now`, anchored on
    the anchor's day-of-month (clamped in short months). */
export function cycleStart(anchor: string, now: Date): string {
  const day = Number(anchor.slice(8, 10)) || 1
  const p = (n: number) => String(n).padStart(2, "0")
  const clamped = (y: number, m: number) => Math.min(day, new Date(y, m + 1, 0).getDate())
  let y = now.getFullYear()
  let m = now.getMonth()
  if (now.getDate() < clamped(y, m)) {
    m -= 1
    if (m < 0) { m = 11; y -= 1 }
  }
  return `${y}-${p(m + 1)}-${p(clamped(y, m))}`
}

/** A transfer counted the way the plan meters it (mirrors format.metered). */
function meteredLocal(rx: number, tx: number, mode: string): number {
  switch (mode) {
    case "up": return tx
    case "down": return rx
    case "max": return Math.max(rx, tx)
    default: return rx + tx
  }
}

function applyTraffic(nodes: Node[]): Node[] {
  const now = new Date()
  // Refresh the server calibration record at most once a minute, so an
  // edit from another browser arrives without a page reload.
  if (Date.now() - serverCalsFetchAt > 60000) {
    serverCalsFetchAt = Date.now()
    void fetchServerCals()
  }
  const pad = (n: number) => String(n).padStart(2, "0")
  const monthKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
  const dayKey = `${monthKey}-${pad(now.getDate())}`
  let dirty = false
  for (const node of nodes) {
    const key = String(node.id)
    let base = trafficBases[key]
    if (!base || base.m !== monthKey) {
      base = { m: monthKey, mrx: node.total_rx, mtx: node.total_tx, d: dayKey, drx: node.total_rx, dtx: node.total_tx }
      trafficBases[key] = base
      dirty = true
    } else if (base.d !== dayKey) {
      base.d = dayKey; base.drx = node.total_rx; base.dtx = node.total_tx
      dirty = true
    }
    // Agent restarts reset the lifetime counters; re-baseline instead of
    // reporting a negative month.
    if (node.total_rx < base.mrx || node.total_tx < base.mtx) { base.mrx = node.total_rx; base.mtx = node.total_tx; dirty = true }
    if (node.total_rx < base.drx || node.total_tx < base.dtx) { base.drx = node.total_rx; base.dtx = node.total_tx; dirty = true }
    node.month_rx = node.total_rx - base.mrx
    node.month_tx = node.total_tx - base.mtx
    node.day_rx = node.total_rx - base.drx
    node.day_tx = node.total_tx - base.dtx
    if (node.metrics) {
      node.metrics.month_rx = node.month_rx
      node.metrics.month_tx = node.month_tx
      node.metrics.total_rx = node.total_rx
      node.metrics.total_tx = node.total_tx
    }
    const cal = trafficCals[key]
    if (cal) {
      const period = cycleStart(cal.start, now)
      if (cal.period !== period) {
        // A new cycle began on the anchor day: the provider's counter
        // restarts too, so re-baseline and drop the pinned reading.
        cal.period = period
        cal.offset = 0
        cal.baseRx = node.total_rx
        cal.baseTx = node.total_tx
        saveTrafficCals()
        // Best effort: persist the rollover server-side too. It
        // succeeds while no password is set; with a password it 403s
        // and the rolled record stays local for this session, then it
        // is saved on the next passworded edit.
        void postCal("/cal/calibrate", {
          id: key, start: cal.start, offset: 0, base_rx: cal.baseRx, base_tx: cal.baseTx,
        })
      }
      const drx = Math.max(0, node.total_rx - cal.baseRx)
      const dtx = Math.max(0, node.total_tx - cal.baseTx)
      node.month_used = cal.offset + meteredLocal(drx, dtx, node.traffic_mode)
      node.month_start = period
    } else if (node.month_used !== undefined) {
      node.month_used = undefined
    }
  }
  if (dirty || Date.now() - trafficSaveAt > 15000) {
    trafficSaveAt = Date.now()
    try { localStorage.setItem(TRAFFIC_KEY, JSON.stringify(trafficBases)) } catch { /* storage may be blocked */ }
  }
  return nodes
}

/* ---------- local metric history (accumulated from the live stream) ---------- */

type Agg = { n: number; cpu: number; mem: number; disk: number; rx: number; tx: number; rxMax: number; txMax: number }
const FINE_BUCKET = 30
const COARSE_BUCKET = 300
const fine = new Map<number, Map<number, Agg>>()
const coarse = new Map<number, Map<number, Agg>>()

function recordInto(store: Map<number, Map<number, Agg>>, size: number, keepSec: number, id: number, ts: number, node: Node) {
  let series = store.get(id)
  if (!series) { series = new Map(); store.set(id, series) }
  const bucket = Math.floor(ts / size) * size
  let agg = series.get(bucket)
  if (!agg) { agg = { n: 0, cpu: 0, mem: 0, disk: 0, rx: 0, tx: 0, rxMax: 0, txMax: 0 }; series.set(bucket, agg) }
  const m = node.metrics!
  agg.n++
  agg.cpu += m.cpu
  agg.mem += m.mem_used
  agg.disk += m.disk_used
  agg.rx += m.net_rx
  agg.tx += m.net_tx
  agg.rxMax = Math.max(agg.rxMax, m.net_rx)
  agg.txMax = Math.max(agg.txMax, m.net_tx)
  const cutoff = ts - keepSec
  for (const key of series.keys()) if (key < cutoff) series.delete(key)
}

function recordHistory(nodes: Node[], tsSec: number) {
  for (const node of nodes) {
    if (!node.online || !node.metrics) continue
    recordInto(fine, FINE_BUCKET, 26 * 3600, node.id, tsSec, node)
    recordInto(coarse, COARSE_BUCKET, 8 * 86400, node.id, tsSec, node)
  }
}

type HistoryPoint = {
  ts: number
  cpu: number
  mem_used: number
  disk_used: number
  net_rx: number
  net_tx: number
  net_rx_max: number
  net_tx_max: number
}

function historyFor(id: number, hours: number, points: number): { metrics: HistoryPoint[]; ping: never[]; probes: Record<string, string> } {
  const nowSec = Math.floor(Date.now() / 1000)
  const from = nowSec - hours * 3600
  const store = hours <= 26 ? fine : coarse
  const series = store.get(id)
  if (!series) return { metrics: [], ping: [], probes: {} }
  let buckets = [...series.entries()]
    .filter(([ts]) => ts >= from - COARSE_BUCKET)
    .sort((a, b) => a[0] - b[0])
    .map(([ts, a]) => ({
      ts, cpu: a.cpu / a.n, mem_used: a.mem / a.n, disk_used: a.disk / a.n,
      net_rx: a.rx / a.n, net_tx: a.tx / a.n, net_rx_max: a.rxMax, net_tx_max: a.txMax, n: a.n,
    }))
  if (buckets.length > points) {
    const group = Math.ceil(buckets.length / points)
    const merged: typeof buckets = []
    for (let i = 0; i < buckets.length; i += group) {
      const slice = buckets.slice(i, i + group)
      const n = slice.reduce((s, b) => s + b.n, 0)
      merged.push({
        ts: slice[0].ts,
        cpu: slice.reduce((s, b) => s + b.cpu * b.n, 0) / n,
        mem_used: slice.reduce((s, b) => s + b.mem_used * b.n, 0) / n,
        disk_used: slice.reduce((s, b) => s + b.disk_used * b.n, 0) / n,
        net_rx: slice.reduce((s, b) => s + b.net_rx * b.n, 0) / n,
        net_tx: slice.reduce((s, b) => s + b.net_tx * b.n, 0) / n,
        net_rx_max: Math.max(...slice.map((b) => b.net_rx_max)),
        net_tx_max: Math.max(...slice.map((b) => b.net_tx_max)),
        n,
      })
    }
    buckets = merged
  }
  return {
    metrics: buckets.map(({ n: _n, ...point }) => point),
    ping: [],
    probes: {},
  }
}

/* ---------- latency history (Nezha service monitors) ---------- */

type MonitorSeries = {
  monitor_id: number
  monitor_name: string
  created_at: number[]
  avg_delay: (number | null)[]
}

const monitorCache = new Map<number, { at: number; data: Promise<MonitorSeries[]> }>()

function fetchMonitorSeries(id: number): Promise<MonitorSeries[]> {
  const hit = monitorCache.get(id)
  if (hit && Date.now() - hit.at < 60000) return hit.data
  const data = (async () => {
    const res = await fetch(`/api/v1/monitor/${id}`)
    if (!res.ok) throw new ApiError(res.status, (await res.text()) || res.statusText)
    const body = (await res.json()) as { result?: MonitorSeries[] | null }
    return body.result ?? []
  })()
  monitorCache.set(id, { at: Date.now(), data })
  return data
}

type PingPointOut = { task_id: number; ts: number; latency: number | null }

/**
 * The dashboard's per-server monitor API answers with parallel arrays of
 * minute buckets (ms timestamps + average delay) for the last 24 hours.
 * A bucket at the 1000 ms cap, at zero, or missing is a lost minute: it
 * becomes a null point and counts towards the window loss the chips show.
 */
async function pingHistory(id: number, hours: number) {
  const series = await fetchMonitorSeries(id)
  const fromSec = Math.floor(Date.now() / 1000) - hours * 3600
  const ping: PingPointOut[] = []
  const probes: Record<string, string> = {}
  const loss: Record<string, number> = {}
  for (const s of series) {
    probes[s.monitor_id] = s.monitor_name
    let total = 0
    let lost = 0
    for (let i = 0; i < s.created_at.length; i++) {
      const ts = Math.floor(s.created_at[i] / 60000) * 60
      if (ts < fromSec) continue
      const raw = s.avg_delay[i]
      const bad = raw === null || raw === undefined || !Number.isFinite(raw) || raw <= 0 || raw >= 1000
      total++
      if (bad) lost++
      ping.push({ task_id: s.monitor_id, ts, latency: bad ? null : raw })
    }
    if (total > 0 && lost > 0) loss[s.monitor_id] = (lost / total) * 100
  }
  return { metrics: [], ping, probes, loss }
}

/* ---------- api() routing ---------- */

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (path === "/me") {
    // The site name lives in the panel snapshot; load it on first use. A
    // failed load must not block the page: fall back to a neutral name.
    try { await ensureSnapshot(60000, init?.signal ?? undefined) } catch { /* keep fallback */ }
    return { authed: false, github: false, site_name: siteName || "Monitor", public_page: true } as T
  }
  const metricsMatch = /^\/nodes\/(\d+)\/metrics\?(.*)$/.exec(path)
  if (metricsMatch) {
    const params = new URLSearchParams(metricsMatch[2])
    const hours = Number(params.get("hours") ?? 1) || 1
    const points = Number(params.get("points") ?? 600) || 600
    const series = params.get("series") ?? "metrics"
    if (series === "ping") return (await pingHistory(Number(metricsMatch[1]), hours)) as T
    return historyFor(Number(metricsMatch[1]), hours, points) as T
  }
  if (path === "/nodes") {
    const nodes = await ensureSnapshot(0, init?.signal ?? undefined)
    const cloned = nodes.map((n) => ({ ...n, metrics: n.metrics ? { ...n.metrics } : null }))
    return { nodes: ingest(cloned) } as unknown as T
  }
  throw new ApiError(404, `Unsupported endpoint: ${path}`)
}

/** Shared ingest: traffic accounting + history sampling for one snapshot of nodes. */
function ingest(nodes: Node[]): Node[] {
  const stamped = applyTraffic(nodes)
  recordHistory(stamped, Math.floor(Date.now() / 1000))
  return stamped
}

const METRIC_FIELDS = ["uptime", "cpu", "mem_total", "mem_used", "swap_total", "swap_used", "disk_total", "disk_used",
  "net_rx", "net_tx", "total_rx", "total_tx", "month_rx", "month_tx", "tcp", "udp", "procs"] as const
const nonnegativeNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0

/** A malformed report must not remove every other node from the page. */
export function safeNodes(nodes: unknown): Node[] {
  if (!Array.isArray(nodes)) throw new Error("Invalid node data format")
  return nodes.filter((node): node is Node => node !== null && typeof node === "object" && Number.isSafeInteger(node.id)).map((node) => {
    const m = node.metrics
    return m == null || (METRIC_FIELDS.every((key) => nonnegativeNumber(m[key])) && Array.isArray(m.load) && m.load.length === 3 && m.load.every(nonnegativeNumber))
      ? node : { ...node, metrics: null }
  })
}

/** Keep unchanged rows stable across JSON snapshots so memoized rows can skip a paint. */
export function shareNodes(previous: Node[] | null, incoming: Node[]): Node[] {
  if (!previous) return incoming
  const byId = new Map(previous.map((node) => [node.id, node]))
  const next = incoming.map((node) => {
    const old = byId.get(node.id)
    if (!old) return node
    const a = old.metrics
    const b = node.metrics
    const sameMetrics = a === b || (a != null && b != null && METRIC_FIELDS.every((key) => a[key] === b[key]) && a.load.every((value, i) => value === b.load[i]))
    const keys = Object.keys(node) as (keyof Node)[]
    if (sameMetrics && keys.length === Object.keys(old).length && keys.every((key) => key === "metrics" || old[key] === node[key])) return old
    return sameMetrics && a !== b ? { ...node, metrics: a } : node
  })
  return next.length === previous.length && next.every((node, i) => node === previous[i]) ? previous : next
}

type NodeObserver = {
  onNodes: (nodes: Node[]) => void
  onError: (error: Error) => void
}

/**
 * One live subscription against the Nezha dashboard: the embedded panel
 * snapshot seeds the list (and carries the billing notes), the dashboard
 * `/ws` push keeps it live, and snapshot polling is the fallback.
 */
export function subscribeNodes({ onNodes, onError }: NodeObserver) {
  let socket: WebSocket | null = null
  let poll: ReturnType<typeof setTimeout> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let watchdog: ReturnType<typeof setTimeout> | null = null
  let notesTimer: ReturnType<typeof setTimeout> | null = null
  let polling = false
  let pollGeneration = 0
  let disposed = false
  let visible = typeof document === "undefined" || document.visibilityState !== "hidden"

  const emit = (nodes: Node[]) => onNodes(safeNodes(ingest(nodes)))

  const fetchOnce = async () => {
    if (disposed || !visible) return
    try {
      emit(await ensureSnapshot(0))
    } catch (error) {
      if (!disposed) onError(error instanceof Error ? error : new Error("Network error"))
    }
  }

  const pollOnce = () => {
    poll = null
    const generation = pollGeneration
    void fetchOnce().finally(() => {
      if (polling && !disposed && visible && generation === pollGeneration) poll = setTimeout(pollOnce, 5000)
    })
  }
  const startPolling = () => {
    if (!polling && !disposed && visible) {
      polling = true
      poll = setTimeout(pollOnce, 5000)
    }
  }
  const stopPolling = () => {
    polling = false
    pollGeneration++
    if (poll) clearTimeout(poll)
    poll = null
  }

  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`
  const reconnect = () => {
    if (!disposed && visible && !retry) retry = setTimeout(() => { retry = null; connect() }, 5000)
  }
  const clearWatchdog = () => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = null
  }
  const armWatchdog = (current: WebSocket) => {
    clearWatchdog()
    watchdog = setTimeout(() => {
      watchdog = null
      if (disposed || !visible || socket !== current) return
      socket = null
      current.onmessage = current.onerror = current.onclose = null
      try { current.close() } catch { /* A pending handshake may reject close(). */ }
      startPolling()
      reconnect()
    }, 30000)
  }
  const connect = () => {
    if (disposed || !visible) return
    let current: WebSocket
    try {
      current = new WebSocket(url)
      socket = current
      armWatchdog(current)
    } catch {
      startPolling()
      reconnect()
      return
    }
    current.onmessage = (event) => {
      if (disposed || !visible || socket !== current || typeof event.data !== "string") return
      try {
        const data = JSON.parse(event.data) as { now?: number; servers?: V0Server[] }
        if (!Array.isArray(data?.servers)) return
        const nowMs = data.now ?? Date.now()
        emit(data.servers.map((sv) => mapServer(sv, null, notesById, nowMs)))
        stopPolling()
        armWatchdog(current)
      } catch {
        if (disposed || !visible || socket !== current) return
        onError(new Error("Invalid live data format; reconnecting"))
        current.close()
      }
    }
    current.onerror = () => current.close()
    current.onclose = () => {
      if (disposed || !visible || socket !== current) return
      clearWatchdog()
      socket = null
      startPolling()
      reconnect()
    }
  }

  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      visible = false
      stopPolling()
      clearWatchdog()
      if (retry) clearTimeout(retry)
      retry = null
      const current = socket
      socket = null
      if (current) {
        current.onmessage = current.onerror = current.onclose = null
        current.close()
      }
    } else if (!visible && !disposed) {
      visible = true
      void fetchOnce()
      connect()
    }
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange)

  void fetchOnce()
  if (visible) connect()
  // Notes and the site name change rarely; refresh the snapshot quietly.
  const refreshNotes = () => {
    notesTimer = null
    if (disposed) return
    void ensureSnapshot(0).catch(() => { /* the stream remains authoritative */ })
    notesTimer = setTimeout(refreshNotes, 300000)
  }
  notesTimer = setTimeout(refreshNotes, 300000)
  return () => {
    disposed = true
    clearWatchdog()
    stopPolling()
    if (retry) clearTimeout(retry)
    if (notesTimer) clearTimeout(notesTimer)
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange)
    if (socket) {
      socket.onmessage = socket.onerror = socket.onclose = null
      socket.close()
    }
  }
}

/** Live node list, preferring the hub's two-second WebSocket snapshots. */
export function useNodes() {
  const [nodes, setNodes] = useState<Node[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A 401 means the status page was closed to anonymous callers after loading.
  const [closed, setClosed] = useState(false)

  useEffect(() => subscribeNodes({
    onNodes: (next) => {
      // Let taps and scrolling win over the recurring telemetry paints.
      startTransition(() => setNodes((previous) => shareNodes(previous, next)))
      setError(null)
      setClosed(false)
    },
    onError: (error) => {
      setError(error.message || "Network error")
      if (error instanceof ApiError && error.status === 401) setClosed(true)
    },
  }), [])

  return { nodes, error, closed }
}
