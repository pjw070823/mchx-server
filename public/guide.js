// Minecraft Hex — 플레이어 가이드.
//
// 게임을 하는 사람이 읽는 설명서입니다. 일곱 쪽으로 나뉘고 쪽마다 주소가 있습니다
// (#/guide, #/guide/win …). 한 쪽에 다 싣고 #앵커로 나누지 않은 이유는 이 사이트가 이미
// 해시를 라우팅에 쓰고 있어서입니다 — 앵커를 쓰면 "미션 목록으로 바로 가는 링크"를 줄 수
// 없습니다.
//
// 여기 적힌 규칙은 전부 서버와 모드의 코드에서 확인한 것입니다. 미션 목록은 이 파일에
// 없고 /api/missions 에서 받습니다: 미션을 넣고 빼면 가이드가 따라 바뀝니다. 이 파일이
// 갖고 있는 것은 "판정 종류를 문장으로 바꾸는 법"과, 데이터에 없는 것 둘 — 영어 이름과
// 아이템의 한국어 이름 — 입니다. 모르는 미션이 와도 깨지지 않고 이름과 종류로 보여줍니다.

import { escapeHtml, BOUNDS } from "/board.js";

/* ------------------------------------------------------------------ 쪽 목록 */

export const GUIDE_SECTIONS = [
  { id: "", ko: "게임 소개", en: "The game" },
  { id: "win", ko: "승리 조건", en: "How to win" },
  { id: "difficulty", ko: "미션 난도", en: "Difficulty" },
  { id: "missions", ko: "미션 목록", en: "Missions" },
  { id: "modes", ko: "게임 모드", en: "Modes" },
  { id: "settings", ko: "방 설정과 개인 설정", en: "Settings" },
  { id: "systems", ko: "그 밖의 시스템", en: "Everything else" },
];

const href = (id) => (id ? `#/guide/${id}` : "#/guide");

/** 주소의 뒷부분으로 쪽을 찾습니다. 모르는 이름이면 첫 쪽입니다. */
export function guideSection(id) {
  return GUIDE_SECTIONS.find((s) => s.id === (id ?? "")) ?? GUIDE_SECTIONS[0];
}

/* -------------------------------------------------------------- 판 그림 */

const C = {
  none: { ring: "#252A32", bg: "#161A20", fg: "#8F98A4" },
  a: { ring: "#7BA0FC", bg: "#4A7BFA", fg: "#0B0D10" },
  b: { ring: "#DAA8FC", bg: "#C77CFA", fg: "#0B0D10" },
  // 난도 색은 이 가이드에만 있습니다. 실제 판은 난도를 색으로 나누지 않습니다 —
  // 그래서 "어느 줄이 어려운가"를 보여줄 곳이 여기뿐입니다.
  easy: { ring: "#2F6B57", bg: "#143027", fg: "#8FD8BC" },
  medium: { ring: "#8A6A22", bg: "#33270F", fg: "#F0CC78" },
  hard: { ring: "#9A3F3A", bg: "#3A1614", fg: "#F3A39C" },
  hi: { ring: "#FFFFFF", bg: "#2A303A", fg: "#FFFFFF" },
};

/**
 * 설명용 작은 판. 실제 관전 보드와 같은 클래스·같은 순서로 그립니다: 행은 r 순서,
 * 행 안에서는 q 내림차순, 아래 행일수록 왼쪽으로. 순서를 여기서 다르게 쓰면 그림이
 * 실제 판을 좌우로 뒤집은 모양이 되어, 가이드가 틀린 방향을 가르치게 됩니다.
 */
function miniBoard(paint) {
  let rows = "";
  for (let r = 0; r < 5; r++) {
    let cells = "";
    for (let q = 4; q >= 0; q--) {
      const t = paint(q, r) ?? C.none;
      cells += `<div class="hcell" style="background:${t.ring}"><i style="background:${t.bg};color:${t.fg}">${t.label ?? ""}</i></div>`;
    }
    rows += `<div class="hrow" style="margin-left:calc(var(--w) * ${((4 - r) * 0.5225).toFixed(4)})">${cells}</div>`;
  }
  const lines = BOUNDS.map((b) => `<polyline points="${b.points}" class="${b.side}" vector-effect="non-scaling-stroke"/>`).join("");
  return `
    <div class="board-hold g-board">
      <div class="hexgrid">
        <svg class="board-bounds" viewBox="-34 -34 795 546" preserveAspectRatio="xMidYMid meet">${lines}</svg>
        <div>${rows}</div>
      </div>
    </div>`;
}

const key = (q, r) => `${q},${r}`;
const difficultyOf = (q, r) => (q + r === 4 ? "hard" : q + r === 3 || q + r === 5 ? "medium" : "easy");

/** 파랑이 위아래를 이은 판. 분홍은 가운데 줄에서 막혔습니다. */
function figWin() {
  const a = new Set(["2,0", "2,1", "1,2", "1,3", "0,4"]);
  const b = new Set(["4,2", "3,2", "2,2", "0,1", "3,3"]);
  return miniBoard((q, r) => (a.has(key(q, r)) ? C.a : b.has(key(q, r)) ? C.b : C.none));
}

/** 가운데 칸과 맞닿은 여섯 칸. */
function figNeighbours() {
  const around = new Set(["3,2", "1,2", "2,1", "2,3", "3,1", "1,3"]);
  return miniBoard((q, r) => (q === 2 && r === 2 ? C.hi : around.has(key(q, r)) ? C.a : C.none));
}

function figDifficulty(L) {
  const label = { easy: L.easyShort, medium: L.mediumShort, hard: L.hardShort };
  return miniBoard((q, r) => ({ ...C[difficultyOf(q, r)], label: label[difficultyOf(q, r)] }));
}

/* ------------------------------------------------------------- 작은 부품 */

const h = (text) => `<h3 class="g-h">${text}</h3>`;
const p = (text) => `<p class="g-p">${text}</p>`;
const ul = (items) => `<ul class="g-ul">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
const note = (text) => `<div class="g-note">${text}</div>`;
const fig = (board, caption) => `<figure class="g-fig">${board}<figcaption>${caption}</figcaption></figure>`;
// 열이 넷 이상이면 좁은 화면에서 글자가 한두 자씩 꺾입니다. 그런 표는 줄이지 않고 옆으로 밉니다.
const table = (head, rows) => `
  <div class="g-table-hold"><table class="g-table${head.length >= 4 ? " wide" : ""}">
    <thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
const swatch = (c) => `<span class="g-sw" style="background:${c.bg};box-shadow:inset 0 0 0 2px ${c.ring}"></span>`;

/* ---------------------------------------------------------------- 본문: 한국어 */

