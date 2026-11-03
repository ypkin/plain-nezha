import { useMemo, useState, type ReactNode } from "react"
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight } from "lucide-react"

import { Dot, Flag, Meter, Num, OsIcon, SLOT } from "@/components/NodeMarks"
import { RowDetails } from "@/components/RowDetails"
import { StatBar } from "@/components/StatBar"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { Node } from "@/lib/api"
import { compact, CYCLES, daysUntil, distro, duration, FOREVER, money, percent } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * The figure over its meter, as shadcn's stat tiles set them.
 */
function Bar({ pct, label }: { pct: number | null; label?: string }) {
  const v = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="tnum truncate text-[11px] leading-none text-muted-foreground @max-3xl:text-[9px] @max-sm:text-[11px]">
        {label ?? (pct === null ? "—" : `${v.toFixed(1)}%`)}
      </span>
      <Meter pct={pct} className="@max-sm:h-[2px]" />
    </div>
  )
}

function Expiry({ node }: { node: Node }) {
  const days = node.expires_in !== undefined ? node.expires_in : daysUntil(node.expires_at)
  if (days === null) return <span className="text-muted-foreground" title="永不到期">{FOREVER}</span>
  if (days < 0) return <Badge variant="destructive" className="px-1.5 py-0 text-[10px] font-normal @max-sm:text-[11px]">Expired</Badge>
  if (days <= 7) return <Badge variant="warning" className="px-1.5 py-0 text-[10px] font-normal @max-sm:text-[11px]">{days}d</Badge>
  return <span>{days}d</span>
}

/**
 * Column widths and responsive folding.
 * On wide screens (max-w-7xl), all 12 columns are comfortably displayed.
 * On smaller screens, secondary columns gracefully hide.
 * Compact PC rule: fixed layout at every width (previously table-fixed only
 * kicked in below 3xl, so on wide PC the browser auto-stretched columns and
 * rows looked loose). Wide percentages below sum to 100%; the @max-3xl and
 * @max-sm overrides for narrow/mobile are untouched.
 */
const COL = {
  status: "w-[4%] text-center @max-3xl:w-[6%] @max-sm:py-0.5 py-1",
  name: "min-w-28 max-w-56 truncate text-left font-medium w-[8%] @max-3xl:w-[19%] @max-3xl:max-w-none @max-3xl:min-w-0 @max-sm:w-[22%] @max-sm:py-0.5 py-1",
  location: "w-[5%] text-center @max-3xl:w-[7%] @max-sm:hidden py-1",
  os: "w-[10%] text-center @max-5xl:hidden py-1",
  uptime: "w-[6%] text-center @max-3xl:hidden py-1",
  expiry: "w-[9%] text-center @max-3xl:w-[18%] @max-sm:w-[12%] @max-3xl:min-w-0 overflow-hidden @max-sm:py-0.5 py-1",
  load: "w-[4%] text-center @max-3xl:hidden py-1",
  speed: "min-w-28 text-center w-[8%] @max-3xl:w-[19%] @max-3xl:min-w-0 @max-sm:w-[21%] overflow-hidden @max-sm:py-0.5 py-1",
  bar: "w-[8%] min-w-16 text-center @max-3xl:w-[10%] @max-3xl:min-w-0 @max-sm:w-[13%] overflow-hidden @max-sm:py-0.5 py-1",
  price: "w-[10%] min-w-22 text-center @max-3xl:hidden py-1",
}

type SortField = "name" | "uptime" | "load" | "speed" | "cpu" | "mem" | "disk" | "price"
type SortOrder = "asc" | "desc"

