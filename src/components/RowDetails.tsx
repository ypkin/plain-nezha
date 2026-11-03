import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react"
import { ChartLine } from "lucide-react"

import { deployed, Meter, OsIcon } from "@/components/NodeMarks"
import { Badge } from "@/components/ui/badge"
import { Segmented } from "@/components/ui/segmented"
import { Skeleton } from "@/components/ui/skeleton"
import { calPasswordSet, clearTrafficCal, fetchServices, fetchUnlock, getTrafficCal, invalidateServicesCache, invalidateUnlockCache, requestServicesTest, requestUnlockTest, saveTrafficCal, type Node, type ServicesNode, type UnlockIp, type UnlockNode } from "@/lib/api"
import {
  bytes, cpuName, CYCLES, daysUntil, dayUsage, FOREVER, money, monthUsage, osName, pair, percent, periodStart,
  TRAFFIC_MODES, uptime, virtName,
} from "@/lib/format"
import { fetchHistory, latencyWindow } from "@/lib/history"
import { knownPing } from "@/lib/pings"
import { Link } from "@/lib/route"
import { nodeServices, SERVICE_CHECK_IDS } from "@/lib/services"
import { cn } from "@/lib/utils"

// From the chart page's chunk, which App warms at start, so the table itself
// carries no recharts.
const Latency = lazy(() => import("@/components/NodeDetail").then((m) => ({ default: m.Latency })))

const TABS = [
  { value: "latency", label: "网络延迟" },
  { value: "overview", label: "系统概览" },
  { value: "unlock", label: "解锁" },
  { value: "services", label: "已部署业务" },
]

/**
 * One topic per card, on the shaded strip the open row lays down.
 */
function Block({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("min-w-0 rounded-lg border border-border/80 bg-card p-3.5", className)}>
      <h4 className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold text-foreground">
        <span>{title}</span>
        {aside}
      </h4>
      <div className="space-y-1">{children}</div>
    </section>
  )
}

/** One fact per line, the label in a fixed column so the values align. */
function Line({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[3.8rem_minmax(0,1fr)] items-baseline gap-x-2 text-xs leading-5">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("tnum break-words font-medium text-foreground", className)}>{children}</span>
    </div>
  )
}

/**
 * This period's usage against the plan's quota, with today's share lifted a
 * shade at the tip.
 */
function PeriodMeter({ used, today, limit, title }: { used: number; today: number; limit: number; title: string }) {
  const pct = percent(used, limit)
  const share = pct > 0 ? (percent(Math.min(today, used), limit) / pct) * 100 : 0
  return (
    <Meter pct={pct} title={title} className="my-1.5 h-2">
      {today > 0 && <div className="absolute inset-y-0 right-0 min-w-0.5 rounded-r-full bg-background/45" style={{ width: `${share}%` }} />}
    </Meter>
  )
}

/** Streaming/AI unlock, from the IPQuality results behind /unlock/.
    Only sailor (id 101) has data so far; other nodes show 暂无数据.
    The test button starts a background IPQuality run on sailor (a few
    minutes); the card polls until checked_at changes. */