const KO = {
  kicker: "가이드", prev: "이전", next: "다음",
  easyShort: "쉬움", mediumShort: "보통", hardShort: "어려움",

  "": () => `
    ${p("Minecraft Hex 는 마인크래프트로 하는 미션 경주입니다. 두 진영이 <b>같은 시드의 월드를 각자</b> 플레이하면서, 5×5 육각 판에 깔린 미션을 먼저 달성해 칸을 차지합니다. 자기 진영의 마주 보는 두 변을 칸으로 먼저 이으면 이깁니다.")}
    ${h("한 판은 이렇게 흘러갑니다")}
    ${ul([
      "<b>방에 모입니다.</b> 타이틀 화면의 <b>MCHX 로비</b>에서 랭크전을 돌리거나, 방을 만들어 4글자 코드를 친구에게 줍니다.",
      "<b>판이 정해집니다.</b> 전체 미션 중 25개가 무작위로 뽑혀 판에 놓입니다. 두 진영이 보는 판은 같습니다.",
      "<b>각자의 월드가 만들어집니다.</b> 시드가 같아서 지형과 구조물이 같습니다. 상대는 내 월드에 없습니다 — 서로 방해할 수 없고, 보이는 것은 판과 채팅뿐입니다.",
      "<b>모두 준비되면 5초를 세고 시작합니다.</b> 그 전에는 움직일 수 없고 미션도 인정되지 않습니다.",
      "<b>미션을 달성하면 그 칸이 내 색이 됩니다.</b> 순서도 턴도 없습니다. 먼저 한 쪽이 가져가고, 한 번 넘어간 칸은 바뀌지 않습니다.",
      "<b>두 변이 이어지는 순간 끝납니다.</b> 10초 뒤 월드에서 나와 방(커스텀)이나 로비(랭크)로 돌아갑니다.",
    ])}
    ${h("판은 어디서 보나요")}
    ${ul([
      "게임 안에서 <b>B 키</b>를 누르면 판이 크게 뜹니다. 열려 있는 동안 내 월드는 멈춥니다. B 를 다시 누르면 닫힙니다.",
      "플레이 중에는 화면 구석에 작은 판과 경과 시간이 계속 떠 있습니다.",
      "일시정지 메뉴(Esc)에도 <b>보드 보기</b>가 있습니다.",
      "칸에 마우스를 올리면 미션 이름이 보입니다. 미션마다 정확히 무엇을 해야 하는지는 <a href=\"#/guide/missions\">미션 목록</a>에 있습니다.",
    ])}
    ${h("상대가 무엇을 하는지")}
    ${p("상대가 칸을 차지하면 알림이 뜨고 판에 바로 반영됩니다. 상대의 사망 메시지와 도전 과제 달성, 채팅도 내 채팅창에 보입니다. Tab 을 누르면 상대가 목록에 나옵니다.")}
    ${note("이 사이트의 <a href=\"#/live\">라이브</a>에서는 진행 중인 판을 누구나 볼 수 있고, 끝난 판은 <a href=\"#/replays\">리플레이</a>로 한 수씩 되감아 볼 수 있습니다. 관전자에게 시드는 공개되지 않습니다.")}
  `,

  win: () => `
    ${p("<b>자기 진영의 마주 보는 두 변을, 자기가 차지한 칸으로 끊김 없이 이으면 이깁니다.</b> 이어지는 순간 판이 끝나고, 칸을 몇 개 차지했는지는 승패와 무관합니다.")}
    ${fig(figWin(), "파랑이 위쪽 변에서 아래쪽 변까지 다섯 칸으로 이었습니다. 분홍은 좌우를 이으려다 가운데에서 막혔습니다.")}
    ${h("두 진영은 서로 다른 방향을 잇습니다")}
    ${table(["진영", "이어야 하는 변", "판 바깥 선의 색"], [
      ["파랑 (A)", "위 ↔ 아래", "위·아래 변이 파랑"],
      ["분홍 (B)", "왼쪽 ↔ 오른쪽", "왼쪽·오른쪽 변이 분홍"],
    ])}
    ${p("판 바깥을 두른 선이 곧 안내입니다. 내 색으로 그어진 두 변이 내가 이어야 하는 변입니다. 어느 진영이 될지는 서버가 정합니다(2대2 에서는 팀을 고를 수 있습니다).")}
    ${note("<b>게임 안에서는 기본 설정으로 내가 항상 파랑·위아래로 보입니다.</b> 로비 설정의 <b>내 색상 고정</b>이 켜져 있기 때문이고, 화면에 보이는 것만 바뀔 뿐 규칙은 같습니다. 그래서 같은 판을 상대는 뒤집힌 모양으로 봅니다. 이 사이트의 관전·리플레이는 실제 진영 그대로 보여줍니다 — <a href=\"#/guide/settings\">개인 설정</a>.")}
    ${h("\"이어졌다\"의 기준")}
    ${fig(figNeighbours(), "가운데 칸(흰 테두리)과 맞닿은 칸은 여섯입니다. 변을 맞댄 칸끼리만 이어집니다.")}
    ${ul([
      "칸 하나는 최대 여섯 칸과 맞닿습니다. 판에서 서로 변을 맞대고 있는 칸이 이웃입니다.",
      "시작하는 변에 붙은 내 칸에서 출발해, 내 칸만 밟고 반대쪽 변에 붙은 칸까지 갈 수 있으면 이어진 것입니다.",
      "길은 곧을 필요가 없습니다. 돌아가도 되고, 길이도 상관없습니다. 가장 짧은 길이 다섯 칸입니다.",
      "모서리 칸은 두 변에 모두 붙어 있어서, 어느 진영에게나 변에 붙은 칸입니다.",
    ])}
    ${h("칸은 먼저 한 사람의 것입니다")}
    ${ul([
      "미션을 달성한 순간 그 칸이 내 것이 됩니다. 서버에 먼저 도착한 쪽이 가져갑니다.",
      "한 번 차지한 칸은 판이 끝날 때까지 바뀌지 않습니다. 뺏을 수도, 잃을 수도 없습니다.",
      "상대가 먼저 가져간 칸의 미션은 그 뒤에 해도 아무 일도 일어나지 않습니다.",
      "그래서 상대가 이으려는 길 위의 칸을 먼저 차지하면 그 길이 막힙니다. 판은 내 길을 내는 것과 상대 길을 끊는 것 사이의 선택입니다.",
    ])}
    ${h("이어지지 않고 끝나는 경우")}
    ${table(["상황", "결과"], [
      ["한쪽이 <b>게임 포기하기</b>를 누름", "상대의 승리. 5초 뒤 함께 월드에서 나갑니다"],
      ["월드에서 나가거나 게임을 끔", "상대의 승리. 방의 자리도 내놓습니다"],
      ["연결이 끊김", "모드가 자동으로 다시 접속합니다. 약 10초 안에 자리를 되찾지 못하면 상대의 승리"],
      ["솔로에서 포기", "승자 없이 끝납니다"],
    ])}
    ${p("제한 시간은 없습니다. 누군가 잇거나 그만둘 때까지 계속됩니다.")}
  `,

  difficulty: () => `
    ${p("미션은 <b>쉬움 · 보통 · 어려움</b> 세 난도로 나뉘고, 난도마다 판에서 놓이는 자리가 정해져 있습니다. 어떤 미션이 뽑힐지는 매 판 다르지만 <b>어려운 미션이 어느 줄에 오는지는 항상 같습니다.</b>")}
    ${fig(figDifficulty(KO), "모든 판의 난도 배치. 어려움 다섯 칸이 판의 짧은 대각선을 따라 한 줄로 놓입니다.")}
    ${table(["난도", "판의 칸 수", "전체 미션 수", "자리"], [
      [`${swatch(C.easy)} 쉬움`, "12", "<span data-pool=\"easy\">—</span>", "양쪽 끝의 삼각형 두 곳"],
      [`${swatch(C.medium)} 보통`, "8", "<span data-pool=\"medium\">—</span>", "어려움 줄의 양옆 두 줄"],
      [`${swatch(C.hard)} 어려움`, "5", "<span data-pool=\"hard\">—</span>", "가운데 대각선 한 줄"],
    ])}
    ${h("이기려면 어려운 미션을 적어도 하나는 해야 합니다")}
    ${p("어려움 줄은 판을 둘로 가릅니다. 위에서 아래로 가든 왼쪽에서 오른쪽으로 가든, 한쪽 변에서 반대쪽 변으로 가는 길은 반드시 이 줄을 한 번 건넙니다. 그래서 <b>어느 진영이든 어려움 칸을 최소 하나 차지해야 이을 수 있습니다.</b>")}
    ${ul([
      "가장 짧은 길(다섯 칸)도 어려움 칸 하나를 지납니다. 나머지 네 칸을 쉬움·보통으로 채우는 길이 여럿 있습니다.",
      "어려움 칸은 다섯뿐이고 두 진영이 같이 노립니다. 상대가 세 개를 먼저 가져가면 내가 건널 수 있는 자리는 둘만 남습니다.",
      "모서리의 어려움 칸 둘은 두 변에 동시에 붙어 있습니다.",
    ])}
    ${h("매 판 미션이 달라집니다")}
    ${p("전체 미션은 판의 칸보다 많습니다. 판이 시작될 때 난도별로 섞어서 쉬움 12개, 보통 8개, 어려움 5개를 뽑아 그 난도의 자리에 무작위로 놓습니다. 그래서 대부분의 미션은 어느 한 판에는 나오지 않고, 같은 미션이라도 놓이는 칸은 판마다 다릅니다.")}
    ${note("난도는 색으로 구분되지 않습니다. 게임 안의 판과 이 사이트의 관전 보드 모두 빈 칸은 같은 색입니다. 위 그림의 색은 설명을 위한 것이고, 실제로는 <b>칸의 위치</b>로 난도를 압니다.")}
  `,

  missions: () => `
    ${p("지금 서버에 등록된 미션 전부와, 각각 <b>정확히 무엇을 하면 달성으로 인정되는지</b>입니다. 한 판에는 이 중 25개만 나옵니다.")}
    ${h("모든 미션에 공통인 규칙")}
    ${ul([
      "카운트다운이 끝난 뒤에 한 것만 인정됩니다.",
      "판에 놓인 미션만 의미가 있습니다. 이번 판에 없는 미션은 해도 아무 일도 없습니다.",
      "<b>아이템을 모으는 미션은 조건을 채운 그 순간 한 번이면 됩니다.</b> 칸을 차지한 뒤에는 그 아이템을 쓰거나 버려도 칸을 잃지 않습니다.",
      "모으는 미션은 <b>내 인벤토리에 든 것</b>만 셉니다. 상자에 넣어 둔 것은 세지 않습니다. 여러 칸에 나뉘어 있어도 합쳐서 셉니다.",
      "구리로 된 것은 산화했거나 밀랍칠한 것도 같은 것으로 셉니다(예: 산화된 구리 랜턴).",
      "<b>2대2</b> 에서 <span class=\"g-chip team\">팀 합산</span> 표시가 있는 미션은 팀원 둘의 것을 더해서 판정합니다. 표시가 없는 미션은 둘 중 한 명이 해내면 됩니다.",
    ])}
    <div class="g-tools">
      <div class="g-filter" id="gFilter">
        <button type="button" data-d="all" class="on">전체</button>
        <button type="button" data-d="easy">쉬움</button>
        <button type="button" data-d="medium">보통</button>
        <button type="button" data-d="hard">어려움</button>
      </div>
      <input class="g-search" id="gSearch" type="search" placeholder="미션 찾기" autocomplete="off" />
    </div>
    <div id="gMissions"><div class="state">불러오는 중…</div></div>
  `,

  modes: () => `
    ${p("모드는 넷입니다. 랭크전만 레이팅이 걸리고, 나머지는 방을 만들어 하는 자유 대전입니다.")}
    ${table(["", "랭크전", "커스텀 방", "솔로", "2대2"], [
      ["들어가는 법", "매치 시작 → 랭크전 시작", "방 생성 / 방 참여(코드)", "방에 혼자인 채로 시작", "방 설정에서 2v2 로 전환"],
      ["인원", "1 대 1", "1 대 1", "혼자", "최대 2 대 2"],
      ["레이팅", "반영", "미반영", "미반영", "미반영"],
      ["설정", "고정", "방장이 정함", "방장이 정함", "방장이 정함"],
      ["끝난 뒤", "로비로", "같은 방으로 (바로 재대결)", "같은 방으로", "같은 방으로"],
    ])}
    ${h("랭크전")}
    ${ul([
      "마인크래프트 정품 계정 인증이 필요합니다. 인증은 게임이 이미 로그인해 있는 계정으로 자동으로 이루어지고, 비밀번호를 묻지 않습니다.",
      "대기열에 들어가면 레이팅이 비슷한 상대를 찾습니다. 처음에는 ±100 안에서 찾고, 기다릴수록 초당 20씩 범위가 넓어지며, 2분이 지나면 누구와도 맺어집니다.",
      "상대를 찾으면 수락 단계 없이 바로 시작합니다.",
      "설정은 고정입니다: 인벤토리 세이브, 포화 효과, 야간 투시, 수중 호흡, 30분 겉날개 지급이 모두 켜져 있고 시드는 항상 무작위입니다.",
      "같은 인터넷 주소의 두 사람은 맺어지지 않습니다.",
    ])}
    ${h("커스텀 방")}
    ${ul([
      "방을 만들면 4글자 코드가 나옵니다. 상대는 <b>방 참여</b>에서 그 코드를 입력합니다.",
      "방을 만든 사람이 방장입니다. 방장만 <a href=\"#/guide/settings\">방 설정</a>을 바꾸고 시작할 수 있습니다. 방장이 나가면 다음 사람이 방장이 됩니다.",
      "판이 끝나면 같은 방으로 돌아옵니다. 코드와 설정이 그대로라 바로 다시 시작할 수 있고, 다시 할 때마다 시드와 판이 새로 정해집니다.",
      "방 화면에서 채팅할 수 있습니다.",
    ])}
    ${h("솔로")}
    ${ul([
      "방에 혼자 있을 때 시작을 누르면 확인을 한 번 거쳐 솔로로 시작합니다.",
      "상대가 없습니다. 내 두 변을 이으면 <b>클리어</b>와 걸린 시간이 뜹니다.",
      "포기하면 승자 없이 끝납니다. 라이브와 리플레이에는 다른 커스텀 판과 똑같이 나옵니다.",
    ])}
    ${h("2대2")}
    ${p("두 사람이 한 팀이 되어 <b>월드 하나를 같이</b> 씁니다. 상대 팀은 여전히 다른 월드에 있습니다.")}
    ${ul([
      "방 설정의 <b>매치 모드</b>를 2v2 로 바꿉니다. 들어온 사람은 인원이 적은 팀에 앉고, 방 화면의 <b>이 팀으로</b> 버튼으로 자리가 있는 팀으로 옮길 수 있습니다.",
      "팀원은 같은 월드에서 실제로 만납니다. 포트를 열거나 다른 모드를 깔 필요가 없습니다 — 연결은 Hex 서버가 이어 줍니다.",
      "팀 월드에는 팀원만 들어올 수 있습니다.",
      "인원이 모자라도 시작할 수 있습니다: 2 대 1, 1 대 1, 한 팀만(상대 없는 솔로).",
      "아이템을 모으는 미션과 횟수를 세는 미션은 <b>두 사람 것을 더해서</b> 판정합니다. 한 명이 원목 40개, 다른 한 명이 24개를 들고 있으면 64개입니다. 어떤 미션이 합산인지는 <a href=\"#/guide/missions\">미션 목록</a>에 표시돼 있습니다.",
      "칸을 차지하면 개인 이름이 아니라 팀으로 알립니다(\"파랑 팀이 …\").",
      "<b>한 명이라도 떠나면 그 팀이 집니다</b> — 나가기든, 끊긴 뒤 돌아오지 못한 것이든.",
      "<b>포기는 둘이 같이 해야 합니다.</b> 한 명이 <b>게임 포기하기</b>를 누르면 팀원에게만 알림이 가고, 팀원도 누르면 팀이 포기합니다. 먼저 누른 사람의 버튼은 <b>포기 취소</b>로 바뀌어 다시 누르면 거둘 수 있습니다. 상대 팀은 이 과정을 모릅니다. 팀원이 없는 쪽은 혼자 바로 포기합니다.",
      "모두 준비될 때까지 팀 월드의 시간은 멈춰 있습니다. 두 팀이 같은 시각에서 시작합니다.",
      "레벨 20 미션은 둘 중 한 명이 20 이 되면 됩니다. 침대를 써서 밤을 넘기려면 둘 다 자야 합니다.",
    ])}
  `,

  settings: () => `
    ${h("방 설정")}
    ${p("커스텀 방의 방장이 시작 전에 바꿉니다. 방 화면의 <b>방 설정</b>에서 열고, 방장이 아닌 사람은 보기만 할 수 있습니다. 두 진영 모두에게 똑같이 적용됩니다.")}
    ${table(["설정", "기본", "켜면"], [
      ["매치 모드", "1v1", "1v1 과 2v2 를 오갑니다. 지금 앉아 있는 인원으로 할 수 없는 모드로는 바뀌지 않습니다"],
      ["인벤토리 세이브", "켜짐", "죽어도 아이템과 경험치를 잃지 않습니다"],
      ["포화 효과", "켜짐", "배고픔이 줄지 않습니다"],
      ["야간 투시", "켜짐", "어두운 곳이 밝게 보입니다"],
      ["수중 호흡", "켜짐", "물속에서 숨이 줄지 않습니다"],
      ["30분 겉날개 지급", "켜짐", "시작 30분 뒤 모든 플레이어가 겉날개 1개와 폭죽 16개를 받습니다"],
      ["시드 필터링", "꺼짐", "스폰 근처에 쓸 만한 것이 있는 시드에서 시작합니다 (아래)"],
    ])}
    ${p("효과 셋은 판 내내 유지되고 죽은 뒤에도 다시 걸립니다. 랭크전은 위 표의 기본값으로 고정이고 시드 필터링은 항상 꺼져 있습니다.")}
    ${h("시드 필터링")}
    ${p("꺼져 있으면 시드는 매 판 완전히 무작위입니다. 켜면 서버가 <b>미리 확인해 둔 시드 목록</b>에서 하나를 무작위로 뽑습니다. 그 시드들은 스폰 지점에서 128블록 안에 다음 중 하나 이상이 있습니다.")}
    ${ul([
      "<b>마을</b>",
      "<b>루인드 포탈</b> — 지상에 있고, 상자 속 흑요석과 근처의 용암으로 틀의 빈자리를 마저 채울 수 있는 것",
      "<b>용암 풀</b> — 지표에 드러난 용암이 10블록 이상 이어진 것",
      "<b>대동굴</b> — 지상으로 넓게 트인 동굴 입구",
    ])}
    ${p("카운트다운 화면에 그 시드에 <b>무엇이 있는지</b>가 한 줄로 나옵니다(예: \"마을 · 용암 풀 시드\"). 어디에 있는지는 알려주지 않습니다 — 찾는 것은 플레이의 일부입니다. 미션 판은 시드와 상관없이 매번 새로 뽑으므로, 같은 시드가 다시 나와도 미션은 다릅니다.")}
    ${note("서버에 준비된 시드가 없으면 방장이 시작을 눌렀을 때 방 채팅에 안내가 뜨고 시작되지 않습니다. 설정을 끄면 시작할 수 있습니다.")}
    ${h("항상 적용되는 것")}
    ${ul([
      "난이도는 <b>보통</b>으로 고정이고 바꿀 수 없습니다.",
      "치트(명령어)와 게임 모드 변경, 월드 공개는 매치 월드에서 막혀 있습니다.",
      "죽으면 항상 정확히 같은 스폰 지점에서 다시 시작합니다(침대를 썼다면 침대에서).",
    ])}
    ${h("개인 설정")}
    ${p("로비의 <b>설정</b>에서 바꿉니다. 내 화면에만 적용되고 상대나 관전자에게는 영향이 없습니다.")}
    ${table(["설정", "기본", "설명"], [
      ["내 색상 고정", "켜짐", "어느 진영을 받든 내가 항상 고른 색으로, 고른 방향을 잇는 것으로 보입니다. 판·화면 구석의 작은 판·방의 자리·탭 목록·채팅 이름에 모두 적용됩니다"],
      ["색상", "파랑", "파랑 또는 분홍"],
      ["방향", "상하", "상하 또는 좌우"],
      ["보드 위치", "우측 상단", "플레이 중 작은 판이 뜨는 구석. 끌 수도 있습니다"],
      ["미션 아이콘", "켜짐", "판의 칸에 미션 그림을 보여줍니다. 끄면 이름으로 나옵니다"],
      ["타이머", "켜짐", "시작부터 흐른 시간. 판을 열어 월드가 멈춰 있어도 계속 흐릅니다"],
    ])}
    ${note("<b>내 색상 고정이 켜져 있으면 나와 상대가 같은 판을 서로 다른 모양으로 봅니다.</b> 둘 다 자신을 파랑·상하로 보기 때문입니다. 상대와 칸 위치를 말로 주고받을 때는 이 점을 기억하세요. 이 사이트의 관전 화면은 서버가 나눠준 실제 진영 그대로입니다.")}
  `,

  systems: () => `
    ${h("연결이 끊겼을 때")}
    ${ul([
      "판 도중에 서버와의 연결이 끊기면 모드가 자동으로 다시 접속해 자리를 되찾습니다. 그동안 판은 계속 진행됩니다.",
      "서버는 끊긴 자리를 약 10초 동안 비워 둡니다. 그 안에 돌아오지 못하면 상대의 승리로 끝납니다.",
      "2대2 에서 팀 월드와의 연결만 끊긴 경우에는 자동으로 다시 들어갑니다(5번까지).",
    ])}
    ${h("포기")}
    ${ul([
      "일시정지 메뉴(Esc)의 <b>게임 포기하기</b>입니다. 원래 \"저장하고 나가기\"가 있던 자리입니다.",
      "누르면 양쪽에 5초 예고가 뜨고, 그 뒤 상대의 승리로 끝납니다.",
      "커스텀 방에서는 포기해도 방에 남습니다. 바로 다시 시작할 수 있습니다.",
      "2대2 에서는 팀원 둘이 모두 눌러야 합니다 — <a href=\"#/guide/modes\">게임 모드</a>.",
    ])}
    ${h("30분 겉날개")}
    ${p("판이 30분을 넘기면 모든 플레이어에게 겉날개 1개와 폭죽 16개가 지급됩니다. 그쯤 되면 남은 미션이 서로 멀리 떨어져 있어 이동이 승부를 정하기 쉽기 때문입니다. 방 설정에서 끌 수 있고 랭크전에서는 항상 켜져 있습니다.")}
    ${h("명령어")}
    ${table(["명령어", "하는 일"], [
      ["<code>/kill-myself</code>", "스스로 죽습니다. 갇혔을 때 스폰으로 돌아가는 방법입니다"],
      ["<code>/code</code>", "지금 방의 코드를 보여줍니다"],
    ])}
    ${p("<code>/give</code>, <code>/gamemode</code> 같은 치트 명령어는 매치 월드에서 쓸 수 없습니다.")}
    ${h("레이팅")}
    ${ul([
      "랭크전의 결과만 레이팅에 반영됩니다. 커스텀·솔로·2대2 는 반영되지 않습니다.",
      "모두 500 에서 시작합니다. 이기면 오르고 지면 내리며, 나보다 레이팅이 높은 상대를 이길수록 많이 오릅니다(ELO 방식).",
      "변동 폭은 판수가 쌓일수록 줄어듭니다: 30판 미만은 크게, 100판 미만은 중간, 그 뒤로는 작게.",
      "로비의 <b>내 프로필</b>에서 내 레이팅과 그 변화를 볼 수 있습니다. 전체 순위는 <a href=\"#/ranks\">랭킹</a>.",
    ])}
    ${h("관전과 리플레이")}
    ${ul([
      "진행 중인 판은 <a href=\"#/live\">라이브</a>에 나옵니다. 방 코드를 알면 목록에 없는 판도 볼 수 있습니다.",
      "관전자는 판과 점령 순서를 봅니다. 월드 안은 보이지 않고 시드도 받지 못합니다.",
      "끝난 판은 <a href=\"#/replays\">리플레이</a>에 남아, 한 수씩 넘기거나 재생해서 볼 수 있습니다.",
    ])}
    ${h("월드와 업데이트")}
    ${ul([
      "판마다 새 월드가 만들어집니다. 끝난 판의 월드는 모드가 알아서 지웁니다.",
      "새 버전이 나오면 로비가 알려줍니다. 누르면 내려받아 설치하고 게임을 닫습니다. 다시 켜면 최신입니다.",
      "처음 설치하는 법은 <a href=\"#/install\">설치</a>.",
    ])}
  `,
};

