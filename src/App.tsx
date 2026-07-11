import { useEffect, useRef, useState } from "react";

// ============================================================
// МОРСКОЙ БОЙ — реплика советского игрового автомата
// - один корабль плывёт по горизонту (не зависит от перископа)
// - стрелки ←/→ двигают ПРИЦЕЛ перископа влево/вправо
// - торпеда — зелёный прерывистый луч, идёт из нижнего центра
//   к точке прицела
// ============================================================

type Ship = {
  x: number; // 0..1 по ширине окна
  dir: 1 | -1;
  speed: number;
  alive: boolean;
  respawnAt: number;
};

type Torpedo = {
  progress: number;
  active: boolean;
  aimAtFire: number; // положение прицела (0..1) в момент выстрела
};

type Explosion = {
  x: number;
  y: number;
  t: number;
  active: boolean;
  dir: 1 | -1;
};

const VIEW_W = 1000;
const VIEW_H = 420;
const HORIZON_Y = VIEW_H * 0.52;
const PANELS = 3;

// прицел ходит между этими границами (в долях ширины)
const AIM_MIN = 0.1;
const AIM_MAX = 0.9;

// 8 фіксованих напрямків стрільби (як у справжньому автоматі).
// Приціл перемикається між ними покроково — жодних проміжних значень.
const TRAJECTORIES = 8;
const AIM_POSITIONS: number[] = Array.from(
  { length: TRAJECTORIES },
  (_, i) => AIM_MIN + (i / (TRAJECTORIES - 1)) * (AIM_MAX - AIM_MIN)
);

