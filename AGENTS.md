# mchx-server — 매치 서버와 웹

**이 저장소는 혼자가 아니다.** mchx(Minecraft Hex)의 매치 서버이고, 모드·문서·배포 스크립트는
부모 저장소 `pjw070823/mchx`(비공개)에 있다. 부모는 이 저장소를 `server/` 폴더에 두고 커밋 해시
하나로 가리킨다. 문서 전체는 부모의 `wiki/` 에 있다 — 부모가 있다면 `../AGENTS.md` 와
`../wiki/index.md` 를 먼저 읽는다. 파일 지도는 `../wiki/reference/server-map.md`.

```bash
npm install
npm test             # node:test
npm run typecheck
npm run dev          # http://localhost:8787 (API + WS), 웹은 SPECTATOR_PORT (기본 80)
```

## 이 저장소에서만 걸리는 것

- **이 저장소는 공개다.** 시드 풀 파일이나 비밀값을 넣지 않는다. 풀은
  운영 서버의 DB 옆(`~/data/seed-pool.jsonl`)에 따로 올린다.
- **커밋 순서**: 여기를 먼저 커밋·푸시하고, 그다음 부모가 포인터를 커밋한다. 배포 스크립트는
  이 저장소의 `master` 를 `git pull` 만 한다 — 밀지 않은 커밋은 배포되지 않는다.
- **`src/protocol.ts` 는 모드의 `Protocol.kt` 와 짝이다.** 한쪽만 고치면 에러 없이 필드가
  사라진다. 필드를 **추가**하는 것은 안전하고, 이름을 바꾸거나 지우는 것은 아니다.
- **시드는 문자열로 내보낸다**(JSON 에 64비트 정수가 없다). **관전자에게는 시드를 보내지 않는다.**
  **풀에서 뽑은 시드는 공개 API 에서도 가린다**(`withoutPoolSeed`). 시드나 관전자용 필드를 새로
  내보낼 때마다 이 셋을 다시 묻는다.
- **`missions.json` 은 사본이다.** 정본은 부모의 `shared/missions.json` 이고 `npm run sync-missions`
  로 맞춘다. 난이도별 하한(easy 12 · medium 8 · hard 5)을 깨면 서버가 기동하지 않는다.
- **`src/release.ts` 의 해시는 손으로 붙여넣는다.** 틀리면 전원이 업데이트를 못 한다.
  `test/download.test.ts` 가 잡으므로 릴리스 커밋 전에 `npm test`. `MINIMUM` 은 올리는 순간 그
  아래 전원을 잠그므로 `LATEST` 와 다른 배포에서 올린다.
- **`public/downloads/` 에 tester jar 을 넣지 않는다.**
- **방은 메모리에만 있다.** 재시작하면 진행 중인 매치가 사라진다.
- **`public/styles.css` 의 값은 "정리"하지 않는다.** 디자인 목업의 숫자 그대로이고, 그 값들이
  웹 보드와 인게임 보드를 같게 만든다. 행은 q 내림차순으로 그린다.
- **보드의 진실은 `src/hex.ts`** 다. 웹(`public/board.js`)과 모드가 각자 그것을 따라 그린다.
- 주석은 영어, `public/*` 의 주석과 사용자에게 보이는 문자열은 한국어. 커밋에 `Co-Authored-By`
  트레일러를 붙이지 않는다.