/* ------------------------------------------------------------------ 본문: 영어 */

const EN = {
  kicker: "GUIDE", prev: "Previous", next: "Next",
  easyShort: "Easy", mediumShort: "Med", hardShort: "Hard",

  "": () => `
    ${p("Minecraft Hex is a mission race played in Minecraft. Two sides each play <b>their own copy of the same world seed</b> and race to complete missions laid out on a 5×5 hex board. Completing a mission claims its tile; the first side to link its own two opposite edges with claimed tiles wins.")}
    ${h("How a match goes")}
    ${ul([
      "<b>Get into a room.</b> From <b>MCHX 로비</b> on the title screen, queue for ranked or create a room and hand its four-letter code to a friend.",
      "<b>The board is dealt.</b> Twenty-five missions are drawn at random from the full list. Both sides see the same board.",
      "<b>Each side's world is generated.</b> Same seed, so the same terrain and structures. Your opponent is not in your world — you cannot interfere with each other, and all you see of them is the board and chat.",
      "<b>When everyone is ready there is a five-second countdown.</b> You cannot move before it ends and nothing counts before it ends.",
      "<b>Completing a mission turns its tile your colour.</b> There are no turns. Whoever does it first takes it, and a claimed tile never changes hands.",
      "<b>The match ends the moment two edges are linked.</b> Ten seconds later you leave the world for the room (custom) or the lobby (ranked).",
    ])}
    ${h("Where to see the board")}
    ${ul([
      "Press <b>B</b> in game for the full board. Your world is paused while it is open. Press B again to close it.",
      "A small board and the elapsed time stay in a corner of the screen while you play.",
      "The pause menu (Esc) has a board button too.",
      "Hover a tile for the mission's name. Exactly what each mission requires is in the <a href=\"#/guide/missions\">mission list</a>.",
    ])}
    ${h("What your opponent is doing")}
    ${p("A notice appears when your opponent claims a tile and the board updates at once. Their death messages, advancements and chat show up in your chat too, and they appear in the Tab list.")}
    ${note("Anyone can watch a running board under <a href=\"#/live\">Live</a> on this site, and finished ones can be stepped through under <a href=\"#/replays\">Replays</a>. Spectators are never given the seed.")}
  `,

  win: () => `
    ${p("<b>Link your side's two opposite edges with an unbroken run of tiles you have claimed.</b> The match ends the moment that happens. How many tiles each side holds does not matter.")}
    ${fig(figWin(), "Blue has linked the top edge to the bottom edge in five tiles. Pink was going left to right and got cut off in the middle.")}
    ${h("The two sides link in different directions")}
    ${table(["Side", "Edges to link", "Line outside the board"], [
      ["Blue (A)", "top ↔ bottom", "top and bottom edges are blue"],
      ["Pink (B)", "left ↔ right", "left and right edges are pink"],
    ])}
    ${p("The line drawn around the board is the reminder: the two edges in your colour are the two you have to join. The server decides which side you get (in 2v2 you can pick a team).")}
    ${note("<b>In game, by default you always see yourself as blue, linking top to bottom.</b> That is the <b>내 색상 고정</b> (lock my colour) setting, which is on by default. It changes only what you see, not the rules — so your opponent sees the same board mirrored. Spectating and replays on this site show the real sides. See <a href=\"#/guide/settings\">personal settings</a>.")}
    ${h("What counts as linked")}
    ${fig(figNeighbours(), "The centre tile (white ring) touches six others. Only tiles that share an edge are connected.")}
    ${ul([
      "A tile touches at most six others: the ones it shares an edge with on the board.",
      "You are linked if you can walk from one of your tiles on the starting edge to one on the far edge, stepping only on your own tiles.",
      "The path need not be straight and its length does not matter. The shortest possible path is five tiles.",
      "A corner tile sits on two edges at once, so it is an edge tile for either side.",
    ])}
    ${h("A tile belongs to whoever gets there first")}
    ${ul([
      "The tile is yours the moment you complete its mission. Whichever claim reaches the server first wins it.",
      "A claimed tile stays claimed until the match ends. It cannot be taken or lost.",
      "Completing a mission after your opponent has claimed its tile does nothing.",
      "So claiming a tile on the path your opponent is building blocks that path. Every match is a choice between building your line and cutting theirs.",
    ])}
    ${h("Matches that end without a link")}
    ${table(["What happened", "Result"], [
      ["A side presses <b>게임 포기하기</b> (give up)", "The other side wins. Both leave the world five seconds later"],
      ["A player leaves the world or closes the game", "The other side wins. The seat in the room is given up too"],
      ["The connection drops", "The mod reconnects by itself. If the seat is not reclaimed within about ten seconds, the other side wins"],
      ["Giving up a solo run", "It ends with no winner"],
    ])}
    ${p("There is no time limit. A match runs until someone links or someone stops.")}
  `,

  difficulty: () => `
    ${p("Missions come in three tiers — <b>easy, medium and hard</b> — and each tier has fixed places on the board. Which missions are drawn changes every match; <b>where the hard ones sit never does.</b>")}
    ${fig(figDifficulty(EN), "The tier layout of every board. The five hard tiles run along the board's short diagonal.")}
    ${table(["Tier", "Tiles on the board", "Missions in the pool", "Where"], [
      [`${swatch(C.easy)} Easy`, "12", "<span data-pool=\"easy\">—</span>", "the two triangles at either end"],
      [`${swatch(C.medium)} Medium`, "8", "<span data-pool=\"medium\">—</span>", "the two lines either side of the hard line"],
      [`${swatch(C.hard)} Hard`, "5", "<span data-pool=\"hard\">—</span>", "one line down the middle diagonal"],
    ])}
    ${h("You cannot win without at least one hard mission")}
    ${p("The hard line cuts the board in two. Top to bottom or left to right, every path from one edge to the opposite edge has to cross it once. So <b>either side needs at least one hard tile to link.</b>")}
    ${ul([
      "Even the shortest path (five tiles) passes through one hard tile. There are several such paths whose other four tiles are all easy or medium.",
      "There are only five hard tiles and both sides want them. If your opponent takes three, you have two places left to cross.",
      "The two hard tiles in the corners each sit on two edges at once.",
    ])}
    ${h("Every match is a different set")}
    ${p("The pool is larger than the board. When a match starts, each tier is shuffled and twelve easy, eight medium and five hard missions are drawn and placed at random within that tier's tiles. Most missions are absent from any one match, and the same mission lands on a different tile each time.")}
    ${note("Tiers are not colour-coded. On the in-game board and on this site's spectator board every unclaimed tile is the same colour. The colours in the figure above are for explanation; in play you tell the tier by <b>where the tile is</b>.")}
  `,

  missions: () => `
    ${p("Every mission registered on the server right now, with <b>exactly what counts as completing it</b>. Only twenty-five of them appear in any one match. Mission names in game are in Korean; the Korean name is shown under each English one.")}
    ${h("Rules that apply to every mission")}
    ${ul([
      "Only what you do after the countdown ends counts.",
      "Only missions on the board matter. Doing one that is not in this match does nothing.",
      "<b>A collecting mission needs its condition met once, at one moment.</b> After the tile is yours you may use or drop the items; the tile stays.",
      "Collecting missions count only what is <b>in your own inventory</b>. Items in a chest do not count. Split stacks are added together.",
      "Copper things count in any state — oxidized or waxed is the same item (an oxidized copper lantern is a copper lantern).",
      "In <b>2v2</b>, missions marked <span class=\"g-chip team\">TEAM TOTAL</span> are judged on both teammates added together. Unmarked missions need one of you to do it.",
    ])}
    <div class="g-tools">
      <div class="g-filter" id="gFilter">
        <button type="button" data-d="all" class="on">All</button>
        <button type="button" data-d="easy">Easy</button>
        <button type="button" data-d="medium">Medium</button>
        <button type="button" data-d="hard">Hard</button>
      </div>
      <input class="g-search" id="gSearch" type="search" placeholder="Find a mission" autocomplete="off" />
    </div>
    <div id="gMissions"><div class="state">Loading…</div></div>
  `,

  modes: () => `
    ${p("There are four ways to play. Only ranked moves your rating; the rest are free play in a room you create.")}
    ${table(["", "Ranked", "Custom room", "Solo", "2v2"], [
      ["How to start", "매치 시작 → 랭크전 시작", "방 생성 / 방 참여 (code)", "Start while alone in a room", "Switch the room to 2v2"],
      ["Players", "1 v 1", "1 v 1", "one", "up to 2 v 2"],
      ["Rating", "counts", "does not", "does not", "does not"],
      ["Settings", "fixed", "host decides", "host decides", "host decides"],
      ["Afterwards", "back to the lobby", "back to the same room (rematch at once)", "same room", "same room"],
    ])}
    ${h("Ranked")}
    ${ul([
      "Needs a verified Minecraft account. Verification happens automatically with the account the game is already signed in to; you are never asked for a password.",
      "The queue looks for someone near your rating: within ±100 at first, widening by 20 a second, and after two minutes it pairs you with anyone.",
      "A match starts as soon as a pair is found. There is no accept step.",
      "Settings are fixed: keep inventory, saturation, night vision, water breathing and the 30-minute elytra are all on, and the seed is always random.",
      "Two players behind the same internet address are never paired.",
    ])}
    ${h("Custom room")}
    ${ul([
      "Creating a room gives you a four-letter code. Your opponent enters it under <b>방 참여</b> (join room).",
      "Whoever created the room is the host. Only the host changes the <a href=\"#/guide/settings\">room settings</a> and starts the match. If the host leaves, the next player becomes host.",
      "When a match ends you are back in the same room with the same code and settings, ready to go again. Every rematch gets a new seed and a new board.",
      "The room screen has chat.",
    ])}
    ${h("Solo")}
    ${ul([
      "Press start while alone in a room and, after one confirmation, the match starts solo.",
      "There is no opponent. Link your own two edges and you get <b>클리어</b> (clear) with your time.",
      "Giving up ends it with no winner. Solo runs are listed under Live and Replays like any custom match.",
    ])}
    ${h("2v2")}
    ${p("Two players form a team and <b>share one world</b>. The other team is still in a world of its own.")}
    ${ul([
      "Change <b>매치 모드</b> (match mode) to 2v2 in the room settings. Newcomers sit on the emptier team; the <b>이 팀으로</b> (to this team) button on the room screen moves you across if there is room.",
      "Teammates really are in the same world. Nobody has to open a port or install anything else — the Hex server carries the connection.",
      "Only your teammate can enter your team's world.",
      "A match can start short-handed: 2 v 1, 1 v 1, or one team alone (a solo run with no opponent).",
      "Collecting missions and counting missions are judged on <b>both players added together</b>. One of you holding 40 logs and the other 24 is 64. The <a href=\"#/guide/missions\">mission list</a> marks which ones are pooled.",
      "A claim is announced as the team's, not a player's.",
      "<b>If either player leaves, that team loses</b> — whether by quitting or by dropping and not coming back.",
      "<b>Giving up takes both of you.</b> When one presses <b>게임 포기하기</b> only the teammate is told; if the teammate presses it too, the team gives up. The first player's button becomes <b>포기 취소</b> (cancel) and pressing it again withdraws the request. The other team sees none of this. A player with no teammate gives up alone, at once.",
      "Time in a team's world stands still until everyone is ready, so both teams start at the same time of day.",
      "The level-20 mission needs one of you to reach 20. Skipping the night in a bed needs both of you asleep.",
    ])}
  `,

  settings: () => `
    ${h("Room settings")}
    ${p("Set by the host of a custom room before the match, under <b>방 설정</b> on the room screen. Everyone else can look but not change them. They apply to both sides equally. The names below are as they appear in game.")}
    ${table(["Setting", "Default", "When on"], [
      ["매치 모드 (match mode)", "1v1", "Switches between 1v1 and 2v2. It will not switch to a mode the players already seated cannot play"],
      ["인벤토리 세이브 (keep inventory)", "on", "You keep items and experience when you die"],
      ["포화 효과 (saturation)", "on", "Hunger never drops"],
      ["야간 투시 (night vision)", "on", "Dark places are lit"],
      ["수중 호흡 (water breathing)", "on", "You do not run out of air underwater"],
      ["30분 겉날개 지급 (30-minute elytra)", "on", "Thirty minutes in, every player is given an elytra and 16 firework rockets"],
      ["시드 필터링 (seed filter)", "off", "Start on a seed with something useful near the spawn (below)"],
    ])}
    ${p("The three effects last the whole match and are reapplied after death. Ranked uses the defaults above, fixed, and never uses the seed filter.")}
    ${h("Seed filter")}
    ${p("Off, the seed is fully random every match. On, the server draws one at random from <b>a list of seeds it has checked in advance</b>. Each of those has at least one of these within 128 blocks of the spawn point:")}
    ${ul([
      "<b>a village</b>",
      "<b>a ruined portal</b> — on the surface, and one whose missing frame blocks can be filled from the obsidian in its chest and the lava nearby",
      "<b>a lava pool</b> — ten or more connected lava blocks open to the sky",
      "<b>a large cave</b> — a wide cave mouth open to the surface",
    ])}
    ${p("The countdown screen names <b>what the seed has</b> in one line. It does not say where — finding it is part of the play. The mission board is dealt separately from the seed, so the same seed coming up again brings different missions.")}
    ${note("If the server has no checked seeds available, pressing start shows a notice in the room chat and the match does not begin. Turn the setting off to start.")}
    ${h("Always on")}
    ${ul([
      "Difficulty is fixed at <b>Normal</b> and cannot be changed.",
      "Cheats, changing game mode and opening the world to others are blocked in a match world.",
      "You always respawn at exactly the same spawn point (or at your bed, if you set one).",
    ])}
    ${h("Personal settings")}
    ${p("Under <b>설정</b> in the lobby. These change only your own screen; they do not affect your opponent or spectators.")}
    ${table(["Setting", "Default", "What it does"], [
      ["내 색상 고정 (lock my colour)", "on", "Whichever side you are dealt, you always see yourself in the colour you chose, linking in the direction you chose. Applies to the board, the corner board, room seats, the Tab list and chat names"],
      ["색상 (colour)", "blue", "Blue or pink"],
      ["방향 (direction)", "top–bottom", "Top–bottom or left–right"],
      ["보드 위치 (board position)", "top right", "The corner the small board sits in while you play. It can be turned off"],
      ["미션 아이콘 (mission icons)", "on", "Shows mission artwork on tiles. Off, tiles show names"],
      ["타이머 (timer)", "on", "Time since the start. It keeps running while the board is open and your world is paused"],
    ])}
    ${note("<b>With the colour lock on, you and your opponent see the same board differently</b> — each of you sees yourself as blue, top to bottom. Keep that in mind when describing a tile's position to them. The spectator view on this site shows the real sides as the server dealt them.")}
  `,

  systems: () => `
    ${h("If you lose connection")}
    ${ul([
      "If the connection to the server drops mid-match, the mod reconnects by itself and takes your seat back. The match carries on meanwhile.",
      "The server holds a dropped seat for about ten seconds. If you are not back by then, the other side wins.",
      "In 2v2, if only the connection to your team's world drops, you are put back in automatically (up to five tries).",
    ])}
    ${h("Giving up")}
    ${ul([
      "It is <b>게임 포기하기</b> in the pause menu (Esc), where Save and Quit used to be.",
      "Both sides get a five-second notice, then the match ends as a win for the other side.",
      "In a custom room you stay in the room after giving up and can start again straight away.",
      "In 2v2 both teammates have to press it — see <a href=\"#/guide/modes\">Modes</a>.",
    ])}
    ${h("The 30-minute elytra")}
    ${p("Once a match passes thirty minutes every player is handed an elytra and 16 firework rockets. By then the missions left tend to be far apart and travel decides the result. It can be turned off in the room settings and is always on in ranked.")}
    ${h("Commands")}
    ${table(["Command", "What it does"], [
      ["<code>/kill-myself</code>", "Kills you. The way back to spawn if you are stuck"],
      ["<code>/code</code>", "Shows the code of the room you are in"],
    ])}
    ${p("Cheat commands such as <code>/give</code> and <code>/gamemode</code> do not work in a match world.")}
    ${h("Rating")}
    ${ul([
      "Only ranked results move your rating. Custom, solo and 2v2 do not.",
      "Everyone starts at 500. Winning raises it and losing lowers it, and beating a higher-rated opponent raises it more (ELO).",
      "The swing shrinks as you play more: large under 30 matches, medium under 100, small after that.",
      "<b>내 프로필</b> (my profile) in the lobby shows your rating and how it has moved. The full table is under <a href=\"#/ranks\">Ranks</a>.",
    ])}
    ${h("Spectating and replays")}
    ${ul([
      "Running matches are listed under <a href=\"#/live\">Live</a>. With the room code you can watch one that is not listed.",
      "Spectators see the board and the order of claims. They do not see inside a world and are not given the seed.",
      "Finished matches stay under <a href=\"#/replays\">Replays</a>, to step through or play back.",
    ])}
    ${h("Worlds and updates")}
    ${ul([
      "Every match generates a new world. The mod removes the worlds of finished matches by itself.",
      "When a new version ships the lobby says so. One click downloads it, installs it and closes the game; start it again and you are current.",
      "First-time setup is under <a href=\"#/install\">Install</a>.",
    ])}
  `,
};

