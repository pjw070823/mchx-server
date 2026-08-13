// Minecraft Hex — 웹 UI.
//
// 화면 구성과 문구는 목업(Minecraft Hex.dc.html)을 그대로 옮긴 것이고, 값만 실제
// API 에서 옵니다. 목업이 자리표시자로 채워 둔 숫자(누적 판수, 평균 시간 등)는
// 지어내지 않고 실제로 계산되는 것만 보여줍니다.

import { mountSpectator, mountReplay, escapeHtml, mmss } from "/board.js";

const app = document.getElementById("app");

/* ------------------------------------------------------------------ 상태 */

const state = {
  page: "home",
  lang: localStorage.getItem("mchx.lang") || "ko",
  spectate: null,
  os: detectOs(),
  codeInput: "",
  codeError: false,
  rooms: [],
  replays: [],
  replaysTotal: null,
  ranks: [],
  ranksTotal: null,
  // 1-based, per list. Reset on route entry, moved only by the pager.
  pages: { live: 1, replays: 1, ranks: 1 },
  stats: { pool: "—", players: "—", matches: "—" },
  // 설치 페이지가 광고할 빌드. 서버가 접속을 허용하는 그 값과 같은 곳에서 옵니다 —
  // 페이지 소스에 버전을 박아두면 사이트와 서버가 서로 다른 빌드를 말하게 됩니다.
  release: null,
};

function detectOs() {
  const p = navigator.platform || "";
  if (/Mac/i.test(p)) return "mac";
  if (/Linux/i.test(p) && !/Android/i.test(navigator.userAgent)) return "linux";
  return "win";
}

/* ------------------------------------------------------------------- 문구 */

