window.__ModuleLoader__.load({
  id: "@silver/cli",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const css = `
      .silver { --ink: #18243a; --muted: #66758d; --line: #e1e7f0; --panel: #fff;
        --soft: #f3f6fb; --accent: #4058d8; --accent-soft: #ecf0ff; --good: #13855f;
        color: var(--ink); min-height: 100%; overflow: auto; background: #f8fafd; font: 14px/1.5 var(--dsw-font-sans, system-ui, sans-serif); }
      .silver * { box-sizing: border-box; }
      .silver-shell { max-width: 1240px; margin: auto; padding: 32px 36px 72px; }
      .silver-header-shell { padding-bottom: 0; }
      .silver-content { padding-top: 0; }
      .silver-top { display: flex; justify-content: space-between; align-items: center; gap: 24px; margin-bottom: 26px; }
      .silver-logo { display: flex; align-items: center; gap: 14px; }
      .silver-mark { display: grid; place-items: center; width: 43px; height: 43px; border-radius: 13px;
        background: #253b9a; color: white; font-weight: 850; font-size: 22px; letter-spacing: -.08em; }
      .silver-title { font-size: 23px; font-weight: 780; letter-spacing: -.04em; line-height: 1.1; }
      .silver-subtitle { color: var(--muted); font-size: 12px; margin-top: 4px; }
      .silver-live { display: flex; gap: 8px; align-items: center; color: var(--muted); font-size: 12px; }
      .silver-live i { width: 8px; height: 8px; border-radius: 50%; background: #2ab485; }
      .silver-nav { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 28px; }
      .silver-nav button { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--muted);
        padding: 12px 17px; margin-bottom: -1px; cursor: pointer; font: inherit; font-weight: 660; }
      .silver-nav button.active { color: var(--accent); border-bottom-color: var(--accent); }
      .silver-heading { margin-bottom: 23px; }
      .silver-eyebrow { color: var(--accent); font-size: 11px; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
      .silver h1 { font-size: 28px; line-height: 1.2; margin: 7px 0 7px; letter-spacing: -.04em; }
      .silver h2 { font-size: 17px; line-height: 1.3; margin: 0 0 6px; letter-spacing: -.02em; }
      .silver h3 { font-size: 14px; margin: 0 0 5px; }
      .silver p { color: var(--muted); margin: 0; }
      .silver-card { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 24px; min-width: 0; }
      .silver-card + .silver-card { margin-top: 16px; }
      .silver-split { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(280px, .88fr); gap: 18px; align-items: start; }
      .silver-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .silver-between { display: flex; justify-content: space-between; align-items: center; gap: 14px; }
      .silver-gap { margin-top: 18px; }
      .silver-small-gap { margin-top: 10px; }
      .silver-label { display: block; font-weight: 700; font-size: 12px; margin: 0 0 7px; }
      .silver-help { color: var(--muted); font-size: 12px; line-height: 1.5; margin-top: 5px; }
      .silver-field { width: 100%; min-width: 0; color: var(--ink); background: white; border: 1px solid #cdd7e6;
        border-radius: 10px; padding: 10px 12px; font: inherit; outline: 0; }
      .silver-field:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
      .silver-textarea { resize: vertical; line-height: 1.55; }
      .silver-mission { min-height: 280px; }
      .silver-chat-input { min-height: 102px; }
      .silver-code { min-height: 410px; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
      .silver-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid #cdd7e6;
        color: var(--ink); background: #fff; border-radius: 9px; padding: 9px 14px; font: inherit; font-size: 13px;
        font-weight: 700; cursor: pointer; white-space: nowrap; }
      .silver-btn:hover:not(:disabled) { background: var(--soft); }
      .silver-btn.primary { color: #fff; border-color: var(--accent); background: var(--accent); }
      .silver-btn.primary:hover:not(:disabled) { background: #344bc3; }
      .silver-btn:disabled { opacity: .48; cursor: not-allowed; }
      .silver-btn.quiet { border: 0; background: none; color: var(--accent); padding-left: 0; }
      .silver-segment { display: inline-flex; gap: 3px; padding: 3px; background: var(--soft); border: 1px solid var(--line);
        border-radius: 10px; }
      .silver-segment button { border: 0; border-radius: 7px; background: none; padding: 7px 12px; color: var(--muted);
        cursor: pointer; font: inherit; font-size: 12px; font-weight: 700; }
      .silver-segment button.active { color: var(--ink); background: #fff; box-shadow: 0 1px 4px #21376916; }
      .silver-info { padding: 13px 15px; background: #eff3ff; border: 1px solid #dce4ff; border-radius: 11px; color: #334788;
        font-size: 12px; line-height: 1.55; }
      .silver-alert { margin-bottom: 20px; padding: 12px 15px; border: 1px solid #dce4ff; background: #f0f3ff;
        border-radius: 10px; color: #304588; font-size: 13px; }
      .silver-metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
      .silver-metric { padding: 14px; background: var(--soft); border-radius: 11px; min-width: 0; }
      .silver-metric span { display: block; color: var(--muted); font-size: 11px; }
      .silver-metric strong { display: block; margin-top: 3px; font-size: 16px; overflow-wrap: anywhere; }
      .silver-tag { display: inline-flex; align-items: center; padding: 4px 8px; border-radius: 99px; background: var(--soft);
        color: var(--muted); font-size: 11px; font-weight: 720; }
      .silver-tag.running, .silver-tag.active { background: #e5f7ee; color: #15724f; }
      .silver-tag.terminal, .silver-tag.closed { background: #ebeffa; color: #5365a6; }
      .silver-run-picker { display: flex; gap: 8px; overflow-x: auto; padding: 2px 0 14px; margin-bottom: 7px; }
      .silver-run-picker button { border: 1px solid var(--line); background: white; color: var(--ink); border-radius: 10px;
        padding: 10px 13px; cursor: pointer; white-space: nowrap; font: inherit; font-size: 12px; }
      .silver-run-picker button.active { border-color: #9cacf8; background: #f0f3ff; color: var(--accent); }
      .silver-divider { height: 1px; background: var(--line); margin: 21px 0; }
      .silver-room { border: 1px solid var(--line); border-radius: 12px; padding: 15px; margin-top: 10px; }
      .silver-room-title { font-weight: 760; overflow-wrap: anywhere; }
      .silver-timeline { padding: 0; margin: 15px 0 0; list-style: none; }
      .silver-timeline li { display: grid; grid-template-columns: 80px 1fr; gap: 12px; padding: 10px 0;
        border-top: 1px solid var(--line); font-size: 12px; }
      .silver-timeline time { color: var(--muted); }
      .silver-timeline strong { font-weight: 670; }
      .silver-empty { padding: 35px 22px; border: 1px dashed #cdd7e6; border-radius: 13px; text-align: center;
        color: var(--muted); background: white; }
      .silver-settings { display: grid; grid-template-columns: 220px minmax(0,1fr); gap: 22px; align-items: start; }
      .silver-settings-nav { display: grid; gap: 4px; position: sticky; top: 15px; }
      .silver-settings-nav button { text-align: left; border: 0; border-radius: 9px; background: transparent; color: var(--muted);
        font: inherit; font-size: 13px; font-weight: 690; padding: 10px 13px; cursor: pointer; }
      .silver-settings-nav button.active { color: var(--accent); background: var(--accent-soft); }
      .silver-settings-main { min-width: 0; }
      .silver-setting { padding: 18px 0; border-top: 1px solid var(--line); }
      .silver-setting:first-of-type { border-top: 0; padding-top: 3px; }
      .silver-setting-head { display: flex; justify-content: space-between; gap: 15px; align-items: flex-start; margin-bottom: 11px; }
      .silver-setting-head > div { max-width: 440px; }
      .silver-setting-control { width: min(100%, 360px); }
      .silver-setting-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 14px; max-width: 560px; }
      .silver-setting-grid label { min-width: 0; }
      .silver-settings-bar { position: sticky; bottom: 0; display: flex; justify-content: space-between; align-items: center;
        gap: 12px; margin-top: 20px; padding: 15px 0; background: #f8fafd; border-top: 1px solid var(--line); }
      .silver-toggle { display: inline-flex; align-items: center; gap: 9px; cursor: pointer; font-weight: 690; }
      .silver-toggle input { width: 18px; height: 18px; accent-color: var(--accent); }
      .silver-sent { margin: 10px 0; border: 1px solid var(--line); border-radius: 10px; padding: 11px 13px;
        font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
      .silver-sent span { color: var(--muted); display: block; font-size: 11px; margin-bottom: 4px; }
      .silver-header-shell { max-width: 1600px; }
      .silver-header-shell .silver-top { margin-bottom: 14px; }
      .silver-header-shell .silver-nav { margin-bottom: 17px; }
      .silver-run-shell { max-width: 1600px; padding: 0 28px 36px; }
      .silver-workbench { position: relative; display: grid; grid-template-columns: 205px minmax(0, 1fr) 270px; gap: 0;
        height: min(820px, calc(100vh - 170px)); min-height: 420px; overflow: hidden;
        border: 1px solid var(--line); border-radius: 15px; background: white; }
      .silver-workbench > * { min-width: 0; }
      .silver-workbench-list { padding: 17px 10px; border-right: 1px solid var(--line); background: #f9fbfe;
        overflow-y: auto; }
      .silver-workbench-caption { color: var(--muted); font-size: 11px; font-weight: 750; letter-spacing: .09em;
        text-transform: uppercase; padding: 0 10px 12px; }
      .silver-task-row { display: block; width: 100%; text-align: left; border: 1px solid transparent; border-radius: 10px;
        padding: 11px 10px; margin-bottom: 5px; background: transparent; color: var(--ink); cursor: pointer; font: inherit; }
      .silver-task-row:hover { background: #eef2fa; }
      .silver-task-row.active { background: white; border-color: #d6def0; box-shadow: 0 2px 8px #223b6510; }
      .silver-task-row strong { display: block; font-size: 13px; }
      .silver-task-row span { display: block; color: var(--muted); font-size: 11px; margin-top: 4px; }
      .silver-task-row i { display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: #9aa9bf; }
      .silver-task-row i.running { background: #23ac75; }
      .silver-workbench-main { display: flex; flex-direction: column; min-height: 0; }
      .silver-conversation-head { display: flex; align-items: center; justify-content: space-between; gap: 14px;
        padding: 16px 22px; border-bottom: 1px solid var(--line); }
      .silver-conversation-head h1 { font-size: 19px; margin: 0; }
      .silver-conversation-head p { font-size: 11px; margin-top: 3px; }
      .silver-conversation-stats { display: flex; gap: 18px; padding: 9px 22px; border-bottom: 1px solid var(--line);
        color: var(--muted); font-size: 11px; }
      .silver-conversation-stats b { color: var(--ink); }
      .silver-conversation-stream { flex: 1; min-height: 0; overflow-y: auto; padding: 25px max(22px, calc((100% - 690px) / 2)); }
      .silver-chat-row { display: flex; margin: 0 0 20px; }
      .silver-chat-row.operator { justify-content: flex-end; }
      .silver-chat-bubble { max-width: min(100%, 610px); padding: 12px 15px; border: 1px solid var(--line);
        border-radius: 13px; background: white; overflow-wrap: anywhere; }
      .silver-chat-row.operator .silver-chat-bubble { background: #edf1ff; border-color: #dce4ff; }
      .silver-chat-byline { color: var(--muted); font-size: 11px; font-weight: 700; margin-bottom: 5px; }
      .silver-chat-body { white-space: pre-wrap; font-size: 13px; line-height: 1.5; }
      .silver-chat-system { display: flex; gap: 11px; align-items: baseline; padding: 10px 0; color: #536179;
        border-bottom: 1px solid #eef1f6; font-size: 12px; }
      .silver-chat-system time { flex: none; color: #8290a4; font-size: 11px; }
      .silver-chat-system.important { color: #147451; font-weight: 650; }
      .silver-composer { padding: 14px 19px 17px; border-top: 1px solid var(--line); background: white; }
      .silver-composer textarea { min-height: 70px; max-height: 190px; }
      .silver-composer-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 9px; }
      .silver-composer-foot .silver-help { margin: 0; }
      .silver-workbench-rooms { border-left: 1px solid var(--line); padding: 17px 15px; overflow-y: auto; }
      .silver-room-row { display: block; width: 100%; text-align: left; padding: 10px 11px; border: 1px solid var(--line);
        border-radius: 10px; margin-bottom: 7px; background: white; color: var(--ink); font: inherit; cursor: pointer; }
      .silver-room-row.active { border-color: #aab9f2; background: #f4f6ff; }
      .silver-room-row strong { font-size: 13px; }
      .silver-room-row span { display: block; color: var(--muted); font-size: 11px; margin-top: 3px; }
      .silver-room-inspect { padding-top: 13px; margin-top: 14px; border-top: 1px solid var(--line); }
      .silver-room-inspect textarea { min-height: 78px; }
      .silver-room-inspect .silver-segment { margin: 9px 0; }
      .silver-room-tabs { display: flex; gap: 5px; padding: 10px 22px; border-bottom: 1px solid var(--line); }
      .silver-room-tabs button { border: 0; border-radius: 8px; padding: 7px 12px; background: transparent;
        color: var(--muted); font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
      .silver-room-tabs button.active { color: var(--accent); background: var(--accent-soft); }
      .silver-room-entry { padding: 13px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
      .silver-room-entry:last-child { border-bottom: 0; }
      .silver-room-entry-head { display: flex; justify-content: space-between; gap: 12px; color: var(--muted);
        font-size: 11px; margin-bottom: 6px; }
      .silver-room-entry-head strong { color: var(--ink); }
      .silver-room-entry-body { white-space: pre-wrap; line-height: 1.6; font-size: 13px; }
      .silver-room-entry-note { margin-top: 7px; color: var(--muted); font-size: 11px; white-space: pre-wrap; }
      .silver-room-toggle { display: none; }
      @media (max-width: 1050px) { .silver-workbench { grid-template-columns: 190px minmax(0, 1fr); }
        .silver-room-toggle { display: inline-flex; }
        .silver-workbench-rooms { display: none; }
        .silver-workbench-rooms.open { display: block; position: absolute; z-index: 2; top: 0; right: 0; bottom: 0;
          width: min(330px, 90%); background: white; box-shadow: -12px 0 35px #16284b24; } }
      @media (max-width: 700px) { .silver-shell.silver-run-shell { padding: 0 12px 22px; }
        .silver-workbench { display: flex; flex-direction: column; height: calc(100vh - 145px); min-height: 480px; }
        .silver-workbench-list { display: flex; gap: 7px; flex: none; padding: 8px; overflow-x: auto; border-right: 0;
          border-bottom: 1px solid var(--line); }
        .silver-workbench-caption { display: none; }
        .silver-task-row { width: 150px; flex: none; margin: 0; }
        .silver-workbench-main { flex: 1; }
        .silver-conversation-head { padding: 12px 15px; }
        .silver-conversation-stream { padding: 18px 16px; }
        .silver-conversation-stats { padding: 8px 15px; gap: 9px; flex-wrap: wrap; }
        .silver-composer { padding: 10px 12px 12px; }
      }
      @media (max-width: 850px) { .silver-shell { padding: 23px 18px 60px; } .silver-split { grid-template-columns: 1fr; }
        .silver-settings { grid-template-columns: 1fr; gap: 12px; } .silver-settings-nav { position: static; display: flex; overflow-x: auto; } }
      @media (max-width: 520px) { .silver-top { align-items: flex-start; } .silver-live { display: none; }
        .silver-card { padding: 18px; } .silver-setting-grid { grid-template-columns: 1fr; }
        .silver-nav button { flex: 1; padding: 11px 7px; } .silver-between.mobile-stack { align-items: flex-start; flex-direction: column; } }
    `;

    const configGroups = [
      ["model", "模型"],
      ["team", "协作与并发"],
      ["runtime", "执行环境"],
      ["contest", "外部能力"],
      ["roles", "角色职责"],
      ["advanced", "高级 YAML"],
    ];
    const controlPaths = {
      provider: ["defaults.provider", "agents.ctf-solver.provider"],
      model: ["defaults.model", "agents.ctf-solver.model"],
      effort: ["defaults.effort", "agents.ctf-solver.effort"],
      contextWindow: ["selectedModel.contextWindow"],
      initialWorkers: ["swarm.initialWorkers"],
      maxWorkers: ["swarm.maxWorkers"],
      maxConcurrentRooms: ["competition.maxConcurrentRooms"],
      timeoutMs: ["live.timeoutMs"],
      maxTurns: ["live.maxTurns"],
      externalSearch: ["runtime.externalSearch"],
      nativeAssistants: ["nativeAssistants.enabled"],
      maxAssistants: ["nativeAssistants.maxPerMember"],
      maxAssistantDepth: ["nativeAssistants.maxDepth"],
      maxModelLoops: ["runtime.maxModelLoops"],
      feedEnabled: ["swarm.chat.enabled"],
      feedDelivery: ["swarm.chat.delivery"],
      skillRoots: ["skills.roots"],
      hintPolicy: ["competition.hintPolicy"],
      autonomy: ["competition.autonomy"],
      workerRoles: ["swarm.workerRoles"],
    };
    function segment(options, value, set) {
      return h("div", { className: "silver-segment", role: "group" }, options.map(([id, label]) =>
        h("button", { key: id, type: "button", className: value === id ? "active" : "", onClick: () => set(id) }, label)));
    }
    function setting(title, description, control) {
      return h("div", { className: "silver-setting" },
        h("div", { className: "silver-setting-head" }, h("div", null, h("h3", null, title), h("p", { className: "silver-help" }, description))),
        h("div", { className: "silver-setting-control" }, control));
    }
    function input(value, onChange, props = {}) {
      return h("input", { className: "silver-field", value: value ?? "", onChange: (event) => onChange(event.target.value), ...props });
    }
    function select(value, onChange, options) {
      return h("select", { className: "silver-field", value: value ?? "", onChange: (event) => onChange(event.target.value) },
        options.map(([id, label]) => h("option", { key: id, value: id }, label)));
    }
    function toggle(checked, onChange, label) {
      return h("label", { className: "silver-toggle" }, h("input", { type: "checkbox", checked: !!checked, onChange: (event) => onChange(event.target.checked) }), label);
    }
    function eventLabel(event, mission) {
      const target = event.targetId ? ` · ${event.targetId}` : "";
      switch (event.type) {
        case "queue-target": return `Commander 已分配房间${target}`;
        case "worker-start": return `房间开始工作${target}`;
        case "worker-end": return mission?.projects.some((room) => room.challengeId === event.targetId && room.platformCompleted)
          ? `房间结束${target} · 平台已完成${event.outcome && event.outcome !== "solved" ? `（本地退出记录：${event.outcome}）` : ""}`
          : `房间结束${target}${event.outcome ? ` · ${event.outcome}` : ""}`;
        case "submit": return `平台返回提交判决${target} · ${event.correct ? "接受" : "未接受"}${event.count !== null && event.total !== null ? ` · ${event.count}/${event.total}` : ""}`;
        case "target-result-recorded": return `Commander 记录房间结果${target}`;
        case "room-control-request": return `房间请求协调${target}`;
        case "room-control-resolved": return `Commander 回应房间${target}`;
        case "commander-transport-waiting": return "Commander 连接等待恢复";
        case "commander-transport-resume": return "Commander 连接已恢复";
        case "mission-done": return "Mission 已结束";
        case "mission-failed": return "Mission 运行失败";
        case "interrupt": return "收到停止信号";
        default: return event.type;
      }
    }
    function timeLabel(value) {
      if (!value) return "—";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    function SilverPage({ call }) {
      const [page, setPage] = React.useState("mission");
      const [mode, setMode] = React.useState("ctf");
      const [mission, setMission] = React.useState("");
      const [missionInput, setMissionInput] = React.useState("text");
      const [importedFile, setImportedFile] = React.useState("");
      const [missions, setMissions] = React.useState([]);
      const [selected, setSelected] = React.useState("");
      const [choices, setChoices] = React.useState([]);
      const [configId, setConfigId] = React.useState("");
      const [config, setConfig] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [configText, setConfigText] = React.useState("");
      const [settingsGroup, setSettingsGroup] = React.useState("model");
      const [roomDetails, setRoomDetails] = React.useState({});
      const [roomOverview, setRoomOverview] = React.useState({});
      const [roomTab, setRoomTab] = React.useState("feed");
      const [focusedRoom, setFocusedRoom] = React.useState("");
      const [roomDrawer, setRoomDrawer] = React.useState(false);
      const [roomText, setRoomText] = React.useState({});
      const [roomDelivery, setRoomDelivery] = React.useState("steer");
      const [commanderText, setCommanderText] = React.useState("");
      const [commanderDelivery, setCommanderDelivery] = React.useState("queue");
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState("");
      const streamRef = React.useRef(null);
      const lastStreamMission = React.useRef("");
      const current = missions.find((item) => item.id === selected);
      const modeChoices = choices.filter((item) => item.mode === mode);
      const activeConfigId = modeChoices.some((item) => item.id === configId) ? configId : modeChoices[0]?.id;
      const facts = config && config.id === activeConfigId ? config.summary : null;
      const settings = config && config.id === activeConfigId ? draft : null;
      const formDirty = !!(settings && config && JSON.stringify(settings) !== JSON.stringify(config.settings));
      const yamlDirty = !!config && configText !== config.text;
      const dirty = formDirty || yamlDirty;
      const setField = (name, value) => setDraft((before) => ({ ...before, [name]: value }));
      React.useEffect(() => {
        const stream = streamRef.current;
        if (!stream || page !== "runs" || !current) return;
        if (lastStreamMission.current !== selected || stream.scrollHeight - stream.scrollTop - stream.clientHeight < 240) {
          stream.scrollTop = stream.scrollHeight;
        }
        lastStreamMission.current = selected;
      }, [page, selected, current?.activity?.length, current?.messages?.length]);

      async function refresh() {
        const result = await call("missions/list", {});
        if (result.ok) {
          setMissions(result.value);
          setSelected((before) => before || result.value[0]?.id || "");
        } else setNotice(result.error.message);
      }
      React.useEffect(() => {
        void refresh();
        void call("configs/list", {}).then((result) => result.ok ? setChoices(result.value) : setNotice(result.error.message));
        const timer = setInterval(() => { void refresh(); }, 5000);
        return () => clearInterval(timer);
      }, []);
      React.useEffect(() => {
        if (!activeConfigId) return;
        let alive = true;
        void call("configs/get", { id: activeConfigId }).then((result) => {
          if (!alive) return;
          if (result.ok) { setConfig(result.value); setDraft(result.value.settings); setConfigText(result.value.text); }
          else setNotice(result.error.message);
        });
        return () => { alive = false; };
      }, [activeConfigId]);
      React.useEffect(() => {
        if (page !== "runs" || !selected || !focusedRoom) return;
        let alive = true;
        const update = async () => {
          const result = await call("rooms/overview", { id: selected, challengeId: focusedRoom });
          if (alive && result.ok) setRoomOverview((before) => ({ ...before, [focusedRoom]: result.value }));
        };
        void update();
        const timer = setInterval(() => { void update(); }, 5000);
        return () => { alive = false; clearInterval(timer); };
      }, [page, selected, focusedRoom]);
      async function action(message, work) {
        setBusy(true); setNotice(message);
        try { await work(); } catch (error) { setNotice(String(error.message ?? error)); }
        finally { setBusy(false); }
      }
      async function start() {
        await action("正在交给 Commander…", async () => {
          const result = await call("missions/start", { mode, mission, configId: activeConfigId });
          if (!result.ok) throw new Error(result.error.message);
          setSelected(result.value.id); setMission(""); setImportedFile(""); setPage("runs");
          setNotice("Mission 已交给 Commander。运行状态会自动刷新。");
          await refresh();
        });
      }
      async function importMission(event) {
        const file = event.target.files?.[0];
        if (!file) return;
        event.target.value = "";
        if (file.size > 1024 * 1024) { setNotice("Mission 文件不能超过 1 MiB。"); return; }
        try {
          setMission(await file.text());
          setImportedFile(file.name);
          setNotice(`已导入 ${file.name}；请检查原文后启动。`);
        } catch { setNotice("无法读取 Mission 文件。"); }
      }
      async function sendCommander() {
        const message = commanderText;
        await action("正在投递消息…", async () => {
          const result = await call("commander/message", { id: selected, mode: commanderDelivery, message });
          if (!result.ok) throw new Error(result.error.message);
          setCommanderText("");
          setNotice(commanderDelivery === "interrupt" ? "Commander 已接收中断请求，随后处理消息。" : "Commander 已接收，将在回合边界处理。");
          await refresh();
        });
      }
      async function sendRoom(challengeId) {
        await action("正在投递到房间…", async () => {
          const result = await call("rooms/message", { id: selected, challengeId, mode: roomDelivery, message: roomText[challengeId] });
          if (!result.ok) throw new Error(result.error.message);
          setRoomText((before) => ({ ...before, [challengeId]: "" }));
          setNotice(`房间已接收，投递成员 ${result.value.deliveredCount ?? "—"} 人。`);
          await refresh();
        });
      }
      async function inspect(challengeId) {
        const result = await call("rooms/status", { id: selected, challengeId });
        if (result.ok) setRoomDetails((before) => ({ ...before, [challengeId]: result.value }));
        else setNotice(result.error.message);
      }
      async function saveSettings() {
        if (!config || !settings) return;
        await action("正在保存配置…", async () => {
          const changes = [];
          for (const [key, paths] of Object.entries(controlPaths)) {
            if (JSON.stringify(settings[key]) !== JSON.stringify(config.settings[key])) {
              const value = key === "skillRoots" ? settings[key].map((item) => item.trim()).filter(Boolean) : settings[key];
              for (const path of paths) changes.push({ path, value });
            }
          }
          if (!changes.length) return;
          const result = await call("configs/update", { id: activeConfigId, revision: config.revision, changes });
          if (!result.ok) throw new Error(result.error.message);
          setConfig(result.value); setDraft(result.value.settings); setConfigText(result.value.text);
          setNotice("设置已保存。新 Mission 会使用它；运行中的任务不变。");
        });
      }
      async function saveYaml() {
        await action("正在校验并保存 YAML…", async () => {
          const result = await call("configs/save", { id: activeConfigId, revision: config.revision, text: configText });
          if (!result.ok) throw new Error(result.error.message);
          setConfig(result.value); setDraft(result.value.settings); setConfigText(result.value.text);
          setNotice("YAML 已保存。新 Mission 会使用它；运行中的任务不变。");
        });
      }
      async function reloadConfig() {
        if (!activeConfigId) return;
        const result = await call("configs/get", { id: activeConfigId });
        if (!result.ok) { setNotice(result.error.message); return; }
        setConfig(result.value); setDraft(result.value.settings); setConfigText(result.value.text);
        setNotice("已重新读取磁盘上的配置。");
      }
      function configPicker() {
        return select(activeConfigId, setConfigId, modeChoices.map((item) => [item.id, item.label]));
      }
      function numeric(key, min = 0) {
        return input(settings[key], (value) => setField(key, value === "" ? "" : Number(value)), { type: "number", min });
      }
      function settingContent() {
        if (!settings) return h("div", { className: "silver-empty" }, "正在读取配置…");
        if (settingsGroup === "model") return h(React.Fragment, null,
          setting("提供商", "Commander、Lead 和任务执行者当前共用的主模型路线。选择已在 YAML 中配置的提供商。",
            select(settings.provider, (value) => {
              const model = settings.providers[value]?.[0] ?? "";
              setDraft((before) => ({ ...before, provider: value, model,
                contextWindow: before.modelContextWindows?.[value]?.[model] ?? null }));
            },
              Object.keys(settings.providers).map((name) => [name, name]))),
          setting("模型名称", "可选取该提供商已声明的模型，也可填入模型 ID；需要的接口与认证仍在高级 YAML 的 providers 中配置。",
            h(React.Fragment, null,
              input(settings.model, (value) => setDraft((before) => ({ ...before, model: value,
                contextWindow: before.modelContextWindows?.[before.provider]?.[value] ?? null })),
                { list: "silver-model-options", placeholder: "模型 ID" }),
              h("datalist", { id: "silver-model-options" }, (settings.providers[settings.provider] ?? []).map((name) => h("option", { key: name, value: name }))))),
          setting("推理强度", "默认档交给 DSH 和提供商决定；只有提供商声明支持的档位才可显式选择。",
            select(settings.effort, (value) => setField("effort", value), [["default", "默认"], ["off", "关闭"], ["low", "低"], ["high", "高"], ["max", "最高"]])),
          setting("上下文窗口", "限制 DSH 每个成员会话使用的窗口；窗口变小会更早触发官方压缩。任务、Intel 和原始工件仍独立保存。新 Mission 生效。",
            select(settings.contextWindow === null ? "" : String(settings.contextWindow),
              (value) => setField("contextWindow", value === "" ? null : Number(value)),
              [["", "跟随提供商"], ["262144", "256K（推荐）"], ["300000", "300K"], ["500000", "500K"], ["1000000", "1M"]])));
        if (settingsGroup === "team") return h(React.Fragment, null,
          setting("任务执行者人数", "不含 Lead。初始人数在开房时加入；上限允许后续由团队增加。初始人数不能超过上限。",
            h("div", { className: "silver-setting-grid" },
              h("label", null, h("span", { className: "silver-label" }, "初始任务执行者"), numeric("initialWorkers", 1)),
              h("label", null, h("span", { className: "silver-label" }, "任务执行者上限"), numeric("maxWorkers", 1)))),
          setting("同时运行的房间", "控制跨任务并发；每个房间内部由 Lead 和任务执行者协作。", numeric("maxConcurrentRooms", 1)),
          setting("DSH 子助手", "成员可用 DSH 原生子助手处理局部工作；这不会增加 Silver 房间数。",
            h(React.Fragment, null, toggle(settings.nativeAssistants, (value) => setField("nativeAssistants", value), "允许成员使用子助手"),
              settings.nativeAssistants && h("div", { className: "silver-setting-grid silver-small-gap" },
                h("label", null, h("span", { className: "silver-label" }, "每名成员上限"), numeric("maxAssistants", 1)),
                h("label", null, h("span", { className: "silver-label" }, "最大层级"), numeric("maxAssistantDepth", 1))))),
          setting("公共 Feed", "房间的公共交流面。索引通知只告诉成员有更新，正文按需读取。",
            h(React.Fragment, null, toggle(settings.feedEnabled, (value) => setField("feedEnabled", value), "启用房间 Feed"),
              settings.feedEnabled && h("div", { className: "silver-small-gap" },
                select(settings.feedDelivery, (value) => setField("feedDelivery", value),
                  [["index-only", "只投递索引"], ["recent-delta", "投递近期变化"], ["pull-only", "按需拉取"]])))));
        if (settingsGroup === "runtime") return h(React.Fragment, null,
          setting("房间时限", "这里只管理房间生命周期，不判断任务内容或技术进展。",
            h("div", null,
              toggle(settings.timeoutMs === 0, (value) => setField("timeoutMs", value ? 0 : 5400000), "不设本地时限"),
              settings.timeoutMs !== 0 && h("label", { className: "silver-small-gap", style: { display: "block" } },
                h("span", { className: "silver-label" }, "分钟"), input(settings.timeoutMs / 60000, (value) => setField("timeoutMs", Number(value) * 60000), { type: "number", min: 1, step: 1 })))),
          setting("模型回合上限", "0 表示不按回合数停房。", numeric("maxTurns", 0)),
          setting("单次模型循环上限", "限制一次 DSH 工作回合中的连续模型与工具循环，避免单回合无界增长。", numeric("maxModelLoops", 1)));

        if (settingsGroup === "contest") return h(React.Fragment, null,
          h("div", { className: "silver-info" },
            "任务规则、验收与权限由 Mission 告诉 Commander 和房间；Silver 不预设领域协议或技术路线。"),
          setting("公开搜索", "控制模型工具面上的 web_search；不会限制 bash、web_fetch 或房间自己的技术路线。",
            toggle(settings.externalSearch, (value) => setField("externalSearch", value), "启用 web_search")),
          setting("DSH Skill 根目录", "可选。每行一个显式外部 Skill 目录；公开版本不附带或自动挂载 Skill。",
            h("textarea", { className: "silver-field silver-textarea", style: { minHeight: 84 },
              value: (settings.skillRoots ?? []).join("\n"),
              onChange: (event) => setField("skillRoots", event.target.value.split("\n")),
              placeholder: "每行一个目录，可留空" })),
          mode === "ctf" && setting("外部提示", "仅在外部适配器提供提示能力时生效。Mission 仍可另行说明外部交互方式。",
            select(settings.hintPolicy, (value) => setField("hintPolicy", value), [["open", "可用"], ["off", "关闭"]])),
          setting("协作自主性", "由 Mission 说明哪些决策需要人工介入；这里只配置运行偏好。",
            select(settings.autonomy, (value) => setField("autonomy", value), [["human_assisted", "人工协助"], ["autonomous", "自主"]])));
        if (settingsGroup === "roles") return h(React.Fragment, null,
            h("p", { className: "silver-info" }, "按顺序发给初始任务执行者。这里只描述职责边界，不写死执行方法；留空的席位由房间自行协调。"),
            (settings.workerRoles ?? []).map((role, index) => setting(`任务执行者 ${index + 1}`, "这个席位的职责说明。Lead 仍负责房间协调。",
              h("textarea", { className: "silver-field silver-textarea", style: { minHeight: 118 }, value: role,
                onChange: (event) => setField("workerRoles", settings.workerRoles.map((item, i) => i === index ? event.target.value : item)) }))));
        return h(React.Fragment, null,
          h("div", { className: "silver-info" }, "高级配置保留完整 YAML：提供商接口、认证引用、角色差量等不会被简化表单覆盖。保存时用 Silver 原有配置校验。"),
          h("textarea", { className: "silver-field silver-textarea silver-code silver-gap", spellCheck: false,
            value: configText, onChange: (event) => setConfigText(event.target.value), "aria-label": "Silver YAML 配置" }));
      }

      function roomView(mission, room) {
        const overview = roomOverview[room.challengeId];
        const feed = overview?.feed ?? [];
        const intel = overview?.intel ?? [];
        const statuses = overview?.statuses ?? [];
        const members = roomDetails[room.challengeId]?.members ?? [];
        const memberLabel = (id) => {
          const index = members.findIndex((item) => item.memberId === id);
          if (index < 0) return id || "成员";
          const member = members[index];
          return `${member.role === "lead" ? "Lead" : `任务执行者 ${members.slice(0, index + 1).filter((item) => item.role === "worker").length}`} · ${id.slice(-6)}`;
        };
        return h("section", { className: "silver-workbench-main", "aria-label": `房间 ${room.challengeId} 进展` },
          h("header", { className: "silver-conversation-head" },
            h("div", null, h("h1", null, `房间 ${room.challengeId}`),
              h("p", null, `${room.status} · 房间公开记录，最终结果以外部验收方为准`)),
            h("div", { className: "silver-row" },
              h("button", { className: "silver-btn", onClick: () => setFocusedRoom("") }, "← Mission"),
              h("button", { className: "silver-btn silver-room-toggle", onClick: () => setRoomDrawer(true) }, "其他房间"))),
          h("div", { className: "silver-conversation-stats" },
            h("span", null, "成员 ", h("b", null, members.length || statuses.length || "—")),
            h("span", null, "Feed ", h("b", null, overview?.feedTotal ?? feed.length)),
            h("span", null, "Intel ", h("b", null, overview?.intelTotal ?? intel.length))),
          h("div", { className: "silver-room-tabs", role: "tablist", "aria-label": "房间内容" },
            [["feed", "交流 / 进展"], ["intel", "共享情报"], ["members", "成员方向"]].map(([id, label]) =>
              h("button", { key: id, role: "tab", "aria-selected": roomTab === id,
                className: roomTab === id ? "active" : "", onClick: () => setRoomTab(id) }, label))),
          h("div", { className: "silver-conversation-stream", role: "tabpanel" },
            roomTab === "feed" && (feed.length ? feed.map((item) =>
              h("article", { key: item.messageId, className: "silver-room-entry" },
                h("div", { className: "silver-room-entry-head" },
                  h("strong", null, `${memberLabel(item.authorAttemptId)} · ${item.type ?? "讨论"}`),
                  h("time", null, timeLabel(item.createdAt))),
                h("div", { className: "silver-room-entry-body" }, item.text)))
              : h("div", { className: "silver-empty" }, overview ? "房间还没有公开交流。" : "正在读取房间公开记录…")),
            roomTab === "intel" && (intel.length ? intel.map((item) =>
              h("article", { key: item.intelId, className: "silver-room-entry" },
                h("div", { className: "silver-room-entry-head" },
                  h("strong", null, `${item.tags?.join(" · ") || "情报"}${item.status === "retracted" ? " · 已撤回" : ""}`),
                  h("time", null, timeLabel(item.updatedAt))),
                h("div", { className: "silver-room-entry-body" }, item.observation),
                item.conditions && h("div", { className: "silver-room-entry-note" }, `条件：${item.conditions}`),
                item.evidence?.length > 0 && h("div", { className: "silver-room-entry-note" },
                  `证据：${item.evidence.map((ref) => `${ref.kind} ${ref.ref}`).join(" · ")}`),
                item.comments?.map((comment, index) => h("div", { key: index, className: "silver-room-entry-note" },
                  `补充 · ${timeLabel(comment.createdAt)} · ${comment.body}`))))
              : h("div", { className: "silver-empty" }, overview ? "房间还没有共享情报。" : "正在读取共享情报…")),
            roomTab === "members" && (members.length || statuses.length ?
              (members.length ? members : statuses.map((item) => ({ memberId: item.memberId }))).map((member, index) => {
                const status = statuses.find((item) => item.memberId === member.memberId);
                return h("article", { key: member.memberId ?? index, className: "silver-room-entry" },
                  h("div", { className: "silver-room-entry-head" },
                    h("strong", null, memberLabel(member.memberId)),
                    h("span", null, member.status ?? "")),
                  h("div", { className: "silver-room-entry-body" }, status?.approach || "尚未公开当前方向"),
                  status?.updatedAt && h("div", { className: "silver-room-entry-note" }, `更新于 ${timeLabel(status.updatedAt)}`));
              }) : h("div", { className: "silver-empty" }, "成员状态尚未就绪。"))),
          h("div", { className: "silver-composer" },
            h("label", { className: "silver-label", htmlFor: "silver-room-input" }, "联系房间"),
            h("textarea", { id: "silver-room-input", className: "silver-field silver-textarea",
              value: roomText[room.challengeId] ?? "", placeholder: "给 Lead 与任务执行者留言…",
              onChange: (event) => setRoomText((before) => ({ ...before, [room.challengeId]: event.target.value })) }),
            h("div", { className: "silver-composer-foot" },
              segment([["queue", "排队"], ["steer", "插入"], ["interrupt", "中断"]], roomDelivery, setRoomDelivery),
              h("button", { className: "silver-btn primary", disabled: busy || !(roomText[room.challengeId] ?? "").trim() ||
                mission.status !== "running" || room.status !== "active", onClick: () => sendRoom(room.challengeId) }, "发送"))));
      }

      function workbench() {
        if (!missions.length) return h("div", { className: "silver-shell silver-run-shell" },
          h("div", { className: "silver-empty" }, "还没有通过界面启动的 Mission。",
            h("div", { className: "silver-small-gap" }, h("button", { className: "silver-btn primary", onClick: () => setPage("mission") }, "创建任务"))));
        const entries = current ? [
          ...(current.activity ?? []).slice().reverse().map((event) => ({ kind: "event", at: event.at, event })),
          ...(current.messages ?? []).map((message) => ({ kind: "message", at: message.at, message })),
        ].sort((a, b) => String(a.at).localeCompare(String(b.at))) : [];
        const room = current?.projects.find((item) => item.challengeId === focusedRoom);
        return h("div", { className: "silver-shell silver-run-shell" },
          h("div", { className: "silver-workbench" },
            h("aside", { className: "silver-workbench-list", "aria-label": "任务列表" },
              h("div", { className: "silver-workbench-caption" }, "任务"),
              missions.map((item) => h("button", { key: item.id, className: `silver-task-row ${selected === item.id ? "active" : ""}`,
                "aria-pressed": selected === item.id,
                onClick: () => { setSelected(item.id); setFocusedRoom(""); setRoomDetails({}); setRoomOverview({}); setRoomDrawer(false); } },
                h("strong", null, h("i", { className: item.status }), `${item.mode?.toUpperCase() ?? "MISSION"} · ${item.id.slice(3, 11)}`),
                h("span", null, `${timeLabel(item.startedAt)} · ${item.status === "running" ? "运行中" : item.status}`),
                item.projects.length > 0 && h("span", null, item.projects.map((room) => room.challengeId).join(" · "))))),
            current ? (room ? roomView(current, room) : h("section", { className: "silver-workbench-main", "aria-label": "任务动态" },
              h("header", { className: "silver-conversation-head" },
                h("div", null, h("h1", null, `Mission ${current.id.slice(3, 11)}`),
                  h("p", null, `${current.mode?.toUpperCase() ?? "MISSION"} · ${current.configId ?? "默认配置"} · ${current.status}`)),
                h("div", { className: "silver-row" },
                  h("button", { className: "silver-btn silver-room-toggle", onClick: () => setRoomDrawer(true) }, `房间 ${current.projects.length}`),
                  h("button", { className: "silver-btn", onClick: refresh }, "刷新"))),
              h("div", { className: "silver-conversation-stats" },
                h("span", null, "已完成 ", h("b", null, current.solvedRooms)),
                h("span", null, "房间 ", h("b", null, current.projects.length)),
                h("span", null, "已发现 ", h("b", null, current.discoveredRooms ?? "—")),
                current.terminalKind && h("span", null, "终态 ", h("b", null, current.terminalKind))),
              h("div", { className: "silver-conversation-stream", ref: streamRef, role: "log", "aria-label": "Mission 控制动态与操作者消息" },
                h("div", { className: "silver-chat-row operator" }, h("div", { className: "silver-chat-bubble" },
                  h("div", { className: "silver-chat-byline" }, `你 · ${timeLabel(current.startedAt)}`),
                  h("div", { className: "silver-chat-body" }, "Mission 已交给 Commander。"))),
                entries.map((entry, index) => entry.kind === "message"
                  ? h("div", { key: `message-${index}-${entry.at}`, className: "silver-chat-row operator" },
                    h("div", { className: "silver-chat-bubble" },
                      h("div", { className: "silver-chat-byline" }, `你 → ${entry.message.target === "commander" ? "Commander" : `房间 ${entry.message.target}`} · ${timeLabel(entry.at)}`),
                      h("div", { className: "silver-chat-body" }, entry.message.text)))
                  : h("div", { key: `event-${index}-${entry.at}`, className: `silver-chat-system ${entry.event.type === "submit" && entry.event.correct ? "important" : ""}` },
                    h("time", null, timeLabel(entry.at)), h("span", null, eventLabel(entry.event, current)))),
                entries.length === 0 && h("div", { className: "silver-chat-system" },
                  h("time", null, timeLabel(current.startedAt)), h("span", null, "Commander 正在处理 Mission；进展会在这里更新。"))),
              h("div", { className: "silver-composer" },
                h("label", { className: "silver-label", htmlFor: "silver-commander-input" }, "联系 Commander"),
                h("textarea", { id: "silver-commander-input", className: "silver-field silver-textarea",
                  value: commanderText, onChange: (event) => setCommanderText(event.target.value),
                  placeholder: "补充任务、纠正调度，或告诉 Commander 新的 Mission 文件位置…" }),
                h("div", { className: "silver-composer-foot" },
                  segment([["queue", "下一回合"], ["interrupt", "立即中断"]], commanderDelivery, setCommanderDelivery),
                  h("button", { className: "silver-btn primary", disabled: busy || !commanderText.trim() || current.status !== "running",
                    onClick: sendCommander }, "发送")))))
              : h("div", { className: "silver-empty" }, "请选择任务。"),
            current && h("aside", { className: `silver-workbench-rooms ${roomDrawer ? "open" : ""}`, "aria-label": "房间" },
              h("div", { className: "silver-between" },
                h("div", { className: "silver-workbench-caption", style: { paddingLeft: 0 } }, "房间"),
                h("button", { className: "silver-btn silver-room-toggle", onClick: () => setRoomDrawer(false) }, "关闭")),
              current.projects.length === 0 && h("p", { className: "silver-help" }, "Commander 尚未开房。"),
              current.projects.map((item) => h("button", { key: item.challengeId,
                className: `silver-room-row ${focusedRoom === item.challengeId ? "active" : ""}`,
                onClick: () => { setFocusedRoom(item.challengeId); setRoomTab("feed"); setRoomDrawer(false); void inspect(item.challengeId); } },
                h("strong", null, item.challengeId), h("span", null, item.platformCompleted ? "平台已完成" : item.status))),
              room && h("p", { className: "silver-help silver-gap" }, "房间公开交流、情报和成员方向显示在中间。"))));
      }

      return h("div", { className: "silver" }, h("style", null, css), h("div", { className: `silver-shell ${page === "mission" ? "" : "silver-header-shell"}` },
        h("header", { className: "silver-top" },
          h("div", { className: "silver-logo" }, h("div", { className: "silver-mark" }, "S"),
            h("div", null, h("div", { className: "silver-title" }, "Silver"), h("div", { className: "silver-subtitle" }, "安全团队任务工作台"))),
          h("div", { className: "silver-live" }, h("i"), "DSH Team 运行环境")),
        h("nav", { className: "silver-nav", "aria-label": "Silver 导航" },
          [["mission", "新任务"], ["runs", "运行工作台"], ["settings", "设置"]].map(([id, label]) =>
            h("button", { key: id, type: "button", className: page === id ? "active" : "", onClick: () => setPage(id) }, label))),
        notice && h("div", { className: "silver-alert", role: "status" }, notice),

        page === "mission" && h(React.Fragment, null,
          h("div", { className: "silver-heading" }, h("div", { className: "silver-eyebrow" }, "New mission"), h("h1", null, "把任务交给 Commander"),
            h("p", null, "直接描述目标、导入 Mission 文件，或告诉 Commander 文件在哪里。它会按原文理解、开房和调度。")),
          h("div", { className: "silver-split" },
            h("section", { className: "silver-card" },
              h("div", { className: "silver-between mobile-stack" }, h("div", null, h("h2", null, "任务输入"), h("p", null, "不要求模板，也不会预解析领域规则。")),
                segment([["text", "直接输入"], ["import", "导入文件"], ["file", "告诉它文件位置"]], missionInput, setMissionInput)),
              missionInput === "import" && h("div", { className: "silver-gap" },
                h("label", { className: "silver-label", htmlFor: "silver-mission-file" }, "选择本地 Mission 文本文件"),
                h("input", { id: "silver-mission-file", className: "silver-field silver-small-gap", type: "file",
                  accept: ".md,.markdown,.txt,.yaml,.yml,.json,text/plain,text/markdown", onChange: importMission }),
                importedFile && h("p", { className: "silver-help silver-small-gap" }, `已载入：${importedFile}`)),
              h("label", { className: "silver-label silver-gap", htmlFor: "silver-mission" },
                missionInput === "file" ? "对 Commander 说" : missionInput === "import" ? "Mission 原文 · 可检查和编辑" : "Mission 原文"),
              h("textarea", { id: "silver-mission", className: "silver-field silver-textarea silver-mission", value: mission,
                onChange: (event) => setMission(event.target.value),
                placeholder: missionInput === "file"
                  ? "请读取 /path/to/mission.md，按其中的任务、范围和验收规则执行。"
                  : "说明目标、范围、外部规则和验收条件；也可以直接把完整 Mission 粘贴在这里。" }),
              h("div", { className: "silver-between mobile-stack silver-gap" },
                h("span", { className: "silver-help" }, missionInput === "file" ? "这句话原样发给 Commander；文件由它用 DSH read 工具读取。" : missionInput === "import" ? "文件原文载入此处，启动时原样交给 Commander。" : "任务原文会交给 Commander。"),
                h("button", { className: "silver-btn primary", disabled: busy || !mission.trim() || !activeConfigId, onClick: start }, "启动任务 →"))),
            h("aside", null,
              h("section", { className: "silver-card" },
                h("h2", null, "本次运行"), h("p", null, "选择配置；保存设置后，新任务才使用修改。"),
                h("div", { className: "silver-gap" }, segment([["ctf", "长任务协作"]], mode, (value) => { setMode(value); setConfigId(""); })),
                h("label", { className: "silver-label silver-gap" }, "配置文件"), configPicker(),
                h("button", { className: "silver-btn quiet silver-gap", onClick: () => setPage("settings") }, "查看与修改设置 →")),
              facts && h("section", { className: "silver-card" }, h("h2", null, "当前配置摘要"),
                h("div", { className: "silver-metrics silver-small-gap" },
                  [["主模型", facts.model], ["任务执行者 初始 / 上限", facts.workers], ["并发房间", facts.rooms], ["执行位置", facts.execution]].map(([label, value]) =>
                    h("div", { key: label, className: "silver-metric" }, h("span", null, label), h("strong", null, value))))))))),

        page === "runs" && workbench(),

        page === "settings" && h("div", { className: "silver-shell silver-content" },
          h("div", { className: "silver-heading" }, h("div", { className: "silver-eyebrow" }, "Configuration"),
            h("h1", null, "运行设置"), h("p", null, "按能力调整模型、协作与执行环境；领域细节留在 Mission 或高级配置中。")),
          h("div", { className: "silver-between mobile-stack", style: { marginBottom: 20 } },
            h("div", { className: "silver-row" }, segment([["ctf", "长任务协作"]], mode, (value) => { setMode(value); setConfigId(""); }),
              h("div", { style: { minWidth: 220 } }, configPicker())),
            h("span", { className: "silver-help" }, "修改仅作用于之后启动的 Mission")),
          h("div", { className: "silver-settings" },
            h("nav", { className: "silver-settings-nav", "aria-label": "设置分组" },
              configGroups.map(([id, label]) =>
                h("button", { key: id, className: settingsGroup === id ? "active" : "", onClick: () => setSettingsGroup(id) }, label))),
            h("div", { className: "silver-settings-main" },
              h("section", { className: "silver-card" },
                h("h2", null, configGroups.find(([id]) => id === settingsGroup)?.[1]),
                h("p", null, settingsGroup === "advanced" ? "完整配置与注释。适合调整提供商、认证引用及未列出的高级字段。" : "每项说明它控制的范围；没有列出的字段可在高级 YAML 编辑。"),
                h("div", { className: "silver-gap" }, settingContent())),
              h("div", { className: "silver-settings-bar" },
                h("span", { className: "silver-help" }, dirty ? "有未保存修改" : "配置已保存"),
                h("div", { className: "silver-row" },
                  h("button", { className: "silver-btn", disabled: busy || dirty, onClick: reloadConfig }, "重新载入"),
                  dirty && h("button", { className: "silver-btn", onClick: () => { setDraft(config.settings); setConfigText(config.text); } }, "放弃修改"),
                  h("button", { className: "silver-btn primary", disabled: busy || !dirty || !config,
                    onClick: formDirty && yamlDirty ? () => setNotice("表单和 YAML 都有修改。请先保存或放弃其中一处修改。") : yamlDirty ? saveYaml : saveSettings }, "保存设置")))))));
    }

    function SilverIcon() { return h("span", { style: { fontSize: 18, lineHeight: 1, color: "var(--dsw-alias-state-business-primary, #4058d8)" } }, "S"); }
    return {
      inject: ["slots", "connection"],
      apply(ctx) {
        const call = (endpoint, payload) => ctx.connection.rpc.call("/api", `silver/${endpoint}`, payload);
        ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "silver" }, () => h(SilverPage, { call })));
        ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: "silver", order: 15, label: "Silver" }, SilverIcon));
      },
    };
  },
});