/* ---------------------------------------------------------------- 미션 사전 */

/**
 * 미션의 영어 이름. 데이터(missions.json)에는 한국어 이름뿐이라 여기 둡니다.
 * 없는 id 는 한국어 이름으로 나옵니다 — 새 미션이 추가돼도 목록은 깨지지 않습니다.
 */
const NAME_EN = {
  easy_oak_logs: "64 Oak Logs",
  easy_distinct_chest: "Fill a chest with 27 different items",
  easy_obsidian: "4 Obsidian",
  easy_crafter_crafter: "Crafters Crafting Crafters",
  easy_cookie: "1 Cookie",
  easy_eight_dyes: "8 different dyes",
  easy_bookshelf: "1 Bookshelf",
  easy_powered_rails: "12 Powered Rails",
  easy_iron_ingots: "16 Iron Ingots",
  easy_ender_pearl: "1 Ender Pearl",
  easy_what_a_deal: "What a Deal!",
  easy_six_stones: "Granite, Diorite, Andesite, Deepslate, Sandstone and Tuff",
  easy_fall_survive_128: "Survive a 128-block fall",
  easy_jump_1000: "Jump 1,000 times",
  easy_die_lava: "Die in lava",
  easy_bed_respawn: "Respawn at a bed",
  easy_kill_villager: "Kill a villager",
  easy_glow_sign: "Glow and Behold!",
  easy_dolphins_grace: "Get Dolphin's Grace",
  easy_patterned_banner: "Make a patterned banner",
  easy_five_log_types: "5 kinds of log",
  easy_minecart_20_blocks: "Ride a minecart 20 blocks",
  easy_boat_with_monster: "Share a boat with a monster",
  easy_self_arrow_hit: "Hit yourself with your own arrow",
  easy_breed_animal: "The Parrots and the Bats",
  easy_age_lock_baby: "Keep a baby young with a Golden Dandelion",
  easy_die_dripstone: "Die to dripstone",
  easy_use_lodestone: "Country Lode, Take Me Home",
  medium_axolotl: "1 Bucket of Axolotl",
  medium_three_lanterns: "Lantern, Soul Lantern and Copper Lantern",
  medium_return_to_sender: "Return to Sender",
  medium_beetroot_seeds: "8 Beetroot Seeds",
  medium_glowstone: "8 Glowstone",
  medium_tnt: "1 TNT",
  medium_jukebox: "1 Jukebox",
  medium_cake: "1 Cake",
  medium_far_from_origin: "Get past ±1000 on both X and Z",
  medium_six_pickaxes: "Every pickaxe except netherite",
  medium_two_egg_variants: "2 different kinds of egg",
  medium_kill_mob_far_10: "Kill a monster from 10 blocks away",
  medium_suspicious_stew_2: "2 Suspicious Stew",
  medium_light_as_rabbit: "Light as a Rabbit",
  medium_ancient_debris: "Respecting the Remnants",
  medium_xp_level_20: "Reach level 20",
  medium_sneak_100: "Sneak 100",
  medium_magma_cream: "1 Magma Cream",
  medium_jeb_sheep: "Make a rainbow sheep",
  medium_kill_zombie_piglin_3: "Kill 3 Zombified Piglins",
  medium_nether_y_120: "Climb to Y 120 in the Nether",
  medium_cat_tamed: "Tame a cat",
  medium_noteblock_tweb: "Play \"Mary Had a Little Lamb\" on note blocks",
  medium_writable_book: "1 Book and Quill",
  medium_armor_broken: "Break a piece of armor",
  medium_armor_stand_full: "A full set of armor on an armor stand",
  hard_any_potion: "Any potion",
  hard_dried_ghast: "1 Dried Ghast",
  hard_pufferfish: "2 Pufferfish",
  hard_honey_bottle: "1 Honey Bottle",
  hard_enchanted_book: "1 Enchanted Book",
  hard_dyes_14: "14 different dyes",
  hard_sea_lantern: "1 Sea Lantern",
  hard_wither_death: "Wither away",
  hard_wolf_armor: "Put wolf armor on a wolf",
};