const UNLOCK_ORDER: [string, string][] = [
  ["netflix", "Netflix"],
  ["disney", "Disney+"],
  ["hbo", "HBO Max"],
  ["youtube", "YouTube"],
  ["chatgpt", "ChatGPT"],
  ["claude", "Claude"],
  ["gemini", "Gemini"],
  ["muse", "Muse"],
]
function UnlockBadges({ ip }: { ip: UnlockIp }) {
  const services = ip.services ?? {}
  // Desktop: the wrapper disappears (lg:contents) so the badges
  // become items of UnlockBlock's shared 9-column grid, whose badge
  // columns are auto-sized to the widest badge in that column across
  // both rows. That keeps the two rows aligned without the equal
  // 1fr columns that left short badges stranded and long badges
  // squeezed against the next one. Below lg the wrapper is an
  // ordinary 2/4-column grid under its label.
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:contents">
      {UNLOCK_ORDER.map(([key, label]) => {
        const s = services[key]
        if (!s) return <span key={key} />
        const color = s.status === "unlocked"
          ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
          : s.status === "partial"
            ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
            : s.status === "blocked"
              ? "border-red-500/50 text-red-600 dark:text-red-400"
              : "border-border text-muted-foreground"
        const mark = s.status === "unlocked" ? "✓" : s.status === "partial" ? "△ 仅自制" : s.status === "blocked" ? "✗ 屏蔽" : "?"
        return (
          <span key={key} className={cn("min-w-0 justify-self-start whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium", color)}>
            {label} {mark}{s.region ? ` ${s.region}` : ""}
          </span>
        )
      })}
    </div>
  )
}
/** Never show a full address on the public page: v4 keeps two octets,
    v6 keeps the /64 prefix. The service stores masked values too; this
    is defence in depth in case a future check writes a full address. */
