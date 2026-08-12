"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { demoSnapshot } from "@/lib/demo";
import type { BillingMode, FactorySnapshot, GraphEdge, GraphNode, ReplayBundle, Usage } from "@/lib/types";

const NODE_WIDTH = 178;
const NODE_HEIGHT = 76;
const COLUMN_GAP = 224;
const ROW_GAP = 96;
const GRAPH_X = 30;
const GRAPH_Y = 56;
const DEFAULT_BRIDGE_ENDPOINT = "http://127.0.0.1:4317";
const BRIDGE_SESSION_KEY = "gamefactory.observatory.bridge";
const columnLabels = ["Run", "Extensions", "Creative inputs", "Candidate", "Workspace", "Team", "Agents", "Evaluation", "Decision", "Result"];

type SourceMode = "live" | "replay" | "demo";
type GraphFilter = "extension" | "resource" | "agent" | "evaluator" | "decision";
type LocalNetworkRequestInit = RequestInit & { targetAddressSpace?: "local" };

function normalizeBridgeEndpoint(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:") throw new Error("bridge endpoint must use HTTP");
  if (!["127.0.0.1", "::1", "localhost"].includes(url.hostname)) throw new Error("bridge endpoint must stay on this device");
  return url.origin;
}

function graphFilterGroup(node: GraphNode): GraphFilter | undefined {
  if (node.kind === "extension") return "extension";
  if (node.kind === "resource") return "resource";
  if (node.kind === "agent" || node.kind === "contributor") return "agent";
  if (node.kind === "evaluator") return "evaluator";
  if (node.kind === "decision" || node.kind === "outcome") return "decision";
  return undefined;
}