/** 아이템 id → [한국어, 영어]. 미션 조건 문장에 나오는 것들입니다. */
const ITEM = {
  "minecraft:oak_log": ["참나무 원목", "Oak Log"],
  "minecraft:birch_log": ["자작나무 원목", "Birch Log"],
  "minecraft:spruce_log": ["가문비나무 원목", "Spruce Log"],
  "minecraft:jungle_log": ["정글나무 원목", "Jungle Log"],
  "minecraft:acacia_log": ["아카시아나무 원목", "Acacia Log"],
  "minecraft:dark_oak_log": ["짙은 참나무 원목", "Dark Oak Log"],
  "minecraft:mangrove_log": ["맹그로브나무 원목", "Mangrove Log"],
  "minecraft:cherry_log": ["벚나무 원목", "Cherry Log"],
  "minecraft:pale_oak_log": ["창백한 참나무 원목", "Pale Oak Log"],
  "minecraft:poplar_log": ["포플러나무 원목", "Poplar Log"],
  "minecraft:crimson_stem": ["진홍빛 자루", "Crimson Stem"],
  "minecraft:warped_stem": ["뒤틀린 자루", "Warped Stem"],
  "minecraft:obsidian": ["흑요석", "Obsidian"],
  "minecraft:cookie": ["쿠키", "Cookie"],
  "minecraft:bookshelf": ["책장", "Bookshelf"],
  "minecraft:powered_rail": ["전동 레일", "Powered Rail"],
  "minecraft:iron_ingot": ["철 주괴", "Iron Ingot"],
  "minecraft:ender_pearl": ["엔더 진주", "Ender Pearl"],
  "minecraft:granite": ["화강암", "Granite"],
  "minecraft:diorite": ["섬록암", "Diorite"],
  "minecraft:andesite": ["안산암", "Andesite"],
  "minecraft:deepslate": ["심층암", "Deepslate"],
  "minecraft:sandstone": ["사암", "Sandstone"],
  "minecraft:tuff": ["응회암", "Tuff"],
  "minecraft:axolotl_bucket": ["아홀로틀이 담긴 양동이", "Bucket of Axolotl"],
  "minecraft:lantern": ["랜턴", "Lantern"],
  "minecraft:soul_lantern": ["영혼 랜턴", "Soul Lantern"],
  "minecraft:copper_lantern": ["구리 랜턴", "Copper Lantern"],
  "minecraft:beetroot_seeds": ["비트 씨앗", "Beetroot Seeds"],
  "minecraft:glowstone": ["발광석", "Glowstone"],
  "minecraft:tnt": ["TNT", "TNT"],
  "minecraft:jukebox": ["주크박스", "Jukebox"],
  "minecraft:cake": ["케이크", "Cake"],
  "minecraft:wooden_pickaxe": ["나무 곡괭이", "Wooden Pickaxe"],
  "minecraft:stone_pickaxe": ["돌 곡괭이", "Stone Pickaxe"],
  "minecraft:copper_pickaxe": ["구리 곡괭이", "Copper Pickaxe"],
  "minecraft:iron_pickaxe": ["철 곡괭이", "Iron Pickaxe"],
  "minecraft:golden_pickaxe": ["금 곡괭이", "Golden Pickaxe"],
  "minecraft:diamond_pickaxe": ["다이아몬드 곡괭이", "Diamond Pickaxe"],
  "minecraft:egg": ["달걀", "Egg"],
  "minecraft:blue_egg": ["파란 달걀", "Blue Egg"],
  "minecraft:brown_egg": ["갈색 달걀", "Brown Egg"],
  "minecraft:suspicious_stew": ["수상한 스튜", "Suspicious Stew"],
  "minecraft:magma_cream": ["마그마 크림", "Magma Cream"],
  "minecraft:writable_book": ["책과 깃펜", "Book and Quill"],
  "minecraft:dried_ghast": ["마른 가스트", "Dried Ghast"],
  "minecraft:pufferfish": ["복어", "Pufferfish"],
  "minecraft:honey_bottle": ["꿀이 든 병", "Honey Bottle"],
  "minecraft:enchanted_book": ["마법이 부여된 책", "Enchanted Book"],
  "minecraft:sea_lantern": ["바다 랜턴", "Sea Lantern"],
  "minecraft:potion": ["물약", "Potion"],
  "minecraft:splash_potion": ["투척용 물약", "Splash Potion"],
  "minecraft:lingering_potion": ["잔류형 물약", "Lingering Potion"],
};

