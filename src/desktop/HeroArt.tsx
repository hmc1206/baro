// 바탕화면 히어로 카드 배경 그림: 겹친 산 능선 + 줄무늬 해 + 굽은 길 (외부 이미지 없이 SVG로)
// seed가 바뀌면 해 위치·능선이 조금씩 달라져 카드마다 다른 그림처럼 보임
const P = [
  // 먼 능선 → 가까운 능선 (뒤에 있을수록 밝고 흐리게)
  { d: "M0 300 C120 250 210 270 320 230 S520 170 640 215 S860 180 980 225 S1140 205 1200 240 V500 H0Z", fill: "#3B5753", op: .55 },
  { d: "M0 330 C140 290 240 320 360 280 S560 250 700 300 S900 250 1040 290 S1160 280 1200 300 V500 H0Z", fill: "#27403D", op: .8 },
  { d: "M0 380 C160 330 260 370 420 330 S640 300 760 350 S960 320 1080 360 S1170 350 1200 365 V500 H0Z", fill: "#172B29", op: 1 },
  { d: "M0 430 C180 395 330 430 470 405 S700 380 860 420 S1060 400 1200 430 V500 H0Z", fill: "#0C1917", op: 1 },
];

export function HeroArt({ seed = 0 }: { seed?: number }) {
  const s = ((seed * 37) % 7) - 3;            // -3..3
  const sunX = 820 + s * 40, sunY = 200 + (seed % 3) * 12;
  const id = `ha${seed}`;
  return (
    <svg className="dk-art" viewBox="0 0 1200 500" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0B2224" /><stop offset=".55" stopColor="#1E3634" /><stop offset="1" stopColor="#4A3322" />
        </linearGradient>
        <radialGradient id={`${id}g`} cx={sunX / 1200} cy={sunY / 500} r=".45">
          <stop offset="0" stopColor="#F5A524" stopOpacity=".55" /><stop offset="1" stopColor="#F5A524" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}r`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F3B98A" stopOpacity=".35" /><stop offset="1" stopColor="#E8986A" />
        </linearGradient>
        <clipPath id={`${id}c`}><circle cx={sunX} cy={sunY} r="96" /></clipPath>
      </defs>
      <rect width="1200" height="500" fill={`url(#${id}s)`} />
      <rect width="1200" height="500" fill={`url(#${id}g)`} />
      {/* 해: 동심원 줄무늬 */}
      <g clipPath={`url(#${id}c)`}>
        <circle cx={sunX} cy={sunY} r="96" fill="#E9762C" />
        {Array.from({ length: 8 }, (_, i) => <circle key={i} cx={sunX} cy={sunY} r={90 - i * 11} fill="none" stroke="#FFD08A" strokeOpacity={.18 + i * .07} strokeWidth="3" />)}
      </g>
      {P.map((p, i) => <path key={i} d={p.d} fill={p.fill} opacity={p.op} transform={`translate(${s * (i + 1) * 6} 0)`} />)}
      {/* 굽은 길: 아래 가운데에서 능선 사이로 */}
      <path d={`M${560 + s * 10} 500 C ${520 + s * 10} 470 700 455 640 430 S 560 405 660 392 S 720 378 ${690 + s * 6} 370
        L ${700 + s * 6} 370 C 760 380 700 394 690 398 S 640 420 700 438 S ${760 + s * 10} 478 ${720 + s * 10} 500 Z`} fill={`url(#${id}r)`} />
    </svg>
  );
}
