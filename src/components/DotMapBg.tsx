import { useEffect, useMemo, useRef } from "react"
import type { Node } from "@/lib/api"
import { NZ_LAND } from "@/lib/land"
import { CC_GEO, NODE_CC, NODE_GEO } from "@/lib/geo"

/**
 * Dotted world map below the server list, rendered like Prism's DotMap:
 * canvas land dots from the NZ_LAND mask (330x133, Natural Earth
 * land-50m), node markers resolved by reported country code (hand-placed
 * city coords only while the reported country still matches, otherwise
 * the country fallback), busiest/fastest markers pulsing with the same
 * periods as the stat bar, offline markers rose, and the coastline
 * sparkle sweep.
 *
 * Background-only variant: no clicks, tags or tooltips; the section is
 * decorative. Land dots draw even before any marker resolves; markers
 * follow the nodes passed in (App passes the visible group, so the map
 * matches the table, including its busiest/fastest pulses).
 */

const DOT_COLOR = "rgba(199,205,214,0.85)"
const DOT_HALO = "rgba(10,14,20,0.55)"
const DOT_COLOR_M = "rgba(255,255,255,0.95)"
const SPARKLE_ALPHA = 0.95
const SPARKLE_WAVES = 4
const MARK_COLOR = "#4ade80"
const MARK_SCALE = 1.8
const HOT_BUSY_COLOR = "#fb923c"
const HOT_FAST_COLOR = "#38bdf8"
const OFFLINE_COLOR = "#fb7185"
const DOT_R = 0.26
const DOT_R_M = 0.42

const TAU = 6.2832

/** Fit a canvas to its wrapper (CSS pixels) at device pixel ratio, capped at 3. Returns null when the wrapper has no size. */
function fitCanvas(wrap: HTMLDivElement, cv: HTMLCanvasElement, ctx: CanvasRenderingContext2D): { w: number; h: number } | null {
  const w = wrap.clientWidth
  const h = wrap.clientHeight
  if (!w || !h) return null
  const dpr = Math.min(window.devicePixelRatio || 1, 3)
  const tw = Math.round(w * dpr)
  const th = Math.round(h * dpr)
  if (cv.width !== tw || cv.height !== th) {
    cv.width = tw
    cv.height = th
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { w, h }
}

/** First mask row below 61°S — Antarctica. Drawn only while a node
 * actually reports AQ; with no node there the continent stays hidden. */
const AQ_ROW = 112

type Marker = {
  x: number
  y: number
  names: string[]
  online: boolean
  busy: boolean
  fast: boolean
}

let landBitsCache: number[][] | null = null
function landBits(): number[][] {
  if (landBitsCache) return landBitsCache
  const bits: number[][] = []
  for (let r = 0; r < NZ_LAND.rows; r++) {
    const raw = atob(NZ_LAND.data[r])
    const row: number[] = []
    for (let c = 0; c < NZ_LAND.cols; c++) {
      row.push((raw.charCodeAt(c >> 3) >> (7 - (c & 7))) & 1)
    }
    bits.push(row)
  }
  landBitsCache = bits
  return bits
}

const geoCache = new Map<string, [number, number] | null>()
function geoOf(name: string, cc: string): [number, number] | null {
  const key = (name || "").toLowerCase()
  const ucc = (cc || "").toUpperCase()
  const ckey = `${key}|${ucc}`
  const hit = geoCache.get(ckey)
  if (hit !== undefined) return hit
  let g: [number, number] | null = null
  if (ucc && NODE_GEO[key] && NODE_CC[key] === ucc) g = NODE_GEO[key]
  else if (ucc && CC_GEO[ucc]) g = CC_GEO[ucc]
  else g = NODE_GEO[key] ?? null
  geoCache.set(ckey, g)
  return g
}

function project(lat: number, lon: number) {
  return {
    x: (lon - NZ_LAND.lonL) / (NZ_LAND.lonR - NZ_LAND.lonL),
    y: (NZ_LAND.latTop - lat) / (NZ_LAND.latTop - NZ_LAND.latBot),
  }
}

function buildMarkers(nodes: Node[]): Marker[] {
  let busyId: number | null = null
  let fastId: number | null = null
  let busyCpu = -1
  let fastRx = -1
  for (const node of nodes) {
    if (!node.online || !node.metrics) continue
    if (node.metrics.cpu > busyCpu) {
      busyCpu = node.metrics.cpu
      busyId = node.id
    }
    if (node.metrics.net_rx > fastRx) {
      fastRx = node.metrics.net_rx
      fastId = node.id
    }
  }
  const groups = new Map<string, Marker>()
  for (const node of nodes) {
    if (!node.name) continue
    const g = geoOf(node.name, node.country)
    if (!g) continue
    const p = project(g[0], g[1])
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) continue
    const key = `${Math.round(p.x * 300)}:${Math.round(p.y * 300)}`
    let grp = groups.get(key)
    if (!grp) {
      grp = { x: p.x, y: p.y, names: [], online: false, busy: false, fast: false }
      groups.set(key, grp)
    }
    if (!grp.names.includes(node.name)) {
      grp.names.push(node.name)
      if (node.online) grp.online = true
      if (node.id === busyId) grp.busy = true
      if (node.id === fastId) grp.fast = true
    }
  }
  return [...groups.values()]
}