const DYES = ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray",
  "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"].map((c) => `minecraft:${c}_dye`);

/** 사전에 없는 id 는 id 에서 이름을 만듭니다: minecraft:iron_ingot → Iron Ingot. */
function itemName(id, ko) {
  const hit = ITEM[id];
  if (hit) return hit[ko ? 0 : 1];
  return id.replace(/^minecraft:/, "").split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** 을/를. 마지막 글자에 받침이 있으면 "을" — 한글이 아니면 "을(를)" 로 둡니다. */
function objectParticle(word) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return "을(를)";
  return code % 28 ? "을" : "를";
}

const listOf = (ids, ko) => ids.map((id) => itemName(id, ko)).join(ko ? " · " : ", ");
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/** 도전 과제 id → 바닐라가 요구하는 것. */
const ADVANCEMENT = {
  "minecraft:adventure/crafters_crafting_crafters": ["제작기가 제작기를 만들어 낼 때 그 근처에 있습니다.", "Be near a Crafter when it crafts a Crafter."],
  "minecraft:adventure/trade": ["주민과 거래를 한 번 성사시킵니다.", "Complete one trade with a villager."],
  "minecraft:husbandry/make_a_sign_glow": ["표지판에 발광 먹물 주머니를 사용합니다.", "Use a Glow Ink Sac on a sign."],
  "minecraft:husbandry/breed_an_animal": ["동물 두 마리를 교배시킵니다.", "Breed two animals."],
  "minecraft:adventure/use_lodestone": ["자석석에 나침반을 사용합니다.", "Use a Compass on a Lodestone."],
  "minecraft:nether/return_to_sender": ["가스트가 쏜 화염구를 되받아쳐 가스트를 죽입니다.", "Kill a Ghast with a fireball knocked back at it."],
  "minecraft:adventure/walk_on_powder_snow_with_leather_boots": ["가죽 장화를 신고 가루눈 위를 걷습니다.", "Walk on Powder Snow wearing Leather Boots."],
  "minecraft:adventure/salvage_sherd": ["수상한 모래나 수상한 자갈을 솔로 털어 도자기 조각을 얻습니다.", "Brush a suspicious block and get a Pottery Sherd out of it."],
  "minecraft:adventure/avoid_vibration": ["스컬크 감지체나 워든 근처에서 웅크려, 들키지 않고 움직입니다.", "Sneak near a Sculk Sensor or a Warden so that it does not detect you."],
};