function maskIp(ip: string): string {
  if (ip.includes(".")) {
    const parts = ip.split(".")
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.*.*` : ip
  }
  if (ip.includes("::")) return `${ip.split("::")[0]}::*`
  const parts = ip.split(":")
  return parts.length > 2 ? `${parts.slice(0, -1).join(":")}:*` : ip
}
function UnlockIpGroup({ label, ip }: { label: string; ip: UnlockIp | undefined }) {
  if (!ip) return null
  const typeLabel = ip.status === "pending"
    ? ""
    : ip.ip_type === "broadcast"
      ? `广播 · 注册 ${ip.registration ?? "?"} / 使用 ${ip.usage ?? "?"}`
      : ip.ip_type === "native"
        ? "原生"
        : ""
  // A fragment, not a stacked block: UnlockBlock lays the two groups
  // out as two grid rows (label | badges), so the whole card is two
  // lines on desktop instead of label-above-badges times two.
  return (
    <>
      <p className="whitespace-nowrap text-[11px] font-medium text-muted-foreground">
        {label}{ip.ip ? ` · ${maskIp(ip.ip)}` : ""}{typeLabel ? ` · ${typeLabel}` : ""}
      </p>
      {ip.status === "pending" ? (
        <p className="text-[11px] text-muted-foreground">{ip.note ?? "等 IPv6 的 IPQuality 报告，这里不先用别的脚本结果顶替。"}</p>
      ) : (
        <UnlockBadges ip={ip} />
      )}
    </>
  )
}
function UnlockBlock({ node }: { node: Node }) {
  const [data, setData] = useState<UnlockNode | null | undefined>(undefined)
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState("")
  const [before, setBefore] = useState<string | undefined>(undefined)
  useEffect(() => {
    let live = true
    void fetchUnlock(node.id).then((d) => { if (live) setData(d) })
    return () => { live = false }
  }, [node.id])
  useEffect(() => {
    if (!testing) return
    const started = Date.now()
    const timer = setInterval(async () => {
      invalidateUnlockCache()
      const d = await fetchUnlock(node.id)
      if (d && d.checked_at && d.checked_at !== before) {
        setData(d)
        setTesting(false)
      } else if (Date.now() - started > 5 * 60 * 1000) {
        setTesting(false)
        setTestError("检测超时，请稍后刷新页面")
      }
    }, 15000)
    return () => clearInterval(timer)
  }, [testing, node.id, before])
  const runTest = async () => {
    setTestError("")
    setBefore(data?.checked_at)
    const res = await requestUnlockTest()
    if (res === "failed") {
      setTestError("服务端未达，检测未启动")
      return
    }
    if (res === "cooldown") {
      setTestError("刚测过不久，稍后再试")
      return
    }
    setTesting(true)
  }
  const checked = data?.checked_at ? data.checked_at.slice(5, 10) : ""
  return (
    <Block
      title="流媒体及 AI 解锁"
      className="col-span-full"
      aside={
        <div className="flex items-center gap-2">
          {checked && <span className="tnum text-[11px] font-normal text-muted-foreground">每周检测 · 上次 {checked}</span>}
          <button type="button" onClick={runTest} disabled={testing} className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50">
            {testing ? "检测中…" : "重新检测"}
          </button>
        </div>
      }
    >
      {data === undefined ? (
        <p className="text-[11px] text-muted-foreground">加载中…</p>
      ) : data === null ? (
        <p className="text-[11px] text-muted-foreground">暂无数据</p>
      ) : (
        <div className="grid gap-y-3 lg:grid-cols-[max-content_repeat(8,auto)] lg:items-center lg:gap-x-2 lg:gap-y-2">
          <UnlockIpGroup label="IPv4" ip={data.ipv4} />
          <UnlockIpGroup label="IPv6" ip={data.ipv6} />
        </div>
      )}
      {testError && <p className="pt-1 text-[11px] font-medium text-destructive">{testError}</p>}
      <p className="pt-1 text-[11px] text-muted-foreground">数据来源：IPQuality 报告 + 试验检测 + 直接测试；Muse 为官网直测可达（首页/join 均 200，无地区拦截页），非账号注册验证。检测跑完约需几分钟，跑完卡片自动刷新。</p>
    </Block>
  )
}

/** The four cards: the machine, what it is doing, what it has moved, and its term. */
function Overview({ node }: { node: Node }) {
  // Traffic calibration: pin this period's start date and the provider's
  // own reading so the meter aligns with the provider. The record lives
  // on the server (see lib/api), not in this browser; edits are
  // password-protected once a password exists, and a new password set
  // here becomes the calibration password.
  const [calOpen, setCalOpen] = useState(false)
  const [calTick, setCalTick] = useState(0)
  const cal = useMemo(() => getTrafficCal(node.id), [node.id, calTick])
  const [draftDate, setDraftDate] = useState("")
  const [draftAmt, setDraftAmt] = useState("")
  const [draftUnit, setDraftUnit] = useState<"MB" | "GB" | "TB">("GB")
  const [draftPassword, setDraftPassword] = useState("")
  const [draftNewPassword, setDraftNewPassword] = useState("")
  const [calError, setCalError] = useState("")
  const [calSaving, setCalSaving] = useState(false)
  const nowD = new Date()
  const todayLocal = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, "0")}-${String(nowD.getDate()).padStart(2, "0")}`
  const openCal = () => {
    setDraftDate(cal?.start ?? node.month_start)
    setDraftAmt(cal ? String(Math.round((cal.offset / 1024 ** 3) * 100) / 100) : "")
    setDraftUnit("GB")
    setDraftPassword("")
    setDraftNewPassword("")
    setCalError("")
    setCalOpen(true)
  }
  const saveCal = async () => {
    const amt = Number.parseFloat(draftAmt)
    const mult = draftUnit === "TB" ? 1024 ** 4 : draftUnit === "MB" ? 1024 ** 2 : 1024 ** 3
    if (!draftDate || draftDate > todayLocal || !Number.isFinite(amt) || amt < 0) return
    setCalSaving(true)
    setCalError("")
    const res = await saveTrafficCal(
      node.id, draftDate, Math.round(amt * mult), node.total_rx, node.total_tx,
      draftPassword, draftNewPassword,
    )
    setCalSaving(false)
    if (res === "wrong-password") {
      setCalError("密码不对，校准未保存")
      return
    }
    if (res === "failed") {
      setCalError("服务端未达，校准未保存，请稍后再试")
      return
    }
    setCalTick((n) => n + 1)
    setCalOpen(false)
  }
  const clearCal = async () => {
    setCalSaving(true)
    setCalError("")
    const res = await clearTrafficCal(node.id, draftPassword)
    setCalSaving(false)
    if (res === "wrong-password") {
      setCalError("密码不对，校准未清除")
      return
    }
    if (res === "failed") {
      setCalError("服务端未达，校准未清除，请稍后再试")
      return
    }
    setCalTick((n) => n + 1)
    setCalOpen(false)
  }
  const m = node.online ? node.metrics : null
  const away = node.last_seen ? Date.now() / 1000 - node.last_seen : 0
  const days = node.expires_in !== undefined ? node.expires_in : daysUntil(node.expires_at)
  const used = monthUsage(node)
  const today = dayUsage(node)
  const limit = node.traffic_limit
  const since = periodStart(node.month_start)
  const usage = (used: number, total: number) => `${pair(used, total)}（${percent(used, total).toFixed(1)}%）`
  const flow = (rx: number, tx: number) => `↓ ${bytes(rx)} · ↑ ${bytes(tx)}`
  const metering = [
    node.traffic_reset_day > 0 && `每月 ${node.traffic_reset_day} 日重置`,
    limit > 0 && (TRAFFIC_MODES[node.traffic_mode] ?? node.traffic_mode),
  ].filter(Boolean)

  return (
    <div className="grid gap-3 @min-[30rem]:grid-cols-2 @6xl:grid-cols-4">
      <Block
        title="系统信息"
        aside={
          <div className="flex items-center gap-1.5">
            {node.group && (
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
                {node.group}
              </Badge>
            )}
            {node.agent_version && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground">
                v{node.agent_version}
              </Badge>
            )}
          </div>
        }
      >
        <Line label="系统">
          <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
            <OsIcon os={node.os} />
            <span className="min-w-0 truncate">{osName(node.os) || "—"}</span>
          </span>
        </Line>
        {node.kernel && <Line label="内核">{node.kernel}</Line>}
        <Line label="架构">{[node.arch, virtName(node.virt)].filter(Boolean).join(" · ") || "—"}</Line>
        <Line label="CPU">{node.cpu_name ? `${cpuName(node.cpu_name)} × ${node.cpu_cores}` : `${node.cpu_cores} 核`}</Line>
        <Line label={node.online ? "在线" : "离线"}>
          {node.online ? (m ? uptime(m.uptime) : "等待上报") : away >= 60 ? uptime(away) : "刚刚"}
        </Line>
      </Block>

      <Block
        title="资源监控"
        aside={
          <Link href={`/node/${node.id}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
            <ChartLine className="size-3" />
            历史图表
          </Link>
        }
      >
        {m && <Line label="CPU">{m.cpu.toFixed(1)}%</Line>}
        <Line label="内存">{m ? usage(m.mem_used, m.mem_total) : bytes(node.mem_total)}</Line>
        <Line label="交换">{node.swap_total > 0 ? (m ? usage(m.swap_used, m.swap_total) : bytes(node.swap_total)) : "未启用"}</Line>
        <Line label="硬盘">{m ? usage(m.disk_used, m.disk_total) : bytes(node.disk_total)}</Line>
        {m && <Line label="负载">{m.load.map((n) => n.toFixed(2)).join(" / ")}</Line>}
      </Block>

      <Block
        title="流量统计"
        aside={
          <div className="flex items-center gap-2">
            {since && (
              <span className="tnum text-[11px] font-normal text-muted-foreground">
                {since}起
              </span>
            )}
            <button type="button" onClick={openCal} className="text-[11px] font-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              校准
            </button>
          </div>
        }
      >
        <Line label="本期">{limit > 0 ? usage(used, limit) : `${bytes(used)} / ${FOREVER}`}</Line>
        {limit > 0 && (
          <PeriodMeter used={used} today={today} limit={limit} title={`本期已用 ${pair(used, limit)}，其中今日 ${bytes(today)}`} />
        )}
        <Line label="今日">{flow(node.day_rx, node.day_tx)}</Line>
        <Line label="累计">{flow(node.total_rx, node.total_tx)}</Line>
        {metering.length > 0 && <Line label="计量">{metering.join(" · ")}</Line>}
        {calOpen && (
          <div className="space-y-2 border-t border-border/60 pt-2">
            <label className="block text-[11px] text-muted-foreground">
              本期开始日期
              <input type="date" value={draftDate} max={todayLocal} onChange={(e) => setDraftDate(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs font-normal text-foreground" />
            </label>
            <label className="block text-[11px] text-muted-foreground">
              服务商当前已用（本期）
              <span className="mt-1 flex gap-1.5">
                <input type="number" min="0" step="0.01" value={draftAmt} onChange={(e) => setDraftAmt(e.target.value)} placeholder="0" className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-1 text-xs font-normal text-foreground" />
                <select value={draftUnit} onChange={(e) => setDraftUnit(e.target.value as "MB" | "GB" | "TB")} className="shrink-0 rounded-md border border-border bg-background px-1.5 py-1 text-xs font-normal text-foreground">
                  <option value="MB">MB</option>
                  <option value="GB">GB</option>
                  <option value="TB">TB</option>
                </select>
              </span>
            </label>
            <label className="block text-[11px] text-muted-foreground">
              校准密码{calPasswordSet() ? "（已有密码时必填）" : "（首次设置时留空即不设密码）"}
              <input type="password" value={draftPassword} onChange={(e) => setDraftPassword(e.target.value)} placeholder="已有密码时填写" className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs font-normal text-foreground" />
            </label>
            <label className="block text-[11px] text-muted-foreground">
              新密码（留空不改；首次填写即生效）
              <input type="password" value={draftNewPassword} onChange={(e) => setDraftNewPassword(e.target.value)} placeholder="留空不改" className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs font-normal text-foreground" />
            </label>
            <p className="text-[11px] text-muted-foreground">校准存在服务器上，换浏览器也能看到；密码只在服务端存哈希，不存浏览器。</p>
            {calError && <p className="text-[11px] font-medium text-destructive">{calError}</p>}
            <div className="flex items-center gap-1.5 pt-0.5">
              <button type="button" onClick={saveCal} disabled={calSaving} className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50">保存</button>
              <button type="button" onClick={() => setCalOpen(false)} className="rounded-md border border-border px-2.5 py-1 text-[11px] font-normal">取消</button>
              {cal && (
                <button type="button" onClick={clearCal} disabled={calSaving} className="ml-auto text-[11px] font-normal text-muted-foreground hover:text-destructive disabled:opacity-50">恢复默认</button>
              )}
            </div>
          </div>
        )}
      </Block>

      <Block title="账期信息">
        <Line label="续费">
          {node.price > 0 ? `${money(node.price, node.currency)} / ${CYCLES[node.billing_cycle] ?? node.billing_cycle}` : "Free"}
        </Line>
        <Line label="到期">{node.expires_at || "长期有效"}</Line>
        {days !== null && (
          <Line label="剩余">
            {days < 0 ? (
              <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">Expired {-days}d</Badge>
            ) : days <= 7 ? (
              <Badge variant="warning" className="px-1.5 py-0 text-[10px]">{days}d left</Badge>
            ) : (
              `${days}d`
            )}
          </Line>
        )}
      </Block>
    </div>
  )
}

function ServicesTab({ node }: { node: Node }) {
  const list = nodeServices(node.name)
  const checkable = SERVICE_CHECK_IDS.has(node.id)
  const [live, setLive] = useState<ServicesNode | null | undefined>(undefined)
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState("")
  const [before, setBefore] = useState<string | undefined>(undefined)
  useEffect(() => {
    let alive = true
    if (checkable) void fetchServices(node.id).then((d) => { if (alive) setLive(d) })
    return () => { alive = false }
  }, [node.id, checkable])
  useEffect(() => {
    if (!testing) return
    const started = Date.now()
    const timer = setInterval(async () => {
      invalidateServicesCache()
      const d = await fetchServices(node.id)
      if (d && d.checked_at && d.checked_at !== before) {
        setLive(d)
        setTesting(false)
        window.dispatchEvent(new Event("design-services-updated"))
      } else if (Date.now() - started > 7 * 60 * 1000) {
        setTesting(false)
        setTestError("仍在排队，下次打开本页时自动刷新")
      }
    }, 15000)
    return () => clearInterval(timer)
  }, [testing, node.id, before])
  const runTest = async () => {
    setTestError("")
    setBefore(live?.checked_at)
    const res = await requestServicesTest(node.id)
    if (res === "failed") {
      setTestError("服务端未达，检测未启动")
      return
    }
    if (res === "cooldown") {
      setTestError("刚测过不久，稍后再试")
      return
    }
    setTesting(true)
  }
  const checked = live?.checked_at ? live.checked_at.slice(0, 16).replace("T", " ") : ""
  const mark = (s: string) => {
    const st = live?.services?.[s]
    return st === "running" ? "✓ " : st === "stopped" ? "✗ " : st === "unknown" ? "? " : ""
  }
  return (
    <Block
      title="已部署业务"
      aside={
        checkable ? (
          <div className="flex items-center gap-2">
            {checked && <span className="tnum text-[11px] font-normal text-muted-foreground">上次 {checked}</span>}
            <button type="button" onClick={runTest} disabled={testing} className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50">
              {testing ? "检测中…" : "重新检测"}
            </button>
          </div>
        ) : undefined
      }
    >
      {list.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {list.map((s) => (
            <Badge key={s} variant="secondary" className="px-2 py-0.5 text-[11px] font-normal">
              {mark(s)}{s}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">— 待确认</p>
      )}
      {testError && <p className="pt-1 text-[11px] font-medium text-destructive">{testError}</p>}
      {checkable && (
        <p className="pt-1 text-[11px] text-muted-foreground">
          {live === undefined ? "加载中…" : live === null ? "暂无实查数据，点重新检测到节点实查。" : "实查：到节点查服务在不在跑；按钮排队后节点 5 分钟内轮询上报，跑完自动刷新。"}
        </p>
      )}
    </Block>
  )
}

/**
 * What a row opens into: two tabs, the round trips to the node first and the
 * four cards of what it is behind them.
 */
export function RowDetails({ node }: { node: Node }) {
  const [learned, setLearned] = useState<boolean | null>(null)
  const has = learned ?? knownPing(node.id)
  const [tab, setTab] = useState<string | null>(null)
  const shown = has === true ? tab ?? "latency" : "overview"
  const ready = deployed(node)

  useEffect(() => {
    if (ready) void fetchHistory(node.id, latencyWindow(), "ping")
  }, [node.id, ready])

  if (!ready) {
    return <p className="px-4 py-4 text-sm text-muted-foreground">尚未接入。在后台生成安装命令并执行一次。</p>
  }

  return (
    <div className="space-y-3.5 px-4 py-3.5 text-xs @max-3xl:px-2">
      {has === true && (
        <div className="flex items-center">
          <Segmented value={shown} onChange={setTab} options={TABS} label="详情视图" className="max-md:h-5 max-md:p-0" />
        </div>
      )}

      {has === undefined && <Skeleton className="h-[320px] rounded-lg" />}

      <div hidden={shown !== "latency"}>
        <Suspense fallback={has === true ? <Skeleton className="h-[320px] rounded-lg" /> : null}>
          <Latency id={node.id} card className="h-[280px] @max-3xl:h-[220px]" onKnown={setLearned} />
        </Suspense>
      </div>

      <div hidden={shown !== "overview" || has === undefined}>
        <Overview node={node} />
      </div>

      <div hidden={shown !== "unlock"}>
        <UnlockBlock node={node} />
      </div>

      <div hidden={shown !== "services"}>
        <ServicesTab node={node} />
      </div>
    </div>
  )
}