// Півширина видимої частини корпусу танкера в долях ширини екрана.
// Танкер малюється завширшки 220px при VIEW_W=1000, але заповнюють корпус
// лише ~160px (без гострого бульбового форштевня та прозорих країв).
// 80/1000 = 0.08 — відповідає видимому силуету, охоплює ніс/середину/корму,
// але не робить корабель штучно ширшим.
// Півширина хітбокса = півширина видимого корпусу танкера.
// Танкер малюється при w=220px, потім масштабується на 1/1.8:
// повна ширина = 220/1.8 ≈ 122.2px при VIEW_W=1000 → 0.1222 в долях,
// півширина ≈ 0.0611. Площа ураження точно = площі корабля.
const SHIP_HALF_WIDTH = 220 / 1.8 / 2 / VIEW_W;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const shipRef = useRef<Ship>({
    x: 0.2,
    dir: 1,
    speed: 0.1,
    alive: true,
    respawnAt: 0,
  });

  const torpedoRef = useRef<Torpedo>({
    progress: 0,
    active: false,
    aimAtFire: 0.5,
  });
  const explosionRef = useRef<Explosion>({ x: 0, y: 0, t: 0, active: false, dir: 1 });
  const lastTimeRef = useRef<number>(0);
  const shakeRef = useRef<number>(0);

  // Приціл — індекс однієї з 8 фіксованих позицій (0..7).
  // Стартуємо приблизно по центру (індекс 3 або 4).
  const aimIndexRef = useRef<number>(Math.floor(TRAJECTORIES / 2));
  // Фактична координата прицілу (0..1) — завжди дорівнює AIM_POSITIONS[index].
  const aimRef = useRef<number>(AIM_POSITIONS[Math.floor(TRAJECTORIES / 2)]);
  // Ставимо посилання на функції перемикання, які визначені нижче,
  // щоб уникнути "used before declaration" в HoldButton.
  const keysRef = useRef<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });

  function setAimIndex(i: number) {
    const clamped = Math.max(0, Math.min(TRAJECTORIES - 1, i));
    aimIndexRef.current = clamped;
    aimRef.current = AIM_POSITIONS[clamped];
  }
  function stepAim(delta: number) {
    setAimIndex(aimIndexRef.current + delta);
  }

  const [score, setScore] = useState(0);
  const [shots, setShots] = useState(10);
  // Кількість влучень у поточній «десятці» торпед — для нарахування бонусу
  const hitsInBatchRef = useRef(0);
  const firedInBatchRef = useRef(0);
  // Множник швидкості корабля — зростає з кожним досягненням 10 влучень
  const speedMultRef = useRef(1);
  const scoreRef = useRef(score);
  const shotsRef = useRef(shots);
  scoreRef.current = score;
  shotsRef.current = shots;

  // --- Звук ---
  const audioCtxRef = useRef<AudioContext | null>(null);
  function getAudio() {
    if (!audioCtxRef.current) {
      const w = window as unknown as {
        AudioContext: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const AC = w.AudioContext || w.webkitAudioContext!;
      audioCtxRef.current = new AC();
    }
    return audioCtxRef.current;
  }
  function playFire() {
    const ctx = getAudio();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.setValueAtTime(520, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(120, ctx.currentTime + 0.4);
    g.gain.setValueAtTime(0.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.5);
  }
  function playBoom() {
    const ctx = getAudio();
    const bufferSize = ctx.sampleRate * 1.0;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = 0.45;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 700;
    src.connect(filter).connect(g).connect(ctx.destination);
    src.start();
  }
  function playMiss() {
    const ctx = getAudio();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(160, ctx.currentTime);
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.3);
  }

  // --- Управління клавіатурою ---
  // Приціл перемикається покроково — по одній фіксованій позиції за натискання
  // (включно з автоповтором ОС при утриманні клавіші). keysRef більше не
  // впливає на плавний рух — його зберігаємо тільки для сумісності з
  // екранними кнопками (див. нижче).
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code === "ArrowLeft") {
        e.preventDefault();
        stepAim(-1);
      }
      if (e.code === "ArrowRight") {
        e.preventDefault();
        stepAim(+1);
      }
      if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        fire();
      }
      if (e.code === "KeyR") reset();
    };
    window.addEventListener("keydown", onDown);
    return () => {
      window.removeEventListener("keydown", onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Игровой цикл ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const loop = (time: number) => {
      const dt = Math.min(0.05, (time - lastTimeRef.current) / 1000 || 0);
      lastTimeRef.current = time;
      update(dt, time);
      draw(ctx, time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // --- Керування мишею ---
  // Позиція курсору над canvas'ом «приліплюється» до найближчого з 8 напрямків.
  // Між ними проміжних значень не буває.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0) return;
      const relX = (e.clientX - rect.left) / rect.width; // 0..1
      // Знаходимо найближчу з 8 позицій
      let bestI = 0;
      let bestD = Infinity;
      for (let i = 0; i < TRAJECTORIES; i++) {
        const d = Math.abs(AIM_POSITIONS[i] - relX);
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      if (bestI !== aimIndexRef.current) setAimIndex(bestI);
    };
    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      fire();
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("click", onClick);
    return () => {
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("click", onClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(dt: number, now: number) {
    // Приціл НЕ рухається плавно — він завжди дорівнює AIM_POSITIONS[aimIndexRef].
    // Перемикання відбувається тільки в обробниках клавіатури / миші / кнопок.
    // keysRef більше не використовується для аіма.

    // Корабль плаває туди-сюди, розвертаючись на краях.
    // Після попадання (s.alive=false) він з'являється з ПРОТИЛЕЖНОГО
    // боку екрана після невеликої паузи (respawnAt).
    const s = shipRef.current;
    if (s.alive) {
      s.x += s.dir * s.speed * dt;
      if (s.x < -0.15) {
        s.x = -0.15;
        s.dir = 1;
        s.speed = randSpeed();
      } else if (s.x > 1.15) {
        s.x = 1.15;
        s.dir = -1;
        s.speed = randSpeed();
      }
    } else if (now >= s.respawnAt) {
      // З'являється з боку, ПРОТИЛЕЖНОГО тому, куди рухався до вибуху.
      // Якщо плив вправо (dir=1) — випливе зліва (з x=-0.15, dir=1).
      // Якщо плив вліво (dir=-1) — випливе справа (з x=1.15, dir=-1).
      if (s.dir === 1) {
        s.x = -0.15;
      } else {
        s.x = 1.15;
      }
      s.speed = randSpeed();
      s.alive = true;
    }

    // Торпеда
    const t = torpedoRef.current;
    if (t.active) {
      t.progress += dt * 0.6;
      if (t.progress >= 1) {
        t.active = false;
        checkHit();
        t.progress = 0;
      }
    }

    // Взрыв
    const ex = explosionRef.current;
    if (ex.active) {
      ex.t += dt * 1.3;
      if (ex.t >= 1) ex.active = false;
    }

    if (shakeRef.current > 0) {
      shakeRef.current = Math.max(0, shakeRef.current - dt * 3);
    }
  }

  function randSpeed() {
    return (0.07 + Math.random() * 0.09) * speedMultRef.current;
  }

  function checkHit() {
    const s = shipRef.current;
    // Корабель завжди «живий» — плаває туди-сюди без перерв.
    // Перевіряємо влучання у МОМЕНТ, коли торпеда доходить до лінії корабля.
    // Порівнюємо збережений напрямок торпеди (aimAtFire) із поточним
    // (уже посунутим за час польоту) положенням корабля.
    // Область попадання = вся видима довжина корпусу (SHIP_HALF_WIDTH),
    // тому влучання зараховується і в ніс, і в середину, і в корму,
    // але не по прозорих полях зображення.
    const targetX = torpedoRef.current.aimAtFire;
    const dx = Math.abs(s.x - targetX);
    const hitTolerance = SHIP_HALF_WIDTH;
    if (dx < hitTolerance) {
      // Корабель «тоне» — зникає, потім з'явиться з протилежного боку.
      s.alive = false;
      s.respawnAt = performance.now() + 1500 + Math.random() * 1000;
      setScore((v) => v + 1);
      hitsInBatchRef.current += 1;
      const ex = explosionRef.current;
      ex.x = s.x * VIEW_W;
      ex.y = HORIZON_Y;
      ex.t = 0;
      ex.active = true;
      ex.dir = s.dir;
      shakeRef.current = 1;
      playBoom();
    } else {
      playMiss();
    }

    // За кожні 10 влучень: +5 торпед та швидкість корабля незначно росте.
    if (hitsInBatchRef.current >= 10) {
      hitsInBatchRef.current = 0;
      setShots((v) => v + 5);
      // Приблизно +8% швидкості за кожну «десятку», з розумним стелем.
      speedMultRef.current = Math.min(2.5, speedMultRef.current * 1.08);
    }
  }

  function fire() {
    if (torpedoRef.current.active) return;
    if (shotsRef.current <= 0) return;
    torpedoRef.current.active = true;
    torpedoRef.current.progress = 0;
    torpedoRef.current.aimAtFire = aimRef.current;
    setShots((v) => v - 1);
    firedInBatchRef.current += 1;
    playFire();
  }

  function reset() {
    setScore(0);
    setShots(10);
    hitsInBatchRef.current = 0;
    firedInBatchRef.current = 0;
    speedMultRef.current = 1;
    aimRef.current = 0.5;
    shipRef.current = {
      x: 0.2,
      dir: 1,
      speed: randSpeed(),
      alive: true,
      respawnAt: 0,
    };
    explosionRef.current.active = false;
    torpedoRef.current.active = false;
  }

  // ==========================================================
  // РИСОВАНИЕ
  // ==========================================================
  function draw(ctx: CanvasRenderingContext2D, now: number) {
    ctx.save();
    const sh = shakeRef.current;
    const sx = (Math.random() - 0.5) * sh * 12;
    const sy = (Math.random() - 0.5) * sh * 12;
    ctx.translate(sx, sy);

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    ctx.save();
    const pad = 12;
    roundedPill(ctx, pad, pad, VIEW_W - pad * 2, VIEW_H - pad * 2);
    ctx.clip();

    drawScene(ctx, now);

    ctx.restore();

    // Вертикальные разделители
    ctx.fillStyle = "#000";
    const panelW = VIEW_W / PANELS;
    const barW = 10;
    for (let i = 1; i < PANELS; i++) {
      ctx.fillRect(i * panelW - barW / 2, 0, barW, VIEW_H);
    }

    // Прицел — в позиции aim
    drawCrosshair(ctx, aimRef.current * VIEW_W);

    ctx.restore();
  }

  function roundedPill(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number
  ) {
    ctx.beginPath();
    const r = h / 2;
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(x + r, y + h);
    ctx.arc(x + r, y + r, r, Math.PI / 2, -Math.PI / 2);
    ctx.closePath();
  }

  function drawScene(ctx: CanvasRenderingContext2D, now: number) {
    const skyGrad = ctx.createLinearGradient(0, 0, 0, HORIZON_Y);
    skyGrad.addColorStop(0, "#0a1420");
    skyGrad.addColorStop(1, "#2a4560");
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, VIEW_W, HORIZON_Y);

    const seaGrad = ctx.createLinearGradient(0, HORIZON_Y, 0, VIEW_H);
    seaGrad.addColorStop(0, "#1a2a35");
    seaGrad.addColorStop(0.4, "#0d1a24");
    seaGrad.addColorStop(1, "#050b12");
    ctx.fillStyle = seaGrad;
    ctx.fillRect(0, HORIZON_Y, VIEW_W, VIEW_H - HORIZON_Y);

    const moonX = VIEW_W * 0.75;
    const moonGrad = ctx.createRadialGradient(
      moonX,
      HORIZON_Y - 50,
      2,
      moonX,
      HORIZON_Y - 50,
      150
    );
    moonGrad.addColorStop(0, "rgba(230,230,200,0.4)");
    moonGrad.addColorStop(1, "rgba(230,230,200,0)");
    ctx.fillStyle = moonGrad;
    ctx.fillRect(0, 0, VIEW_W, HORIZON_Y);

    drawWaves(ctx, now, moonX);

    const s = shipRef.current;
    if (s.alive) {
      // ватерлиния корабля точно на линии горизонта
      drawShip(ctx, s.x * VIEW_W, HORIZON_Y, s.dir);
    }

    if (torpedoRef.current.active) {
      drawTorpedoBeam(
        ctx,
        torpedoRef.current.progress,
        torpedoRef.current.aimAtFire,
        now
      );
    }

    if (explosionRef.current.active) {
      drawExplosion(ctx, explosionRef.current);
    }
  }

  function drawWaves(
    ctx: CanvasRenderingContext2D,
    now: number,
    moonX: number
  ) {
    const t = now / 1000;
    const lines = 14;
    for (let i = 0; i < lines; i++) {
      const p = (i / lines + (t * 0.05) % 1) % 1;
      const y = HORIZON_Y + Math.pow(p, 2.2) * (VIEW_H - HORIZON_Y);
      const alpha = 0.05 + p * 0.18;
      ctx.strokeStyle = `rgba(180,200,220,${alpha})`;
      ctx.lineWidth = 1 + p * 2.5;
      ctx.beginPath();
      const amp = 4 + p * 12;
      ctx.moveTo(0, y);
      for (let x = 0; x <= VIEW_W; x += 30) {
        const yy = y + Math.sin((x + t * 60) * 0.02 + i) * amp * 0.3;
        ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }

    ctx.save();
    const grad = ctx.createLinearGradient(0, HORIZON_Y, 0, VIEW_H);
    grad.addColorStop(0, "rgba(210,220,230,0.35)");
    grad.addColorStop(1, "rgba(210,220,230,0.02)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(moonX - 12, HORIZON_Y);
    ctx.lineTo(moonX + 12, HORIZON_Y);
    ctx.lineTo(moonX + 240, VIEW_H);
    ctx.lineTo(moonX - 240, VIEW_H);
    ctx.closePath();
    ctx.globalAlpha = 0.35;
    ctx.fill();
    ctx.restore();
  }

  // Танкер с российским флагом. y — линия горизонта (ватерлиния).
  // silhouette=true — рисуем тёмный силуэт (для взрыва)
  function drawShip(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    dir: 1 | -1,
    silhouette: boolean = false
  ) {
    ctx.save();
    ctx.translate(x, y);
    // dir=1 — идёт вправо, нос справа; dir=-1 — влево, нос слева.
    // Масштаб 1/1.8 — зменшуємо танкер у 1.8 раза відносно попереднього розміру.
    ctx.scale(dir / 1.8, 1 / 1.8);

    // Габариты танкера (длинный низкий корпус)
    const w = 220; // длина
    const hullH = 14; // высота надводного борта
    const bowLen = 24; // длина носовой оконечности

    // ============ КОРПУС ============
    // Основной цвет — тёмно-красно-бурый (типичный сурик у танкеров)
    // В режиме силуэта — всё чёрное
    const SIL = "#000";
    const hullTop = silhouette ? SIL : "#7a2214";
    const hullSide = silhouette ? SIL : "#4a1608";
    const deckColor = silhouette ? SIL : "#2a1408";
    const pipeColor = silhouette ? SIL : "#8a8578";
    const manifoldColor = silhouette ? SIL : "#a0998a";
    const valveColor = silhouette ? SIL : "#c8c0b0";
    const superstructureColor = silhouette ? SIL : "#d8d4c8";
    const superstructureLight = silhouette ? SIL : "#e8e4d8";
    const windowColor = silhouette ? SIL : "#1a1a1a";
    const bridgeWindowColor = silhouette ? SIL : "#1a2028";
    const funnelCapColor = silhouette ? SIL : "#1a1a1a";

    // Верхняя палуба (плоская, идёт до надстройки)
    ctx.fillStyle = hullTop;
    ctx.beginPath();
    // корма (слева)
    ctx.moveTo(-w / 2, -hullH);
    ctx.lineTo(-w / 2, 0);
    // ватерлиния до носа
    ctx.lineTo(w / 2 - bowLen, 0);
    // острый нос (закруглённый бульб-форштевень)
    ctx.lineTo(w / 2, 0);
    ctx.quadraticCurveTo(w / 2 + 6, -hullH * 0.5, w / 2 - bowLen * 0.4, -hullH);
    // палуба обратно к корме
    ctx.lineTo(-w / 2, -hullH);
    ctx.closePath();
    ctx.fill();

    // Более тёмный низ борта (для объёма)
    ctx.fillStyle = hullSide;
    ctx.fillRect(-w / 2, -hullH * 0.35, w - bowLen * 0.3, hullH * 0.35);

    // Тонкая белая ватерлиния (только в цветном режиме)
    if (!silhouette) {
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-w / 2, 0);
      ctx.lineTo(w / 2 - 2, 0);
      ctx.stroke();
    }

    // Палубный настил (тёмная линия сверху корпуса)
    ctx.fillStyle = deckColor;
    ctx.fillRect(-w / 2, -hullH - 1, w - bowLen * 0.3, 2);

    // ============ ПАЛУБНОЕ ОБОРУДОВАНИЕ (трубопроводы, манифолд) ============
    // Продольный трубопровод по центру палубы (характерная черта танкера)
    ctx.fillStyle = pipeColor;
    ctx.fillRect(-w / 2 + 30, -hullH - 3, w - bowLen - 40, 2);

    // Манифолд в центре — крестообразный узел трубопровода
    ctx.fillStyle = manifoldColor;
    ctx.fillRect(-8, -hullH - 6, 16, 4);
    ctx.fillRect(-2, -hullH - 10, 4, 6);

    // Клапаны/вентили вдоль палубы (маленькие штришки)
    ctx.fillStyle = valveColor;
    for (let i = 0; i < 5; i++) {
      const px = -w / 2 + 45 + i * 30;
      ctx.fillRect(px, -hullH - 4, 1.5, 2);
    }

    // ============ НАДСТРОЙКА НА КОРМЕ ============
    // У танкеров жилая надстройка и мостик расположены на корме
    const supX = -w / 2 + 20; // ближе к корме (слева при dir=1)
    const supW = 44;
    const supH = 26;

    // Основной блок надстройки — белый (жилые палубы)
    ctx.fillStyle = superstructureColor;
    ctx.fillRect(supX, -hullH - supH, supW, supH);

    if (!silhouette) {
      // Тень на дальней стороне
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fillRect(supX + supW - 6, -hullH - supH, 6, supH);
    }

    // Ряды иллюминаторов/окон (тёмные полоски по этажам)
    ctx.fillStyle = windowColor;
    for (let row = 0; row < 4; row++) {
      const ry = -hullH - supH + 3 + row * 6;
      ctx.fillRect(supX + 3, ry, supW - 6, 1.5);
    }

    // Мостик наверху (шире, чем надстройка) — рулевая рубка
    const bridgeW = supW + 8;
    const bridgeH = 6;
    ctx.fillStyle = superstructureLight;
    ctx.fillRect(supX - 4, -hullH - supH - bridgeH, bridgeW, bridgeH);
    // Окна мостика (одна длинная полоса)
    ctx.fillStyle = bridgeWindowColor;
    ctx.fillRect(supX - 2, -hullH - supH - bridgeH + 1.5, bridgeW - 4, 2);

    // ============ ТРУБА ============
    // Труба со стороны кормы за надстройкой
    const funnelX = supX - 2;
    const funnelW = 12;
    const funnelH = 20;
    ctx.fillStyle = superstructureLight;
    ctx.fillRect(funnelX, -hullH - supH - bridgeH - funnelH + 4, funnelW, funnelH);
    // Чёрная шапка трубы
    ctx.fillStyle = funnelCapColor;
    ctx.fillRect(funnelX - 1, -hullH - supH - bridgeH - funnelH + 3, funnelW + 2, 2);

    // ============ РОССИЙСКИЙ ФЛАГ НА ТРУБЕ ============
    // Три горизонтальные полосы: белый, синий, красный
    if (!silhouette) {
      const flagX = funnelX + 2;
      const flagY = -hullH - supH - bridgeH - funnelH + 8;
      const flagW = funnelW - 4;
      const stripeH = 3;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(flagX, flagY, flagW, stripeH);
      ctx.fillStyle = "#0033a0";
      ctx.fillRect(flagX, flagY + stripeH, flagW, stripeH);
      ctx.fillStyle = "#d52b1e";
      ctx.fillRect(flagX, flagY + stripeH * 2, flagW, stripeH);
    }

    // ============ МАЧТА С ФЛАГОМ ============
    // Кормовой флагшток с российским флагом (маленький развевающийся флаг)
    const mastX = supX + supW - 6;
    const mastTop = -hullH - supH - bridgeH - 18;
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(mastX, -hullH - supH - bridgeH);
    ctx.lineTo(mastX, mastTop);
    ctx.stroke();

    // Развевающийся флаг (три полосы, слегка волнообразный)
    // Флаг развернут в обратную сторону — от мачты влево (в системе dir)
    const bigFlagW = 16;
    const bigFlagH = 10;
    const bfx = mastX - 1;
    const bfy = mastTop + 1;
    const drawStripe = (color: string, y0: number, y1: number, y2: number, y3: number) => {
      ctx.fillStyle = silhouette ? SIL : color;
      ctx.beginPath();
      ctx.moveTo(bfx, bfy + y0);
      ctx.lineTo(bfx - bigFlagW, bfy + y1);
      ctx.lineTo(bfx - bigFlagW, bfy + y2);
      ctx.lineTo(bfx, bfy + y3);
      ctx.closePath();
      ctx.fill();
    };
    drawStripe("#ffffff", 0, -1, bigFlagH / 3, bigFlagH / 3);
    drawStripe("#0033a0", bigFlagH / 3, bigFlagH / 3, (bigFlagH * 2) / 3 + 1, (bigFlagH * 2) / 3);
    drawStripe("#d52b1e", (bigFlagH * 2) / 3, (bigFlagH * 2) / 3 + 1, bigFlagH + 2, bigFlagH);

    // Носовой флагшток
    const bowMastX = w / 2 - bowLen - 6;
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bowMastX, -hullH);
    ctx.lineTo(bowMastX, -hullH - 14);
    ctx.stroke();

    // ============ ОТРАЖЕНИЕ В ВОДЕ ============
    ctx.scale(1, 1); // (уже в системе dir)
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = hullSide;
    ctx.beginPath();
    ctx.moveTo(-w / 2, 0);
    ctx.lineTo(w / 2 - 2, 0);
    ctx.lineTo(w / 2 - 10, 5);
    ctx.lineTo(-w / 2 + 4, 5);
    ctx.closePath();
    ctx.fill();
    // размытое отражение надстройки
    ctx.fillStyle = "#d8d4c8";
    ctx.fillRect(supX + 2, 0.5, supW - 4, 5);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  // ЗЕЛЁНЫЙ ПРЕРЫВИСТЫЙ ЛУЧ ТОРПЕДЫ — от нижнего центра к точке прицела
  function drawTorpedoBeam(
    ctx: CanvasRenderingContext2D,
    p: number,
    aim: number,
    now: number
  ) {
    const startX = VIEW_W / 2;
    const startY = VIEW_H - 10;
    const endX = aim * VIEW_W;
    const endY = HORIZON_Y + 4;

    const cx = startX + (endX - startX) * p;
    const cy = startY + (endY - startY) * p;

    ctx.save();
    ctx.shadowColor = "rgba(80,255,120,0.9)";
    ctx.shadowBlur = 18;

    const dashLen = 14;
    const gapLen = 10;
    ctx.setLineDash([dashLen, gapLen]);
    const phase = (now / 40) % (dashLen + gapLen);
    ctx.lineDashOffset = -phase;
    ctx.lineCap = "round";

    ctx.strokeStyle = "rgba(60,255,110,0.35)";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(cx, cy);
    ctx.stroke();

    ctx.strokeStyle = "#a8ffb0";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(cx, cy);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.shadowBlur = 25;
    ctx.fillStyle = "#e6ffe6";
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawExplosion(ctx: CanvasRenderingContext2D, ex: Explosion) {
    const t = ex.t;
    const R = 100 + t * 70;

    ctx.save();
    ctx.translate(ex.x, ex.y);

    const glow = ctx.createRadialGradient(0, -10, 4, 0, -10, R * 1.8);
    glow.addColorStop(0, `rgba(255,180,60,${1 - t})`);
    glow.addColorStop(0.35, `rgba(220,60,20,${0.9 * (1 - t)})`);
    glow.addColorStop(1, "rgba(120,10,0,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, -10, R * 1.8, 0, Math.PI * 2);
    ctx.fill();

    const spikes = 12;
    ctx.fillStyle = `rgba(255,220,90,${1 - t * 0.8})`;
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const ang = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? R * (0.6 + t * 0.15) : R * (0.3 + t * 0.05);
      const x = Math.cos(ang) * r;
      const y = Math.sin(ang) * r * 0.75 - 10;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = `rgba(255,255,240,${(1 - t) * 0.9})`;
    ctx.beginPath();
    ctx.arc(0, -10, R * 0.25, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    // Силуэт горящего танкера — сохраняем его форму!
    ctx.save();
    ctx.globalAlpha = Math.max(0, 0.95 - t * 0.4);
    drawShip(ctx, ex.x, ex.y, ex.dir, true);
    ctx.restore();
  }

  function drawCrosshair(ctx: CanvasRenderingContext2D, x: number) {
    ctx.save();
    // вертикальная линия через весь экран (визирная линия перископа)
    ctx.strokeStyle = "rgba(180,255,200,0.25)";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(x, 20);
    ctx.lineTo(x, VIEW_H - 20);
    ctx.stroke();
    ctx.setLineDash([]);

    // «крест» прицела на горизонте
    ctx.strokeStyle = "rgba(180,255,200,0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, HORIZON_Y - 45);
    ctx.lineTo(x, HORIZON_Y + 45);
    ctx.moveTo(x - 40, HORIZON_Y);
    ctx.lineTo(x + 40, HORIZON_Y);
    ctx.stroke();

    // окружность
    ctx.strokeStyle = "rgba(180,255,200,0.8)";
    ctx.beginPath();
    ctx.arc(x, HORIZON_Y, 14, 0, Math.PI * 2);
    ctx.stroke();

    // маленькие деления по бокам
    ctx.strokeStyle = "rgba(180,255,200,0.5)";
    for (let i = 1; i <= 3; i++) {
      const d = i * 25;
      ctx.beginPath();
      ctx.moveTo(x - d, HORIZON_Y - 5);
      ctx.lineTo(x - d, HORIZON_Y + 5);
      ctx.moveTo(x + d, HORIZON_Y - 5);
      ctx.lineTo(x + d, HORIZON_Y + 5);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ==========================================================
  // ИНТЕРФЕЙС
  // ==========================================================
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-[#1a1e22] to-[#050708] text-slate-200 flex flex-col items-center justify-center p-4 select-none">
      <div className="w-full max-w-5xl">
        <div
          className="relative rounded-[36px] p-4 md:p-10 shadow-[0_25px_80px_rgba(0,0,0,0.8)]"
          style={{
            background:
              "linear-gradient(180deg,#c8ced4 0%,#8a9098 25%,#5a6068 55%,#3a4046 80%,#2a2e34 100%)",
            border: "3px solid #1a1e22",
            boxShadow:
              "inset 0 2px 4px rgba(255,255,255,0.4), inset 0 -4px 10px rgba(0,0,0,0.5), 0 25px 80px rgba(0,0,0,0.8)",
          }}
        >
          <div
            className="absolute inset-3 rounded-[30px] pointer-events-none"
            style={{ boxShadow: "inset 0 0 0 2px rgba(0,0,0,0.4)" }}
          />

          <div className="text-center mb-4">
            <h1
              className="inline-block px-4 md:px-6 py-2 rounded-md text-sm md:text-xl tracking-[0.15em] md:tracking-[0.2em] font-black"
              style={{
                background:
                  "linear-gradient(180deg,#e8ecef 0%,#a8b0b8 45%,#6a7278 55%,#3a4046 100%)",
                color: "#1a1e22",
                textShadow:
                  "0 1px 0 rgba(255,255,255,0.55), 0 -1px 0 rgba(0,0,0,0.4)",
                border: "2px solid #2a2e32",
                boxShadow:
                  "inset 0 2px 4px rgba(255,255,255,0.5), inset 0 -2px 4px rgba(0,0,0,0.4), 0 4px 0 #1a1e22, 0 6px 12px rgba(0,0,0,0.5)",
                fontFamily: "'Impact','Arial Black',sans-serif",
              }}
            >
              РОСІЙСЬКИЙ ТАНКЕР, ІДІ НА...!
            </h1>
          </div>

          <div className="flex items-center justify-between gap-4 mb-4 px-2">
            <Scoreboard label="ВЛУЧАННЯ" value={score} color="#ff5a2a" />
            <div className="text-center text-xs md:text-sm tracking-widest text-slate-900 font-semibold">
              <div>Україна · 2026</div>
              <div className="text-[10px] text-slate-800/80">ігровий автомат</div>
            </div>
            <Scoreboard label="ТОРПЕДИ" value={shots} color="#2affaa" />
          </div>

          <div className="relative mx-auto">
            <div
              className="relative mx-auto rounded-[210px] overflow-hidden"
              style={{
                background: "#000",
                boxShadow:
                  "0 0 0 8px #0a0d10, 0 0 0 12px #2a2e34, 0 0 45px rgba(0,0,0,0.9) inset",
              }}
            >
              <canvas
                ref={canvasRef}
                width={VIEW_W}
                height={VIEW_H}
                className="block w-full h-auto"
              />

              {shots <= 0 && (
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center text-center px-4"
                  style={{ background: "rgba(0,0,0,0.72)" }}
                >
                  <div
                    className="text-4xl md:text-6xl font-black tracking-[0.25em]"
                    style={{
                      color: "#ff2a2a",
                      textShadow:
                        "0 0 12px rgba(255,40,40,0.9), 0 0 30px rgba(255,40,40,0.6), 0 3px 0 #300",
                      fontFamily: "'Impact','Arial Black',sans-serif",
                    }}
                  >
                    GAME OVER
                  </div>
                  <div className="mt-4 text-slate-200 text-sm md:text-base tracking-widest">
                    Влучень: <b>{score}</b>
                  </div>
                  <button
                    onClick={reset}
                    className="mt-5 px-6 py-2 rounded-md text-white font-black tracking-widest"
                    style={{
                      background:
                        "linear-gradient(180deg,#ff6b3a 0%, #b31a08 55%, #6a0a02 100%)",
                      border: "2px solid #200000",
                      boxShadow:
                        "0 4px 0 #2a0000, inset 0 2px 4px rgba(255,220,180,0.5)",
                      textShadow: "0 2px 0 #400000",
                    }}
                  >
                    RESTART
                  </button>
                </div>
              )}
            </div>

            <PeriscopeGauge aimRef={aimRef} />
          </div>

          <div className="mt-4 md:mt-6 flex flex-col md:flex-row items-center justify-between gap-3 md:gap-4">
            <div className="flex flex-col md:flex-row items-start md:items-center gap-2 md:gap-3 w-full md:w-auto">
              <button
                onClick={reset}
                className="px-3 md:px-4 py-1.5 md:py-2 rounded-md text-slate-100 text-xs md:text-sm tracking-wider shadow-inner"
                style={{
                  background:
                    "linear-gradient(180deg,#8a9098 0%,#5a6068 55%,#3a4046 100%)",
                  border: "1px solid #1a1e22",
                  boxShadow:
                    "inset 0 1px 2px rgba(255,255,255,0.35), inset 0 -2px 4px rgba(0,0,0,0.4), 0 2px 0 #1a1e22",
                  textShadow: "0 -1px 0 rgba(0,0,0,0.4)",
                }}
              >
                СКИДАННЯ
              </button>
              <div className="text-slate-900 text-[10px] md:text-xs font-semibold normal-case tracking-normal">
                <span className="text-black font-bold">←→</span> рух прицілу ·{" "}
                <span className="text-black font-bold">Пробіл</span> вогонь ·{" "}
                <span className="text-black font-bold">R</span> перезапуск
              </div>
            </div>

            <div className="flex items-center justify-between w-full md:w-auto gap-3">
              <div className="flex items-center gap-2 md:gap-3">
                <HoldButton
                  label="◄"
                  onPress={(v) => {
                    keysRef.current.left = v;
                    if (v) stepAim(-1);
                  }}
                />
                <HoldButton
                  label="►"
                  onPress={(v) => {
                    keysRef.current.right = v;
                    if (v) stepAim(+1);
                  }}
                />
              </div>
              <button
                onMouseDown={fire}
                onTouchStart={(e) => {
                  e.preventDefault();
                  fire();
                }}
                className="relative w-20 h-20 md:w-24 md:h-24 rounded-full active:translate-y-1 transition-transform"
                style={{
                  background:
                    "radial-gradient(circle at 35% 30%, #ff6b3a 0%, #b31a08 45%, #6a0a02 100%)",
                  boxShadow:
                    "0 8px 0 #2a0000, 0 12px 20px rgba(0,0,0,0.7), inset 0 2px 4px rgba(255,220,180,0.5)",
                  border: "3px solid #200000",
                }}
              >
                <span
                  className="absolute inset-0 flex items-center justify-center font-black tracking-widest text-white"
                  style={{
                    textShadow: "0 2px 0 #400000",
                    fontFamily: "'Impact','Arial Black',sans-serif",
                    fontSize: 16,
                  }}
                >
                  ВОГОНЬ
                </span>
              </button>
            </div>
          </div>
        </div>

        <p className="text-center text-slate-400/60 text-xs mt-4 tracking-wider">
          © репліка легендарного автомата «Морський бій» · зроблено у браузері
        </p>
      </div>
    </div>
  );
}

function Scoreboard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  const digits = String(value).padStart(3, "0");
  return (
    <div className="flex flex-col items-center">
      <div className="text-[10px] md:text-xs tracking-[0.25em] text-slate-900 font-bold mb-1">
        {label}
      </div>
      <div
        className="flex gap-1 px-2 py-1 rounded-md"
        style={{
          background: "#050708",
          border: "2px inset #2a2e34",
          boxShadow: "inset 0 0 12px rgba(0,0,0,0.9)",
        }}
      >
        {digits.split("").map((d, i) => (
          <div
            key={i}
            className="w-6 md:w-8 h-9 md:h-11 flex items-center justify-center rounded-sm"
            style={{
              background: "#0a0d10",
              color,
              fontFamily: "'Courier New',monospace",
              fontWeight: 900,
              fontSize: 28,
              textShadow: `0 0 8px ${color}, 0 0 16px ${color}`,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {d}
          </div>
        ))}
      </div>
    </div>
  );
}



function HoldButton({
  label,
  onPress,
}: {
  label: string;
  onPress: (v: boolean) => void;
}) {
  return (
    <button
      onMouseDown={() => onPress(true)}
      onMouseUp={() => onPress(false)}
      onMouseLeave={() => onPress(false)}
      onTouchStart={(e) => {
        e.preventDefault();
        onPress(true);
      }}
      onTouchEnd={() => onPress(false)}
      className="w-12 h-12 rounded-md text-slate-100 text-xl font-bold active:translate-y-0.5"
      style={{
        background: "linear-gradient(180deg,#8a9098 0%,#5a6068 55%,#3a4046 100%)",
        border: "2px solid #1a1e22",
        boxShadow:
          "inset 0 2px 4px rgba(255,255,255,0.35), inset 0 -2px 3px rgba(0,0,0,0.4), 0 3px 0 #1a1e22",
        textShadow: "0 -1px 0 rgba(0,0,0,0.4)",
      }}
    >
      {label}
    </button>
  );
}

function PeriscopeGauge({
  aimRef,
}: {
  aimRef: React.MutableRefObject<number>;
}) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((v) => v + 1), 60);
    return () => clearInterval(id);
  }, []);
  const aim = aimRef.current;
  // aim: AIM_MIN..AIM_MAX → 0..1
  const pct = ((aim - AIM_MIN) / (AIM_MAX - AIM_MIN)) * 100;
  return (
    <div className="mx-auto mt-3 max-w-md">
      <div className="flex items-center justify-between text-[10px] tracking-widest text-slate-900 font-bold mb-1 px-1">
        <span>◄ ЛІВИЙ БОРТ</span>
        <span>ПРИЦІЛ</span>
        <span>ПРАВИЙ БОРТ ►</span>
      </div>
      <div
        className="h-3 rounded-full relative"
        style={{
          background: "#050708",
          border: "1px solid #2a2e34",
          boxShadow: "inset 0 0 6px rgba(0,0,0,0.9)",
        }}
      >
        <div
          className="absolute top-1/2 -translate-y-1/2 w-2 h-5 rounded-sm"
          style={{
            left: `calc(${pct}% - 4px)`,
            background: "linear-gradient(180deg,#a8ffb0,#20a040)",
            boxShadow: "0 0 8px rgba(80,255,120,0.8)",
          }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 w-px h-3"
          style={{ left: "50%", background: "rgba(255,255,255,0.3)" }}
        />
      </div>
    </div>
  );
}