function dotShape(ctx: CanvasRenderingContext2D, cx: number, cy: number, rr: number, round: boolean) {
  if (round) {
    ctx.moveTo(cx + rr, cy)
    ctx.arc(cx, cy, rr, 0, TAU)
  } else {
    ctx.rect(cx - rr, cy - rr, rr * 2, rr * 2)
  }
}

export function DotMapBg({ nodes }: { nodes: Node[] }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const landRef = useRef<HTMLCanvasElement>(null)
  const dotRef = useRef<HTMLCanvasElement>(null)
  const sparklesRef = useRef<{ gx: number; gy: number; ph: number }[]>([])
  const markers = useMemo(() => buildMarkers(nodes), [nodes])
  const hasAQ = useMemo(() => nodes.some((n) => (n.country || "").toUpperCase() === "AQ"), [nodes])
  const markersRef = useRef(markers)
  markersRef.current = markers

  // Land layer: redrawn on resize only; the dot layer animates above it.
  useEffect(() => {
    const box = boxRef.current
    const cv = landRef.current
    if (!box || !cv) return
    const ctx = cv.getContext("2d")
    if (!ctx) return
    let timer: number | undefined
    const draw = () => {
      const wh = fitCanvas(box, cv, ctx)
      if (!wh) return
      const { w, h } = wh
      const isM = window.matchMedia("(max-width: 768px)").matches
      const bits = landBits()
      const cw = w / NZ_LAND.cols
      const ch = h / NZ_LAND.rows
      const r = Math.min(cw, ch) * (isM ? DOT_R_M : DOT_R)
      ctx.clearRect(0, 0, w, h)
      const yMax = hasAQ ? NZ_LAND.rows : AQ_ROW
      ctx.fillStyle = DOT_HALO
      const hr = r * 1.6
      ctx.beginPath()
      for (let y = 0; y < yMax; y++) {
        for (let x = 0; x < NZ_LAND.cols; x++) {
          if (bits[y][x]) dotShape(ctx, (x + 0.5) * cw, (y + 0.5) * ch, hr, isM)
        }
      }
      ctx.fill()
      ctx.fillStyle = isM ? DOT_COLOR_M : DOT_COLOR
      ctx.beginPath()
      for (let y = 0; y < yMax; y++) {
        for (let x = 0; x < NZ_LAND.cols; x++) {
          if (bits[y][x]) dotShape(ctx, (x + 0.5) * cw, (y + 0.5) * ch, r, isM)
        }
      }
      ctx.fill()
      const sparkles: { gx: number; gy: number; ph: number }[] = []
      for (let yy = 0; yy < yMax; yy++) {
        for (let xx = 0; xx < NZ_LAND.cols; xx++) {
          if (!bits[yy][xx]) continue
          let coast = false
          for (let ddy = -1; ddy <= 1 && !coast; ddy++) {
            for (let ddx = -1; ddx <= 1 && !coast; ddx++) {
              if (!ddx && !ddy) continue
              const nnx = xx + ddx
              const nny = yy + ddy
              if (nnx < 0 || nnx >= NZ_LAND.cols || nny < 0 || nny >= NZ_LAND.rows || !bits[nny][nnx]) coast = true
            }
          }
          if (coast) sparkles.push({ gx: xx, gy: yy, ph: (xx / NZ_LAND.cols) * Math.PI * 2 * SPARKLE_WAVES })
        }
      }
      sparklesRef.current = sparkles
    }
    draw()
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(draw, 200)
    })
    ro.observe(box)
    return () => {
      ro.disconnect()
      window.clearTimeout(timer)
    }
  }, [hasAQ])

  // Dot layer animation: hot markers pulse, coastline sparkles sweep.
  useEffect(() => {
    const box = boxRef.current
    const cv = dotRef.current
    if (!box || !cv) return
    const ctx = cv.getContext("2d")
    if (!ctx) return
    let raf = 0
    const drawDots = (t: number) => {
      const wh = fitCanvas(box, cv, ctx)
      if (!wh) return
      const { w, h } = wh
      ctx.clearRect(0, 0, w, h)
      const pitch = w / NZ_LAND.cols
      for (const m of markersRef.current) {
        const mc = m.online ? MARK_COLOR : OFFLINE_COLOR
        const hot = m.online && (m.busy || m.fast)
        const n = m.names.length
        const scale = n < 3 ? 1 : n < 5 ? 1.3 : 1.6
        const x = m.x * w
        const y = m.y * h
        if (hot) {
          const mainHc = m.busy ? HOT_BUSY_COLOR : HOT_FAST_COLOR
          const mph = (t / (m.busy ? 1600 : 2000)) % 1
          const mrr = pitch * (2.0 + 0.5 * Math.sin(mph * TAU)) * scale * MARK_SCALE
          ctx.save()
          ctx.strokeStyle = mainHc
          ctx.globalAlpha = 0.6 + 0.4 * Math.sin(mph * TAU)
          ctx.lineWidth = Math.max(2, pitch * 0.3 * MARK_SCALE)
          ctx.shadowColor = mainHc
          ctx.shadowBlur = pitch * 2.4 * MARK_SCALE
          ctx.beginPath()
          ctx.arc(x, y, mrr, 0, TAU)
          ctx.stroke()
          ctx.restore()
          const icons: { ch: string; hc: string; period: number }[] = []
          if (m.busy) icons.push({ ch: "🔥", hc: HOT_BUSY_COLOR, period: 1600 })
          if (m.fast) icons.push({ ch: "⚡", hc: HOT_FAST_COLOR, period: 2000 })
          const fs = Math.max(16, pitch * 2.6 * MARK_SCALE)
          icons.forEach((ic, k) => {
            const ox = icons.length > 1 ? (k === 0 ? -fs * 0.62 : fs * 0.62) : 0
            ctx.save()
            ctx.fillStyle = "rgba(0,0,0,0.55)"
            ctx.beginPath()
            ctx.arc(x + ox, y, fs * 0.62, 0, TAU)
            ctx.fill()
            ctx.restore()
            const ph = (t / ic.period) % 1
            ctx.save()
            ctx.globalAlpha = 0.6 + 0.4 * Math.sin(ph * TAU)
            ctx.font = `${fs}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`
            ctx.textAlign = "center"
            ctx.textBaseline = "middle"
            ctx.shadowColor = ic.hc
            ctx.shadowBlur = pitch * 2.5 * MARK_SCALE
            ctx.fillText(ic.ch, x + ox, y)
            ctx.restore()
          })
        } else {
          if (!m.online) {
            ctx.save()
            ctx.fillStyle = "rgba(0,0,0,0.55)"
            ctx.beginPath()
            ctx.arc(x, y, Math.max(2, pitch * 0.32 * MARK_SCALE) * 2.4, 0, TAU)
            ctx.fill()
            ctx.restore()
          }
          ctx.save()
          ctx.strokeStyle = mc
          ctx.globalAlpha = m.online ? 0.85 : 0.7
          ctx.lineWidth = Math.max(1.5, pitch * 0.22 * MARK_SCALE)
          ctx.beginPath()
          ctx.arc(x, y, pitch * 1.15 * scale * MARK_SCALE, 0, TAU)
          ctx.stroke()
          ctx.restore()
          ctx.save()
          ctx.fillStyle = mc
          ctx.globalAlpha = m.online ? 0.9 : 0.7
          ctx.beginPath()
          ctx.arc(x, y, Math.max(2, pitch * 0.32 * MARK_SCALE), 0, TAU)
          ctx.fill()
          ctx.restore()
        }
      }
      const sparkles = sparklesRef.current
      if (sparkles.length) {
        const scw = w / NZ_LAND.cols
        const sch = h / NZ_LAND.rows
        const isM = window.matchMedia("(max-width: 768px)").matches
        const sr = Math.min(scw, sch) * (isM ? DOT_R_M : DOT_R)
        const NB = 24
        const buckets: { gx: number; gy: number }[][] = Array.from({ length: NB }, () => [])
        const tt = t / 900
        for (const sp of sparkles) {
          const wv = 0.5 + 0.5 * Math.sin(tt - sp.ph)
          const bi = Math.min(NB - 1, (wv * NB) | 0)
          buckets[bi].push(sp)
        }
        for (let b = 0; b < NB; b++) {
          const arr = buckets[b]
          if (!arr.length) continue
          const sa = (SPARKLE_ALPHA * (b + 0.5)) / NB
          if (sa < 0.03) continue
          ctx.fillStyle = `rgba(255,255,255,${sa.toFixed(3)})`
          ctx.beginPath()
          for (const pp of arr) {
            const px = (pp.gx + 0.5) * scw
            const py = (pp.gy + 0.5) * sch
            dotShape(ctx, px, py, sr, isM)
          }
          ctx.fill()
        }
      }
    }
    const loop = (t: number) => {
      if (document.hidden) {
        raf = 0
        return
      }
      drawDots(t || 0)
      raf = requestAnimationFrame(loop)
    }
    const pump = () => {
      if (!raf && !document.hidden) raf = requestAnimationFrame(loop)
    }
    document.addEventListener("visibilitychange", pump)
    pump()
    return () => {
      document.removeEventListener("visibilitychange", pump)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <div
      ref={boxRef}
      className="relative w-full select-none"
      style={{ margin: "6px auto 0", aspectRatio: "330 / 133" }}
      aria-hidden="true"
    >
      <canvas ref={landRef} className="absolute inset-0 h-full w-full" />
      <canvas ref={dotRef} className="absolute inset-0 h-full w-full" />
    </div>
  )
}
