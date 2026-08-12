// Minecraft Hex — 보드 렌더링 + 관전 클라이언트.
//
// 화면 구성과 보드는 목업을 그대로 옮겼습니다. 육각형은 clip-path 를 쓴 div 이고,
// 마름모 바깥 변만 절대 배치한 SVG 로 겹쳐 그립니다.

/** 모드가 붙는 API+WebSocket 포트. 리버스 프록시가 없을 때만 씁니다. */
const API_PORT = 8787;

/**
 * 관전 소켓 주소.
 *
 * HTTPS 로 열렸다면 앞에 리버스 프록시가 있다는 뜻입니다 — Node 는 TLS 를 직접 하지
 * 않습니다. 그때는 같은 오리진의 `/ws` 로 붙어야 합니다. 여기서 포트를 덧붙이면
 * `wss://도메인:8787/ws` 가 되는데, 그 포트에는 인증서가 없어 연결이 깨집니다.
 *
 * 평문일 때는 같은 Node 프로세스가 두 포트로 서비스합니다 — API+WS 는 [API_PORT],
 * 관전 보드는 :80. 페이지가 :80 에서 왔으면 소켓은 다른 포트로 붙어야 하고, 그 외
 * 포트에서 왔으면 그 포트가 곧 API 포트입니다(개발 중 임의 포트로 띄우는 경우).
 */
function defaultWsUrl() {
  if (location.protocol === "https:") return `wss://${location.host}/ws`;
  const port = location.port;
  const wsPort = port && port !== "80" ? port : API_PORT;
  return `ws://${location.hostname}:${wsPort}/ws`;
}

async function loadMissions() {
  const res = await fetch("/api/missions");
  const { missions } = await res.json();
  const map = new Map();
  for (const m of missions) map.set(m.id, m);
  return map;
}

/* ------------------------------------------------------------ 보드 그리기 */

/** 칸 색 — 목업 그대로. 난이도는 색으로 구분하지 않습니다. */
const TILE_COLORS = {
  none: { ring: "#252A32", bg: "#161A20", fg: "#8F98A4" },
  A: { ring: "#7BA0FC", bg: "#4A7BFA", fg: "#0B0D10" },
  B: { ring: "#DAA8FC", bg: "#C77CFA", fg: "#0B0D10" },
};
const SELECTED_RING = "#FFFFFF";

/**
 * 마름모 바깥 변. 좌표는 목업의 폴리라인을 그대로 옮긴 것이고(칸 너비 100 = --w),
 * 색만 실제 규칙에 맞췄습니다 — A 는 r=0 ↔ r=4(위아래), B 는 q=0 ↔ q=4(좌우).
 */
const BOUNDS = [
  { side: "a", points: "197.75,22.37 259,-12.99 311.25,17.18 363.5,-12.99 415.75,17.18 468,-12.99 520.25,17.18 572.5,-12.99 624.75,17.18 677,-12.99 738.25,22.37" },
  { side: "b", points: "738.25,22.37 738.25,93.1 686,123.26 686,183.59 633.75,213.76 633.75,274.09 581.5,304.25 581.5,364.58 529.25,394.75 529.25,455.08 468,490.44" },
  { side: "a", points: "468,490.44 415.75,460.27 363.5,490.44 311.25,460.27 259,490.44 206.75,460.27 154.5,490.44 102.25,460.27 50,490.44 -11.25,455.08" },
  { side: "b", points: "-11.25,455.08 -11.25,384.35 41,354.19 41,293.86 93.25,263.69 93.25,203.36 145.5,173.2 145.5,112.87 197.75,82.7 197.75,22.37" },
];

/**
 * 보드를 `holder` 안에 그립니다. 보드가 아직 없으면(대기 중인 방) 비워 둡니다 —
 * 빈 마름모 윤곽만 떠 있으면 매치가 시작된 것처럼 보입니다.
 */