const T = {
  ko: {
    nav1: "소개", nav3: "라이브", nav4: "랭킹", nav5: "설치", getMod: "모드 받기",
    ctaWatch: "라이브 보러 가기", ctaDl: "모드 내려받기",
    statPool: "전체 목표", statPlayers: "등록 플레이어", statPlayed: "누적 판수",
    rulesKicker: "규칙", rulesH: "목표 25개짜리 판 하나, 먼저 잇는 쪽이 이깁니다.",
    r1: "64개 목표 중 25개가 뽑혀 5×5 육각 판에 깔립니다. 두 사람 모두 같은 판, 같은 시드로 시작합니다.",
    r2: "목표를 깨면 그 칸이 내 색으로 넘어옵니다. 턴 순서도 없고, 한 번 넘어간 칸은 다시 뺏기지 않습니다.",
    r3: "한쪽은 위아래, 다른 쪽은 좌우를 잇습니다. 자기 두 변이 끊김 없이 연결되는 순간 판이 끝납니다.",
    kLive: "라이브", liveH: "진행 중인 판", noLive: "지금 열려 있는 판이 없습니다.",
    kPrivate: "비공개 경기", codePh: "코드", codeBtn: "보기",
    codeNote: "비공개 판은 목록에 뜨지 않습니다. 받은 코드를 입력하세요.",
    codeErr: "그 코드로 열린 판이 없습니다.",
    noSuchRoom: "%s — 그런 방이 없습니다. 코드를 다시 확인해 주세요.",
    backLive: "← 라이브 목록",
    tagRanked: "랭크", tagCasual: "일반", tagWaiting: "대기",
    watch: "보기 →", waiting: "대기 중",
    selTile: "선택한 칸", claimedK: "점령 현황", chainK: "남은 칸", eventLog: "이벤트 로그",
    claimedVerb: "점령 ·", unclaimed: "빈 칸", pickTile: "칸을 누르면 목표가 보입니다.",
    roomWord: "방 ", dirA: "위 ↕ 아래", dirB: "좌 ↔ 우",
    nav6: "리플레이", kReplays: "기록", replaysH: "지난 경기 다시 보기",
    replaysNote: "끝난 판은 처음부터 되감아 볼 수 있습니다. 한 수씩 넘기거나 재생을 눌러 두면 순서대로 놓입니다.",
    noReplays: "아직 끝난 판이 없습니다.",
    backReplays: "← 지난 경기 목록", openReplay: "다시 보기 →",
    play: "재생", pause: "일시정지", loading: "불러오는 중…",
    replayGone: "그 경기 기록을 찾을 수 없습니다.", replayFailed: "기록을 불러오지 못했습니다.",
    drawTag: "무승부", winTag: "승",
    kSeason: "랭킹", ranksH: "레이팅 순위표", noRanks: "아직 기록된 플레이어가 없습니다.",
    thRank: "순위", thPlayer: "플레이어", thWl: "전적", thPct: "승률",
    prev: "이전", next: "다음",
    kInstall: "설치", dlH: "클라이언트 모드 내려받기",
    dlP: "모드는 직접 플레이할 때만 필요합니다. 라이브는 아무것도 깔지 않아도 볼 수 있습니다.",
    relLine: "패브릭 · 마인크래프트 26.1.2",
    dlJar: "jar 내려받기", changelog: "커밋 기록", dlSize: "MB",
    requires: "필요한 것", notRequired: "필요 없는 것",
    nr1: "따로 돌릴 서버", nr2: "별도 계정 — 마인크래프트 계정으로 인증합니다", nr3: "라이브 시청용 설치",
    footer: "MINECRAFT HEX · 유저 제작 프로젝트 · MOJANG 과 무관합니다",
    stepsTitle: "설치 순서",
  },
  en: {
    nav1: "Overview", nav3: "Live", nav4: "Ranks", nav5: "Install", getMod: "Get the mod",
    ctaWatch: "Watch a live match", ctaDl: "Get the client mod",
    statPool: "OBJECTIVE POOL", statPlayers: "RATED PLAYERS", statPlayed: "MATCHES PLAYED",
    rulesKicker: "THE RULES", rulesH: "Twenty-five objectives, one board, two edges to link.",
    r1: "Twenty-five objectives are drawn from a pool of 64 and dealt onto a 5×5 hex board. Both players get the same board and the same world seed.",
    r2: "Finishing an objective claims its tile. There is no turn order, nothing to spend, and a tile cannot be taken back once it is claimed.",
    r3: "One player links top to bottom, the other left to right. First unbroken run of tiles between your own two edges ends the match.",
    kLive: "LIVE", liveH: "Live boards", noLive: "No boards are running right now.",
    kPrivate: "PRIVATE MATCH", codePh: "CODE", codeBtn: "Watch",
    codeNote: "Private boards are never listed. Enter the code the players gave you.",
    codeErr: "No live board is running on that code.",
    noSuchRoom: "%s — no such room. Check the code and try again.",
    backLive: "← ALL LIVE MATCHES",
    tagRanked: "RANKED", tagCasual: "CASUAL", tagWaiting: "WAITING",
    watch: "Watch →", waiting: "waiting",
    selTile: "SELECTED TILE", claimedK: "CLAIMED", chainK: "TILES LEFT", eventLog: "EVENT LOG",
    claimedVerb: "claimed", unclaimed: "unclaimed", pickTile: "Pick a tile to read its objective.",
    roomWord: "ROOM ", dirA: "top ↕ bottom", dirB: "left ↔ right",
    nav6: "Replays", kReplays: "ARCHIVE", replaysH: "Watch a finished match",
    replaysNote: "Every finished board can be replayed from the first claim. Step through it, or hit play and let it deal itself out.",
    noReplays: "No finished matches yet.",
    backReplays: "← ALL REPLAYS", openReplay: "Replay →",
    play: "Play", pause: "Pause", loading: "Loading…",
    replayGone: "No record of that match.", replayFailed: "Could not load that replay.",
    drawTag: "DRAW", winTag: "WON",
    kSeason: "LADDER", ranksH: "Rated leaderboard", noRanks: "No rated players yet.",
    thRank: "RANK", thPlayer: "PLAYER", thWl: "W / L", thPct: "WIN %",
    prev: "Prev", next: "Next",
    kInstall: "INSTALL", dlH: "Get the client mod",
    dlP: "You only need the mod to play. Watching boards on this site needs nothing installed.",
    relLine: "Fabric · Minecraft 26.1.2",
    dlJar: "Download jar", changelog: "Commits", dlSize: "MB",
    requires: "REQUIRES", notRequired: "NOT REQUIRED",
    nr1: "A server to host", nr2: "A separate account — your Minecraft account signs you in", nr3: "Anything installed to watch",
    stepsTitle: "INSTALL STEPS",
    footer: "MINECRAFT HEX · COMMUNITY PROJECT · NOT AFFILIATED WITH MOJANG",
  },
};
const t = () => T[state.lang];