function sortNodes(nodes: Node[], field: SortField | null, order: SortOrder): Node[] {
  if (!field) return [...nodes].sort((a, b) => a.sort - b.sort || a.id - b.id)

  return [...nodes].sort((a, b) => {
    let res = 0
    const ma = a.online ? a.metrics : null
    const mb = b.online ? b.metrics : null

    switch (field) {
      case "name":
        res = a.name.localeCompare(b.name, "zh-CN")
        break
      case "uptime":
        res = (ma?.uptime ?? -1) - (mb?.uptime ?? -1)
        break
      case "load":
        res = (ma?.load[0] ?? -1) - (mb?.load[0] ?? -1)
        break
      case "speed": {
        const sa = ma ? ma.net_rx + ma.net_tx : -1
        const sb = mb ? mb.net_rx + mb.net_tx : -1
        res = sa - sb
        break
      }
      case "cpu":
        res = (ma?.cpu ?? -1) - (mb?.cpu ?? -1)
        break
      case "mem": {
        const pa = ma ? ma.mem_used / Math.max(1, ma.mem_total) : -1
        const pb = mb ? mb.mem_used / Math.max(1, mb.mem_total) : -1
        res = pa - pb
        break
      }
      case "disk": {
        const pa = ma ? ma.disk_used / Math.max(1, ma.disk_total) : -1
        const pb = mb ? mb.disk_used / Math.max(1, mb.disk_total) : -1
        res = pa - pb
        break
      }
      case "price":
        res = a.price - b.price
        break
    }

    return order === "desc" ? -res : res
  })
}

