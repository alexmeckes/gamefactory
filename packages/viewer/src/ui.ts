export const FACTORY_VIEWER_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GameFactory Flight Recorder</title>
  <style>
    :root {
      color-scheme: dark;
      --ink: #f4f1e8;
      --muted: #9ca3a6;
      --dim: #676f72;
      --panel: rgba(18, 22, 24, .82);
      --panel-solid: #15191b;
      --line: rgba(244, 241, 232, .11);
      --amber: #f4b860;
      --mint: #72d6aa;
      --blue: #77a8ff;
      --red: #ff786f;
      --violet: #bd91ff;
      --bg: #0b0e0f;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { background-image: radial-gradient(circle at 72% -20%, rgba(244,184,96,.11), transparent 35%), radial-gradient(circle at -10% 70%, rgba(119,168,255,.08), transparent 32%), linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px); background-size: auto, auto, 28px 28px, 28px 28px; }
    button, select, input { font: inherit; }
    button, select { color: var(--ink); background: #1c2224; border: 1px solid var(--line); border-radius: 8px; }
    button { cursor: pointer; padding: 8px 12px; }
    button:hover { border-color: rgba(244,184,96,.55); }
    .shell { display: grid; grid-template-columns: 242px minmax(0,1fr); min-height: 100vh; }
    .sidebar { position: sticky; top: 0; height: 100vh; padding: 26px 18px; border-right: 1px solid var(--line); background: rgba(9,12,13,.9); backdrop-filter: blur(18px); display: flex; flex-direction: column; gap: 28px; z-index: 4; }
    .brand { display: flex; gap: 12px; align-items: center; }
    .mark { width: 36px; height: 36px; border: 1px solid rgba(244,184,96,.45); background: linear-gradient(145deg, rgba(244,184,96,.25), rgba(244,184,96,.02)); border-radius: 10px; display: grid; place-items: center; box-shadow: inset 0 0 16px rgba(244,184,96,.08); }
    .mark::before { content: ""; width: 14px; height: 14px; border: 2px solid var(--amber); transform: rotate(45deg); }
    .brand strong { display: block; letter-spacing: .02em; }
    .brand span, .eyebrow { color: var(--amber); font: 600 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .15em; }
    .nav-label { color: var(--dim); font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .14em; margin-bottom: 10px; }
    .run-select { width: 100%; padding: 10px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .run-state { margin-top: 10px; display: flex; gap: 8px; align-items: center; color: var(--muted); font-size: 12px; }
    .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); box-shadow: 0 0 0 0 rgba(114,214,170,.4); }
    .pulse.live { background: var(--mint); animation: pulse 2s infinite; }
    @keyframes pulse { 70% { box-shadow: 0 0 0 7px rgba(114,214,170,0); } }
    .legend { display: grid; gap: 8px; }
    .legend-row { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 11px; }
    .legend-dot { width: 7px; height: 7px; border-radius: 50%; }
    .sidebar-foot { margin-top: auto; color: var(--dim); font: 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .main { min-width: 0; padding: 34px clamp(20px,4vw,58px) 54px; }
    .top { display: grid; grid-template-columns: 1fr auto; gap: 24px; align-items: start; }
    h1 { font-size: clamp(28px,4vw,48px); letter-spacing: -.045em; line-height: 1.02; margin: 7px 0 10px; max-width: 850px; }
    .objective { color: var(--muted); font-size: 14px; line-height: 1.55; max-width: 820px; margin: 0; }
    .run-code { max-width: 310px; text-align: right; color: var(--muted); font: 11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .stats { display: grid; grid-template-columns: repeat(5,minmax(100px,1fr)); gap: 10px; margin: 28px 0 12px; }
    .stat, .panel { background: var(--panel); border: 1px solid var(--line); box-shadow: 0 14px 45px rgba(0,0,0,.2); }
    .stat { border-radius: 10px; padding: 14px 15px; min-height: 78px; }
    .stat .label { color: var(--dim); font: 600 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .13em; }
    .stat .value { margin-top: 9px; font-size: 23px; font-weight: 650; letter-spacing: -.03em; }
    .stat .sub { margin-top: 3px; color: var(--muted); font-size: 10px; }
    .usage-strip { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 10px; margin: 0 0 14px; }
    .usage-card { min-width: 0; padding: 11px 14px; border: 1px solid rgba(189,145,255,.18); border-radius: 10px; background: rgba(28,25,34,.68); }
    .usage-label { color: var(--violet); font: 600 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .12em; }
    .usage-value { margin-top: 7px; overflow: hidden; color: var(--ink); font: 650 15px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
    .usage-sub { margin-top: 4px; overflow: hidden; color: var(--dim); font: 9px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
    .panel { border-radius: 12px; overflow: hidden; }
    .panel-head { min-height: 52px; padding: 14px 17px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 14px; }
    .panel-title { display: flex; gap: 10px; align-items: center; font-size: 13px; font-weight: 650; }
    .panel-index { color: var(--amber); font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .panel-note { color: var(--dim); font-size: 11px; }
    .replay { margin: 14px 0; }
    .replay-body { display: grid; grid-template-columns: auto auto 1fr auto; gap: 10px; padding: 13px 16px; align-items: center; }
    .replay button.active { color: #07110c; background: var(--mint); border-color: var(--mint); }
    .range { accent-color: var(--amber); width: 100%; }
    .cursor-label { min-width: 158px; text-align: right; color: var(--muted); font: 10px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .grid { display: grid; grid-template-columns: minmax(0,1.65fr) minmax(320px,.8fr); gap: 14px; align-items: start; }
    .stack { display: grid; gap: 14px; min-width: 0; }
    .timeline { padding: 10px 0 14px; overflow-x: auto; }
    .view-toolbar { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
    .view-toolbar button { padding: 6px 9px; color: var(--muted); font: 600 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .08em; }
    .view-toolbar button.active { color: #17110a; background: var(--amber); border-color: var(--amber); }
    .view-toolbar .toolbar-separator { width: 1px; height: 20px; background: var(--line); margin: 0 2px; }
    .graph-wrap { min-height: 490px; overflow: auto; padding: 0; background: radial-gradient(circle at 14% 50%, rgba(119,168,255,.045), transparent 30%); }
    .graph-panel { margin-bottom: 14px; }
    .graph-canvas { position: relative; min-height: 490px; min-width: 780px; }
    .graph-edges, .graph-clusters { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
    .graph-edge { fill: none; stroke: rgba(151,164,170,.27); stroke-width: 1.35; }
    .graph-edge.fan-out { stroke: rgba(119,168,255,.38); }
    .graph-edge.evidence { stroke: rgba(189,145,255,.38); stroke-dasharray: 4 4; }
    .graph-edge.decision { stroke: rgba(244,184,96,.46); }
    .graph-edge.active { stroke: var(--amber); stroke-width: 2; stroke-dasharray: 7 5; animation: dash 1.2s linear infinite; }
    @keyframes dash { to { stroke-dashoffset: -24; } }
    .graph-cluster { position: absolute; border: 1px solid rgba(244,241,232,.07); border-radius: 12px; background: rgba(255,255,255,.012); }
    .graph-cluster-label { position: absolute; top: 8px; left: 10px; color: var(--dim); font: 8px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .08em; }
    .graph-node { position: absolute; width: 160px; min-height: 68px; padding: 10px 11px; border: 1px solid rgba(244,241,232,.14); border-radius: 9px; background: #161b1d; color: var(--ink); text-align: left; box-shadow: 0 8px 24px rgba(0,0,0,.24); cursor: pointer; transition: opacity .15s, border-color .15s, transform .15s; z-index: 2; }
    .graph-node:hover, .graph-node.selected { transform: translateY(-2px); border-color: rgba(244,184,96,.65); }
    .graph-node.running { border-color: rgba(119,168,255,.7); box-shadow: 0 0 0 1px rgba(119,168,255,.12), 0 8px 24px rgba(0,0,0,.24); }
    .graph-node.keep, .graph-node.pass, .graph-node.complete { border-color: rgba(114,214,170,.38); }
    .graph-node.discard, .graph-node.baseline { border-color: rgba(244,184,96,.32); }
    .graph-node.blocked, .graph-node.fail, .graph-node.crash, .graph-node.cancelled { border-color: rgba(255,120,111,.55); }
    .graph-node.dimmed { opacity: .16; }
    .graph-node.candidate { width: 176px; min-height: 74px; background: linear-gradient(145deg,rgba(244,184,96,.075),#161b1d 56%); }
    .graph-node.campaign { width: 148px; border-color: rgba(244,184,96,.45); background: linear-gradient(145deg,rgba(244,184,96,.13),#161b1d); }
    .graph-node.contributor { border-color: rgba(189,145,255,.3); }
    .graph-node.evaluator { border-color: rgba(119,168,255,.32); }
    .graph-node.decision { border-radius: 18px 5px 18px 5px; border-color: rgba(244,184,96,.48); }
    .node-kind { color: var(--dim); font: 600 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .11em; }
    .node-label { margin-top: 7px; font: 650 10px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .node-foot { display: flex; justify-content: space-between; gap: 6px; margin-top: 8px; color: var(--muted); font: 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .node-expand { color: var(--amber); }
    .graph-empty { padding: 30px; color: var(--dim); }
    .hidden { display: none !important; }
    .track-row { min-width: 650px; display: grid; grid-template-columns: 172px minmax(360px,1fr) 86px; gap: 14px; align-items: center; min-height: 42px; padding: 5px 17px; cursor: pointer; }
    .track-row:hover, .track-row.selected { background: rgba(244,184,96,.055); }
    .track-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .track { height: 18px; position: relative; }
    .track::before { content: ""; position: absolute; left: 0; right: 0; top: 8px; height: 1px; background: var(--line); }
    .track-span { position: absolute; top: 6px; height: 5px; min-width: 4px; border-radius: 6px; background: linear-gradient(90deg,var(--blue),var(--violet)); opacity: .55; }
    .track-dot { position: absolute; top: 4px; width: 9px; height: 9px; margin-left: -4px; border-radius: 50%; border: 2px solid var(--panel-solid); background: var(--blue); }
    .track-dot.decision { background: var(--amber); }
    .track-dot.done { background: var(--mint); }
    .track-dot.blocked { background: var(--red); }
    .track-status { text-align: right; }
    .badge { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 999px; padding: 4px 7px; color: var(--muted); font: 600 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .07em; }
    .badge.keep, .badge.pass, .badge.complete { color: var(--mint); border-color: rgba(114,214,170,.35); background: rgba(114,214,170,.06); }
    .badge.discard, .badge.inconclusive { color: var(--amber); border-color: rgba(244,184,96,.3); }
    .badge.blocked, .badge.crash, .badge.fail, .badge.cancelled, .badge.interrupted { color: var(--red); border-color: rgba(255,120,111,.34); }
    .badge.in-progress, .badge.live { color: var(--blue); border-color: rgba(119,168,255,.35); }
    .metric-list { padding: 10px 17px 17px; display: grid; gap: 11px; }
    .metric-row { display: grid; grid-template-columns: 180px 1fr 74px; gap: 12px; align-items: center; }
    .metric-name { font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .metric-bar { height: 7px; background: rgba(255,255,255,.05); border-radius: 8px; overflow: hidden; }
    .metric-fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg,var(--amber),#f7d69d); }
    .metric-value { text-align: right; color: var(--muted); font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .cards { padding: 14px; display: grid; grid-template-columns: repeat(auto-fill,minmax(220px,1fr)); gap: 9px; max-height: 470px; overflow: auto; }
    .experiment-card { text-align: left; border-radius: 9px; padding: 13px; min-height: 112px; background: rgba(255,255,255,.025); border: 1px solid var(--line); cursor: pointer; }
    .experiment-card:hover, .experiment-card.selected { transform: translateY(-1px); border-color: rgba(244,184,96,.45); background: rgba(244,184,96,.04); }
    .card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .card-id { font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-summary { min-height: 32px; margin-top: 12px; color: var(--muted); font-size: 11px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .card-foot { margin-top: 12px; display: flex; justify-content: space-between; color: var(--dim); font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .details { position: sticky; top: 14px; max-height: calc(100vh - 28px); display: flex; flex-direction: column; }
    .detail-body { padding: 17px; overflow: auto; }
    .detail-title { margin: 0 0 4px; font: 650 15px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .detail-summary { margin: 12px 0 18px; color: var(--muted); font-size: 12px; line-height: 1.55; }
    .section-label { margin: 19px 0 9px; color: var(--dim); font: 600 9px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .14em; }
    .phase-list { position: relative; display: grid; gap: 0; }
    .phase-row { position: relative; display: grid; grid-template-columns: 14px 90px 1fr; gap: 8px; min-height: 42px; color: var(--muted); font-size: 10px; }
    .phase-row::before { content: ""; position: absolute; left: 4px; top: 10px; bottom: -10px; width: 1px; background: var(--line); }
    .phase-row:last-child::before { display: none; }
    .phase-node { width: 9px; height: 9px; border: 2px solid var(--panel-solid); background: var(--blue); border-radius: 50%; margin-top: 4px; z-index: 1; }
    .phase-row.future { opacity: .25; }
    .phase-name { color: var(--ink); font: 9px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }
    .phase-note { line-height: 1.5; }
    .eval { border: 1px solid var(--line); border-radius: 8px; padding: 10px; margin-bottom: 7px; }
    .eval-top, .artifact, .agent-row { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
    .eval-name, .agent-name { font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .eval p, .agent-row p { color: var(--muted); font-size: 10px; line-height: 1.45; margin: 7px 0 0; }
    .agent-row { align-items: flex-start; padding: 9px 0; border-bottom: 1px solid var(--line); }
    .agent-role { color: var(--violet); font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }
    .artifact { color: var(--muted); text-decoration: none; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 10px; }
    .artifact[href]:hover { color: var(--amber); }
    .artifact-kind { flex: 0 0 auto; color: var(--dim); font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }
    .artifact-preview { width: 100%; max-height: 200px; object-fit: contain; border: 1px solid var(--line); border-radius: 8px; background: #07090a; margin: 3px 0 9px; }
    .feed { padding: 6px 17px 14px; }
    .feed-row { display: grid; grid-template-columns: 40px 126px 94px 1fr; gap: 8px; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,.055); color: var(--muted); font: 9px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .feed-seq { color: var(--dim); }.feed-phase { color: var(--blue); }.feed-exp { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty { padding: 28px 17px; color: var(--dim); font-size: 12px; line-height: 1.55; }
    .error-bar { display: none; position: fixed; left: 260px; right: 18px; bottom: 18px; padding: 11px 14px; border: 1px solid rgba(255,120,111,.45); background: #281515; border-radius: 8px; color: #ffc0bb; font-size: 12px; z-index: 10; }
    @media (max-width: 980px) { .shell { grid-template-columns: 1fr; }.sidebar { position: relative; width: auto; height: auto; border-right: 0; border-bottom: 1px solid var(--line); display: grid; grid-template-columns: 1fr 1fr; }.legend,.sidebar-foot { display:none; }.grid { grid-template-columns: 1fr; }.details { position: relative; top: 0; max-height: none; }.stats { grid-template-columns: repeat(3,1fr); }.usage-strip { grid-template-columns: repeat(2,1fr); }.error-bar { left:18px; } }
    @media (max-width: 640px) { .main { padding: 24px 14px 40px; }.top { grid-template-columns: 1fr; }.run-code { text-align:left; }.stats { grid-template-columns: repeat(2,1fr); }.usage-strip { grid-template-columns: 1fr 1fr; }.replay-body { grid-template-columns: auto 1fr; }.range { grid-column: 1/-1; }.cursor-label { text-align:left; }.metric-row { grid-template-columns: 120px 1fr 58px; }.feed-row { grid-template-columns: 34px 82px 1fr; }.feed-row span:last-child { display:none; } }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><div class="mark"></div><div><strong>GameFactory</strong><span>Flight recorder</span></div></div>
      <div><div class="nav-label">Recorded run</div><select id="runSelect" class="run-select"></select><div id="runState" class="run-state"></div></div>
      <div class="legend">
        <div class="nav-label">Phase signals</div>
        <div class="legend-row"><span class="legend-dot" style="background:var(--blue)"></span> Work in progress</div>
        <div class="legend-row"><span class="legend-dot" style="background:var(--amber)"></span> Decision point</div>
        <div class="legend-row"><span class="legend-dot" style="background:var(--mint)"></span> Applied and cleaned</div>
        <div class="legend-row"><span class="legend-dot" style="background:var(--red)"></span> Blocked or crashed</div>
      </div>
      <div class="sidebar-foot">The dashboard reads the durable journal and result ledger directly. Closing it never affects a running factory.</div>
    </aside>
    <main class="main">
      <header class="top"><div><div id="eyebrow" class="eyebrow">Loading trace</div><h1 id="title">Factory run</h1><p id="objective" class="objective"></p></div><div id="runCode" class="run-code"></div></header>
      <section id="stats" class="stats"></section>
      <section id="usage" class="usage-strip" aria-label="Model usage"></section>
      <section class="panel replay"><div class="replay-body"><button id="playButton" type="button">▶ Replay</button><button id="followButton" type="button">Follow live</button><input id="replayRange" class="range" type="range" min="0" max="0" value="0" aria-label="Replay position"><div id="cursorLabel" class="cursor-label">Waiting for trace</div></div></section>
      <section class="panel graph-panel"><div class="panel-head"><div class="panel-title"><span class="panel-index">01</span> Factory graph</div><div class="view-toolbar"><button id="graphViewButton" class="active" type="button">Graph</button><button id="timelineViewButton" type="button">Timeline</button><span class="toolbar-separator"></span><button id="expandButton" type="button">Expand all</button><button id="collapseButton" type="button">Collapse</button><span class="toolbar-separator"></span><button class="graph-filter active" data-filter="agent" type="button">Agents</button><button class="graph-filter active" data-filter="evaluator" type="button">Evals</button><button class="graph-filter active" data-filter="decision" type="button">Decisions</button></div></div><div id="graph" class="graph-wrap"></div><div id="timeline" class="timeline hidden"></div></section>
      <div class="grid">
        <div class="stack">
          <section class="panel"><div class="panel-head"><div class="panel-title"><span class="panel-index">02</span> Primary metric</div><div id="metricNote" class="panel-note"></div></div><div id="metrics" class="metric-list"></div></section>
          <section class="panel"><div class="panel-head"><div class="panel-title"><span class="panel-index">03</span> Candidate field</div><div id="candidateNote" class="panel-note"></div></div><div id="cards" class="cards"></div></section>
          <section class="panel"><div class="panel-head"><div class="panel-title"><span class="panel-index">04</span> Event ledger</div><div class="panel-note">Newest visible event last</div></div><div id="feed" class="feed"></div></section>
        </div>
        <aside class="panel details"><div class="panel-head"><div class="panel-title"><span class="panel-index">05</span> Inspection</div><div id="detailStatus"></div></div><div id="detail" class="detail-body"></div></aside>
      </div>
    </main>
  </div>
  <div id="errorBar" class="error-bar"></div>
  <script>
    (function () {
      "use strict";
      var snapshot = null;
      var cursor = 0;
      var follow = true;
      var playing = false;
      var selectedId = null;
      var selectedNodeId = null;
      var graphMode = "graph";
      var expandedClusters = {};
      var graphFilters = { agent:true, evaluator:true, decision:true };
      var replayTimer = null;
      var stream = null;
      var phaseDecision = { "acceptance-intent": true };
      var phaseDone = { cleaned: true };
      var phaseBlocked = { blocked: true };
      var $ = function (id) { return document.getElementById(id); };
      var esc = function (value) { return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) { return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); };
      var fmtTime = function (value) { if (!value) return "—"; return new Intl.DateTimeFormat([], { hour:"2-digit", minute:"2-digit", second:"2-digit" }).format(new Date(value)); };
      var fmtDuration = function (ms) { var s=Math.max(0,Math.round(ms/1000)); var m=Math.floor(s/60); var h=Math.floor(m/60); return h ? h+"h "+(m%60)+"m" : m ? m+"m "+(s%60)+"s" : s+"s"; };
      var fmtNumber = function (value) { if (value == null) return "—"; var abs=Math.abs(value); return abs>=1000 ? value.toLocaleString(undefined,{maximumFractionDigits:1}) : value.toLocaleString(undefined,{maximumFractionDigits:3}); };
      var fmtTokens = function (value) { if (value == null) return "unreported"; return value>=1000000?(value/1000000).toLocaleString(undefined,{maximumFractionDigits:2})+"M":value>=1000?(value/1000).toLocaleString(undefined,{maximumFractionDigits:1})+"k":String(value); };
      var fmtCost = function (value) { return "$"+Number(value).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:4}); };
      var modelLabel = function (usage) { if(!usage)return "unreported"; return [usage.provider,usage.model].filter(Boolean).join(" / ")||"unreported"; };
      var usageTokenTotal = function (usage) { if(!usage)return null; if(usage.totalTokens!=null)return usage.totalTokens; if(usage.inputTokens==null&&usage.outputTokens==null)return null; return (usage.inputTokens||0)+(usage.outputTokens||0); };
      var billingModes = function (usage) { return usage&&Array.isArray(usage.billingModes)?usage.billingModes:usage&&usage.billingMode?[usage.billingMode]:[]; };
      var billingValue = function (usage) { var modes=billingModes(usage);if(modes.length===1&&modes[0]==="subscription")return "Included in plan";if(modes.length===1&&modes[0]==="credits")return "Credits";if(modes.length===1&&modes[0]==="unknown")return "Not reported";if(modes.includes("metered")&&usage&&usage.costUsd!=null)return fmtCost(usage.costUsd);if(usage&&usage.costUsd!=null&&usage.costSource!=="estimated")return fmtCost(usage.costUsd);return "Not reported"; };
      var billingNote = function (usage) { var modes=billingModes(usage);if(modes.length===1&&modes[0]==="subscription")return "subscription usage, not API spend";if(modes.length===1&&modes[0]==="credits")return "usage charged against plan credits";if(modes.includes("metered"))return (usage.pricedInvocations||0)+" / "+(usage.invocations||1)+" invocations reported spend";return "adapter did not report billing mode"; };
      var statusBadge = function (status) { return '<span class="badge '+esc(status)+'">'+esc(status)+'</span>'; };
      var visibleEvents = function () { return snapshot ? snapshot.events.filter(function(e){return e.sequence<=cursor;}) : []; };
      var visibleExperiment = function (exp) { return exp.phases.some(function(p){return p.sequence<=cursor;}) || (exp.resultSequence!=null && exp.resultSequence<=cursor); };
      var resultVisible = function (exp) { return exp.resultSequence == null ? exp.status !== "in-progress" : exp.resultSequence<=cursor; };
      var currentStatus = function (exp) { return resultVisible(exp) ? exp.status : "in-progress"; };
      var eventAtCursor = function () { var events=visibleEvents(); return events.length ? events[events.length-1] : null; };
      function elapsed() {
        if (!snapshot || !snapshot.startedAt) return 0;
        return Math.max(0,(snapshot.live ? Date.now() : new Date(snapshot.finishedAt || snapshot.generatedAt).getTime())-new Date(snapshot.startedAt).getTime());
      }
      function renderRuns() {
        var select=$("runSelect");
        select.innerHTML=snapshot.runs.map(function(run){return '<option value="'+esc(run.id)+'" '+(run.id===snapshot.runId?'selected':'')+'>'+esc(run.id.replace(snapshot.campaign.id+"-",""))+' · '+run.status+'</option>';}).join("") || '<option>No recorded runs</option>';
        select.disabled=!snapshot.runs.length;
        $("runState").innerHTML='<span class="pulse '+(snapshot.live?'live':'')+'"></span><span>'+(snapshot.live?'Recording now':'Replay ready')+' · '+snapshot.sequence+' events</span>';
      }
      function replayTimestamp() {
        var event=eventAtCursor();
        return event ? '#'+event.sequence+' · '+fmtTime(event.timestamp)+' · '+event.phase : cursor===0 ? 'Before first event' : 'End of trace';
      }
      function renderHeader() {
        $("eyebrow").textContent=snapshot.live ? "Live factory telemetry" : "Recorded factory trace";
        $("title").textContent=snapshot.campaign.id;
        $("objective").textContent=snapshot.campaign.objective;
        $("runCode").innerHTML='workflow / '+esc(snapshot.campaign.workflow)+'<br>run / '+esc(snapshot.runId)+'<br><span id="elapsed">'+fmtDuration(elapsed())+'</span> elapsed';
      }
      function renderStats(experiments) {
        var counts={experiments:experiments.filter(function(e){return currentStatus(e)!=="baseline";}).length,active:0,keep:0,discard:0,blocked:0};
        experiments.forEach(function(exp){var s=currentStatus(exp); if(s==="in-progress")counts.active++; if(s==="keep")counts.keep++; if(s==="discard")counts.discard++; if(s==="blocked"||s==="crash")counts.blocked++;});
        var stats=[
          [counts.experiments,"Candidates","explored"],
          [counts.active,"Active","right now"],
          [counts.keep,"Kept","merged"],
          [counts.discard,"Discarded","cleaned"],
          [counts.blocked,"Needs review","retained / failed"]
        ];
        $("stats").innerHTML=stats.map(function(s){return '<div class="stat"><div class="label">'+s[1]+'</div><div class="value">'+s[0]+'</div><div class="sub">'+s[2]+'</div></div>';}).join("");
      }
      function usageAtCursor() {
        var visible=snapshot.graph.nodes.filter(function(node){return node.usage&&(node.completedSequence==null?node.enteredSequence:node.completedSequence)<=cursor;});
        var leafExperiments={};visible.forEach(function(node){if(node.kind==="contributor"||node.kind==="evaluator")leafExperiments[node.experimentId||""]=true;});
        var selected=visible.filter(function(node){return node.kind==="contributor"||node.kind==="evaluator"||(node.kind==="agent"&&!leafExperiments[node.experimentId||""]);});
        var unique={};selected.forEach(function(node){unique[node.invocationId||node.id]=node;});
        var values=Object.keys(unique).map(function(key){return unique[key];});var models={};var totals={invocations:values.length,tokenInvocations:0,pricedInvocations:0,totalTokens:0,costUsd:0,billingModes:[]};
        values.forEach(function(node){var usage=node.usage||{};var tokens=usageTokenTotal(usage);if(tokens!=null){totals.tokenInvocations++;totals.totalTokens+=tokens;}if(usage.costUsd!=null){totals.pricedInvocations++;totals.costUsd+=usage.costUsd;}if(usage.billingMode&&totals.billingModes.indexOf(usage.billingMode)<0)totals.billingModes.push(usage.billingMode);var key=(usage.provider||"")+"\u0000"+(usage.model||"");var model=models[key]||(models[key]={label:modelLabel(usage),invocations:0,tokens:0,cost:0,tokenInvocations:0,pricedInvocations:0,billingModes:[]});model.invocations++;if(tokens!=null){model.tokenInvocations++;model.tokens+=tokens;}if(usage.costUsd!=null){model.pricedInvocations++;model.cost+=usage.costUsd;}if(usage.billingMode&&model.billingModes.indexOf(usage.billingMode)<0)model.billingModes.push(usage.billingMode);});
        totals.models=Object.keys(models).map(function(key){return models[key];}).sort(function(a,b){return b.cost-a.cost||b.tokens-a.tokens||a.label.localeCompare(b.label);});return totals;
      }
      function renderUsage() {
        var usage=usageAtCursor();var reportedModels=usage.models.filter(function(model){return model.label!=="unreported";});var top=reportedModels[0];var tokenValue=usage.tokenInvocations?fmtTokens(usage.totalTokens):"unreported";
        var cards=[[usage.invocations,"Invocations",usage.invocations?"agents, subagents, and model-backed evaluators":"none recorded"],[top?top.label:"unreported","Models",top?reportedModels.length+" reported configuration"+(reportedModels.length===1?"":"s"):"adapter did not identify a model"],[tokenValue,"Tokens",usage.tokenInvocations+" / "+usage.invocations+" invocations reported"],[billingValue(usage),"Billing",billingNote(usage)]];
        $("usage").innerHTML=cards.map(function(card){return '<div class="usage-card"><div class="usage-label">'+esc(card[1])+'</div><div class="usage-value" title="'+esc(card[0])+'">'+esc(card[0])+'</div><div class="usage-sub">'+esc(card[2])+'</div></div>';}).join("");
      }
      function usageDetails(usage,invocationId,parentInvocationId) {
        if(!usage&&!invocationId&&!parentInvocationId)return "";var rows=[];if(invocationId)rows.push(["Invocation",invocationId]);if(parentInvocationId)rows.push(["Parent",parentInvocationId]);if(usage){if(usage.provider)rows.push(["Provider",usage.provider]);if(usage.model)rows.push(["Model",usage.model+(usage.identitySource?" · "+usage.identitySource:"")]);if(usage.inputTokens!=null)rows.push(["Input tokens",fmtNumber(usage.inputTokens)]);if(usage.cachedInputTokens!=null)rows.push(["Cached input",fmtNumber(usage.cachedInputTokens)]);if(usage.outputTokens!=null)rows.push(["Output tokens",fmtNumber(usage.outputTokens)]);if(usage.reasoningTokens!=null)rows.push(["Reasoning tokens",fmtNumber(usage.reasoningTokens)]);var total=usageTokenTotal(usage);if(total!=null)rows.push(["Total tokens",fmtNumber(total)]);rows.push(["Billing",billingValue(usage)]);if(usage.costUsd!=null&&usage.costSource==="estimated")rows.push(["API equivalent",fmtCost(usage.costUsd)+" · estimate"]);if(usage.pricingVersion)rows.push(["Pricing",usage.pricingVersion]);}return rows.map(function(row){return '<div class="artifact"><span>'+esc(row[0])+'</span><span class="artifact-kind" title="'+esc(row[1])+'">'+esc(row[1])+'</span></div>';}).join("");
      }
      function renderReplay() {
        var range=$("replayRange"); range.max=String(snapshot.sequence); range.value=String(cursor);
        $("cursorLabel").textContent=replayTimestamp();
        $("playButton").textContent=playing?'Ⅱ Pause':'▶ Replay';
        $("playButton").classList.toggle("active",playing);
        $("followButton").classList.toggle("active",follow);
        $("followButton").textContent=follow?(snapshot.live?'Following live':'At latest event'):'Jump to latest';
      }
      function eventPosition(timestamp,start,end) { if(end<=start)return 0; return Math.max(0,Math.min(100,(new Date(timestamp).getTime()-start)/(end-start)*100)); }
      function renderTimeline(experiments) {
        if (!experiments.length) { $("timeline").innerHTML='<div class="empty">No experiment has reached this point in the trace.</div>'; return; }
        var start=new Date(snapshot.startedAt||experiments[0].startedAt).getTime();
        var end=snapshot.live?Date.now():new Date(snapshot.finishedAt||snapshot.generatedAt).getTime();
        var html=experiments.map(function(exp){
          var phases=exp.phases.filter(function(p){return p.sequence<=cursor;});
          var first=phases[0], last=phases[phases.length-1];
          var left=first?eventPosition(first.timestamp,start,end):0, right=last?eventPosition(last.timestamp,start,end):left;
          var dots=phases.map(function(p){var cls=phaseDecision[p.phase]?'decision':phaseDone[p.phase]?'done':phaseBlocked[p.phase]?'blocked':''; return '<span class="track-dot '+cls+'" style="left:'+eventPosition(p.timestamp,start,end)+'%" title="'+esc(p.phase+' · '+p.note)+'"></span>';}).join("");
          return '<div class="track-row '+(selectedId===exp.id?'selected':'')+'" data-exp="'+esc(exp.id)+'"><div class="track-name">'+esc(exp.id)+'</div><div class="track"><span class="track-span" style="left:'+left+'%;width:'+Math.max(0.5,right-left)+'%"></span>'+dots+'</div><div class="track-status">'+statusBadge(currentStatus(exp))+'</div></div>';
        }).join("");
        $("timeline").innerHTML=html;
      }
      function graphNodeState(node) {
        if(cursor<node.enteredSequence)return "waiting";
        if(node.completedSequence!=null&&cursor>=node.completedSequence)return node.finalState;
        return "running";
      }
      function graphFilterGroup(node) {
        if(node.kind==="agent"||node.kind==="contributor")return "agent";
        if(node.kind==="evaluator")return "evaluator";
        if(node.kind==="decision"||node.kind==="outcome")return "decision";
        return null;
      }
      function renderGraph() {
        var root=snapshot.graph.nodes.find(function(node){return node.kind==="campaign";});
        var visibleClusters=snapshot.graph.clusters.filter(function(cluster){return cluster.enteredSequence<=cursor;});
        if(!root){$("graph").innerHTML='<div class="graph-empty">The graph will appear when the run is recorded.</div>';return;}
        var positions={}, clusterBoxes=[], laneTop=30, maxX=400;
        visibleClusters.forEach(function(cluster,lane){
          var isExpanded=Boolean(expandedClusters[cluster.id]);
          var clusterNodes=snapshot.graph.nodes.filter(function(node){return node.clusterId===cluster.id&&node.enteredSequence<=cursor&&(isExpanded||node.kind==="candidate");});
          var byColumn={};
          clusterNodes.forEach(function(node){(byColumn[node.column]||(byColumn[node.column]=[])).push(node);});
          var widest=1;Object.keys(byColumn).forEach(function(key){widest=Math.max(widest,byColumn[key].length);});
          var laneHeight=isExpanded?Math.max(132,widest*82+46):106;
          var center=laneTop+laneHeight/2;
          Object.keys(byColumn).forEach(function(key){
            var column=Number(key), items=byColumn[key].sort(function(a,b){return a.order-b.order;});
            items.forEach(function(node,index){
              var x=220+(column-1)*194;
              var y=center-(items.length*76+(items.length-1)*6)/2+index*82;
              positions[node.id]={x:x,y:y,w:node.kind==="candidate"?176:160,h:node.kind==="candidate"?74:68,node:node,cluster:cluster};
              maxX=Math.max(maxX,x+(node.kind==="candidate"?176:160)+30);
            });
          });
          if(isExpanded&&clusterNodes.length){
            var values=clusterNodes.map(function(node){return positions[node.id];}).filter(Boolean);
            var right=Math.max.apply(Math,values.map(function(item){return item.x+item.w;}));
            clusterBoxes.push({x:202,y:laneTop+3,w:right-190,h:laneHeight-6,label:cluster.label});
          }
          laneTop+=laneHeight+16;
        });
        var canvasHeight=Math.max(490,laneTop+18), rootY=Math.max(26,(laneTop-16)/2-34);
        positions[root.id]={x:24,y:rootY,w:148,h:68,node:root,cluster:null};
        var nodeIds={};Object.keys(positions).forEach(function(id){nodeIds[id]=true;});
        var edges=snapshot.graph.edges.filter(function(edge){return edge.enteredSequence<=cursor&&nodeIds[edge.source]&&nodeIds[edge.target];});
        var edgeHtml='<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(151,164,170,.55)"></path></marker></defs>'+edges.map(function(edge){
          var source=positions[edge.source],target=positions[edge.target];var x1=source.x+source.w,y1=source.y+source.h/2,x2=target.x,y2=target.y+target.h/2;var bend=Math.max(28,(x2-x1)*.46);var targetState=graphNodeState(target.node);var active=targetState==="running";
          return '<path class="graph-edge '+esc(edge.kind)+(active?' active':'')+'" d="M '+x1+' '+y1+' C '+(x1+bend)+' '+y1+', '+(x2-bend)+' '+y2+', '+x2+' '+y2+'" marker-end="url(#arrow)"></path>';
        }).join("");
        var clusterHtml=clusterBoxes.map(function(box){return '<div class="graph-cluster" style="left:'+box.x+'px;top:'+box.y+'px;width:'+box.w+'px;height:'+box.h+'px"><span class="graph-cluster-label">'+esc(box.label)+'</span></div>';}).join("");
        var nodeHtml=Object.keys(positions).map(function(id){
          var item=positions[id],node=item.node,state=graphNodeState(node),group=graphFilterGroup(node),dimmed=group&&!graphFilters[group],cluster=node.clusterId?snapshot.graph.clusters.find(function(value){return value.id===node.clusterId;}):null,isExpanded=cluster&&expandedClusters[cluster.id];var facts=[];if(node.usage&&node.usage.model)facts.push(node.usage.model);var nodeTokens=usageTokenTotal(node.usage);if(nodeTokens!=null)facts.push(fmtTokens(nodeTokens));if(node.usage&&node.usage.billingMode)facts.push(billingValue(node.usage));else if(node.usage&&node.usage.costUsd!=null&&node.usage.costSource!=="estimated")facts.push(fmtCost(node.usage.costUsd));if(node.metrics)facts.push(node.metrics+' metrics');if(node.artifacts)facts.push(node.artifacts+' artifacts');if(node.durationMs!=null)facts.push(fmtDuration(node.durationMs));
          return '<button type="button" class="graph-node '+esc(node.kind)+' '+esc(state)+(dimmed?' dimmed':'')+(selectedNodeId===node.id?' selected':'')+'" data-node="'+esc(node.id)+'" '+(node.experimentId?'data-exp="'+esc(node.experimentId)+'"':'')+' '+(node.clusterId?'data-cluster="'+esc(node.clusterId)+'"':'')+' style="left:'+item.x+'px;top:'+item.y+'px" title="'+esc(node.detail||node.label)+'"><div class="node-kind">'+esc(node.kind)+'</div><div class="node-label">'+esc(node.label)+'</div><div class="node-foot"><span>'+esc(state)+'</span><span>'+(node.kind==="candidate"?'<span class="node-expand">'+(isExpanded?'− collapse':'+ expand')+'</span>':esc(facts.join(' · ')))+'</span></div></button>';
        }).join("");
        $("graph").innerHTML='<div class="graph-canvas" style="width:'+Math.max(780,maxX)+'px;height:'+canvasHeight+'px"><div class="graph-clusters">'+clusterHtml+'</div><svg class="graph-edges" width="'+Math.max(780,maxX)+'" height="'+canvasHeight+'">'+edgeHtml+'</svg>'+nodeHtml+'</div>';
        document.querySelectorAll("[data-node]").forEach(function(element){element.addEventListener("click",function(){
          selectedNodeId=element.getAttribute("data-node");selectedId=element.getAttribute("data-exp")||selectedId;var node=snapshot.graph.nodes.find(function(value){return value.id===selectedNodeId;});var clusterId=element.getAttribute("data-cluster");if(node&&node.kind==="candidate"&&clusterId)expandedClusters[clusterId]=!expandedClusters[clusterId];render();
        });});
      }
      function renderMetrics(experiments) {
        var measured=experiments.filter(function(e){return resultVisible(e)&&e.primaryMetric!=null;});
        $("metricNote").textContent=snapshot.campaign.primaryMetric+' · '+snapshot.campaign.direction;
        if(!measured.length){$("metrics").innerHTML='<div class="empty">The primary metric appears after an evaluation is recorded.</div>';return;}
        var values=measured.map(function(e){return e.primaryMetric;}); var min=Math.min.apply(Math,values), max=Math.max.apply(Math,values); var span=max-min||1;
        $("metrics").innerHTML=measured.map(function(exp){var pct=18+(exp.primaryMetric-min)/span*82;return '<div class="metric-row"><div class="metric-name" title="'+esc(exp.id)+'">'+esc(exp.id)+'</div><div class="metric-bar"><div class="metric-fill" style="width:'+pct+'%"></div></div><div class="metric-value">'+fmtNumber(exp.primaryMetric)+'</div></div>';}).join("");
      }
      function renderCards(experiments) {
        $("candidateNote").textContent=experiments.length+' visible at event '+cursor;
        if(!experiments.length){$("cards").innerHTML='<div class="empty">Move the replay cursor forward to watch candidates enter the factory.</div>';return;}
        $("cards").innerHTML=experiments.map(function(exp){var phases=exp.phases.filter(function(p){return p.sequence<=cursor;});var summary=resultVisible(exp)?exp.summary:(phases.length?phases[phases.length-1].note:"");return '<article class="experiment-card '+(selectedId===exp.id?'selected':'')+'" data-exp="'+esc(exp.id)+'"><div class="card-top"><span class="card-id">'+esc(exp.id)+'</span>'+statusBadge(currentStatus(exp))+'</div><div class="card-summary">'+esc(summary||"Awaiting work")+'</div><div class="card-foot"><span>'+(exp.round!=null?'R'+exp.round+' · ':'')+(exp.slot!=null?'slot '+exp.slot:'')+'</span><span>'+phases.length+' phases'+(resultVisible(exp)&&exp.primaryMetric!=null?' · '+fmtNumber(exp.primaryMetric):'')+'</span></div></article>';}).join("");
      }
      function renderFeed() {
        var events=visibleEvents().slice(-14);
        $("feed").innerHTML=events.length?events.map(function(e){return '<div class="feed-row"><span class="feed-seq">#'+e.sequence+'</span><span class="feed-exp" title="'+esc(e.experimentId)+'">'+esc(e.experimentId)+'</span><span class="feed-phase">'+esc(e.phase)+'</span><span>'+esc(e.note)+'</span></div>';}).join(""):'<div class="empty">No events at this replay position.</div>';
      }
      function renderDetail(experiments) {
        var exp=experiments.find(function(e){return e.id===selectedId;}) || experiments[experiments.length-1];
        if(!exp){$("detailStatus").innerHTML='';$("detail").innerHTML='<div class="empty">Select an experiment after it enters the trace.</div>';return;}
        selectedId=exp.id; var hasResult=resultVisible(exp);var selectedNode=snapshot.graph.nodes.find(function(node){return node.id===selectedNodeId&&node.enteredSequence<=cursor;});$("detailStatus").innerHTML=statusBadge(selectedNode?graphNodeState(selectedNode):currentStatus(exp));
        var phaseHtml=exp.phases.map(function(p){var future=p.sequence>cursor;return '<div class="phase-row '+(future?'future':'')+'"><span class="phase-node"></span><span class="phase-name">'+esc(p.phase)+'</span><span class="phase-note">'+esc(p.note)+'<br>'+fmtTime(p.timestamp)+' · #'+p.sequence+'</span></div>';}).join("");
        var evalHtml="";
        if(exp.evaluatedSequence!=null&&exp.evaluatedSequence<=cursor){evalHtml=exp.evaluations.map(function(e){return '<div class="eval"><div class="eval-top"><span class="eval-name">'+esc(e.evaluator)+'</span>'+statusBadge(e.status)+'</div>'+(e.summary?'<p>'+esc(e.summary)+'</p>':'')+'<p>'+Object.keys(e.metrics).length+' metrics · '+e.violations+' violations · '+e.artifacts+' artifacts</p></div>';}).join("")||'<div class="empty">Evaluation completed without a retained result payload.</div>';}
        var agentHtml=hasResult&&exp.contributors.length?exp.contributors.map(function(a){var facts=[a.role];if(a.usage&&a.usage.model)facts.push(modelLabel(a.usage));var tokens=usageTokenTotal(a.usage);if(tokens!=null)facts.push(fmtTokens(tokens)+' tokens');if(a.usage&&a.usage.billingMode)facts.push(billingValue(a.usage));else if(a.usage&&a.usage.costUsd!=null&&a.usage.costSource!=="estimated")facts.push(fmtCost(a.usage.costUsd));return '<div class="agent-row"><div><div class="agent-name">'+esc(a.agentId)+'</div><div class="agent-role">'+esc(facts.join(' · '))+'</div><p>'+esc(a.summary)+'</p></div>'+statusBadge(a.status)+'</div>';}).join(""):hasResult&&exp.agentSummary?'<div class="detail-summary">'+esc(exp.agentSummary)+'</div>':'';
        var previews=hasResult?exp.artifacts.filter(function(a){return a.available&&a.mediaType&&a.mediaType.indexOf("image/")===0;}).slice(0,2):[];
        var previewHtml=previews.map(function(a){return '<a href="'+esc(a.url)+'" target="_blank" rel="noreferrer"><img class="artifact-preview" src="'+esc(a.url)+'" alt="'+esc(a.label)+'"></a>';}).join("");
        var artifactHtml=hasResult?exp.artifacts.slice(0,60).map(function(a){var tag=a.available?'a':'div';var href=a.available?' href="'+esc(a.url)+'" target="_blank" rel="noreferrer"':'';return '<'+tag+' class="artifact"'+href+'><span>'+esc(a.label)+'</span><span class="artifact-kind">'+esc(a.kind)+'</span></'+tag+'>';}).join(""):'';
        var metrics=hasResult?Object.keys(exp.metrics).sort().slice(0,12).map(function(key){return '<div class="artifact"><span>'+esc(key)+'</span><span class="artifact-kind">'+fmtNumber(exp.metrics[key])+'</span></div>';}).join(""):'';
        var nodeHtml=selectedNode&&selectedNode.kind!=="candidate"?'<div class="section-label">Selected node · '+esc(selectedNode.kind)+'</div><h2 class="detail-title">'+esc(selectedNode.label)+'</h2><div class="detail-summary">'+esc(selectedNode.detail||"No node summary was recorded.")+'</div><div class="artifact"><span>Entered trace</span><span class="artifact-kind">#'+selectedNode.enteredSequence+'</span></div>'+usageDetails(selectedNode.usage,selectedNode.invocationId,selectedNode.parentInvocationId):'';
        $("detail").innerHTML=nodeHtml+'<div class="section-label">Experiment</div><h2 class="detail-title">'+esc(exp.id)+'</h2><div class="detail-summary">'+esc((hasResult?exp.summary:null)||"This candidate is still moving through the factory.")+'</div><div class="section-label">Lifecycle</div><div class="phase-list">'+phaseHtml+'</div>'+(metrics?'<div class="section-label">Metrics</div>'+metrics:'')+(evalHtml?'<div class="section-label">Evaluator waterfall</div>'+evalHtml:'')+(agentHtml?'<div class="section-label">Agent work</div>'+agentHtml:'')+(artifactHtml?'<div class="section-label">Evidence · '+exp.artifacts.length+'</div>'+previewHtml+artifactHtml+(exp.artifacts.length>60?'<div class="empty">Showing the first 60 artifacts.</div>':''):'');
      }
      function bindExperimentClicks() { document.querySelectorAll("[data-exp]:not([data-node])").forEach(function(node){node.addEventListener("click",function(){selectedId=node.getAttribute("data-exp");selectedNodeId=null;render();});}); }
      function render() {
        if(!snapshot)return;
        var experiments=snapshot.experiments.filter(visibleExperiment);
        $("graph").classList.toggle("hidden",graphMode!=="graph");$("timeline").classList.toggle("hidden",graphMode!=="timeline");$("graphViewButton").classList.toggle("active",graphMode==="graph");$("timelineViewButton").classList.toggle("active",graphMode==="timeline");
        renderRuns();renderHeader();renderStats(experiments);renderUsage();renderReplay();renderGraph();renderTimeline(experiments);renderMetrics(experiments);renderCards(experiments);renderFeed();renderDetail(experiments);bindExperimentClicks();
      }
      function stopReplay(){playing=false;if(replayTimer){clearInterval(replayTimer);replayTimer=null;}}
      function toggleReplay(){if(playing){stopReplay();render();return;}follow=false;if(cursor>=snapshot.sequence)cursor=0;playing=true;replayTimer=setInterval(function(){var next=snapshot.events.find(function(e){return e.sequence>cursor;});if(!next){stopReplay();cursor=snapshot.sequence;render();return;}cursor=next.sequence;render();},420);render();}
      function acceptSnapshot(next){var wasAtEnd=snapshot&&cursor>=snapshot.sequence;snapshot=next;if(follow||wasAtEnd)cursor=snapshot.sequence;if(!selectedId&&snapshot.experiments.length)selectedId=snapshot.experiments[snapshot.experiments.length-1].id;render();}
      function connect(runId){if(stream)stream.close();var query=runId?'?run='+encodeURIComponent(runId):'';stream=new EventSource('/api/stream'+query);stream.addEventListener('snapshot',function(event){acceptSnapshot(JSON.parse(event.data));hideError();});stream.addEventListener('trace-error',function(event){var data=JSON.parse(event.data);showError(data.message);});stream.onerror=function(){showError('Viewer connection interrupted; reconnecting…');};}
      function loadRun(runId){stopReplay();follow=true;selectedId=null;selectedNodeId=null;expandedClusters={};fetch('/api/snapshot?run='+encodeURIComponent(runId)).then(function(r){if(!r.ok)throw new Error('Unable to load trace');return r.json();}).then(function(data){acceptSnapshot(data);connect(data.runId);}).catch(function(error){showError(error.message);});}
      function showError(message){var bar=$("errorBar");bar.textContent=message;bar.style.display="block";} function hideError(){$("errorBar").style.display="none";}
      $("playButton").addEventListener("click",toggleReplay);
      $("followButton").addEventListener("click",function(){stopReplay();follow=true;cursor=snapshot?snapshot.sequence:0;render();});
      $("replayRange").addEventListener("input",function(){stopReplay();follow=false;cursor=Number(this.value);render();});
      $("runSelect").addEventListener("change",function(){loadRun(this.value);});
      $("graphViewButton").addEventListener("click",function(){graphMode="graph";render();});
      $("timelineViewButton").addEventListener("click",function(){graphMode="timeline";render();});
      $("expandButton").addEventListener("click",function(){snapshot.graph.clusters.forEach(function(cluster){if(cluster.enteredSequence<=cursor)expandedClusters[cluster.id]=true;});render();});
      $("collapseButton").addEventListener("click",function(){expandedClusters={};render();});
      document.querySelectorAll(".graph-filter").forEach(function(button){button.addEventListener("click",function(){var filter=button.getAttribute("data-filter");graphFilters[filter]=!graphFilters[filter];button.classList.toggle("active",graphFilters[filter]);render();});});
      setInterval(function(){var node=$("elapsed");if(node&&snapshot)node.textContent=fmtDuration(elapsed());},1000);
      fetch('/api/snapshot').then(function(r){if(!r.ok)throw new Error('Unable to load factory trace');return r.json();}).then(function(data){acceptSnapshot(data);connect(data.runId);}).catch(function(error){showError(error.message);});
    })();
  </script>
</body>
</html>`;