const OS_STEPS = {
  ko: {
    win: [
      { n: "01", title: "패브릭 로더 설치", body: "패브릭 인스톨러를 실행하고 26.1.2 를 고르면 런처에 프로필이 하나 새로 생깁니다." },
      { n: "02", title: "의존 모드 두 개 넣기", body: "Fabric API 와 Fabric Language Kotlin 을 mods 폴더에 넣습니다. 둘 중 하나라도 없으면 모드가 로드되지 않습니다.", cmd: "%appdata%\\.minecraft\\mods" },
      { n: "03", title: "mchx 넣기", body: "같은 폴더에 mchx jar 을 추가합니다. 타이틀 화면에 MCHX 로비 버튼이 생기면 정상입니다." },
      { n: "04", title: "접속할 서버 바꾸기 (선택)", body: "기본값은 공식 서버입니다. 직접 띄운 서버를 쓸 때만 고치면 됩니다.", cmd: '{"serverUrl":"ws://내서버:8787/ws"}' },
    ],
    mac: [
      { n: "01", title: "패브릭 로더 설치", body: "패브릭 인스톨러를 실행하고 26.1.2 를 고릅니다." },
      { n: "02", title: "의존 모드 두 개 넣기", body: "Fabric API 와 Fabric Language Kotlin 을 mods 폴더에 넣습니다.", cmd: "~/Library/Application Support/minecraft/mods" },
      { n: "03", title: "mchx 넣기", body: "같은 폴더에 추가합니다. 실행이 막히면 우클릭 후 열기를 한 번만 해 주면 됩니다." },
      { n: "04", title: "접속할 서버 바꾸기 (선택)", body: "config/mchx.json 을 고칩니다.", cmd: '{"serverUrl":"ws://내서버:8787/ws"}' },
    ],
    linux: [
      { n: "01", title: "패브릭 로더 설치", body: "터미널로 깔아도 됩니다. 버전만 명시해 주세요.", cmd: "java -jar fabric-installer.jar client -mcversion 26.1.2" },
      { n: "02", title: "의존 모드 두 개 넣기", body: "Fabric API 와 Fabric Language Kotlin 을 mods 폴더에 넣습니다.", cmd: "~/.minecraft/mods" },
      { n: "03", title: "mchx 넣기", body: "같은 폴더에 mchx jar 을 추가합니다." },
      { n: "04", title: "접속할 서버 바꾸기 (선택)", body: "config/mchx.json 을 고칩니다.", cmd: '{"serverUrl":"ws://내서버:8787/ws"}' },
    ],
  },
  en: {
    win: [
      { n: "01", title: "Install Fabric Loader", body: "Run the Fabric installer and pick Minecraft 26.1.2. It writes a new profile into your launcher." },
      { n: "02", title: "Drop in both dependencies", body: "Fabric API and Fabric Language Kotlin both go in the mods folder. The mod will not load without them.", cmd: "%appdata%\\.minecraft\\mods" },
      { n: "03", title: "Add mchx", body: "Put the mchx jar in the same folder. You'll see an MCHX button on the title screen." },
      { n: "04", title: "Point at another server (optional)", body: "Only needed if you run your own.", cmd: '{"serverUrl":"ws://your-host:8787/ws"}' },
    ],
    mac: [
      { n: "01", title: "Install Fabric Loader", body: "Run the Fabric installer and pick Minecraft 26.1.2." },
      { n: "02", title: "Drop in both dependencies", body: "Fabric API and Fabric Language Kotlin both go in the mods folder.", cmd: "~/Library/Application Support/minecraft/mods" },
      { n: "03", title: "Add mchx", body: "Same folder. If Gatekeeper blocks it, right-click and Open once." },
      { n: "04", title: "Point at another server (optional)", body: "Edit config/mchx.json.", cmd: '{"serverUrl":"ws://your-host:8787/ws"}' },
    ],
    linux: [
      { n: "01", title: "Install Fabric Loader", body: "A headless install works fine. Pass the version explicitly.", cmd: "java -jar fabric-installer.jar client -mcversion 26.1.2" },
      { n: "02", title: "Drop in both dependencies", body: "Fabric API and Fabric Language Kotlin both go in the mods folder.", cmd: "~/.minecraft/mods" },
      { n: "03", title: "Add mchx", body: "Put the mchx jar in the same folder." },
      { n: "04", title: "Point at another server (optional)", body: "Edit config/mchx.json.", cmd: '{"serverUrl":"ws://your-host:8787/ws"}' },
    ],
  },
};