export function renderBoard(holder, { board, claimed, missions, selected, onSelect } = {}) {
  holder.innerHTML = "";
  if (!board || board.length === 0) return;

  const claimedMap = new Map();
  for (const c of claimed ?? []) claimedMap.set(c.tileId, c);

  const rows = new Map();
  for (const tile of board) {
    if (!rows.has(tile.r)) rows.set(tile.r, []);
    rows.get(tile.r).push(tile);
  }
  const rowKeys = [...rows.keys()].sort((a, b) => a - b);
  // q 는 내림차순 — 행이 왼쪽으로 밀려 내려가므로, 어떤 칸의 오른쪽 아래에 그려지는
  // 칸이 서버 기준 이웃 (q-1, r+1) 이어야 합니다. q 오름차순은 판을 좌우로 뒤집어서,
  // 맞물려 보이는 칸이 실제로는 이웃이 아니고 하드 대각선도 서로 닿지 않게 됩니다.
  for (const k of rowKeys) rows.get(k).sort((a, b) => b.q - a.q);

  const grid = document.createElement("div");
  grid.className = "hexgrid";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "board-bounds");
  svg.setAttribute("viewBox", "-34 -34 795 546");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  for (const b of BOUNDS) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", b.points);
    line.setAttribute("class", b.side);
    line.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(line);
  }
  grid.appendChild(svg);

  // 목업과 같이 행들은 따로 감쌉니다. 경계선 SVG 가 절대 배치라 형제로 두면 첫 행의
  // 겹침 오프셋을 지우는 `:first-child` 가 SVG 쪽에 걸립니다.
  const stack = document.createElement("div");
  grid.appendChild(stack);

  rowKeys.forEach((k, idx) => {
    const row = document.createElement("div");
    row.className = "hrow";
    // 아래 행일수록 왼쪽으로 밀립니다. 5행이면 목업의 2.09 / 1.5675 / 1.045 / 0.5225 / 0.
    const shift = ((rowKeys.length - 1 - idx) * 0.5225).toFixed(4);
    row.style.marginLeft = `calc(var(--w) * ${shift})`;

    for (const tile of rows.get(k)) {
      const claim = claimedMap.get(tile.tileId);
      const color = TILE_COLORS[claim?.side ?? "none"] ?? TILE_COLORS.none;

      const cell = document.createElement("div");
      cell.className = "hcell";
      cell.style.background = selected === tile.tileId ? SELECTED_RING : color.ring;

      const inner = document.createElement("i");
      inner.style.background = color.bg;
      inner.style.color = color.fg;
      inner.textContent = (missions?.get(tile.missionId)?.displayName ?? tile.missionId).trim();

      cell.appendChild(inner);
      if (onSelect) cell.addEventListener("click", () => onSelect(tile.tileId));
      row.appendChild(cell);
    }
    stack.appendChild(row);
  });

  holder.appendChild(grid);
}

/* ------------------------------------------------- 관전·리플레이 공통 골격 */

/**
 * 목업의 관전 화면 마크업. 실시간 관전과 리플레이가 같은 틀을 쓰고, 다른 건 시계에
 * 무엇을 넣느냐와 보드 아래 재생 컨트롤이 붙느냐뿐입니다. `#board` 는 비워 두고
 * 호출한 쪽이 [renderBoard] 로 채웁니다.
 */