// Accordion: the open row is owned by ServerTable, not by each row,
// so opening one node always closes the previously opened one.
function Row({ node, badge, open, onToggle }: { node: Node; badge?: "busy" | "fast" | "both" | null; open: boolean; onToggle: () => void }) {
  const m = node.online ? node.metrics : null
  const toggle = onToggle

  return (
    <>
      <TableRow
        aria-expanded={open}
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}
        className={cn(
          "cursor-pointer transition-colors hover:bg-muted/40",
          open && "border-b-0 bg-muted/25 hover:bg-muted/30",
        )}
      >
        <TableCell className={cn(COL.status, "text-center")}>
          <div className="flex items-center justify-center @max-sm:hidden">
            {badge ? (
              <span className="inline-flex items-center gap-0.5 text-[13px] leading-none">
                {(badge === "busy" || badge === "both") && (
                  <span title="最忙节点" className={cn(m && m.cpu > 15 && "animate-pulse")}>🔥</span>
                )}
                {(badge === "fast" || badge === "both") && (
                  <span title="最快节点" className={cn(m && m.net_rx > 1.5 * 1024 * 1024 && "animate-pulse")}>⚡</span>
                )}
              </span>
            ) : (
              <Dot node={node} />
            )}
          </div>
          {/* Phones: the flag stands in for the dot — full colour online with a
              tiny green dot beside it, dimmed offline. A busy/fastest mark
              replaces it, side by side when one node is both. */}
          <div className="hidden items-center justify-center @max-sm:flex">
            {badge ? (
              <span
                className={cn(
                  "relative inline-flex leading-none",
                  badge === "both" ? "flex-row items-center gap-0.5 text-[10px] scale-50" : "items-center text-[13px]",
                )}
              >
                {(badge === "busy" || badge === "both") && (
                  <span title="最忙节点" className={cn(m && m.cpu > 15 && "animate-pulse")}>🔥</span>
                )}
                {(badge === "fast" || badge === "both") && (
                  <span title="最快节点" className={cn(m && m.net_rx > 1.5 * 1024 * 1024 && "animate-pulse")}>⚡</span>
                )}
              </span>
            ) : (
              <span className={cn("size-2 rounded-full", node.online ? "bg-green-500" : "bg-muted-foreground/40")} />
            )}
          </div>
        </TableCell>
        <TableCell className={cn(COL.name, "text-left font-medium")} title={node.name}>
          <div className="flex items-center gap-1.5 min-w-0">
            <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200 @max-sm:hidden", open && "rotate-90 text-foreground")} />
            <span className="hidden shrink-0 @max-sm:inline-flex">
              <Flag code={node.country} showCode={false} className="[&_img]:h-3 [&_img]:w-3 [&_img]:rounded-full" />
            </span>
            <span
              className={cn("truncate text-muted-foreground", badge === "busy" || badge === "both" ? "shine-busy" : badge === "fast" ? "shine-fast" : undefined)}
              title={node.name}
            >
              {node.name}
            </span>
          </div>
        </TableCell>
        <TableCell className={cn(COL.location, "text-muted-foreground")}><Flag code={node.country} /></TableCell>
        <TableCell className={cn(COL.os, "text-muted-foreground")}>
          <span className="inline-flex items-center justify-center gap-1.5">
            <OsIcon os={node.os} />
            <span className="truncate">{distro(node.os) || "—"}</span>
          </span>
        </TableCell>
        <TableCell className={cn(COL.uptime, "tnum text-muted-foreground")}>{m ? duration(m.uptime) : "—"}</TableCell>
        <TableCell className={cn(COL.load, "tnum text-muted-foreground")}>{m ? m.load[0].toFixed(2) : "—"}</TableCell>
        <TableCell className={COL.speed}>
          {m ? (
            <div className="inline-flex items-center justify-center gap-1 whitespace-nowrap text-xs @max-3xl:text-[9px] @max-3xl:leading-none @max-sm:text-[11px] @max-sm:gap-0.5 text-muted-foreground">
              <Num ch={SLOT.compact} className="@max-3xl:min-w-0">{compact(m.net_tx)}</Num>
              <span className="text-muted-foreground/60">|</span>
              <Num ch={SLOT.compact} className="@max-3xl:min-w-0 text-left">{compact(m.net_rx)}</Num>
            </div>
          ) : (
            <span className="text-muted-foreground text-xs @max-3xl:text-[9px] @max-sm:text-[11px]">— | —</span>
          )}
        </TableCell>
        <TableCell className={COL.bar}><Bar pct={m ? m.cpu : null} /></TableCell>
        <TableCell className={COL.bar}><Bar pct={m ? percent(m.mem_used, m.mem_total) : null} /></TableCell>
        <TableCell className={COL.bar}><Bar pct={m ? percent(m.disk_used, m.disk_total) : null} /></TableCell>
        <TableCell className={cn(COL.price, "tnum text-muted-foreground")}>
          {node.price > 0 ? `${money(node.price, node.currency)} / ${CYCLES[node.billing_cycle] ?? node.billing_cycle}` : "Free"}
        </TableCell>
        <TableCell className={cn(COL.expiry, "tnum text-muted-foreground")}><Expiry node={node} /></TableCell>
      </TableRow>
      {open && (
        <TableRow className="border-b bg-muted/25 hover:bg-muted/25">
          <TableCell colSpan={12} className="p-0! text-left whitespace-normal">
            <RowDetails node={node} />
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

function SortableHead({
  col,
  label,
  field,
  sortField,
  sortOrder,
  onSort,
}: {
  col: keyof typeof COL
  label: ReactNode
  field?: SortField
  sortField: SortField | null
  sortOrder: SortOrder
  onSort: (field: SortField) => void
}) {
  const isSorted = field && sortField === field
  return (
    <TableHead
      className={cn(
        "group h-9 px-2 text-center text-xs font-medium text-muted-foreground transition-colors @max-3xl:px-0.5 @max-3xl:text-[10px] @max-sm:text-[11px]",
        COL[col],
        col === "name" && "text-left",
        field && "cursor-pointer select-none hover:text-foreground",
      )}
      onClick={field ? () => onSort(field) : undefined}
    >
      <div className={cn("inline-flex items-center gap-1 @max-3xl:gap-0.5", col === "name" && "justify-start pl-5 @max-3xl:pl-2")}>
        <span>{label}</span>
        {field && (
          <span className="shrink-0 text-muted-foreground/70">
            {isSorted ? (
              sortOrder === "asc" ? <ArrowUp className="size-3 text-primary" /> : <ArrowDown className="size-3 text-primary" />
            ) : (
              <ArrowUpDown className="size-2.5 opacity-0 transition-opacity group-hover:opacity-100 @max-3xl:hidden" />
            )}
          </span>
        )}
      </div>
    </TableHead>
  )
}

export function ServerTable({ nodes }: { nodes: Node[] }) {
  const [openId, setOpenId] = useState<number | null>(null)
  const [sortField, setSortField] = useState<SortField | null>(null)
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc")

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      if (sortOrder === "desc") {
        setSortOrder("asc")
      } else {
        setSortField(null)
        setSortOrder("desc")
      }
    } else {
      setSortField(field)
      setSortOrder("desc")
    }
  }

  const [selectedGroup, setSelectedGroup] = useState<string | null>(null)

  const groups = useMemo(() => {
    return [...new Set(nodes.map((n) => n.group ?? "").filter(Boolean))]
  }, [nodes])

  const hasUngrouped = useMemo(() => {
    return groups.length > 0 && nodes.some((n) => !(n.group ?? ""))
  }, [groups, nodes])

  const groupNodes = useMemo(() => {
    if (selectedGroup === null) return nodes
    if (selectedGroup === "") return nodes.filter((n) => !(n.group ?? ""))
    return nodes.filter((n) => n.group === selectedGroup)
  }, [nodes, selectedGroup])

  const sortedNodes = useMemo(() => sortNodes(groupNodes, sortField, sortOrder), [groupNodes, sortField, sortOrder])

  // The stat bar's busiest/fastest designations, mirrored onto the rows
  // (the Prism rule): that node's status dot becomes 🔥 / ⚡ instead.
  const { busiestId, fastestId } = useMemo(() => {
    let busy: { id: number; cpu: number } | null = null
    let fast: { id: number; rx: number } | null = null
    for (const node of groupNodes) {
      if (!node.online || !node.metrics) continue
      if (!busy || node.metrics.cpu > busy.cpu) busy = { id: node.id, cpu: node.metrics.cpu }
      if (!fast || node.metrics.net_rx > fast.rx) fast = { id: node.id, rx: node.metrics.net_rx }
    }
    return { busiestId: busy?.id ?? null, fastestId: fast?.id ?? null }
  }, [groupNodes])

  const heads: [keyof typeof COL, ReactNode, SortField?][] = [
    ["status", "状态"],
    ["name", "名称", "name"],
    ["location", "位置"],
    ["os", "系统"],
    ["uptime", "在线", "uptime"],
    ["load", "负载", "load"],
    ["speed", <>网速 ↑|↓</>, "speed"],
    ["bar", "CPU", "cpu"],
    ["bar", "内存", "mem"],
    ["bar", "硬盘", "disk"],
    ["price", "续费", "price"],
    ["expiry", "到期"],
  ]

  return (
    <Card className="@container gap-0 overflow-hidden py-0">
      {/* Header: the transplanted stat bar alone, sized to the card. */}
      <CardHeader className="border-b border-border/60 px-3 py-2.5 max-md:px-1 xl:hidden">
        <StatBar nodes={groupNodes} className="w-full" />
      </CardHeader>

      {/* Group selector pill bar (renders only when node groups exist) */}
      {groups.length > 0 && (
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/20 px-3 py-1.5">
          <div className="flex items-center gap-1 overflow-x-auto text-[11px] scrollbar-none">
          <button
            type="button"
            onClick={() => setSelectedGroup(null)}
            className={cn(
              "shrink-0 rounded-md px-2 py-0 text-[11px] leading-5 transition-colors cursor-pointer h-5 inline-flex items-center",
              selectedGroup === null
                ? "bg-primary text-primary-foreground font-medium"
                : "bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            全部 ({nodes.length})
          </button>
          {groups.map((g) => {
            const count = nodes.filter((n) => n.group === g).length
            return (
              <button
                key={g}
                type="button"
                onClick={() => setSelectedGroup(g)}
                className={cn(
                  "shrink-0 rounded-md px-2 py-0 text-[11px] leading-5 transition-colors cursor-pointer h-5 inline-flex items-center",
                  selectedGroup === g
                    ? "bg-primary text-primary-foreground font-medium"
                    : "bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {g} ({count})
              </button>
            )
          })}
          {hasUngrouped && (
            <button
              type="button"
              onClick={() => setSelectedGroup("")}
              className={cn(
                "shrink-0 rounded-md px-2 py-0 text-[11px] leading-5 transition-colors cursor-pointer h-5 inline-flex items-center",
                selectedGroup === ""
                  ? "bg-primary text-primary-foreground font-medium"
                  : "bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              未分组 ({nodes.filter((n) => !(n.group ?? "")).length})
            </button>
          )}
          </div>
          {/* Wide screens: the one-line stat bar fills the group bar's right side. */}
          <StatBar nodes={groupNodes} variant="line" className="ml-auto max-xl:hidden" />
        </div>
      )}

      <CardContent className="p-0">
        <Table className="text-center text-sm table-fixed @max-3xl:text-[10px] @max-sm:text-xs">
          <TableHeader>
            <TableRow className="hover:bg-transparent bg-muted/20">
              {heads.map(([col, label, field], i) => (
                <SortableHead
                  key={i}
                  col={col}
                  label={label}
                  field={field}
                  sortField={sortField}
                  sortOrder={sortOrder}
                  onSort={handleSort}
                />
              ))}
            </TableRow>
          </TableHeader>
          {/* Mobile rows: 6px padding each side (desktop stays 4px). */}
          <TableBody className="[&_td]:px-2 [&_td]:py-1 @max-3xl:[&_td]:px-0.5 @max-sm:[&_td]:py-[6px]">
            {sortedNodes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={12} className="py-12 text-center text-sm text-muted-foreground">
                  暂无服务器
                </TableCell>
              </TableRow>
            ) : (
              sortedNodes.map((n) => (
                <Row
                  key={n.id}
                  node={n}
                  badge={n.id === busiestId && n.id === fastestId ? "both" : n.id === busiestId ? "busy" : n.id === fastestId ? "fast" : null}
                  open={openId === n.id}
                  onToggle={() => setOpenId((cur) => (cur === n.id ? null : n.id))}
                />
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

/**
 * High-fidelity table skeleton to prevent layout shifts (CLS = 0) during initial load.
 */
export function ServerTableSkeleton() {
  return (
    <Card className="@container gap-0 overflow-hidden py-0">
      <CardHeader className="border-b border-border/60 py-3 sm:flex-row sm:items-center sm:justify-between max-md:px-3 gap-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-24 rounded-md" />
          <Skeleton className="h-5 w-16 rounded-md" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-7 w-28 rounded-md" />
          <Skeleton className="h-7 w-36 rounded-md" />
          <Skeleton className="h-7 w-32 rounded-md" />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-border/30">
          <div className="flex h-9 items-center px-4 bg-muted/20">
            <Skeleton className="h-3 w-full" />
          </div>
          {[...Array(6)].map((_, i) => (
            <div key={i} className="flex h-11 items-center gap-4 px-4">
              <Skeleton className="size-2.5 rounded-full shrink-0" />
              <Skeleton className="h-4 w-32 shrink-0" />
              <Skeleton className="h-4 w-12 shrink-0 @max-sm:hidden" />
              <Skeleton className="h-4 w-20 shrink-0 @max-5xl:hidden" />
              <Skeleton className="h-4 w-16 shrink-0 @max-3xl:hidden" />
              <Skeleton className="h-4 w-16 shrink-0 @max-5xl:hidden" />
              <Skeleton className="h-4 w-12 shrink-0 @max-3xl:hidden" />
              <Skeleton className="h-4 w-24 shrink-0 @max-3xl:w-12" />
              <Skeleton className="h-2 w-16 shrink-0" />
              <Skeleton className="h-2 w-16 shrink-0" />
              <Skeleton className="h-2 w-16 shrink-0" />
              <Skeleton className="h-2 w-24 shrink-0" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