/* ------------------------------------------------------------------ 유틸 */

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function clock(fromMs) {
  if (!fromMs) return "--:--";
  const s = Math.max(0, Math.floor((Date.now() - fromMs) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function pct(n, total) {
  if (!total) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

/* ------------------------------------------------------- 헤더 / 푸터 / 셸 */

function header() {
  const L = t();
  const on = (p) => (state.page === p ? " on" : "");
  const live = state.rooms.length;
  return `
    <div class="hdr">
      <a class="hdr-brand" href="#/" aria-label="MINECRAFT HEX">
        <img class="hdr-logo" src="/logo.png" alt="MINECRAFT HEX" width="41" height="36" />
      </a>
      <nav class="hdr-nav">
        <a href="#/"${on("home") ? ' class="on"' : ""}>${L.nav1}</a>
        <a href="#/live"${on("live") || on("spectate") ? ' class="on"' : ""}>${L.nav3}</a>
        <a href="#/replays"${on("replays") || on("replay") ? ' class="on"' : ""}>${L.nav6}</a>
        <a href="#/ranks"${on("ranks") ? ' class="on"' : ""}>${L.nav4}</a>
        <a href="#/install"${on("install") ? ' class="on"' : ""}>${L.nav5}</a>
      </nav>
      <div class="hdr-right">
        <div class="lang">
          <button data-lang="en" class="${state.lang === "en" ? "on" : ""}">EN</button>
          <button data-lang="ko" class="${state.lang === "ko" ? "on" : ""}">한국어</button>
        </div>
        <a class="cta" href="#/install">${L.getMod}</a>
      </div>
    </div>
  `;
}

function footer() {
  const L = t();
  return `
    <div class="ftr">
      <span class="mark"></span>
      <span class="txt">${L.footer}</span>
    </div>
  `;
}

function render(body) {
  app.innerHTML = header() + body + footer();
  app.querySelectorAll(".lang button").forEach((b) =>
    b.addEventListener("click", () => {
      state.lang = b.dataset.lang;
      localStorage.setItem("mchx.lang", state.lang);
      route();
    }),
  );
}

/* -------------------------------------------------------------- 화면: 소개 */

function heroHexes() {
  // 장식용 격자. 파랑이 세로로, 보라가 가로로 이어지는 모습을 미리 보여줍니다.
  const own = { 6: "a", 12: "a", 13: "a", 7: "b", 2: "b", 18: "b", 19: "b" };
  let rows = "";
  for (let r = 0; r < 5; r++) {
    let cells = "";
    for (let c = 0; c < 5; c++) {
      const o = own[r * 5 + c];
      const ring = o === "a" ? "#4A7BFA" : o === "b" ? "#C77CFA" : "#1E232B";
      const bg = o === "a" ? "#16224a" : o === "b" ? "#2a1c45" : "#0E1116";
      cells += `<div class="hcell" style="background:${ring}"><i style="background:${bg}"></i></div>`;
    }
    rows += `<div class="hrow" style="margin-left:calc((var(--w) + 3px) * ${(4 - r) / 2})">${cells}</div>`;
  }
  return `<div class="hexgrid">${rows}</div>`;
}

function pageHome() {
  const L = t();
  const s = state.stats;
  return `
    <div class="hero">
      <div>
        <img class="hero-logo" src="/logo.png" alt="MINECRAFT HEX" width="321" height="280" />
        <div class="hero-btns">
          <a class="cta cta-lg" href="#/live">${L.ctaWatch}</a>
          <a class="cta-ghost" href="#/install">${L.ctaDl}</a>
        </div>
        <div class="hero-stats">
          <div><b>${s.pool}</b><span>${L.statPool}</span></div>
          <div><b>${s.matches}</b><span>${L.statPlayed}</span></div>
          <div><b>${s.players}</b><span>${L.statPlayers}</span></div>
        </div>
      </div>
      <div class="hero-art">${heroHexes()}</div>
    </div>

    <div class="rules">
      <div>
        <div class="kick">${L.rulesKicker}</div>
        <h2>${L.rulesH}</h2>
      </div>
      <div class="rules-body">
        <div class="rule"><i>01</i><p>${L.r1}</p></div>
        <div class="rule"><i>02</i><p>${L.r2}</p></div>
        <div class="rule"><i>03</i><p>${L.r3}</p></div>
      </div>
    </div>
  `;
}

async function loadStats() {
  const [m, mm, lb] = await Promise.all([
    api("/api/missions").catch(() => null),
    api("/api/matches?limit=1").catch(() => null),
    api("/api/leaderboard?limit=200").catch(() => null),
  ]);
  state.stats = {
    pool: m ? String(m.missions.length) : "—",
    matches: mm && mm.total != null ? String(mm.total) : "—",
    players: lb ? String(lb.players.length) : "—",
  };
}

/* -------------------------------------------------------------- 화면: 라이브 */

function matchRow(room) {
  const L = t();
  const a = (room.players ?? []).find((p) => p.side === "A");
  const b = (room.players ?? []).find((p) => p.side === "B");
  const playing = room.status === "playing";
  const size = room.boardSize || 25;
  // 랭크 여부는 방이 어떻게 만들어졌는지로 정해집니다. 예전에는 설정 토글을 봤는데,
  // 커스텀 방이 레이팅에 반영되지 않게 되면서 그 토글 자체가 없어졌습니다.
  const ranked = room.origin === "ranked";
  const tag = !playing ? L.tagWaiting : ranked ? L.tagRanked : L.tagCasual;
  const tagCls = !playing ? "private" : ranked ? "ranked" : "private";

  const side = (p, cls) => p
    ? `<div class="row-p"><span class="dot ${cls}"></span><span class="nm">${escapeHtml(p.name ?? "")}</span><span class="el">${p.elo ?? "—"}</span></div>`
    : `<div class="row-p"><span class="dot ${cls}" style="opacity:.35"></span><span class="el">${L.waiting}</span></div>`;

  return `
    <a class="row" href="#/board/${encodeURIComponent(room.code)}">
      <div class="row-tag ${tagCls}">${tag}</div>
      <div class="row-players">
        ${side(a, "a")}
        <span class="row-vs">vs</span>
        ${side(b, "b")}
      </div>
      <div class="row-prog">
        <div class="row-bar">
          <div class="a" style="width:${pct(room.claimedA ?? 0, size)}"></div>
          <div class="b" style="width:${pct(room.claimedB ?? 0, size)}"></div>
        </div>
        <div class="row-tiles">${room.claimedA ?? 0}–${room.claimedB ?? 0} · ${size}${state.lang === "ko" ? "칸" : " tiles"}</div>
      </div>
      <div class="row-clock">${playing ? clock(room.startedAt) : "--:--"}</div>
      <div class="row-watch">${L.watch}</div>
    </a>
  `;
}

function pageLive() {
  const L = t();
  const from = (state.pages.live - 1) * PAGE;
  const rooms = state.rooms.slice(from, from + PAGE);
  return `
    <div class="wrap">
      <div class="live-top">
        <div>
          <div class="kick live-kick"><span>${L.kLive}</span><span class="bar"></span></div>
          <h2 class="h-lg">${L.liveH}</h2>
        </div>
        <div style="flex:0 1 auto;min-width:0">
          <div class="kick" style="font-size:10.5px;letter-spacing:.16em">${L.kPrivate}</div>
          <form class="code-row" id="codeForm">
            <input class="code-in${state.codeError ? " bad" : ""}" id="codeIn" maxlength="4"
                   placeholder="${L.codePh}" autocomplete="off" value="${escapeHtml(state.codeInput)}" />
            <button class="code-btn" type="submit">${L.codeBtn}</button>
          </form>
          <div class="code-note${state.codeError ? " bad" : ""}">${state.codeError ? L.codeErr : L.codeNote}</div>
        </div>
      </div>
      ${rooms.length
        ? `<div class="rows">${rooms.map(matchRow).join("")}</div>`
        : `<div class="rows"><div class="row" style="cursor:default"><div class="state" style="width:100%">${L.noLive}</div></div></div>`}
      ${pager("live", state.pages.live, state.rooms.length)}
    </div>
  `;
}

function wireLive() {
  const form = document.getElementById("codeForm");
  if (!form) return;
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const code = (document.getElementById("codeIn").value || "").trim().toUpperCase();
    if (code.length !== 4) return;
    state.codeInput = code;
    state.codeError = false;
    // 목록과 대조하지 않고 그대로 넘깁니다. 이 입력창의 안내문 자체가 "비공개 판은
    // 목록에 뜨지 않는다"고 말하는데, 목록에 있어야만 통과시키면 앞뒤가 맞지 않습니다.
    // 끝난 랭크 방도 마찬가지로 목록에서 빠지지만 수거 전까지는 관전할 수 있습니다.
    // 방이 있는지 아는 건 서버뿐이므로, 판단은 관전 소켓에 맡깁니다.
    location.hash = `#/board/${code}`;
  });
}

/* ---------------------------------------------------------- 화면: 리플레이 */

function replayRow(m) {
  const L = t();
  const size = m.boardSize || 25;
  const a = m.players?.A ?? {};
  const b = m.players?.B ?? {};
  const tag = m.rated ? L.tagRanked : L.tagCasual;
  const dur = m.startedAt && m.endedAt ? mmss(m.endedAt - m.startedAt) : "--:--";

  // 승자 쪽 이름에 점을 채워 표시합니다. 목록만 보고도 결과를 알 수 있어야 합니다.
  const side = (p, cls, won) => `
    <div class="row-p">
      <span class="dot ${cls}"${won ? "" : ' style="opacity:.35"'}></span>
      <span class="nm">${escapeHtml(p.name ?? "—")}</span>
      <span class="el">${p.elo ?? "—"}</span>
    </div>`;

  return `
    <a class="row" href="#/replay/${m.id}">
      <div class="row-tag ${m.rated ? "ranked" : "private"}">${tag}</div>
      <div class="row-players">
        ${side(a, "a", m.winnerSide === "A")}
        <span class="row-vs">vs</span>
        ${side(b, "b", m.winnerSide === "B")}
      </div>
      <div class="row-prog">
        <div class="row-bar">
          <div class="a" style="width:${pct(m.claimedA ?? 0, size)}"></div>
          <div class="b" style="width:${pct(m.claimedB ?? 0, size)}"></div>
        </div>
        <div class="row-tiles">${m.claimedA ?? 0}–${m.claimedB ?? 0} · ${size}${state.lang === "ko" ? "칸" : " tiles"}</div>
      </div>
      <div class="row-clock">${dur}</div>
      <div class="row-watch">${L.openReplay}</div>
    </a>
  `;
}

/** 한 화면에 올리는 줄 수. 세 목록이 같은 값을 씁니다. */
const PAGE = 20;

const pageCount = (total) => Math.max(1, Math.ceil((total ?? 0) / PAGE));

/**
 * 이전 / n · N / 다음.
 *
 * 한 쪽뿐이면 아무것도 그리지 않습니다 — 누를 데가 없는 컨트롤은 없느니만 못합니다.
 */
function pager(key, page, total) {
  const pages = pageCount(total);
  if (pages <= 1) return "";
  const L = t();
  return `
    <div class="pager" data-pager="${key}">
      <button type="button" data-go="${page - 1}"${page <= 1 ? " disabled" : ""}>‹ ${L.prev}</button>
      <span class="pager-at">${page} <i>/</i> ${pages}</span>
      <button type="button" data-go="${page + 1}"${page >= pages ? " disabled" : ""}>${L.next} ›</button>
    </div>`;
}

/** 페이지 버튼에 `go` 를 물립니다. 목록마다 다시 그린 뒤 한 번씩 불러야 합니다. */
function wirePager(key, go) {
  document.querySelectorAll(`[data-pager="${key}"] button[data-go]`).forEach((b) => {
    b.addEventListener("click", () => {
      state.pages[key] = Number(b.dataset.go);
      window.scrollTo({ top: 0, behavior: "instant" });
      go();
    });
  });
}

function totalLine() {
  const n = state.replaysTotal;
  if (n == null) return "—";
  return state.lang === "ko" ? `누적 ${n}판` : `${n} played`;
}

function pageReplays() {
  const L = t();
  const rows = state.replays;
  return `
    <div class="wrap">
      <div class="live-top">
        <div>
          <div class="kick live-kick"><span>${L.kReplays}</span><span class="bar"></span><span class="upd">${totalLine()}</span></div>
          <h2 class="h-lg">${L.replaysH}</h2>
        </div>
        <div style="flex:0 1 380px;min-width:0">
          <div class="code-note">${L.replaysNote}</div>
        </div>
      </div>
      ${rows.length
        ? `<div class="rows">${rows.map(replayRow).join("")}</div>`
        : `<div class="rows"><div class="row" style="cursor:default"><div class="state" style="width:100%">${L.noReplays}</div></div></div>`}
      ${pager("replays", state.pages.replays, state.replaysTotal)}
    </div>
  `;
}

/* -------------------------------------------------------------- 화면: 랭킹 */

function pageRanks() {
  const L = t();
  const rows = state.ranks;
  if (!rows.length) {
    return `<div class="wrap wrap-narrow"><div class="kick">${L.kSeason}</div><h2 class="h-lg" style="margin-top:12px">${L.ranksH}</h2><div class="state">${L.noRanks}</div></div>`;
  }
  return `
    <div class="wrap wrap-narrow">
      <div class="kick">${L.kSeason}</div>
      <h2 class="h-lg" style="margin-top:12px">${L.ranksH}</h2>
      <div class="rank-head">
        <div>${L.thRank}</div><div>${L.thPlayer}</div>
        <div class="r">ELO</div><div class="r">${L.thWl}</div><div class="r c-pct">${L.thPct}</div>
      </div>
      ${rows.map((p, i) => {
        const rank = (state.pages.ranks - 1) * PAGE + i + 1;
        const total = (p.wins ?? 0) + (p.losses ?? 0) + (p.draws ?? 0);
        const wp = total ? `${Math.round(((p.wins ?? 0) / total) * 100)}%` : "—";
        const top = rank <= 3 ? ` top${rank}` : "";
        return `
          <div class="rank-row${top}">
            <div class="rank-n">${String(rank).padStart(2, "0")}</div>
            <div class="rank-p"><span class="dot"></span><span>${escapeHtml(p.name ?? "")}</span></div>
            <div class="rank-elo">${p.elo ?? "—"}</div>
            <div class="rank-num">${p.wins ?? 0} / ${p.losses ?? 0}</div>
            <div class="rank-num c-pct">${wp}</div>
          </div>`;
      }).join("")}
      ${pager("ranks", state.pages.ranks, state.ranksTotal)}
    </div>
  `;
}

/* -------------------------------------------------------------- 화면: 설치 */

/** 파일 크기 한 줄. 아직 게시된 jar 이 없으면 아무것도 덧붙이지 않습니다. */
function dlMeta(L) {
  const d = state.release?.download;
  if (!d) return "";
  return ` · ${(d.sizeBytes / 1048576).toFixed(1)} ${L.dlSize}`;
}

function pageInstall() {
  const L = t();
  const steps = OS_STEPS[state.lang][state.os];
  const tab = (id, label) => `<button data-os="${id}" class="${state.os === id ? "on" : ""}">${label}</button>`;
  return `
    <div class="wrap wrap-narrow">
      <div class="kick">${L.kInstall}</div>
      <h2 class="h-lg" style="margin-top:12px">${L.dlH}</h2>
      <p class="dl-hero">${L.dlP}</p>

      <div class="dl-card" id="dlcard">
        <div class="rel">
          <b>mchx ${state.release ? escapeHtml(state.release.version) : "—"}</b>
          <div class="meta">${L.relLine}${dlMeta(L)}</div>
        </div>
        <div class="dl-btns">
          ${state.release?.download
            ? `<a class="cta cta-lg" href="${escapeHtml(state.release.download.url)}">${L.dlJar}</a>`
            : ""}
          <a class="cta-ghost" href="https://github.com/pjw070823/mchx/commits/master" target="_blank" rel="noopener">${L.changelog}</a>
        </div>
      </div>

      <div class="os-tabs">${tab("win", "WINDOWS")}${tab("mac", "MACOS")}${tab("linux", "LINUX")}</div>

      <div class="steps">
        <div class="kick" style="font-size:10.5px;letter-spacing:.16em">${L.stepsTitle}</div>
        <div class="steps-list">
          ${steps.map((s) => `
            <div class="step">
              <div class="n">${s.n}</div>
              <div class="bd">
                <div class="ti">${escapeHtml(s.title)}</div>
                <div class="tx">${escapeHtml(s.body)}</div>
                ${s.cmd ? `<div class="cmd">${escapeHtml(s.cmd)}</div>` : ""}
              </div>
            </div>`).join("")}
        </div>
      </div>

      <div class="req">
        <div>
          <div class="kick" style="font-size:10.5px;letter-spacing:.16em">${L.requires}</div>
          <div class="bd">Minecraft 26.1.2<br />Fabric Loader 0.19+<br />Fabric API<br />Fabric Language Kotlin 1.13+</div>
        </div>
        <div>
          <div class="kick" style="font-size:10.5px;letter-spacing:.16em">${L.notRequired}</div>
          <div class="bd">${L.nr1}<br />${L.nr2}<br />${L.nr3}</div>
        </div>
      </div>
    </div>
  `;
}

function wireInstall() {
  document.querySelectorAll(".os-tabs button").forEach((b) =>
    b.addEventListener("click", () => { state.os = b.dataset.os; route(); }),
  );
}

/* ------------------------------------------------------------------ 라우터 */

let cleanup = null;


/* ------------------------------------------------------------ 목록 불러오기 */

/**
 * 목록 세 개의 적재 방식.
 *
 * 라이브는 한 번에 다 받아 잘라 씁니다 — 열려 있는 방은 많아야 몇 개고, 15초 폴링이
 * 이미 전체를 받아오고 있어서 페이지마다 다시 부를 이유가 없습니다. 리플레이와 랭킹은
 * 수천 줄까지 자랄 수 있으니 서버에서 offset 으로 한 쪽씩 받습니다.
 */
function showLive() {
  render(pageLive());
  wireLive();
  wirePager("live", showLive);
}

async function loadLive() {
  render(pageLive());
  try {
    const { rooms } = await api("/api/rooms");
    state.rooms = rooms ?? [];
  } catch { state.rooms = []; }
  clampPage("live", state.rooms.length);
  showLive();
}

async function loadReplays() {
  render(pageReplays());
  try {
    const { replays, total } = await api(
      `/api/replays?limit=${PAGE}&offset=${(state.pages.replays - 1) * PAGE}`,
    );
    state.replays = replays ?? [];
    state.replaysTotal = total ?? null;
  } catch { state.replays = []; }
  render(pageReplays());
  wirePager("replays", loadReplays);
}

async function loadRanks() {
  render(pageRanks());
  try {
    const { players, total } = await api(
      `/api/leaderboard?limit=${PAGE}&offset=${(state.pages.ranks - 1) * PAGE}`,
    );
    state.ranks = players ?? [];
    state.ranksTotal = total ?? null;
  } catch { state.ranks = []; }
  render(pageRanks());
  wirePager("ranks", loadRanks);
}

/** 목록이 줄어 현재 쪽이 사라졌으면 마지막 쪽으로 당깁니다. */
function clampPage(key, total) {
  state.pages[key] = Math.min(state.pages[key], pageCount(total));
}

async function route() {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }

  const hash = location.hash || "#/";
  const board = hash.match(/^#\/board\/([A-Za-z0-9]{4})$/);

  if (board) {
    state.page = "spectate";
    render(`<div class="wrap wrap-wide" id="spec"></div>`);
    cleanup = mountSpectator(document.getElementById("spec"), board[1].toUpperCase(), t(), state.lang);
    return;
  }

  const replay = hash.match(/^#\/replay\/(\d+)$/);
  if (replay) {
    state.page = "replay";
    render(`<div class="wrap wrap-wide" id="rep"></div>`);
    cleanup = mountReplay(document.getElementById("rep"), replay[1], t(), state.lang);
    return;
  }

  if (hash === "#/replays") {
    state.page = "replays";
    state.pages.replays = 1;
    return loadReplays();
  }

  if (hash === "#/live") {
    state.page = "live";
    state.pages.live = 1;
    return loadLive();
  }

  if (hash === "#/ranks") {
    state.page = "ranks";
    state.pages.ranks = 1;
    return loadRanks();
  }

  if (hash === "#/install") {
    state.page = "install";
    render(pageInstall());
    wireInstall();
    // 먼저 그리고 나서 받습니다. 실패해도 설치 단계는 그대로 읽을 수 있고,
    // 버전 줄만 "—" 로 남습니다.
    if (!state.release) {
      state.release = await api("/api/release").catch(() => null);
      if (state.page === "install") { render(pageInstall()); wireInstall(); }
    }
    return;
  }

  state.page = "home";
  render(pageHome());
  await loadStats();
  render(pageHome());
}

/** 라이브 목록을 주기적으로 다시 받아, 그 화면을 보고 있으면 다시 그립니다. */
async function pollRooms() {
  try {
    const { rooms } = await api("/api/rooms");
    const changed = (rooms ?? []).length !== state.rooms.length;
    state.rooms = rooms ?? [];
    if (changed && state.page === "live") {
      clampPage("live", state.rooms.length);
      showLive();
    }
  } catch { /* 표시등은 있으면 좋은 것 */ }
}

window.addEventListener("hashchange", route);
route();
pollRooms();
setInterval(pollRooms, 15_000);