function specMarkup(vm, L) {
  const esc = escapeHtml;
  const sel = vm.sel;
  const left = vm.total - vm.a - vm.b;
  return `
    <a class="back" href="${vm.backHref}">${vm.backLabel}</a>
    <div class="spec">
      <div class="spec-main">
        <div class="spec-head">
          <div class="spec-vs">
            <div class="spec-p">
              <div class="nm"><span class="dot a"></span><span>${esc(vm.nameA)}</span></div>
              <div class="sub">${esc(vm.subA)}</div>
            </div>
            <div class="vs">vs</div>
            <div class="spec-p">
              <div class="nm"><span class="dot b"></span><span>${esc(vm.nameB)}</span></div>
              <div class="sub">${esc(vm.subB)}</div>
            </div>
          </div>
          <div class="spec-clock">
            <b>${esc(vm.clock)}</b>
            <span>${esc(vm.caption)}</span>
          </div>
        </div>

        <div class="board-hold" id="board"></div>

        ${vm.winner
          ? `<div class="winner"><span class="dot" style="background:${vm.winner.side === "B" ? "#C77CFA" : "#4A7BFA"}"></span><span>${esc(vm.winner.text)}</span></div>`
          : ""}

        ${vm.controls ?? ""}
      </div>

      <div class="spec-side">
        <div class="spec-sec">
          <div class="spec-k">${L.selTile}</div>
          <div class="sel-name">${esc(sel.label)}</div>
          ${sel.detail ? `<div class="sel-detail">${esc(sel.detail)}</div>` : ""}
          ${sel.coord ? `<div class="sel-chips"><span class="chip">${esc(sel.coord)}</span><span class="chip ${sel.ownerCls}">${esc(sel.owner)}</span></div>` : ""}
        </div>
        <div class="counts">
          <div>
            <div class="spec-k">${L.claimedK}</div>
            <div class="n"><span class="a">${vm.a}</span><span class="s">/</span><span class="b">${vm.b}</span></div>
          </div>
          <div class="prog">
            <div class="spec-k">${L.chainK}</div>
            <div class="bar"><i style="width:${vm.total ? Math.round(((vm.a + vm.b) / vm.total) * 100) : 0}%"></i></div>
            <div class="lbl">${left} / ${vm.total}</div>
          </div>
        </div>
        <div class="log">
          <div class="spec-k">${L.eventLog}</div>
          <ol>${vm.log.map((e) => logRow(e, L)).join("")}</ol>
        </div>
      </div>
    </div>
  `;
}

function logRow(e, L) {
  const esc = escapeHtml;
  const side = e.side.toLowerCase();
  return `
    <li>
      <span class="t">${esc(e.time)}</span>
      <span class="dot ${side}"></span>
      <span class="msg"><span class="who ${side}">${esc(e.who)}</span> ${esc(L.claimedVerb)} <span class="what">${esc(e.label)}</span></span>
    </li>`;
}

/** 선택한 칸의 오른쪽 패널 내용. 아직 아무것도 안 골랐으면 안내 문구만 나옵니다. */
function selectedInfo(tileId, board, claimed, missions, L) {
  const none = { label: L.pickTile, detail: "", coord: "", owner: "", ownerCls: "" };
  if (!tileId) return none;
  const tile = board.find((t) => t.tileId === tileId);
  if (!tile) return none;
  const claim = claimed.find((c) => c.tileId === tileId);
  return {
    label: missions.get(tile.missionId)?.displayName ?? tile.missionId,
    detail: tile.difficulty.toUpperCase(),
    coord: tile.tileId,
    owner: claim ? `${claim.side} ${L.claimedVerb.replace("·", "").trim()}` : L.unclaimed,
    ownerCls: claim ? claim.side.toLowerCase() : "",
  };
}

function countSides(claimed) {
  let a = 0, b = 0;
  for (const c of claimed) (c.side === "A" ? a++ : b++);
  return { a, b };
}

/** mm:ss. 리플레이는 매치 시작 기준 경과, 관전은 현재 시각 기준 경과를 넣습니다. */
function mmss(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/* ---------------------------------------------------------------- 관전 */

/**
 * 관전 UI 를 붙이고 방에 접속합니다. 정리 함수를 돌려줍니다.
 *
 * `L` 은 app.js 의 문구 사전, `lang` 은 시간 표기용입니다.
 */
export function mountSpectator(container, roomCode, L, lang) {
  const s = {
    ws: null,
    roomCode,
    missions: new Map(),
    board: [],
    claimed: [],
    status: "waiting",
    startedAt: null,
    players: { A: null, B: null },
    selected: null,
    conn: "",
    /** Set when the server says there is no such room — a dead end, not a hiccup. */
    gone: false,
    winner: null,
    log: [],
    tick: null,
  };

  const nameOf = (side) => s.players[side]?.name ?? "—";
  const eloOf = (side) => (s.players[side]?.elo != null ? `${s.players[side].elo} ELO · ` : "");

  function clockText() {
    if (!s.startedAt || s.status !== "playing") return "--:--";
    return mmss(Date.now() - s.startedAt);
  }

  function draw() {
    // A code that matches nothing needs to say so plainly. Rendering an empty board with
    // an apologetic caption under the clock reads as "loading", and never stops.
    if (s.gone) {
      container.innerHTML = `
        <a class="back" href="#/live">${L.backLive}</a>
        <div class="rows"><div class="row" style="cursor:default">
          <div class="state" style="width:100%">${escapeHtml(L.noSuchRoom.replace("%s", s.roomCode))}</div>
        </div></div>`;
      return;
    }

    const { a, b } = countSides(s.claimed);

    container.innerHTML = specMarkup({
      backHref: "#/live", backLabel: L.backLive,
      nameA: nameOf("A"), subA: eloOf("A") + L.dirA,
      nameB: nameOf("B"), subB: eloOf("B") + L.dirB,
      clock: clockText(),
      caption: s.conn || L.roomWord + s.roomCode,
      winner: s.winner,
      sel: selectedInfo(s.selected, s.board, s.claimed, s.missions, L),
      a, b, total: s.board.length || 25,
      log: s.log,
    }, L);

    renderBoard(container.querySelector("#board"), {
      board: s.board,
      claimed: s.claimed,
      missions: s.missions,
      selected: s.selected,
      onSelect: (id) => { s.selected = id; draw(); },
    });
  }

  function pushLog(claim) {
    const m = s.missions.get(claim.missionId);
    s.log.unshift({
      time: new Date(claim.claimedAt).toLocaleTimeString(lang === "ko" ? "ko-KR" : "en-GB", { hour12: false, hour: "2-digit", minute: "2-digit" }),
      side: claim.side,
      who: s.players[claim.side]?.name ?? claim.side,
      label: m?.displayName ?? claim.missionId,
    });
    if (s.log.length > 40) s.log.pop();
  }

  function handle(msg) {
    switch (msg.type) {
      case "error":
        if (msg.code === "room_not_found") s.gone = true;
        s.conn = msg.message;
        draw();
        return;
      case "room_state":
        s.roomCode = msg.roomCode;
        s.status = msg.status;
        if (msg.you) s.players[msg.you.side] = msg.you;
        if (msg.opponent) s.players[msg.opponent.side] = msg.opponent;
        draw(); return;
      case "match_start":
        s.status = "playing";
        s.board = msg.board;
        s.claimed = msg.claimed ?? [];
        s.startedAt = msg.startsAt;
        s.winner = null;
        draw(); return;
      case "tile_claimed":
        s.claimed = s.claimed.filter((c) => c.tileId !== msg.tileId);
        s.claimed.push({ tileId: msg.tileId, side: msg.side, missionId: msg.missionId, claimedAt: msg.claimedAt });
        pushLog(msg);
        draw(); return;
      case "match_end": {
        s.status = "ended";
        const who = msg.winner ? (s.players[msg.winner]?.name ?? msg.winner) : null;
        s.winner = {
          side: msg.winner ?? "A",
          text: who
            ? (lang === "ko" ? `${who} 승리 — 경기 종료 (${msg.reason})` : `${who} wins — match over (${msg.reason})`)
            : (lang === "ko" ? `경기 종료 (${msg.reason})` : `Match over (${msg.reason})`),
        };
        draw(); return;
      }
      default:
        return;
    }
  }

  function connect() {
    s.conn = lang === "ko" ? "연결 중…" : "connecting…";
    const ws = new WebSocket(defaultWsUrl());
    s.ws = ws;
    ws.onopen = () => {
      s.conn = "";
      ws.send(JSON.stringify({ type: "spectate", roomCode: s.roomCode }));
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    };
    ws.onclose = () => { s.conn = lang === "ko" ? "연결 끊김" : "disconnected"; draw(); };
    ws.onerror = () => { s.conn = lang === "ko" ? "연결 오류" : "connection error"; draw(); };
  }

  draw();
  loadMissions()
    .then((m) => { s.missions = m; draw(); connect(); })
    .catch(() => { s.conn = lang === "ko" ? "미션 목록 로드 실패" : "failed to load objectives"; draw(); });

  // 경과 시간만 1초마다 갱신합니다.
  s.tick = setInterval(() => {
    const el = container.querySelector(".spec-clock b");
    if (el) el.textContent = clockText();
  }, 1000);

  return () => {
    if (s.tick) clearInterval(s.tick);
    if (s.ws) { try { s.ws.close(); } catch {} s.ws = null; }
  };
}

/* -------------------------------------------------------------- 리플레이 */

/** 자동 재생 시 한 수당 머무는 시간. 목업의 900ms 를 그대로 씁니다. */
const REPLAY_STEP_MS = 900;

/**
 * 끝난 경기를 되감아 봅니다. 관전과 같은 틀에 보드 아래 재생 컨트롤이 붙습니다.
 *
 * `step` 은 "지금까지 놓인 수의 개수"입니다 — 0 이면 빈 판, 마지막이면 최종 국면.
 * 정리 함수를 돌려줍니다.
 */
export function mountReplay(container, matchId, L, lang) {
  const s = {
    data: null,
    missions: new Map(),
    step: 0,
    playing: false,
    selected: null,
    timer: null,
    error: "",
  };

  const stateLine = (msg) => `<div class="wrap"><div class="state">${escapeHtml(msg)}</div></div>`;

  function stop() {
    if (s.timer) { clearInterval(s.timer); s.timer = null; }
    s.playing = false;
  }

  function play() {
    if (s.playing) return stop();
    // 끝에서 재생을 누르면 처음부터 다시 봅니다.
    if (s.step >= s.data.claims.length) s.step = 0;
    s.playing = true;
    s.timer = setInterval(() => {
      if (s.step >= s.data.claims.length) { stop(); draw(); return; }
      s.step++;
      draw();
    }, REPLAY_STEP_MS);
  }

  /** 지금 step 까지의 점령 목록. 되감기가 있으니 매번 앞에서부터 자릅니다. */
  function claimsNow() {
    return s.data.claims.slice(0, s.step);
  }

  function clockText() {
    if (s.step === 0 || !s.data.startedAt) return "00:00";
    const last = s.data.claims[s.step - 1];
    return mmss((last?.claimedAt ?? s.data.startedAt) - s.data.startedAt);
  }

  function winnerBanner() {
    // 마지막 수까지 감았을 때만 결과를 밝힙니다 — 중간에 띄우면 스포일러입니다.
    if (s.step < s.data.claims.length) return null;
    const side = s.data.winnerSide;
    const who = side ? (s.data.players[side]?.name ?? side) : null;
    const reason = s.data.reason ?? "";
    return {
      side: side ?? "A",
      text: who
        ? (lang === "ko" ? `${who} 승리 — 경기 종료 (${reason})` : `${who} wins — match over (${reason})`)
        : (lang === "ko" ? `무승부로 종료 (${reason})` : `Ended with no winner (${reason})`),
    };
  }

  function controls() {
    const total = s.data.claims.length;
    return `
      <div class="pb">
        <button class="pb-btn" id="pbPlay" type="button"
                aria-label="${s.playing ? L.pause : L.play}">${s.playing ? "❚❚" : "▶"}</button>
        <input class="pb-range" id="pbRange" type="range" min="0" max="${total}" step="1" value="${s.step}" />
        <div class="pb-lbl">${s.step} / ${total}</div>
      </div>
    `;
  }

  function nameOf(side) {
    return s.data.players[side]?.name ?? "—";
  }

  /** 레이팅은 이 경기 결과가 반영된 값을 쓰되, 무산정 경기면 표시하지 않습니다. */
  function eloOf(side) {
    const p = s.data.players[side];
    const elo = p?.eloAfter ?? p?.eloBefore;
    return elo != null ? `${elo} ELO · ` : "";
  }

  function logEntries() {
    return claimsNow()
      .slice()
      .reverse()
      .map((c) => ({
        time: s.data.startedAt ? mmss(c.claimedAt - s.data.startedAt) : "--:--",
        side: c.side,
        who: nameOf(c.side),
        label: s.missions.get(c.missionId)?.displayName ?? c.missionId,
      }));
  }

  function draw() {
    if (s.error) { container.innerHTML = stateLine(s.error); return; }
    if (!s.data) { container.innerHTML = stateLine(L.loading); return; }

    const claimed = claimsNow();
    const { a, b } = countSides(claimed);
    const dateLine = new Date(s.data.endedAt).toLocaleDateString(lang === "ko" ? "ko-KR" : "en-GB");

    container.innerHTML = specMarkup({
      backHref: "#/replays", backLabel: L.backReplays,
      nameA: nameOf("A"), subA: eloOf("A") + L.dirA,
      nameB: nameOf("B"), subB: eloOf("B") + L.dirB,
      clock: clockText(),
      caption: `${s.data.rated ? L.tagRanked : L.tagCasual} · ${dateLine}`,
      winner: winnerBanner(),
      sel: selectedInfo(s.selected, s.data.board, claimed, s.missions, L),
      a, b, total: s.data.board.length || 25,
      log: logEntries(),
      controls: controls(),
    }, L);

    renderBoard(container.querySelector("#board"), {
      board: s.data.board,
      claimed,
      missions: s.missions,
      selected: s.selected,
      onSelect: (id) => { s.selected = id; draw(); },
    });

    container.querySelector("#pbPlay")?.addEventListener("click", () => { play(); draw(); });
    const range = container.querySelector("#pbRange");
    range?.addEventListener("input", (ev) => {
      stop();
      s.step = Number(ev.target.value);
      draw();
      // 다시 그리면 노브가 사라지므로 초점을 되돌려 드래그가 이어지게 합니다.
      container.querySelector("#pbRange")?.focus();
    });
  }

  draw();
  Promise.all([loadMissions(), fetchReplay(matchId)])
    .then(([missions, data]) => { s.missions = missions; s.data = data; draw(); })
    .catch((err) => { s.error = err?.message === "not_found" ? L.replayGone : L.replayFailed; draw(); });

  return () => stop();
}

async function fetchReplay(id) {
  const res = await fetch(`/api/matches/${encodeURIComponent(id)}/replay`);
  if (!res.ok) throw new Error(res.status === 404 ? "not_found" : "failed");
  return res.json();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export { loadMissions, escapeHtml, mmss };