/** `custom` 키 → 정확한 조건. 판정 코드(모드의 mission/)를 옮긴 것입니다. */
const CUSTOM = {
  bed_respawn: [
    "죽은 뒤 <b>침대에서</b> 다시 태어납니다. 리스폰 정박기에서 태어나는 것, 엔드에서 포탈로 돌아오는 것은 인정되지 않습니다. 침대가 부서졌거나 막혀서 월드 스폰으로 가면 안 됩니다.",
    "Die and respawn <b>at a bed</b>. Respawning at a respawn anchor does not count, nor does returning from the End through the exit portal. If the bed was broken or blocked and you land at world spawn, it does not count.",
  ],
  banner_with_pattern: [
    "무늬가 하나 이상 들어간 현수막을 인벤토리에 가집니다. 불길한 현수막(습격 대장이 들고 있는 것)은 인정되지 않습니다.",
    "Hold a banner with at least one pattern in your inventory. An Ominous Banner does not count.",
  ],
  boat_with_hostile: [
    "적대적 몹과 같은 보트에 타고 있습니다. 뗏목도 됩니다. 슬라임 같은 것도 적대적 몹으로 칩니다.",
    "Be in the same boat as a hostile mob. A raft counts. Slimes and the like count as hostile.",
  ],
  arrow_self_hit: [
    "자기가 쏜 화살에 자기가 맞습니다. 그 화살로 죽지 않아도 됩니다.",
    "Take damage from an arrow you shot yourself. It does not have to kill you.",
  ],
  age_lock_baby: [
    "황금 민들레를 들고 아기 동물에게 우클릭합니다.",
    "Right-click a baby animal while holding a Golden Dandelion.",
  ],
  pos_abs_xz_1000: [
    "X 좌표와 Z 좌표의 절댓값이 <b>둘 다</b> 1000 을 넘는 곳에 섭니다(예: X 1001, Z −1200). 어느 차원이든 됩니다.",
    "Stand where the absolute values of <b>both</b> X and Z are over 1000 (for example X 1001, Z −1200). Any dimension counts.",
  ],
  kill_mob_far_10: [
    "적대적 몹을 죽이는 순간, 그 몹과 나 사이의 거리가 10블록 이상입니다. 높이 차이도 거리에 들어갑니다. 가스트·슬라임·팬텀도 됩니다.",
    "Kill a hostile mob while at least 10 blocks away from it at the moment it dies. Height difference counts toward the distance. Ghasts, slimes and phantoms count.",
  ],
  xp_level_20: [
    "경험치 레벨이 20 이상이 됩니다. 한 번 닿으면 됩니다.",
    "Reach experience level 20. Reaching it once is enough.",
  ],
  jeb_sheep_named: [
    "이름이 정확히 <code>jeb_</code> 인 이름표를 양에게 붙입니다.",
    "Use a name tag reading exactly <code>jeb_</code> on a sheep.",
  ],
  nether_y_120: [
    "네더에서 Y 좌표 120 이상인 곳에 섭니다.",
    "Stand at Y 120 or higher in the Nether.",
  ],
  cat_tamed: [
    "고양이를 길들입니다. 내가 길들인 고양이가 내 64블록 안에 있을 때 인정됩니다.",
    "Tame a cat. It counts while a cat you have tamed is within 64 blocks of you.",
  ],
  noteblock_song_tweb: [
    "소리 블록으로 <b>미 레 도 레 미 미 미</b> 일곱 음을 순서대로 울립니다. 음의 간격만 맞으면 어느 음에서 시작해도 됩니다. 손으로 쳐도, 레드스톤으로 울려도 됩니다. 가장 최근에 울린 일곱 음을 보므로, 틀렸으면 처음부터 다시 일곱 음을 울리면 됩니다.",
    "Sound the seven notes <b>E D C D E E E</b> in order on note blocks. Only the steps between notes matter, so any starting pitch works. Hitting the blocks by hand or driving them with redstone both count. The last seven notes played are what is checked, so after a wrong note just play all seven again.",
  ],
  armor_broken: [
    "입고 있던 방어구(투구·흉갑·레깅스·부츠, 거북 등딱지 포함) 하나가 내구도가 다해 부서집니다.",
    "Wear a piece of armor (helmet, chestplate, leggings or boots, turtle shell included) until it breaks.",
  ],
  armor_stand_full: [
    "머리·몸·다리·발 네 자리가 모두 채워진 갑옷 거치대가 내 16블록 안에 있습니다. 재질은 섞여도 됩니다.",
    "Have an armor stand with all four slots — head, chest, legs and feet — filled, within 16 blocks of you. The pieces need not match.",
  ],
  wolf_armor_equipped: [
    "길들인 늑대에게 늑대 갑옷을 입힙니다. 갑옷을 입은 그 늑대가 내 64블록 안에 있을 때 인정됩니다.",
    "Put wolf armor on a tamed wolf. It counts while that armored wolf is within 64 blocks of you.",
  ],
};

const DEATH = {
  lava: ["용암 피해로 죽습니다. 용암에서 나온 뒤 몸에 붙은 불로 죽는 것은 다른 사인이라 인정되지 않습니다.", "Die to lava damage. Dying to the fire that follows you out of the lava is a different cause and does not count."],
  dripstone: ["뾰족한 점적석 위로 떨어져 죽거나, 떨어지는 종유석에 맞아 죽습니다.", "Die by falling onto pointed dripstone, or by being hit by a falling stalactite."],
  wither: ["시듦 효과의 피해로 죽거나, 위더 스켈레톤에게 죽습니다.", "Die to Wither effect damage, or be killed by a Wither Skeleton."],
};

const MOB = {
  "minecraft:villager": ["주민", "villager"],
  "minecraft:zombified_piglin": ["좀비화 피글린", "Zombified Piglin"],
};

const EFFECT = {
  "minecraft:dolphins_grace": ["돌고래의 가호", "Dolphin's Grace"],
};

/** 2대2 에서 팀원 것을 더해서 보는 판정들. */
const POOLED = new Set(["inventory_count", "inventory_collection", "inventory_distinct", "inventory_any_of", "stat"]);
const isPooled = (d) => POOLED.has(d.type) || (d.type === "custom" && d.key === "armor_broken");

/**
 * 미션 하나의 달성 조건을 문장으로.
 *
 * 문장은 판정 종류에서 만듭니다. 그래서 같은 종류의 새 미션은 여기를 고치지 않아도
 * 맞는 문장을 얻습니다. 모르는 종류나 모르는 키가 오면 지어내지 않고 모른다고 씁니다.
 */