function tokenTotal(usage?: Usage) {
  if (!usage) return undefined;
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return undefined;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

function formatTokens(value?: number) {
  if (value === undefined) return "unreported";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatMoney(value?: number) {
  return value === undefined ? "unreported" : `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

type BillingInfo = {
  billingMode?: BillingMode;
  billingModes?: BillingMode[];
  costUsd?: number;
  costSource?: "provider-reported" | "estimated";
  pricedInvocations?: number;
  invocations?: number;
};

function billingModes(usage?: BillingInfo) {
  return usage?.billingModes ?? (usage?.billingMode ? [usage.billingMode] : []);
}

function billingValue(usage?: BillingInfo) {
  const modes = billingModes(usage);
  if (modes.length === 1 && modes[0] === "subscription") return "Included in plan";
  if (modes.length === 1 && modes[0] === "credits") return "Credits";
  if (modes.length === 1 && modes[0] === "unknown") return "Not reported";
  if (modes.includes("metered") && usage?.costUsd !== undefined) return formatMoney(usage.costUsd);
  if (usage?.costUsd !== undefined && usage.costSource !== "estimated") return formatMoney(usage.costUsd);
  return "Not reported";
}

function billingDetail(usage: FactorySnapshot["usage"]) {
  const modes = billingModes(usage);
  if (modes.length === 1 && modes[0] === "subscription") return "subscription usage, not API spend";
  if (modes.length === 1 && modes[0] === "credits") return "usage charged against plan credits";
  if (modes.includes("metered")) return `${usage.pricedInvocations} / ${usage.invocations} invocations reported spend`;
  return "adapter did not report billing mode";
}

function formatDuration(value?: number) {
  if (value === undefined) return "—";
  const seconds = Math.max(0, Math.round(value / 1000));
  if (seconds > 59) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function modelLabel(usage?: Usage) {
  if (!usage) return "model unreported";
  const label = [usage.provider, usage.model].filter(Boolean).join(" / ") || "model unreported";
  return usage.identitySource ? `${label} · ${usage.identitySource}` : label;
}

function stateAt(node: GraphNode, cursor: number) {
  if (node.enteredSequence > cursor) return "waiting";
  if (node.completedSequence === undefined || node.completedSequence > cursor) return "running";
  return node.finalState;
}

function isSnapshot(value: unknown): value is FactorySnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FactorySnapshot>;
  return Boolean(
    candidate.campaign &&
      typeof candidate.campaign.id === "string" &&
      typeof candidate.runId === "string" &&
      typeof candidate.sequence === "number" &&
      Array.isArray(candidate.graph?.nodes) &&
      Array.isArray(candidate.graph?.edges) &&
      Array.isArray(candidate.experiments),
  );
}

function readBundle(value: unknown): FactorySnapshot | undefined {
  if (isSnapshot(value)) return value;
  if (value && typeof value === "object" && isSnapshot((value as Partial<ReplayBundle>).snapshot)) {
    return (value as ReplayBundle).snapshot;
  }
  return undefined;
}

function downloadReplay(snapshot: FactorySnapshot) {
  const bundle: ReplayBundle = {
    format: "gamefactory-viewer-bundle",
    version: 1,
    exportedAt: new Date().toISOString(),
    snapshot: { ...snapshot, live: false },
  };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${snapshot.campaign.id}-${snapshot.runId}-replay.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function GraphCanvas({ snapshot, cursor, selectedId, onSelect, filters }: {
  snapshot: FactorySnapshot;
  cursor: number;
  selectedId?: string;
  onSelect: (node: GraphNode) => void;
  filters: Record<GraphFilter, boolean>;
}) {
  const layout = useMemo(() => {
    const orders = [...new Set(snapshot.graph.nodes.map((node) => node.order))].sort((a, b) => a - b);
    const orderIndex = new Map(orders.map((order, index) => [order, index]));
    const positions = new Map<string, { x: number; y: number }>();
    for (const node of snapshot.graph.nodes) {
      positions.set(node.id, {
        x: GRAPH_X + node.column * COLUMN_GAP,
        y: GRAPH_Y + (orderIndex.get(node.order) ?? 0) * ROW_GAP,
      });
    }
    const maxColumn = Math.max(7, ...snapshot.graph.nodes.map((node) => node.column));
    return {
      positions,
      width: GRAPH_X * 2 + maxColumn * COLUMN_GAP + NODE_WIDTH,
      height: Math.max(360, GRAPH_Y * 2 + orders.length * ROW_GAP),
    };
  }, [snapshot]);

  const visibleNodes = snapshot.graph.nodes.filter((node) => {
    const group = graphFilterGroup(node);
    return node.enteredSequence <= cursor && (!group || filters[group]);
  });
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = snapshot.graph.edges.filter(
    (edge) => edge.enteredSequence <= cursor && visibleIds.has(edge.source) && visibleIds.has(edge.target),
  );

  return (
    <div className="graph-scroll">
      <div className="graph-canvas" style={{ width: layout.width, height: layout.height }}>
        {columnLabels.map((label, index) => (
          <span className="lane-label" style={{ left: GRAPH_X + index * COLUMN_GAP }} key={label}>
            {String(index + 1).padStart(2, "0")} / {label}
          </span>
        ))}
        {visibleEdges.map((edge) => <EdgeLine edge={edge} positions={layout.positions} key={edge.id} />)}
        {visibleNodes.map((node) => {
          const position = layout.positions.get(node.id);
          if (!position) return null;
          const state = stateAt(node, cursor);
          return (
            <button
              className={`graph-node node-${node.kind} state-${state}${selectedId === node.id ? " selected" : ""}`}
              style={{ left: position.x, top: position.y }}
              key={node.id}
              onClick={() => onSelect(node)}
              type="button"
            >
              <span className="node-topline"><span>{node.kind}</span><i aria-hidden="true" /></span>
              <strong>{node.label}</strong>
              <small>{node.detail ?? state}</small>
              <span className="node-meta"><span>{state}</span>{node.durationMs !== undefined ? <span>{formatDuration(node.durationMs)}</span> : null}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EdgeLine({ edge, positions }: { edge: GraphEdge; positions: Map<string, { x: number; y: number }> }) {
  const source = positions.get(edge.source);
  const target = positions.get(edge.target);
  if (!source || !target) return null;
  const x1 = source.x + NODE_WIDTH;
  const y1 = source.y + NODE_HEIGHT / 2;
  const x2 = target.x;
  const y2 = target.y + NODE_HEIGHT / 2;
  const distance = Math.hypot(x2 - x1, y2 - y1);
  const angle = Math.atan2(y2 - y1, x2 - x1) * (180 / Math.PI);
  return <div className={`edge-line edge-${edge.kind}`} style={{ left: x1, top: y1, width: distance, transform: `rotate(${angle}deg)` }} title={edge.label} />;
}

function UsageBar({ snapshot }: { snapshot: FactorySnapshot }) {
  const usage = snapshot.usage;
  const models = usage.models.map((item) => item.model).filter((model): model is string => Boolean(model));
  return (
    <section className="usage-bar" aria-label="Run usage">
      <div><span>Invocations</span><strong>{usage.invocations}</strong></div>
      <div><span>Total tokens</span><strong>{formatTokens(usage.tokenInvocations ? usage.totalTokens : undefined)}</strong></div>
      <div><span>Reasoning</span><strong>{formatTokens(usage.tokenInvocations ? usage.reasoningTokens : undefined)}</strong></div>
      <div title={billingDetail(usage)}><span>Billing</span><strong>{billingValue(usage)}</strong></div>
      <div className="models"><span>Models</span><strong>{models.join(" · ") || "unreported"}</strong></div>
    </section>
  );
}

function Inspector({ node, snapshot, cursor }: { node?: GraphNode; snapshot: FactorySnapshot; cursor: number }) {
  if (!node) {
    return <aside className="inspector empty-inspector"><span className="section-kicker">Inspection</span><h2>Select a node</h2><p>Open an extension, creative input, candidate, agent, evaluator, or decision to inspect its exact provenance and downstream work.</p></aside>;
  }
  const experiment = snapshot.experiments.find((item) => item.id === node.experimentId);
  const contribution = experiment?.contributors.find((item) => item.invocationId === node.invocationId || item.agentId === node.label);
  const usage = node.usage ?? contribution?.usage;
  const phases = experiment?.phases.filter((phase) => phase.sequence <= cursor) ?? [];
  const provenance = node.provenance;
  const provenanceKeys = ["provenanceType", "resourceType", "id", "version", "activationReason", "capabilities", "permissions", "path", "sha256", "manifestSha256", "configSha256", "modalities", "references"];
  const provenanceRows = provenanceKeys.flatMap((key) => {
    const value = provenance?.[key];
    if (value === undefined) return [];
    const label = key.replace(/([A-Z])/g, " $1");
    const display = Array.isArray(value)
      ? value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join(" · ")
      : typeof value === "object" ? JSON.stringify(value) : String(value);
    return [{ label, display }];
  });
  return (
    <aside className="inspector">
      <div className="inspector-heading"><span className="section-kicker">{node.kind}</span><span className={`state-pill state-${stateAt(node, cursor)}`}>{stateAt(node, cursor)}</span></div>
      <h2>{node.label}</h2>
      <p>{contribution?.summary ?? node.detail ?? "No summary reported."}</p>
      {provenanceRows.length ? <><span className="section-kicker section-space">Exact provenance</span><dl className="provenance-list">{provenanceRows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd title={row.display}>{row.display}</dd></div>)}</dl></> : (
        <dl className="facts">
          <div><dt>Model</dt><dd>{modelLabel(usage)}</dd></div>
          <div><dt>Tokens</dt><dd>{formatTokens(tokenTotal(usage))}</dd></div>
          <div><dt>Billing</dt><dd>{billingValue(usage)}</dd></div>
          <div><dt>Artifacts</dt><dd>{node.artifacts || contribution?.artifacts || 0}</dd></div>
          {usage?.costUsd !== undefined && usage.costSource === "estimated" ? <div><dt>API equivalent</dt><dd>{formatMoney(usage.costUsd)} · estimate</dd></div> : null}
        </dl>
      )}
      {node.invocationId ? <div className="lineage"><span className="section-kicker">Invocation lineage</span><code>{node.parentInvocationId ?? "factory root"}</code><span className="lineage-arrow">↓</span><code>{node.invocationId}</code></div> : null}
      {experiment ? (
        <>
          <span className="section-kicker section-space">Candidate metrics</span>
          <div className="metric-grid">{Object.entries(experiment.metrics).map(([name, value]) => <div key={name}><span>{name.replaceAll("_", " ")}</span><strong>{value.toLocaleString(undefined, { maximumFractionDigits: 3 })}</strong></div>)}</div>
          <span className="section-kicker section-space">Visible journal</span>
          <ol className="phase-list">{phases.slice(-6).map((phase) => <li key={`${phase.sequence}-${phase.phase}`}><i aria-hidden="true" /><span><strong>{phase.phase}</strong><small>#{phase.sequence} · {phase.note}</small></span></li>)}</ol>
        </>
      ) : null}
    </aside>
  );
}

export default function FactoryConsole() {
  const [snapshot, setSnapshot] = useState<FactorySnapshot>(demoSnapshot);
  const [source, setSource] = useState<SourceMode>("demo");
  const [connection, setConnection] = useState("bridge not paired");
  const [bridgeEndpoint, setBridgeEndpoint] = useState(DEFAULT_BRIDGE_ENDPOINT);
  const [bridgeKey, setBridgeKey] = useState("");
  const [bridgePanel, setBridgePanel] = useState(false);
  const [cursor, setCursor] = useState(demoSnapshot.sequence);
  const [following, setFollowing] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [dropActive, setDropActive] = useState(false);
  const [graphFilters, setGraphFilters] = useState<Record<GraphFilter, boolean>>({ extension: true, resource: true, agent: true, evaluator: true, decision: true });
  const fileInput = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number>();
  const requestRef = useRef<AbortController>();
  const selectedNode = snapshot.graph.nodes.find((node) => node.id === selectedId);
  const visibleEvents = snapshot.events.filter((event) => event.sequence <= cursor).slice(-10);

  function applySnapshot(next: FactorySnapshot, nextSource: SourceMode) {
    setSnapshot(next);
    setSource(nextSource);
    setCursor((current) => (following || current > next.sequence ? next.sequence : current));
    if (nextSource !== "live") stopBridgePolling();
  }

  function stopBridgePolling() {
    if (pollRef.current !== undefined) window.clearTimeout(pollRef.current);
    pollRef.current = undefined;
    requestRef.current?.abort();
    requestRef.current = undefined;
  }

  async function connectLive(runId?: string, pairing?: { endpoint: string; key: string }) {
    const key = (pairing?.key ?? bridgeKey).trim();
    let endpoint: string;
    try {
      endpoint = normalizeBridgeEndpoint(pairing?.endpoint ?? bridgeEndpoint);
    } catch (error) {
      setConnection(error instanceof Error ? error.message : "invalid bridge endpoint");
      setBridgePanel(true);
      return;
    }
    if (!key) {
      setConnection("paste the bridge key to connect");
      setBridgePanel(true);
      return;
    }

    stopBridgePolling();
    setConnection("requesting access to the local bridge");
    const controller = new AbortController();
    requestRef.current = controller;
    let paired = false;

    const poll = async () => {
      const url = new URL("/api/snapshot", endpoint);
      if (runId) url.searchParams.set("run", runId);
      try {
        const init: LocalNetworkRequestInit = {
          cache: "no-store",
          headers: { Authorization: `Bearer ${key}` },
          signal: controller.signal,
          targetAddressSpace: "local",
        };
        const response = await fetch(url, init);
        if (response.status === 401) throw new Error("bridge key rejected");
        if (!response.ok) throw new Error(`bridge returned ${response.status}`);
        const value: unknown = await response.json();
        if (!isSnapshot(value)) throw new Error("bridge returned an unreadable trace");
        if (!paired) {
          paired = true;
          setBridgeEndpoint(endpoint);
          setBridgeKey(key);
          setBridgePanel(false);
          window.sessionStorage.setItem(BRIDGE_SESSION_KEY, JSON.stringify({ endpoint, key }));
        }
        applySnapshot(value, "live");
        setConnection(value.live ? "receiving live trace" : "bridge connected · replay ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof TypeError
          ? `no authenticated bridge responded at ${endpoint}`
          : error instanceof Error ? error.message : "local bridge offline or access denied";
        setConnection(message);
        if (!paired) {
          window.sessionStorage.removeItem(BRIDGE_SESSION_KEY);
          requestRef.current = undefined;
          setBridgePanel(true);
          return;
        }
      }
      if (!controller.signal.aborted) pollRef.current = window.setTimeout(() => void poll(), 700);
    };

    await poll();
  }

  function submitBridge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void connectLive(undefined, { endpoint: bridgeEndpoint, key: bridgeKey });
  }

  async function importReplay(file?: File) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { setConnection("replay exceeds the 8 MB viewer limit"); return; }
    try {
      const replay = readBundle(JSON.parse(await file.text()) as unknown);
      if (!replay) throw new Error("invalid replay");
      applySnapshot({ ...replay, live: false }, "replay");
      setFollowing(false);
      setConnection(`loaded ${file.name} locally`);
      setSelectedId(undefined);
    } catch { setConnection("that file is not a GameFactory replay"); }
  }

  useEffect(() => {
    let startTimer: number | undefined;
    const saved = window.sessionStorage.getItem(BRIDGE_SESSION_KEY);
    if (saved) {
      try {
        const pairing = JSON.parse(saved) as { endpoint?: unknown; key?: unknown };
        if (typeof pairing.endpoint === "string" && typeof pairing.key === "string") {
          startTimer = window.setTimeout(() => void connectLive(undefined, { endpoint: pairing.endpoint as string, key: pairing.key as string }), 0);
        }
      } catch {
        window.sessionStorage.removeItem(BRIDGE_SESSION_KEY);
      }
    }
    return () => {
      if (startTimer !== undefined) window.clearTimeout(startTimer);
      stopBridgePolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setCursor((value) => {
      if (value >= snapshot.sequence) { setPlaying(false); return snapshot.sequence; }
      return value + 1;
    }), 55);
    return () => window.clearInterval(timer);
  }, [playing, snapshot.sequence]);

  function selectDemo() {
    applySnapshot(demoSnapshot, "demo");
    setFollowing(false);
    setConnection("showing the built-in example replay");
    setSelectedId(undefined);
  }

  function forgetBridge() {
    stopBridgePolling();
    window.sessionStorage.removeItem(BRIDGE_SESSION_KEY);
    setBridgeKey("");
    setBridgePanel(false);
    selectDemo();
  }

  return (
    <main className="site-shell">
      <header className="masthead">
        <a className="brand" href="#top" aria-label="GameFactory observatory home"><span className="brand-mark"><i /><i /><i /></span><span><strong>GameFactory</strong><small>Observatory</small></span></a>
        <div className="source-switcher" aria-label="Data source">
          <button className={source === "live" ? "active" : ""} onClick={() => bridgeKey ? void connectLive() : setBridgePanel(true)} type="button">Live bridge</button>
          <button className={source === "demo" ? "active" : ""} onClick={selectDemo} type="button">Example replay</button>
          <button className={source === "replay" ? "active" : ""} onClick={() => fileInput.current?.click()} type="button">Open replay</button>
        </div>
        <div className={`connection connection-${source}`}><i aria-hidden="true" /><span>{connection}</span></div>
      </header>

      {bridgePanel ? (
        <section className="bridge-panel" aria-label="Connect local GameFactory bridge">
          <div className="bridge-copy"><span className="section-kicker">Private loopback bridge</span><h2>Pair this browser with the factory on your computer.</h2><p>Run <code>gamefactory bridge</code> locally, then paste the endpoint and one-time key it prints. The listener stays on your device and the key disappears when that command stops.</p></div>
          <form onSubmit={submitBridge}>
            <label><span>Endpoint</span><input autoComplete="off" onChange={(event) => setBridgeEndpoint(event.target.value)} spellCheck={false} value={bridgeEndpoint} /></label>
            <label><span>Bridge key</span><input autoComplete="off" onChange={(event) => setBridgeKey(event.target.value)} placeholder="Paste the one-time key" spellCheck={false} type="password" value={bridgeKey} /></label>
            <div className="bridge-actions"><button disabled={!bridgeEndpoint.trim() || !bridgeKey.trim()} type="submit">Connect this device</button><button className="secondary" onClick={() => setBridgePanel(false)} type="button">Cancel</button>{bridgeKey ? <button className="quiet" onClick={forgetBridge} type="button">Forget key</button> : null}</div>
          </form>
        </section>
      ) : null}

      <section className="hero" id="top">
        <div><p className="eyebrow">{snapshot.live ? "Live orchestration trace" : source === "demo" ? "Interactive example trace" : "Recorded orchestration trace"}</p><h1>{snapshot.campaign.id}</h1><p className="objective">{snapshot.campaign.objective}</p></div>
        <div className="run-ident"><span>workflow / {snapshot.campaign.workflow}</span><span>run / {snapshot.runId}</span><span>sequence / {cursor} of {snapshot.sequence}</span>{source === "demo" ? <span>telemetry / example · models intentionally unreported</span> : null}</div>
      </section>

      <section className="stat-grid" aria-label="Run summary">
        <div><strong>{snapshot.counters.experiments}</strong><span>Candidates explored</span></div><div><strong>{snapshot.counters.active}</strong><span>Active now</span></div><div><strong>{snapshot.counters.kept}</strong><span>Changes kept</span></div><div><strong>{snapshot.counters.discarded}</strong><span>Safely discarded</span></div><div><strong>{formatDuration(snapshot.durationMs)}</strong><span>Wall time</span></div>
      </section>
      <UsageBar snapshot={snapshot} />

      <section className="workspace-grid">
        <div className="graph-panel">
          <div className="panel-heading"><div><span className="section-kicker">Factory graph</span><h2>Who did what, with which capabilities and creative inputs</h2></div><div className="graph-filters">{([['extension','Extensions'],['resource','Creative inputs'],['agent','Agents'],['evaluator','Evaluators'],['decision','Decisions']] as Array<[GraphFilter,string]>).map(([key,label]) => <button className={graphFilters[key] ? "active" : ""} key={key} onClick={() => setGraphFilters((current) => ({ ...current, [key]: !current[key] }))} type="button">{label}</button>)}</div></div>
          <div className="replay-controls"><button onClick={() => { setPlaying((value) => !value); setFollowing(false); }} type="button">{playing ? "Pause" : "Replay"}</button><button className={following ? "active" : ""} onClick={() => { setFollowing(true); setPlaying(false); setCursor(snapshot.sequence); }} type="button">Follow latest</button><input aria-label="Replay position" min={0} max={snapshot.sequence} value={cursor} onChange={(event) => { setCursor(Number(event.target.value)); setFollowing(false); setPlaying(false); }} type="range" /><output>#{cursor}</output></div>
          <GraphCanvas snapshot={snapshot} cursor={cursor} selectedId={selectedId} onSelect={(node) => setSelectedId(node.id)} filters={graphFilters} />
        </div>
        <Inspector node={selectedNode} snapshot={snapshot} cursor={cursor} />
      </section>

      <section className="lower-grid">
        <div className="ledger panel-block">
          <div className="panel-heading compact"><div><span className="section-kicker">Event ledger</span><h2>Latest visible transitions</h2></div><span>{visibleEvents.length} shown</span></div>
          <div className="ledger-table">{visibleEvents.map((event) => <button key={`${event.sequence}-${event.experimentId}-${event.phase}`} onClick={() => { const node = event.nodeId ? snapshot.graph.nodes.find((item) => item.id === event.nodeId) : snapshot.graph.nodes.find((item) => item.experimentId === event.experimentId); if (node) setSelectedId(node.id); }} type="button"><span>#{event.sequence}</span><strong>{event.phase}</strong><code>{event.experimentId}</code><small>{event.note}</small></button>)}</div>
        </div>
        <div className={`replay-drop panel-block${dropActive ? " drop-active" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDropActive(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDropActive(false)} onDrop={(event) => { event.preventDefault(); setDropActive(false); void importReplay(event.dataTransfer.files[0]); }}>
          <span className="section-kicker">Portable replay</span><h2>Take the factory trace with you.</h2><p>Replay files are parsed in your browser. Nothing is uploaded, and opening one never touches the running factory.</p>
          <div className="drop-actions"><button onClick={() => fileInput.current?.click()} type="button">Choose replay</button><button className="secondary" onClick={() => downloadReplay(snapshot)} type="button">Download this run</button></div>
          <input ref={fileInput} hidden accept="application/json,.json" onChange={(event) => void importReplay(event.target.files?.[0])} type="file" />
        </div>
      </section>
      <footer><span>Execution stays beside Godot, Git, and your files.</span><span>The observatory receives only the trace and explicitly preserved artifacts.</span></footer>
    </main>
  );
}