function conditionOf(m, ko) {
  const d = m.detector ?? {};
  const pick = (pair) => pair[ko ? 0 : 1];
  switch (d.type) {
    case "inventory_count":
      return ko
        ? `인벤토리에 <b>${itemName(d.item, true)}</b> ${d.count}개 이상을 가집니다.`
        : `Have at least ${d.count} × <b>${itemName(d.item, false)}</b> in your inventory.`;
    case "inventory_collection":
      return ko
        ? `다음을 <b>전부</b> 하나 이상씩 인벤토리에 가집니다: ${listOf(d.items, true)}.`
        : `Hold at least one of <b>every</b> item in this list: ${listOf(d.items, false)}.`;
    case "inventory_distinct": {
      const all = sameSet(d.candidates, DYES)
        ? (ko ? "염료 16색" : "the 16 dye colours")
        : listOf(d.candidates, ko);
      return ko
        ? `다음 중 서로 다른 <b>${d.minDistinct}종</b> 이상을 인벤토리에 가집니다: ${all}.`
        : `Hold at least <b>${d.minDistinct} different</b> items from this list: ${all}.`;
    }
    case "inventory_any_of":
      return ko
        ? `다음 중 아무것이나 합쳐서 ${d.totalCount}개 이상을 인벤토리에 가집니다: ${listOf(d.items, true)}.`
        : `Hold ${d.totalCount} or more in total of any of: ${listOf(d.items, false)}.`;
    case "inventory_potion":
      return ko
        ? `효과가 있는 물약(일반 · 투척용 · 잔류형 모두 됨) ${d.totalCount}개 이상을 인벤토리에 가집니다. 물병과 어색한 · 평범한 · 진한 물약은 인정되지 않습니다.`
        : `Hold ${d.totalCount} or more potions with an effect — drinkable, splash or lingering. Water Bottles and Awkward, Mundane and Thick Potions do not count.`;
    case "chest_distinct_27":
      return ko
        ? "상자 하나의 27칸을 <b>전부 서로 다른 아이템</b>으로 채우고 상자를 닫습니다. 작은 상자여야 합니다(덫 상자 · 구리 상자도 됨). 큰 상자, 통, 엔더 상자, 상자가 실린 광산 수레는 인정되지 않습니다."
        : "Fill all 27 slots of one chest with <b>27 different items</b>, then close it. It has to be a single chest (trapped and copper chests count). Double chests, barrels, ender chests and chest minecarts do not.";
    case "advancement": {
      const known = ADVANCEMENT[d.id];
      const tail = ko ? " 게임이 그 도전 과제를 준 순간 인정됩니다." : " It counts the moment the game grants the advancement.";
      return known ? pick(known) + tail : (ko ? `도전 과제 <code>${escapeHtml(d.id)}</code> 를 달성합니다.` : `Earn the advancement <code>${escapeHtml(d.id)}</code>.`);
    }
    case "stat": {
      const n = d.threshold;
      if (d.statType === "minecraft:custom" && d.statKey === "minecraft:jump") {
        return ko ? `이번 판에서 ${n.toLocaleString()}번 이상 점프합니다.` : `Jump ${n.toLocaleString()} times or more this match.`;
      }
      if (d.statType === "minecraft:custom" && d.statKey === "minecraft:minecart_one_cm") {
        return ko ? `광산 수레를 타고 합쳐서 ${n / 100}블록 이상 이동합니다.` : `Travel ${n / 100} blocks or more in total by minecart.`;
      }
      if (d.statType === "minecraft:killed") {
        const mob = MOB[d.statKey] ? pick(MOB[d.statKey]) : itemName(d.statKey, ko);
        return ko ? `<b>${mob}</b>${objectParticle(mob)} 직접 ${n}마리 이상 죽입니다.` : `Kill at least ${n} × <b>${mob}</b> yourself.`;
      }
      return ko
        ? `통계 <code>${escapeHtml(d.statKey)}</code> 가 ${n} 이상이 됩니다.`
        : `Reach ${n} on the statistic <code>${escapeHtml(d.statKey)}</code>.`;
    }
    case "death_by":
      return DEATH[d.source] ? pick(DEATH[d.source]) : (ko ? `정해진 사인(<code>${escapeHtml(d.source)}</code>)으로 죽습니다.` : `Die to the cause <code>${escapeHtml(d.source)}</code>.`);
    case "active_effect": {
      const name = EFFECT[d.effect] ? pick(EFFECT[d.effect]) : itemName(d.effect, ko);
      return ko ? `<b>${name}</b> 효과를 받습니다. 효과가 걸려 있는 순간 인정됩니다.` : `Have the <b>${name}</b> effect. It counts while the effect is on you.`;
    }
    case "custom": {
      if (CUSTOM[d.key]) return pick(CUSTOM[d.key]);
      // 값이 키에 들어 있는 묶음: fall_survive_128 → 128블록.
      const fall = /^fall_survive_(\d+)$/.exec(d.key ?? "");
      if (fall) {
        return ko
          ? `한 번에 ${fall[1]}블록 이상 떨어지고, 땅에 닿았을 때 살아 있습니다.`
          : `Fall ${fall[1]} blocks or more in one drop and be alive when you land.`;
      }
      return ko ? "특수 조건입니다. 설명이 아직 준비되지 않았습니다." : "A special condition. Its description is not written yet.";
    }
    default:
      return ko ? "설명이 아직 준비되지 않은 종류의 미션입니다." : "A kind of mission this guide does not describe yet.";
  }
}

/* -------------------------------------------------------------- 미션 목록 */

const TIERS = ["easy", "medium", "hard"];
const TIER_NAME = { ko: { easy: "쉬움", medium: "보통", hard: "어려움" }, en: { easy: "Easy", medium: "Medium", hard: "Hard" } };

/** 아이콘 한 칸. 세로 스트립을 정수 크기 창 안에서 밀어 올립니다(관전 보드와 같은 방식). */
function iconHtml(m, icons) {
  const icon = icons?.[m.id];
  if (!icon) return `<span class="g-mi none"></span>`;
  const anim = icon.frames > 1
    ? ` style="animation:mi-frames ${(icon.frames * icon.ms) / 1000}s steps(${icon.frames}) infinite"`
    : "";
  return `<span class="g-mi"><img src="/mission-icons/${encodeURIComponent(m.id)}.png" alt="" loading="lazy"${anim} /></span>`;
}

function missionRow(m, icons, lang) {
  const ko = lang === "ko";
  const name = ko ? m.displayName : (NAME_EN[m.id] ?? m.displayName);
  const sub = !ko && NAME_EN[m.id] ? `<span class="g-m-sub">${escapeHtml(m.displayName)}</span>` : "";
  const team = isPooled(m.detector ?? {}) ? `<span class="g-chip team">${ko ? "팀 합산" : "TEAM TOTAL"}</span>` : "";
  return `
    <div class="g-m" data-d="${escapeHtml(m.difficulty)}" data-t="${escapeHtml(`${m.displayName} ${NAME_EN[m.id] ?? ""}`.toLowerCase())}">
      ${iconHtml(m, icons)}
      <div class="g-m-bd">
        <div class="g-m-nm">${escapeHtml(name)}${sub}</div>
        <div class="g-m-tx">${conditionOf(m, ko)}</div>
        <div class="g-m-chips"><span class="g-chip ${escapeHtml(m.difficulty)}">${TIER_NAME[lang][m.difficulty] ?? escapeHtml(m.difficulty)}</span>${team}</div>
      </div>
    </div>`;
}

function missionsHtml(missions, icons, lang) {
  const ko = lang === "ko";
  return TIERS.map((tier) => {
    const list = missions.filter((m) => m.difficulty === tier);
    if (!list.length) return "";
    const count = ko ? `${list.length}개` : `${list.length}`;
    return `
      <section class="g-tier" data-tier="${tier}">
        <div class="g-tier-h"><span class="g-chip ${tier}">${TIER_NAME[lang][tier]}</span><span class="g-tier-n">${count}</span></div>
        <div class="g-ms">${list.map((m) => missionRow(m, icons, lang)).join("")}</div>
      </section>`;
  }).join("") + `<div class="state g-none" hidden>${ko ? "찾는 미션이 없습니다." : "No mission matches."}</div>`;
}

/* ------------------------------------------------------------ 쪽 조립 */

/** 가이드 한 쪽의 HTML. 미션 목록과 숫자는 `mountGuide` 가 나중에 채웁니다. */
export function guidePage(sectionId, lang) {
  const L = lang === "ko" ? KO : EN;
  const section = guideSection(sectionId);
  const at = GUIDE_SECTIONS.indexOf(section);
  const prev = GUIDE_SECTIONS[at - 1];
  const next = GUIDE_SECTIONS[at + 1];
  const nav = GUIDE_SECTIONS.map((s, i) => `
    <a href="${href(s.id)}"${s === section ? ' class="on"' : ""}><i>${String(i + 1).padStart(2, "0")}</i>${s[lang]}</a>`).join("");
  return `
    <div class="wrap guide">
      <nav class="g-nav" aria-label="${L.kicker}">
        <div class="kick">${L.kicker}</div>
        <div class="g-nav-list">${nav}</div>
      </nav>
      <article class="g-body">
        <div class="kick">${String(at + 1).padStart(2, "0")} / ${String(GUIDE_SECTIONS.length).padStart(2, "0")}</div>
        <h2 class="h-lg">${section[lang]}</h2>
        ${L[section.id]()}
        <div class="g-pn">
          ${prev ? `<a class="g-pn-a" href="${href(prev.id)}"><span>‹ ${L.prev}</span><b>${prev[lang]}</b></a>` : "<span></span>"}
          ${next ? `<a class="g-pn-a next" href="${href(next.id)}"><span>${L.next} ›</span><b>${next[lang]}</b></a>` : "<span></span>"}
        </div>
      </article>
    </div>`;
}

let cache = null;

/** 미션 목록과 아이콘 목록. 가이드 안에서 쪽을 넘길 때마다 다시 받지 않습니다. */
function loadMissions() {
  cache ??= Promise.all([
    fetch("/api/missions").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("/mission-icons/manifest.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  ]).then(([m, icons]) => {
    // 실패한 결과는 붙잡아 두지 않습니다. 다음에 들어오면 다시 받아 봅니다.
    if (!m) cache = null;
    return { missions: m?.missions ?? null, icons: icons ?? {} };
  });
  return cache;
}

/**
 * 그려진 쪽에 서버에서 온 것을 채웁니다: 난도별 미션 수, 그리고 미션 목록과 그 필터.
 * 돌려주는 함수를 부르면 뒤늦게 도착한 응답이 다른 화면을 건드리지 않습니다.
 */
export function mountGuide(root, sectionId, lang) {
  let alive = true;
  const ko = lang === "ko";

  loadMissions().then(({ missions, icons }) => {
    if (!alive) return;

    root.querySelectorAll("[data-pool]").forEach((el) => {
      if (missions) el.textContent = String(missions.filter((m) => m.difficulty === el.dataset.pool).length);
    });

    const holder = root.querySelector("#gMissions");
    if (!holder) return;
    if (!missions) {
      holder.innerHTML = `<div class="state state-err">${ko ? "미션 목록을 불러오지 못했습니다." : "Could not load the mission list."}</div>`;
      return;
    }
    holder.innerHTML = missionsHtml(missions, icons, lang);

    const search = root.querySelector("#gSearch");
    const buttons = [...root.querySelectorAll("#gFilter button")];
    let tier = "all";
    const apply = () => {
      const q = (search?.value ?? "").trim().toLowerCase();
      let shown = 0;
      holder.querySelectorAll(".g-m").forEach((row) => {
        const ok = (tier === "all" || row.dataset.d === tier) && (!q || row.dataset.t.includes(q));
        row.hidden = !ok;
        if (ok) shown++;
      });
      holder.querySelectorAll(".g-tier").forEach((sec) => {
        sec.hidden = !sec.querySelector(".g-m:not([hidden])");
      });
      holder.querySelector(".g-none").hidden = shown > 0;
    };
    buttons.forEach((b) => b.addEventListener("click", () => {
      tier = b.dataset.d;
      buttons.forEach((x) => x.classList.toggle("on", x === b));
      apply();
    }));
    search?.addEventListener("input", apply);
  });

  return () => { alive = false; };
}
