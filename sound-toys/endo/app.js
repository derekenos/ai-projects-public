// ENDO: a meadow scene that advances one step per kick drum, leading to a
// horse, then a procedurally generated journey through its digestive tract,
// and out into the meadow again (one season later).
(function () {
  'use strict';

  // ------------------------------------------------------------ utilities

  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
  const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------ the story

  // Tunnel sections, in order. len = kicks spent in the section; one kick
  // moves the camera one unit of tunnel.
  const SECTIONS = [
    { key: 'mouth', title: 'mouth', len: 6, radius: 1.7, wall: [150, 40, 55], fog: [60, 8, 18], feature: 'smooth', curve: 0.2, squeeze: 0, particles: 'grass' },
    { key: 'esophagus', title: 'esophagus', len: 16, radius: 0.85, wall: [215, 110, 120], fog: [70, 15, 30], feature: 'ribs', curve: 0.6, squeeze: 0.45, particles: 'grass' },
    { key: 'stomach', title: 'stomach', len: 16, radius: 3.2, wall: [210, 120, 90], fog: [80, 50, 20], feature: 'folds', curve: 0.4, squeeze: 0.1, particles: 'acid' },
    { key: 'small', title: 'small intestine', len: 24, radius: 0.75, wall: [235, 150, 130], fog: [90, 35, 35], feature: 'villi', curve: 1.3, squeeze: 0.35, particles: 'grass' },
    { key: 'cecum', title: 'cecum', len: 16, radius: 2.4, wall: [140, 110, 70], fog: [40, 35, 25], feature: 'folds', curve: 0.5, squeeze: 0.1, particles: 'microbes' },
    { key: 'colon', title: 'colon', len: 16, radius: 1.25, wall: [120, 75, 45], fog: [35, 20, 10], feature: 'haustra', curve: 0.8, squeeze: 0.25, particles: 'grass' },
    { key: 'exit', title: 'light', len: 6, radius: 1.0, wall: [150, 110, 80], fog: [255, 245, 220], feature: 'haustra', curve: 0.2, squeeze: 0, particles: 'none' },
  ];
  let s0 = 0;
  for (const sec of SECTIONS) { sec.start = s0; s0 += sec.len; }
  const TUNNEL_LEN = s0;

  const CHAPTERS = [
    { key: 'meadow', title: 'meadow', len: 16 },
    { key: 'horse', title: 'a horse', len: 16 },
    { key: 'tunnel', title: null, len: TUNNEL_LEN },
    { key: 'return', title: 'meadow, again', len: 12 },
  ];
  let k0 = 0;
  for (const ch of CHAPTERS) { ch.start = k0; k0 += ch.len; }
  const CYCLE_LEN = k0;

  const SEASONS = [
    { name: 'spring', grass: [90, 160, 70], hill: [70, 130, 70], far: [120, 160, 140], skyTop: [120, 170, 220], skyLow: [250, 220, 190], flowers: true, fall: 'petals' },
    { name: 'summer', grass: [120, 160, 50], hill: [95, 135, 55], far: [140, 160, 120], skyTop: [70, 140, 220], skyLow: [230, 230, 200], flowers: true, fall: 'none' },
    { name: 'autumn', grass: [170, 140, 60], hill: [150, 100, 50], far: [160, 130, 110], skyTop: [130, 140, 170], skyLow: [240, 190, 150], flowers: false, fall: 'leaves' },
    { name: 'winter', grass: [200, 205, 210], hill: [170, 175, 185], far: [150, 155, 170], skyTop: [110, 120, 140], skyLow: [200, 200, 205], flowers: false, fall: 'snow' },
  ];

  // ------------------------------------------------------------ state

  let kicks = 0;           // total kicks received
  let progress = 0;        // eased toward kicks; drives the camera
  let lastKickTime = -10;  // performance time (s) of the last kick
  let hudVisible = true;
  let hudTimer = 0;
  let flowers = [];
  let waves = [];          // peristaltic contractions: {s, t}
  let particles = [];
  let titleShown = '';
  let titleTime = -10;

  const canvas = document.getElementById('stage');
  const g = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  }
  new ResizeObserver(resize).observe(canvas);

  function nowS() { return performance.now() / 1000; }

  function cycleOf(k) { return Math.floor(k / CYCLE_LEN); }

  function kick(source) {
    kicks++;
    lastKickTime = nowS();
    hudTimer = 0;
    const local = kicks % CYCLE_LEN;
    const ch = chapterAt(local);
    if (ch.key === 'meadow' || ch.key === 'horse') spawnFlower();
    if (ch.key === 'tunnel') waves.push({ s: local - ch.start, t: nowS() });
    if (waves.length > 12) waves.shift();
    lastSource = source || lastSource;
  }
  let lastSource = '';

  function chapterAt(local) {
    for (let i = CHAPTERS.length - 1; i >= 0; i--) if (local >= CHAPTERS[i].start) return CHAPTERS[i];
    return CHAPTERS[0];
  }

  function sectionAt(s) {
    for (let i = SECTIONS.length - 1; i >= 0; i--) if (s >= SECTIONS[i].start) return i;
    return 0;
  }

  function jumpTo(k) {
    kicks = Math.max(0, k);
    progress = kicks;
    flowers = [];
    waves = [];
    particles = [];
  }

  // ------------------------------------------------------------ meadow

  function spawnFlower() {
    const season = SEASONS[cycleOf(kicks) % SEASONS.length];
    const r = Math.random;
    flowers.push({
      x: r(), y: 0.78 + r() * 0.2, born: nowS(),
      hue: [350, 40, 55, 280, 200, 10][Math.floor(r() * 6)],
      size: 0.6 + r() * 0.6,
      bare: !season.flowers,
    });
    if (flowers.length > 40) flowers.shift();
  }

  function hillY(x, layer, seed) {
    return Math.sin(x * 0.004 * (layer + 1) + seed) * 18 / (layer + 1)
      + Math.sin(x * 0.011 + seed * 2.3) * 9 / (layer + 1)
      + Math.sin(x * 0.0017 + seed * 0.7) * 30;
  }

  // dayT: 0 = dawn, 1 = full day. camX scrolls the landscape.
  function drawMeadow(season, dayT, camX, t) {
    const horizon = H * 0.55;
    const sky = g.createLinearGradient(0, 0, 0, horizon);
    const dawnTop = [40, 50, 90], dawnLow = [240, 150, 120];
    sky.addColorStop(0, rgb(mix(dawnTop, season.skyTop, dayT)));
    sky.addColorStop(1, rgb(mix(dawnLow, season.skyLow, dayT)));
    g.fillStyle = sky;
    g.fillRect(0, 0, W, horizon + 40);

    // Sun.
    const sunY = lerp(horizon + 10, H * 0.14, smooth(dayT));
    const sunX = W * 0.72;
    const glow = g.createRadialGradient(sunX, sunY, 0, sunX, sunY, H * 0.25);
    glow.addColorStop(0, 'rgba(255,240,200,0.55)');
    glow.addColorStop(1, 'rgba(255,240,200,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, W, horizon + 40);
    g.fillStyle = 'rgba(255,245,215,0.95)';
    g.beginPath(); g.arc(sunX, sunY, H * 0.045, 0, TAU); g.fill();

    // Clouds.
    for (let i = 0; i < 5; i++) {
      const cx = ((i * 0.27 * W + t * 6 + camX * 0.05) % (W + 300)) - 150;
      const cy = H * (0.1 + 0.07 * (i % 3));
      g.fillStyle = 'rgba(255,255,255,0.35)';
      for (let j = 0; j < 4; j++) {
        g.beginPath(); g.ellipse(cx + j * 26, cy + Math.sin(j * 2.1) * 6, 34, 14, 0, 0, TAU); g.fill();
      }
    }

    // Hills, far to near.
    const layers = [
      { col: season.far, base: horizon, par: 0.15, shade: 0.85 },
      { col: season.hill, base: horizon + H * 0.06, par: 0.35, shade: 0.95 },
      { col: season.grass, base: horizon + H * 0.14, par: 0.7, shade: 1 },
    ];
    layers.forEach((L, li) => {
      g.fillStyle = rgb(mix(L.col.map((c) => c * L.shade), [40, 40, 60], (1 - dayT) * 0.45));
      g.beginPath();
      g.moveTo(0, H);
      for (let x = 0; x <= W + 8; x += 8) g.lineTo(x, L.base + hillY(x + camX * L.par, li, 1.7 + li));
      g.lineTo(W, H);
      g.closePath();
      g.fill();
    });

    // Foreground grass blades with a gust on each kick.
    const gust = Math.exp(-(nowS() - lastKickTime) * 3) * 0.6;
    const base = horizon + H * 0.14;
    const grassCol = mix(season.grass, [30, 40, 30], (1 - dayT) * 0.5);
    g.strokeStyle = rgb(mix(grassCol, [20, 50, 20], 0.3));
    g.lineWidth = 1.4;
    g.beginPath();
    const rr = rng(7);
    for (let i = 0; i < 260; i++) {
      const x = ((rr() * W * 1.4 - camX * 0.9) % (W * 1.4) + W * 1.4) % (W * 1.4) - W * 0.2;
      const y = lerp(base + H * 0.06, H + 4, rr());
      const len = (8 + rr() * 22) * (0.6 + (y - base) / H * 2);
      const sway = Math.sin(t * 1.7 + x * 0.02) * 0.25 + gust;
      g.moveTo(x, y);
      g.quadraticCurveTo(x + sway * len * 0.4, y - len * 0.6, x + sway * len, y - len);
    }
    g.stroke();

    // Flowers grown by kicks.
    for (const f of flowers) drawFlower(f, base, camX);

    // Falling seasonal particles.
    if (season.fall !== 'none') {
      const fr = rng(11);
      for (let i = 0; i < 40; i++) {
        const sx = fr() * W, speed = 15 + fr() * 25;
        const y = ((fr() * H + t * speed) % (H + 20)) - 10;
        const x = sx + Math.sin(t + i) * 20 - (camX * 0.3) % W;
        const xx = ((x % W) + W) % W;
        if (season.fall === 'snow') { g.fillStyle = 'rgba(255,255,255,0.85)'; g.beginPath(); g.arc(xx, y, 2, 0, TAU); g.fill(); }
        else if (season.fall === 'leaves') { g.fillStyle = `hsla(${20 + i * 5 % 30},70%,45%,0.85)`; g.beginPath(); g.ellipse(xx, y, 5, 2.5, t + i, 0, TAU); g.fill(); }
        else { g.fillStyle = 'rgba(255,200,220,0.8)'; g.beginPath(); g.ellipse(xx, y, 3, 1.6, t * 2 + i, 0, TAU); g.fill(); }
      }
    }
  }

  function drawFlower(f, base, camX) {
    const age = nowS() - f.born;
    const grow = smooth(age / 0.6);
    const x = ((f.x * W * 1.2 - camX * 0.9) % (W * 1.2) + W * 1.2) % (W * 1.2) - W * 0.1;
    const y = lerp(base + H * 0.08, H - 10, (f.y - 0.78) / 0.2);
    const scale = f.size * (0.6 + (y - base) / H * 2.5);
    const stem = 34 * scale * grow;
    g.strokeStyle = 'rgba(40,90,40,0.9)';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x - 4 * scale, y - stem * 0.5, x, y - stem); g.stroke();
    if (f.bare) return;
    const bloom = smooth((age - 0.3) / 0.5);
    if (bloom <= 0) return;
    const pr = 7 * scale * bloom;
    g.fillStyle = `hsl(${f.hue},75%,65%)`;
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * TAU + f.x * 10;
      g.beginPath(); g.ellipse(x + Math.cos(a) * pr, y - stem + Math.sin(a) * pr, pr * 0.75, pr * 0.45, a, 0, TAU); g.fill();
    }
    g.fillStyle = '#f6d55c';
    g.beginPath(); g.arc(x, y - stem, pr * 0.45, 0, TAU); g.fill();
  }

  // ------------------------------------------------------------ the horse

  const COAT = [140, 80, 45];
  const COAT_WINTER = [110, 80, 60];
  const DARK = [70, 40, 25];
  const SKIN = [72, 56, 58];       // muzzle skin
  const BLAZE = [238, 232, 220];

  function coatOf(season) { return season.name === 'winter' ? COAT_WINTER : COAT; }

  function bez(p) { g.bezierCurveTo(p[0], p[1], p[2], p[3], p[4], p[5]); }

  // Cheap smooth noise for trembling: sum of incommensurate sines.
  function wobble(t, seed) {
    return Math.sin(t * 31 + seed) * 0.5 + Math.sin(t * 47 + seed * 2.7) * 0.3 + Math.sin(t * 73 + seed * 5.1) * 0.2;
  }

  // Head placement for the side view. The anchor sits at the throat latch;
  // the muzzle points along -x in head space. lift 0 = grazing, 1 = head up.
  function headPose(lift, chew) {
    const graze = { x: -1.82, y: -0.89 + chew, r: -1.1 };
    const alert = { x: -1.45, y: -2.45, r: -0.35 };
    return { x: lerp(graze.x, alert.x, lift), y: lerp(graze.y, alert.y, lift), r: lerp(graze.r, alert.r, lift) };
  }

  function headToWorld(pose, x, y) {
    const c = Math.cos(pose.r), s = Math.sin(pose.r);
    return { x: pose.x + x * c - y * s, y: pose.y + x * s + y * c };
  }

  // Side profile, facing left. alarm 0..1 widens the eye, flares the nostril
  // and stiffens the ear.
  function drawSideHead(pose, alarm, t, coat) {
    g.save();
    g.translate(pose.x, pose.y);
    g.rotate(pose.r);

    // Ear behind the poll: relaxed it drifts back, alarmed it snaps upright.
    const earRot = lerp(0.5, -0.15, alarm) + Math.sin(t * 1.7) * 0.05 * (1 - alarm);
    g.save();
    g.translate(-0.03, -0.2);
    g.rotate(earRot);
    g.fillStyle = rgb(mix(coat, DARK, 0.15));
    g.beginPath(); g.moveTo(-0.06, 0); g.quadraticCurveTo(-0.07, -0.18, 0.0, -0.27); g.quadraticCurveTo(0.06, -0.15, 0.06, 0); g.closePath(); g.fill();
    g.fillStyle = rgb(DARK, 0.6);
    g.beginPath(); g.moveTo(-0.03, -0.02); g.quadraticCurveTo(-0.03, -0.15, 0.0, -0.22); g.quadraticCurveTo(0.02, -0.12, 0.02, -0.02); g.closePath(); g.fill();
    g.restore();

    // Profile: poll, forehead, straight nasal bone, soft nose, lips, chin,
    // and the big round jowl.
    const profile = () => {
      g.beginPath();
      g.moveTo(0.02, -0.2);
      bez([-0.06, -0.26, -0.15, -0.25, -0.22, -0.24]);
      bez([-0.45, -0.21, -0.66, -0.16, -0.8, -0.12]);
      bez([-0.88, -0.1, -0.95, -0.03, -0.92, 0.04]);
      bez([-0.91, 0.08, -0.86, 0.09, -0.82, 0.09]);
      bez([-0.88, 0.11, -0.88, 0.17, -0.78, 0.18]);
      bez([-0.65, 0.19, -0.5, 0.15, -0.38, 0.18]);
      bez([-0.3, 0.36, 0.0, 0.38, 0.06, 0.18]);
      bez([0.08, 0.05, 0.07, -0.1, 0.02, -0.2]);
      g.closePath();
    };
    const grad = g.createLinearGradient(0, -0.25, 0, 0.35);
    grad.addColorStop(0, rgb(mix(coat, [255, 220, 180], 0.12)));
    grad.addColorStop(1, rgb(mix(coat, DARK, 0.35)));
    g.fillStyle = grad;
    profile();
    g.fill();

    g.save();
    profile();
    g.clip();
    // Dark soft muzzle.
    const mg = g.createLinearGradient(-0.62, 0, -0.85, 0);
    mg.addColorStop(0, rgb(SKIN, 0));
    mg.addColorStop(1, rgb(SKIN, 0.9));
    g.fillStyle = mg;
    g.fillRect(-1, -0.3, 0.5, 0.6);
    // Jowl muscle shading and cheekbone ridge.
    g.strokeStyle = rgb(DARK, 0.25); g.lineWidth = 0.015;
    g.beginPath(); g.moveTo(-0.42, 0.06); g.bezierCurveTo(-0.3, 0.0, -0.12, 0.02, -0.05, 0.12); g.stroke();
    g.beginPath(); g.ellipse(-0.12, 0.17, 0.13, 0.11, 0, -0.5, 2.2); g.stroke();
    // Blaze down the face.
    g.fillStyle = rgb(BLAZE, 0.9);
    g.beginPath(); g.moveTo(-0.2, -0.26); g.bezierCurveTo(-0.45, -0.22, -0.7, -0.17, -0.86, -0.1);
    g.lineTo(-0.84, -0.06); g.bezierCurveTo(-0.65, -0.12, -0.42, -0.16, -0.22, -0.2); g.closePath(); g.fill();
    g.restore();

    // Nostril: a comma that opens when alarmed.
    const flare = 1 + alarm * 0.6 + Math.sin(t * (3 + alarm * 6)) * 0.12 * alarm;
    g.fillStyle = '#1d0f0c';
    g.beginPath(); g.ellipse(-0.83, -0.05, 0.028 * flare, 0.016 * flare, -0.4, 0, TAU); g.fill();
    g.strokeStyle = rgb(SKIN, 1); g.lineWidth = 0.008;
    g.beginPath(); g.arc(-0.83, -0.05, 0.035 * flare, -2.6, 0.6); g.stroke();
    // Lip line.
    g.strokeStyle = 'rgba(25,12,10,0.7)'; g.lineWidth = 0.008;
    g.beginPath(); g.moveTo(-0.91, 0.07); g.quadraticCurveTo(-0.86, 0.095, -0.8, 0.09); g.stroke();

    // Eye: brow ridge, lids, and white showing as it widens.
    const ex = -0.27, ey = -0.13;
    const open = 0.55 + alarm * 0.75;
    g.fillStyle = rgb(mix(coat, [255, 230, 200], 0.15));
    g.beginPath(); g.ellipse(ex + 0.01, ey - 0.035, 0.085, 0.04, -0.15, Math.PI, TAU); g.fill();
    const eyePath = () => {
      g.beginPath();
      g.moveTo(ex - 0.06, ey + 0.005);
      g.quadraticCurveTo(ex, ey - 0.05 * open, ex + 0.06, ey - 0.005);
      g.quadraticCurveTo(ex, ey + 0.035 * open, ex - 0.06, ey + 0.005);
      g.closePath();
    };
    g.save();
    eyePath(); g.clip();
    g.fillStyle = '#efe6dc'; g.fillRect(ex - 0.08, ey - 0.08, 0.16, 0.16);
    // Iris rolls back and toward us as alarm rises.
    g.fillStyle = '#1a0e0a';
    g.beginPath(); g.ellipse(ex + 0.012 * alarm, ey - 0.004, 0.042 - alarm * 0.008, 0.036, 0, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.beginPath(); g.arc(ex - 0.012, ey - 0.014, 0.009, 0, TAU); g.fill();
    g.restore();
    g.strokeStyle = '#140a07'; g.lineWidth = 0.012;
    eyePath(); g.stroke();
    // Lashes on the upper lid.
    g.lineWidth = 0.005;
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const u = 0.15 + i * 0.14;
      const lx = ex - 0.06 + u * 0.12, ly = ey - 0.05 * open * Math.sin(u * Math.PI) * 0.95;
      g.moveTo(lx, ly); g.lineTo(lx - 0.012, ly - 0.02);
    }
    g.stroke();
    // Worry wrinkles above the eye.
    if (alarm > 0.05) {
      g.strokeStyle = rgb(DARK, 0.5 * alarm); g.lineWidth = 0.008;
      for (let i = 0; i < 3; i++) {
        g.beginPath(); g.arc(ex + 0.02, ey + 0.02, 0.085 + i * 0.022, -2.3, -1.2); g.stroke();
      }
    }
    // Forelock spilling over the forehead.
    g.strokeStyle = rgb(DARK); g.lineWidth = 0.025; g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i < 4; i++) {
      g.moveTo(-0.02 - i * 0.03, -0.23);
      g.quadraticCurveTo(-0.12 - i * 0.03, -0.2 + Math.sin(t * 2 + i) * 0.01, -0.17 - i * 0.025, -0.12 + i * 0.01);
    }
    g.stroke();
    g.restore();
  }

  // Side view of the whole horse. Units: ~1 = shoulder-to-elbow; hooves at y=0.
  function drawHorse(x, y, s, t, kickAge, lift, alarm, season) {
    g.save();
    g.translate(x, y);
    g.scale(s, s);
    const coat = coatOf(season);
    const breathe = Math.sin(t * (1.3 + alarm * 3)) * 0.02;
    const chew = Math.max(0, Math.sin(kickAge * 14)) * Math.exp(-kickAge * 3) * 0.06 * (1 - lift);
    const flick = Math.exp(-kickAge * 4) * Math.sin(kickAge * 20) * 0.35;

    // Tail.
    g.strokeStyle = rgb(DARK);
    g.lineWidth = 0.14;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(1.3, -1.85);
    g.quadraticCurveTo(1.75 + flick, -1.4 - alarm * 0.3, 1.55 + flick * 1.5, -0.65 - alarm * 0.2);
    g.stroke();
    g.lineWidth = 0.08;
    g.beginPath(); g.moveTo(1.32, -1.8); g.quadraticCurveTo(1.6 + flick, -1.2, 1.45 + flick, -0.7); g.stroke();

    const leg = (pts, col) => {
      g.strokeStyle = rgb(col); g.lineWidth = 0.17; g.lineJoin = 'round';
      g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.stroke();
      const end = pts[pts.length - 1];
      g.fillStyle = '#2a1c14'; g.fillRect(end[0] - 0.1, end[1] - 0.1, 0.2, 0.12);
    };
    leg([[-0.6, -1.3], [-0.62, -0.6], [-0.6, -0.02]], mix(coat, DARK, 0.5));
    leg([[0.95, -1.45], [1.1, -0.75], [1.0, -0.02]], mix(coat, DARK, 0.5));

    g.fillStyle = rgb(coat);
    g.beginPath(); g.ellipse(0.05, -1.6 + breathe, 1.15, 0.48 + breathe, 0, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(-0.8, -1.55, 0.45, 0.5, 0, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(0.85, -1.65, 0.52, 0.5, 0, 0, TAU); g.fill();

    leg([[-0.85, -1.3], [-0.85, -0.6], [-0.88, -0.02]], coat);
    leg([[0.75, -1.4], [0.9, -0.72], [0.78, -0.02]], coat);

    // Neck from withers and chest to the head's poll and throat.
    const pose = headPose(lift, chew);
    const poll = headToWorld(pose, 0.02, -0.2);
    const throat = headToWorld(pose, 0.04, 0.1);
    const wx = -0.55, wy = -2.0, cx = -1.1, cy = -1.25;
    const topC = { x: (wx + poll.x) / 2 - 0.1, y: (wy + poll.y) / 2 - 0.22 };
    const botC = { x: (cx + throat.x) / 2 + 0.08, y: (cy + throat.y) / 2 + 0.12 };
    g.fillStyle = rgb(coat);
    g.beginPath();
    g.moveTo(wx, wy);
    g.quadraticCurveTo(topC.x, topC.y, poll.x, poll.y);
    g.lineTo(throat.x, throat.y);
    g.quadraticCurveTo(botC.x, botC.y, cx, cy);
    g.closePath();
    g.fill();

    drawSideHead(pose, alarm, t, coat);

    // Mane along the neck's top curve, falling to the near side.
    g.strokeStyle = rgb(DARK); g.lineWidth = 0.05;
    g.beginPath();
    for (let i = 0; i <= 14; i++) {
      const u = 0.05 + 0.85 * i / 14;
      const mx = (1 - u) * (1 - u) * wx + 2 * (1 - u) * u * topC.x + u * u * poll.x;
      const my = (1 - u) * (1 - u) * wy + 2 * (1 - u) * u * topC.y + u * u * poll.y;
      g.moveTo(mx, my);
      g.quadraticCurveTo(mx - 0.06, my + 0.02, mx - 0.07 + Math.sin(t * 2 + i) * 0.02, my + 0.1);
    }
    g.stroke();

    // Grass tuft where it was grazing.
    g.strokeStyle = rgb(mix(season.grass, [20, 50, 20], 0.3)); g.lineWidth = 0.03;
    g.beginPath();
    for (let i = 0; i < 9; i++) { const gx = -2.35 + i * 0.07; g.moveTo(gx, 0); g.lineTo(gx + Math.sin(i) * 0.05, -0.12 - (i % 3) * 0.05); }
    g.stroke();
    g.restore();
  }

  // ------------------------------------------------------------ the face

  // Front view of the head, looking into the camera. Head units: the poll is
  // at y≈-1.1, the chin at y≈1.25. v runs 0..4 over the last four kicks:
  // shock, then confusion, then fear, while the mouth slowly gapes.
  function faceState(v, t, kickAge) {
    const shock = smooth(v / 0.5);
    const confusion = smooth((v - 0.8) / 0.5) * (1 - smooth((v - 2.0) / 0.6));
    const fear = smooth((v - 1.7) / 1.0);
    const gape = smooth((v - 2.2) / 1.6);
    const flinch = Math.exp(-kickAge * 9);
    // Eyes dart while confused: hold a glance, then jump.
    const glance = Math.floor(t * 2.6);
    const dart = (rng(glance * 31 + 7)() - 0.5) * 2;
    return {
      shock, confusion, fear, gape, flinch,
      eyeOpen: 0.75 + shock * 0.55 + fear * 0.35 + flinch * 0.1,
      gazeX: confusion * dart * 0.045,
      gazeY: -fear * 0.012 + confusion * Math.sin(glance) * 0.012,
      tilt: confusion * 0.2 * Math.sin(v * 1.6 + 0.2) - flinch * 0.03,
      tremble: fear * 0.01 + flinch * 0.02,
      // Ears: pricked forward (0) → one back (confusion) → pinned flat (1).
      earL: clamp(fear * 1.1 + confusion * 0.15 + Math.sin(t * 5) * 0.04 * confusion, 0, 1),
      earR: clamp(fear * 1.1 + confusion * 0.75, 0, 1),
      flare: 0.7 + shock * 0.35 + fear * 0.35 + Math.max(0, Math.sin(t * (4 + fear * 7))) * (0.1 + fear * 0.2),
      jawDrop: 0.03 + gape * 0.42 + Math.sin(t * 26) * 0.006 * fear,
    };
  }

  // Right half of the head outline as bezier segments from poll to chin;
  // the left half mirrors it.
  const FACE_RIGHT = [
    [0.25, -1.1, 0.45, -1.02, 0.5, -0.84],     // poll to temple
    [0.56, -0.64, 0.68, -0.52, 0.66, -0.32],   // around the eye
    [0.64, -0.1, 0.52, 0.02, 0.43, 0.2],       // cheek narrowing
    [0.36, 0.38, 0.33, 0.55, 0.36, 0.72],      // narrow nasal bridge
    [0.4, 0.86, 0.45, 0.98, 0.4, 1.1],         // muzzle widens
  ];

  function faceOutline(jaw) {
    g.beginPath();
    g.moveTo(0, -1.12);
    let px = 0, py = -1.12;
    const segs = [];
    for (const s of FACE_RIGHT) { segs.push({ from: [px, py], s }); px = s[4]; py = s[5]; }
    for (const { s } of segs) bez(s);
    // Lower jaw and chin drop with the mouth.
    bez([0.36, 1.18 + jaw, 0.18, 1.26 + jaw, 0, 1.26 + jaw]);
    bez([-0.18, 1.26 + jaw, -0.36, 1.18 + jaw, -0.4, 1.1]);
    for (let i = segs.length - 1; i >= 0; i--) {
      const { from, s } = segs[i];
      g.bezierCurveTo(-s[2], s[3], -s[0], s[1], -from[0], from[1]);
    }
    g.closePath();
  }

  function drawEar(side, pin, t, coat) {
    // side: -1 left, 1 right. pin 0 = pricked forward (inside visible),
    // 1 = flattened back along the skull (only the back visible).
    g.save();
    g.translate(side * 0.33, -0.98);
    const rot = side * lerp(0.15, 1.75, pin);
    g.rotate(rot);
    const len = lerp(0.58, 0.42, pin);
    const wid = lerp(0.19, 0.15, pin);
    g.fillStyle = rgb(mix(coat, DARK, 0.12 + pin * 0.15));
    g.beginPath();
    g.moveTo(-wid, 0);
    g.bezierCurveTo(-wid * 1.15, -len * 0.5, -wid * 0.35, -len * 0.92, 0, -len);
    g.bezierCurveTo(wid * 0.35, -len * 0.92, wid * 1.15, -len * 0.5, wid, 0);
    g.closePath();
    g.fill();
    const inside = 1 - smooth(pin * 1.3);
    if (inside > 0.02) {
      g.fillStyle = rgb([45, 25, 22], inside);
      g.beginPath();
      g.moveTo(-wid * 0.6, -0.02);
      g.bezierCurveTo(-wid * 0.7, -len * 0.5, -wid * 0.2, -len * 0.85, 0, -len * 0.9);
      g.bezierCurveTo(wid * 0.2, -len * 0.85, wid * 0.7, -len * 0.5, wid * 0.6, -0.02);
      g.closePath();
      g.fill();
      // Pale hair tufts inside the ear.
      g.strokeStyle = `rgba(230,215,195,${0.55 * inside})`;
      g.lineWidth = 0.008;
      g.beginPath();
      for (let i = 0; i < 9; i++) {
        const u = i / 8 - 0.5;
        g.moveTo(u * wid * 0.9, -0.03);
        g.quadraticCurveTo(u * wid * 0.5, -len * 0.3, u * wid * 0.2 + Math.sin(t * 3 + i) * 0.005, -len * (0.45 + 0.25 * (1 - Math.abs(u))));
      }
      g.stroke();
    }
    g.restore();
  }

  function drawFaceEye(side, st, t) {
    const ex = side * 0.58, ey = -0.4;
    const open = st.eyeOpen;
    const w = 0.17, h = 0.1 * open;
    // Bony orbit bulge above and around the eye.
    g.fillStyle = 'rgba(255,225,190,0.12)';
    g.beginPath(); g.ellipse(ex - side * 0.01, ey - 0.07, w * 1.2, 0.1, side * 0.25, Math.PI, TAU); g.fill();
    const sock = g.createRadialGradient(ex, ey, w * 0.6, ex, ey, w * 1.5);
    sock.addColorStop(0, 'rgba(30,15,8,0.3)'); sock.addColorStop(1, 'rgba(30,15,8,0)');
    g.fillStyle = sock;
    g.beginPath(); g.ellipse(ex, ey + 0.01, w * 1.5, h * 1.3 + 0.06, side * 0.2, 0, TAU); g.fill();

    const eyePath = () => {
      g.beginPath();
      g.moveTo(ex - side * w, ey + 0.02);
      g.bezierCurveTo(ex - side * w * 0.5, ey - h * 1.3, ex + side * w * 0.6, ey - h * 1.25, ex + side * w, ey - 0.005);
      g.bezierCurveTo(ex + side * w * 0.5, ey + h * 1.05, ex - side * w * 0.5, ey + h * 1.0, ex - side * w, ey + 0.02);
      g.closePath();
    };
    g.save();
    eyePath(); g.clip();
    // Sclera, a little bloodshot toward the corners as fear builds.
    const sg = g.createRadialGradient(ex, ey, 0.01, ex, ey, w);
    sg.addColorStop(0, '#f4ede4');
    sg.addColorStop(1, `rgb(${215 + st.fear * 20},${190 - st.fear * 40},${180 - st.fear * 40})`);
    g.fillStyle = sg;
    g.fillRect(ex - w * 1.2, ey - 0.2, w * 2.4, 0.4);
    if (st.fear > 0.2) {
      g.strokeStyle = `rgba(190,40,40,${(st.fear - 0.2) * 0.5})`; g.lineWidth = 0.004;
      g.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = i * 1.7 + side;
        g.moveTo(ex + side * w * 0.95 * Math.cos(a * 0.3), ey + Math.sin(a) * h * 0.6);
        g.lineTo(ex + side * w * 0.5, ey + Math.sin(a * 1.3) * h * 0.4);
      }
      g.stroke();
    }
    // Iris looks toward the camera (toward the face's midline), darting
    // while confused. Calm, it fills the opening; wide, white shows around it.
    const ix = ex - side * 0.03 + st.gazeX, iy = ey + st.gazeY;
    const ir = 0.085 - st.fear * 0.01;
    const ig = g.createRadialGradient(ix - 0.015, iy - 0.015, 0.005, ix, iy, ir);
    ig.addColorStop(0, '#5a3a24');
    ig.addColorStop(0.6, '#2a170d');
    ig.addColorStop(1, '#0d0705');
    g.fillStyle = ig;
    g.beginPath(); g.ellipse(ix, iy, ir, ir * 0.92, 0, 0, TAU); g.fill();
    // Horizontal horse pupil with the granula on top.
    g.fillStyle = '#050302';
    g.beginPath(); g.ellipse(ix, iy + 0.004, ir * 0.62, ir * (0.28 + st.fear * 0.12), 0, 0, TAU); g.fill();
    g.fillStyle = '#2b1a10';
    g.beginPath(); g.ellipse(ix, iy - ir * 0.27, ir * 0.3, ir * 0.08, 0, 0, TAU); g.fill();
    // Wet highlights: one window, one small bounce.
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.beginPath(); g.ellipse(ix - 0.025, iy - 0.028, 0.016, 0.011, -0.4, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.beginPath(); g.arc(ix + 0.024, iy + 0.024, 0.006, 0, TAU); g.fill();
    // Upper lid shadow.
    g.fillStyle = 'rgba(40,20,10,0.35)';
    g.fillRect(ex - w * 1.2, ey - h * 1.4, w * 2.4, h * 0.45);
    g.restore();

    // Lids and lashes.
    g.strokeStyle = '#120806'; g.lineWidth = 0.014;
    eyePath(); g.stroke();
    g.strokeStyle = '#1a0d08'; g.lineWidth = 0.006;
    g.beginPath();
    for (let i = 0; i < 9; i++) {
      const u = 0.1 + i * 0.1;
      const lx = ex - side * w + side * u * 2 * w;
      const ly = ey + 0.02 - Math.sin(u * Math.PI) * h * 0.98 - u * 0.02;
      g.moveTo(lx, ly);
      g.quadraticCurveTo(lx + side * 0.012, ly - 0.03, lx + side * 0.03, ly - 0.035 - st.fear * 0.01);
    }
    g.stroke();
    // A raised, creased brow: the "worry wrinkle" above the eye.
    const worry = Math.max(st.shock * 0.4, st.fear, st.confusion * 0.6);
    g.strokeStyle = rgb([45, 22, 12], 0.75 * worry); g.lineWidth = 0.016;
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      const r = 0.14 + i * 0.035;
      g.moveTo(ex - side * r * 0.7, ey - r * 0.55 - 0.02);
      g.quadraticCurveTo(ex - side * r * 0.1, ey - r * 1.05 - 0.02 - worry * 0.02, ex + side * r * 0.45, ey - r * 0.75);
      g.stroke();
    }
  }

  function drawFace(cx, cy, S, v, t, kickAge, season) {
    const st = faceState(v, t, kickAge);
    const coat = coatOf(season);
    const jaw = st.jawDrop;

    g.save();
    g.translate(cx + wobble(t, 1) * st.tremble * S, cy + wobble(t, 4) * st.tremble * S - st.flinch * 0.04 * S);
    g.rotate(st.tilt + wobble(t * 0.7, 9) * st.tremble * 0.6);
    const sc = S * (1 + st.flinch * 0.025);
    g.scale(sc, sc);

    // Neck and chest behind the head.
    const neck = () => {
      g.beginPath();
      g.moveTo(-0.5, -0.4);
      g.bezierCurveTo(-0.62, 0.5, -0.72, 1.3, -1.45, 2.8);
      g.lineTo(1.45, 2.8);
      g.bezierCurveTo(0.72, 1.3, 0.62, 0.5, 0.5, -0.4);
      g.closePath();
    };
    const nk = g.createLinearGradient(-1, 0, 1, 0);
    nk.addColorStop(0, rgb(mix(coat, DARK, 0.6)));
    nk.addColorStop(0.35, rgb(mix(coat, DARK, 0.25)));
    nk.addColorStop(1, rgb(mix(coat, DARK, 0.55)));
    g.fillStyle = nk;
    neck(); g.fill();
    // Throat shadow under the jaw, kept inside the neck.
    g.save();
    neck(); g.clip();
    const tg = g.createRadialGradient(0, 1.2 + jaw, 0.1, 0, 1.2 + jaw, 1.0);
    tg.addColorStop(0, rgb(DARK, 0.75)); tg.addColorStop(1, rgb(DARK, 0));
    g.fillStyle = tg;
    g.fillRect(-1.5, 0.2, 3, 2.6);
    g.restore();

    drawEar(-1, st.earL, t, coat);
    drawEar(1, st.earR, t, coat);

    // The head, lit from the upper left.
    const hg = g.createRadialGradient(-0.2, -0.5, 0.1, 0, 0, 1.5);
    hg.addColorStop(0, rgb(mix(coat, [255, 215, 170], 0.22)));
    hg.addColorStop(0.55, rgb(coat));
    hg.addColorStop(1, rgb(mix(coat, DARK, 0.6)));
    g.fillStyle = hg;
    faceOutline(jaw);
    g.fill();

    g.save();
    faceOutline(jaw);
    g.clip();
    // Hollows under the cheekbones; a highlight down the nasal bone.
    for (const side of [-1, 1]) {
      const cg = g.createRadialGradient(side * 0.42, 0.05, 0.02, side * 0.42, 0.05, 0.3);
      cg.addColorStop(0, rgb(DARK, 0.35)); cg.addColorStop(1, rgb(DARK, 0));
      g.fillStyle = cg; g.fillRect(side * 0.42 - 0.3, -0.25, 0.6, 0.6);
    }
    const ng = g.createLinearGradient(-0.25, 0, 0.25, 0);
    ng.addColorStop(0, 'rgba(255,230,200,0)'); ng.addColorStop(0.5, 'rgba(255,230,200,0.18)'); ng.addColorStop(1, 'rgba(255,230,200,0)');
    g.fillStyle = ng; g.fillRect(-0.25, -0.8, 0.5, 1.5);
    // Coat texture: short hairs following the face downward.
    const hr = rng(5);
    g.strokeStyle = rgb(DARK, 0.18); g.lineWidth = 0.006;
    g.beginPath();
    for (let i = 0; i < 260; i++) {
      const x = (hr() - 0.5) * 1.3, y = -1.0 + hr() * 1.9;
      const a = Math.PI / 2 + x * 0.8;
      g.moveTo(x, y); g.lineTo(x + Math.cos(a) * 0.04, y + Math.sin(a) * 0.04);
    }
    g.stroke();
    // Blaze: an irregular white stripe from forehead to nostrils.
    g.fillStyle = rgb(BLAZE, 0.92);
    g.beginPath();
    g.moveTo(-0.13, -0.78);
    g.bezierCurveTo(-0.05, -0.86, 0.1, -0.84, 0.15, -0.74);
    g.bezierCurveTo(0.12, -0.4, 0.06, 0.1, 0.08, 0.5);
    g.bezierCurveTo(0.1, 0.7, 0.18, 0.82, 0.12, 0.95);
    g.bezierCurveTo(0.04, 1.0, -0.06, 1.0, -0.12, 0.93);
    g.bezierCurveTo(-0.15, 0.78, -0.07, 0.62, -0.07, 0.45);
    g.bezierCurveTo(-0.07, 0.0, -0.15, -0.45, -0.13, -0.78);
    g.closePath();
    g.fill();
    // Soft, dark muzzle skin.
    const mz = g.createLinearGradient(0, 0.62, 0, 0.9);
    mz.addColorStop(0, rgb(SKIN, 0)); mz.addColorStop(1, rgb(SKIN, 0.95));
    g.fillStyle = mz; g.fillRect(-0.6, 0.62, 1.2, 0.8 + jaw);
    // Fear sweat glistening on the face.
    if (st.fear > 0.1) {
      const sr = rng(19);
      for (let i = 0; i < 18; i++) {
        const x = (sr() - 0.5) * 0.9, y = -0.8 + sr() * 1.3;
        g.fillStyle = `rgba(255,250,240,${0.35 * st.fear * (0.5 + 0.5 * Math.sin(t * 3 + i))})`;
        g.beginPath(); g.ellipse(x, y, 0.012, 0.02, 0, 0, TAU); g.fill();
      }
    }
    g.restore();
    // Rim shadow so the head reads against the neck behind it.
    g.strokeStyle = rgb(DARK, 0.55); g.lineWidth = 0.025;
    faceOutline(jaw); g.stroke();

    drawFaceEye(-1, st, t);
    drawFaceEye(1, st, t);

    // Forelock tumbling between the ears, shivering with the head.
    // Many fine strands in two shades, of uneven length, for a soft lock.
    const fr = rng(23);
    g.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
      g.strokeStyle = pass ? 'rgba(95,55,30,0.7)' : 'rgba(30,16,8,0.85)';
      g.lineWidth = pass ? 0.007 : 0.012;
      g.beginPath();
      for (let i = 0; i < 34; i++) {
        const x0 = (fr() - 0.5) * 0.26;
        const len = 0.3 + fr() * 0.3;
        const sway = Math.sin(t * 1.5 + i * 0.7) * 0.015 + wobble(t, i) * st.tremble * 2;
        const lean = x0 * 1.3 + (fr() - 0.5) * 0.08;
        g.moveTo(x0, -1.12);
        g.bezierCurveTo(x0 + lean * 0.3, -1.12 + len * 0.35, x0 + lean + sway, -1.12 + len * 0.7, x0 + lean * 1.4 + sway * 1.5, -1.12 + len);
      }
      g.stroke();
    }

    // Nostrils: big commas that flare with each frightened breath.
    for (const side of [-1, 1]) {
      const nx = side * 0.23, ny = 0.86;
      const f = st.flare;
      g.save();
      g.translate(nx, ny);
      g.rotate(side * 0.45);
      g.fillStyle = rgb(mix(SKIN, [255, 255, 255], 0.08));
      g.beginPath(); g.ellipse(0, 0, 0.09 * f, 0.14 * f, 0, 0, TAU); g.fill();
      g.fillStyle = '#120706';
      g.beginPath();
      g.moveTo(0, -0.11 * f);
      g.bezierCurveTo(side * 0.07 * f, -0.08 * f, side * 0.06 * f, 0.08 * f, 0, 0.1 * f);
      g.bezierCurveTo(-side * 0.04 * f, 0.07 * f, -side * 0.02 * f, -0.02 * f, side * 0.01 * f, -0.03 * f);
      g.bezierCurveTo(-side * 0.03 * f, -0.06 * f, -side * 0.02 * f, -0.1 * f, 0, -0.11 * f);
      g.fill();
      g.restore();
    }

    // Mouth: lips part, teeth show, the jaw falls open.
    const my = 1.1;
    const mw = 0.24 + st.gape * 0.06;
    const lipQuiver = Math.sin(t * 30) * 0.008 * st.fear;
    g.fillStyle = '#1c0508';
    g.beginPath();
    g.moveTo(-mw, my);
    g.bezierCurveTo(-mw * 0.6, my - 0.03 - st.gape * 0.06, mw * 0.6, my - 0.03 - st.gape * 0.06, mw, my);
    g.bezierCurveTo(mw * 0.7, my + jaw * 1.1, -mw * 0.7, my + jaw * 1.1, -mw, my);
    g.fill();
    if (jaw > 0.06) {
      // Tongue at the bottom of the open mouth.
      g.fillStyle = 'rgba(190,90,100,0.95)';
      g.beginPath(); g.ellipse(0, my + jaw * 0.78, mw * 0.55, jaw * 0.22, 0, Math.PI, TAU); g.fill();
      // Upper incisors under a curled lip, lower ones on the jaw.
      const th = Math.min(0.1, jaw * 0.35);
      const tooth = (x, y, w, h) => {
        const tg2 = g.createLinearGradient(0, y, 0, y + h);
        tg2.addColorStop(0, '#d9c9a2'); tg2.addColorStop(1, '#f1e7cf');
        g.fillStyle = tg2;
        g.beginPath();
        g.moveTo(x - w / 2, y); g.lineTo(x + w / 2, y);
        g.lineTo(x + w / 2, y + h - 0.01); g.quadraticCurveTo(x + w / 2, y + h, x + w / 2 - 0.01, y + h);
        g.lineTo(x - w / 2 + 0.01, y + h); g.quadraticCurveTo(x - w / 2, y + h, x - w / 2, y + h - 0.01);
        g.closePath(); g.fill();
        g.strokeStyle = 'rgba(90,70,40,0.5)'; g.lineWidth = 0.004; g.stroke();
      };
      for (let i = -3; i < 3; i++) {
        const x = (i + 0.5) * 0.06;
        const y = my - 0.035 - st.gape * 0.06 + x * x * 1.2;
        tooth(x, y, 0.058, th);
        if (jaw > 0.2) {
          const yl = my + jaw * 1.0 - x * x * 1.5;
          tooth(x, yl - th * 0.85, 0.054, th * 0.85);
        }
      }

    }
    // Lips: the upper one curls back; the lower one trembles.
    g.strokeStyle = rgb(mix(SKIN, [20, 10, 10], 0.4)); g.lineWidth = 0.035;
    g.beginPath();
    g.moveTo(-mw - 0.02, my + 0.005);
    g.bezierCurveTo(-mw * 0.6, my - 0.04 - st.gape * 0.07, mw * 0.6, my - 0.04 - st.gape * 0.07, mw + 0.02, my + 0.005);
    g.stroke();
    g.beginPath();
    g.moveTo(-mw - 0.01, my + 0.01);
    g.bezierCurveTo(-mw * 0.7, my + jaw * 1.12 + lipQuiver, mw * 0.7, my + jaw * 1.12 - lipQuiver, mw + 0.01, my + 0.01);
    g.stroke();
    // Whiskers.
    g.strokeStyle = 'rgba(20,12,10,0.6)'; g.lineWidth = 0.004;
    g.beginPath();
    for (let i = 0; i < 14; i++) {
      const side = i % 2 ? 1 : -1;
      const x = side * (0.16 + (i % 5) * 0.035), y = my + 0.02 + (i % 3) * 0.04 + jaw * 0.6;
      g.moveTo(x, y); g.lineTo(x + side * (0.05 + (i % 4) * 0.02), y + 0.04 + Math.sin(t * 4 + i) * 0.006);
    }
    g.stroke();
    g.restore();

    return { mouthX: cx, mouthY: cy + (my + jaw * 0.55) * sc };
  }

  function drawHorseChapter(u, t, season) {
    const kickAge = nowS() - lastKickTime;
    if (u < 12) {
      // Approach from across the meadow; on the 11th kick the horse jerks its
      // head up out of the grass and stares.
      const approach = u / 12;
      const camX = 600 + u * 30;
      const s = lerp(H * 0.02, H * 0.2, Math.pow(approach, 1.6));
      const hx = lerp(W * 0.5, W * 0.62, approach), hy = lerp(H * 0.6, H * 0.88, approach);
      const lift = smooth((u - 10.4) / 0.35);
      const alarm = smooth((u - 10.4) / 1.2);
      drawMeadow(season, 1, camX, t);
      drawHorse(hx, hy, s, t, kickAge, lift, alarm, season);
      return;
    }
    // Close-up: cut to the face. The camera creeps in, then dives for the mouth.
    const v = u - 12;
    g.save();
    g.filter = 'blur(5px)';
    drawMeadow(season, 1, 960, t);
    g.filter = 'none';
    g.restore();
    g.fillStyle = 'rgba(20,25,20,0.15)';
    g.fillRect(0, 0, W, H);

    const S = H * 0.28;
    const creep = 1 + v * 0.06;
    const dive = smooth((v - 3.0) / 1.0);
    // Find where the mouth will be, then zoom about it, steering it to center.
    const cx = W / 2, cy = H * 0.5;
    const probe = { x: cx, y: cy + (1.1 + faceState(v, t, kickAge).jawDrop * 0.55) * S * creep };
    const z = creep * Math.pow(60, dive);
    g.save();
    const tx = lerp(probe.x, W / 2, dive), ty = lerp(probe.y, H / 2, dive);
    g.translate(tx, ty); g.scale(z / creep, z / creep); g.translate(-probe.x, -probe.y);
    drawFace(cx, cy, S * creep, v, t, kickAge, season);
    g.restore();
    if (dive > 0.55) {
      g.fillStyle = rgb(SECTIONS[0].fog, smooth((dive - 0.55) / 0.45));
      g.fillRect(0, 0, W, H);
    }
  }

  // ------------------------------------------------------------ the tunnel

  // Section params at tunnel position s, blended over the last 1.5 units.
  function paramsAt(s) {
    const i = sectionAt(clamp(s, 0, TUNNEL_LEN - 1e-6));
    const a = SECTIONS[i], b = SECTIONS[Math.min(i + 1, SECTIONS.length - 1)];
    const blend = smooth((s - (a.start + a.len - 1.5)) / 1.5);
    return {
      a, b, blend,
      radius: lerp(a.radius, b.radius, blend),
      wall: mix(a.wall, b.wall, blend),
      fog: mix(a.fog, b.fog, blend),
      curve: lerp(a.curve, b.curve, blend),
      squeeze: lerp(a.squeeze, b.squeeze, blend),
    };
  }

  // The tunnel's center line wanders; seeded per cycle so every trip differs.
  let pathSeed = 0, pathCoef = [];
  function setPathSeed(seed) {
    if (seed === pathSeed && pathCoef.length) return;
    pathSeed = seed;
    const r = rng(seed * 7919 + 13);
    pathCoef = [0, 1, 2].map(() => ({ fx: 0.15 + r() * 0.35, fy: 0.12 + r() * 0.3, px: r() * TAU, py: r() * TAU }));
  }
  function pathAt(s) {
    let x = 0, y = 0;
    for (const c of pathCoef) {
      const amp = paramsAt(s).curve;
      x += Math.sin(s * c.fx + c.px) * amp;
      y += Math.sin(s * c.fy + c.py) * amp * 0.6;
    }
    return { x, y };
  }

  function wallRadius(s, theta, P, t) {
    let r = P.radius;
    const f = P.blend < 0.5 ? P.a.feature : P.b.feature;
    if (f === 'ribs') r *= 1 + 0.05 * Math.sin(s * TAU * 2);
    else if (f === 'folds') r *= 1 + 0.08 * Math.sin(theta * 7 + s * 0.9) + 0.04 * Math.sin(theta * 13 - s * 1.7);
    else if (f === 'villi') r *= 1 + 0.06 * Math.sin(theta * 28 + s * 9 + Math.sin(t * 2) * 0.5);
    else if (f === 'haustra') r *= 1 + 0.22 * Math.abs(Math.sin(Math.PI * s / 1.6)) - 0.11;
    // Peristalsis: each kick launches a contraction that travels ahead.
    for (const w of waves) {
      const age = t - w.t;
      const front = w.s + 1.2 + age * 3.5;
      const d = (s - front) / 0.5;
      r *= 1 - P.squeeze * Math.exp(-d * d) * Math.exp(-age * 0.6);
    }
    return r;
  }

  function drawTunnel(sCam, t) {
    const F = Math.min(W, H) * 0.9;
    const cx = W / 2, cy = H / 2;
    const camP = pathAt(sCam);
    const camLook = pathAt(sCam + 1.5);
    // Aim slightly along the path so curves are visible ahead.
    const lookX = (camLook.x - camP.x) * 0.5, lookY = (camLook.y - camP.y) * 0.5;
    const P0 = paramsAt(sCam);
    const flash = Math.exp(-(nowS() - lastKickTime) * 4);

    g.fillStyle = rgb(P0.fog);
    g.fillRect(0, 0, W, H);

    const STEP = 0.2, NEAR = 0.25, FAR = 16;
    const N = 56;
    for (let d = NEAR; d < FAR; d += STEP) {
      const s = sCam + d - ((sCam % STEP) + STEP) % STEP;
      const dd = s - sCam;
      if (dd < NEAR * 0.8) continue;
      const P = paramsAt(s);
      const c = pathAt(s);
      const ox = cx + ((c.x - camP.x) - lookX * dd / 1.5) * F / dd;
      const oy = cy + ((c.y - camP.y) - lookY * dd / 1.5) * F / dd;
      const fogT = clamp(dd / FAR, 0, 1);
      const isExit = P.a.key === 'exit' || P.b.key === 'exit';
      const light = (0.85 + 0.3 * flash) * (1 - Math.pow(fogT, 0.7) * (isExit ? 0.3 : 0.85));
      let col = P.wall.map((v) => v * light);
      const f = P.blend < 0.5 ? P.a.feature : P.b.feature;
      if (f === 'ribs') col = col.map((v) => v * (0.85 + 0.15 * Math.sin(s * TAU * 2)));
      if (f === 'haustra') col = col.map((v) => v * (0.7 + 0.3 * Math.abs(Math.sin(Math.PI * s / 1.6))));
      col = mix(col, P.fog, Math.pow(fogT, 1.4));

      g.fillStyle = rgb(col);
      g.beginPath();
      for (let k = 0; k <= N; k++) {
        const th = k / N * TAU;
        const r = wallRadius(s, th, P, t) * F / dd;
        const x = ox + Math.cos(th) * r, y = oy + Math.sin(th) * r;
        if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.fill();
      // Wet highlight on the upper-left of each ring.
      if (dd < 6) {
        const rr = wallRadius(s, 3.9, P, t) * F / dd;
        g.strokeStyle = `rgba(255,240,240,${0.12 * (1 - dd / 6)})`;
        g.lineWidth = Math.max(1, F / dd * 0.02);
        g.beginPath(); g.arc(ox, oy, rr * 0.97, 3.5, 4.4); g.stroke();
      }
    }

    // Teeth guard the entrance.
    const teethS = 1.6;
    const td = teethS - sCam;
    if (td > NEAR) {
      const c = pathAt(teethS);
      const ox = cx + (c.x - camP.x) * F / td, oy = cy + (c.y - camP.y) * F / td;
      const R = SECTIONS[0].radius * F / td;
      const kickAge = nowS() - lastKickTime;
      const chomp = Math.exp(-kickAge * 5) * 0.35;
      g.fillStyle = '#efe6d2';
      for (const side of [-1, 1]) {
        for (let i = -4; i <= 4; i++) {
          const x = ox + i * R * 0.19;
          const y = oy + side * R * (0.62 - chomp);
          g.beginPath();
          g.ellipse(x, y, R * 0.085, R * 0.16, 0, 0, TAU);
          g.fill();
        }
      }
    }

    drawParticles(sCam, camP, lookX, lookY, F, t);

    // Stomach acid pooling in the lower half.
    const acid = paramsAt(sCam).a.key === 'stomach' ? 1 : 0;
    const acidW = lerp(acid, paramsAt(sCam).b.key === 'stomach' ? 1 : 0, paramsAt(sCam).blend);
    if (acidW > 0.01) {
      const kickAge = nowS() - lastKickTime;
      const slosh = Math.exp(-kickAge * 2) * 30;
      g.fillStyle = `rgba(190,200,60,${0.45 * acidW})`;
      g.beginPath(); g.moveTo(0, H);
      for (let x = 0; x <= W; x += 10) {
        g.lineTo(x, H * 0.66 + Math.sin(x * 0.01 + t * 1.3) * 8 + Math.sin(x * 0.023 - kickAge * 6) * slosh);
      }
      g.lineTo(W, H); g.closePath(); g.fill();
    }
  }

  function spawnParticles(sCam) {
    const r = Math.random;
    while (particles.length < 70) {
      const s = sCam + 2 + r() * 12;
      const kind = paramsAt(s).a.particles;
      if (kind === 'none') break;
      particles.push({ s, a: r() * TAU, rf: r() * 0.85, kind, seed: r() * 100 });
    }
  }

  function drawParticles(sCam, camP, lookX, lookY, F, t) {
    particles = particles.filter((p) => p.s > sCam + 0.3 && paramsAt(p.s).a.particles === p.kind);
    spawnParticles(sCam);
    const cx = W / 2, cy = H / 2;
    particles.sort((a, b) => b.s - a.s);
    for (const p of particles) {
      const dd = p.s - sCam;
      const P = paramsAt(p.s);
      const c = pathAt(p.s);
      const rad = P.radius * p.rf;
      const a = p.a + Math.sin(t * 0.5 + p.seed) * 0.3;
      const wx = c.x - camP.x + Math.cos(a) * rad - lookX * dd / 1.5;
      const wy = c.y - camP.y + Math.sin(a) * rad - lookY * dd / 1.5;
      const x = cx + wx * F / dd, y = cy + wy * F / dd;
      const sz = F / dd * (p.kind === 'microbes' ? 0.09 : 0.04);
      const fade = clamp((14 - dd) / 6, 0, 1) * clamp(dd - 0.3, 0, 1);
      if (p.kind === 'grass') {
        g.strokeStyle = `rgba(80,140,50,${0.8 * fade})`;
        g.lineWidth = Math.max(1, sz * 0.3);
        const ang = p.seed + t * 0.7;
        g.beginPath(); g.moveTo(x - Math.cos(ang) * sz, y - Math.sin(ang) * sz); g.lineTo(x + Math.cos(ang) * sz, y + Math.sin(ang) * sz); g.stroke();
      } else if (p.kind === 'acid') {
        g.strokeStyle = `rgba(230,240,120,${0.6 * fade})`;
        g.lineWidth = Math.max(1, sz * 0.12);
        g.beginPath(); g.arc(x, y - ((t * 30 + p.seed * 10) % 40) * sz * 0.05, sz * 0.6, 0, TAU); g.stroke();
      } else if (p.kind === 'microbes') {
        g.fillStyle = `rgba(150,220,170,${0.55 * fade})`;
        g.beginPath();
        for (let k = 0; k <= 12; k++) {
          const th = k / 12 * TAU;
          const rr = sz * (0.7 + 0.25 * Math.sin(th * 3 + t * 4 + p.seed));
          const px = x + Math.cos(th) * rr * 1.6, py = y + Math.sin(th) * rr;
          if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.fill();
        g.strokeStyle = `rgba(150,220,170,${0.4 * fade})`;
        g.lineWidth = Math.max(1, sz * 0.1);
        g.beginPath(); g.moveTo(x + sz * 1.5, y); g.quadraticCurveTo(x + sz * 2.2, y + Math.sin(t * 8 + p.seed) * sz, x + sz * 2.8, y); g.stroke();
      }
    }
  }

  // ------------------------------------------------------------ return

  function drawReturn(u, t, season) {
    const fromWhite = 1 - smooth(u / 1.5);
    drawMeadow(season, 1, 2000 + u * 6, t);
    // A small mound, and from it one flower that grows with each kick.
    const mx = W * 0.5, my = H * 0.86;
    g.fillStyle = '#5a3c22';
    g.beginPath(); g.ellipse(mx, my, W * 0.06, H * 0.03, 0, Math.PI, TAU); g.fill();
    const grow = clamp(u / CHAPTERS[3].len, 0, 1);
    const stem = H * 0.3 * smooth(grow * 1.2);
    g.strokeStyle = '#3c7a34'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(mx, my - H * 0.02);
    g.bezierCurveTo(mx - 20, my - stem * 0.4, mx + 18, my - stem * 0.7, mx, my - stem); g.stroke();
    if (grow > 0.3) {
      g.fillStyle = '#3c7a34';
      const lf = smooth((grow - 0.3) / 0.3) * 26;
      g.beginPath(); g.ellipse(mx - lf * 0.8, my - stem * 0.45, lf, lf * 0.35, -0.5, 0, TAU); g.fill();
    }
    if (grow > 0.6) {
      const b = smooth((grow - 0.6) / 0.4);
      const hue = [8, 45, 300, 200][cycleOf(kicks) % 4];
      g.fillStyle = `hsl(${hue},70%,62%)`;
      for (let i = 0; i < 8; i++) {
        const a = i / 8 * TAU + t * 0.1;
        g.beginPath(); g.ellipse(mx + Math.cos(a) * 18 * b, my - stem + Math.sin(a) * 18 * b, 14 * b, 7 * b, a, 0, TAU); g.fill();
      }
      g.fillStyle = '#f2cf4a';
      g.beginPath(); g.arc(mx, my - stem, 8 * b, 0, TAU); g.fill();
    }
    if (fromWhite > 0) { g.fillStyle = `rgba(255,248,230,${fromWhite})`; g.fillRect(0, 0, W, H); }
  }

  // ------------------------------------------------------------ titles & HUD

  function currentTitle(local) {
    const ch = chapterAt(local);
    if (ch.key !== 'tunnel') return { key: ch.key, text: ch.title };
    const sec = SECTIONS[sectionAt(local - ch.start)];
    return { key: sec.key, text: sec.title };
  }

  const NUMERALS = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi'];
  const TITLE_ORDER = ['meadow', 'horse', ...SECTIONS.map((s) => s.key), 'return'];

  function drawTitle(local, t) {
    const cur = currentTitle(local);
    if (cur.key !== titleShown) { titleShown = cur.key; titleTime = t; }
    const age = t - titleTime;
    const a = smooth(age / 0.8) * (1 - smooth((age - 3.5) / 1.5));
    if (a <= 0) return;
    const n = TITLE_ORDER.indexOf(cur.key);
    g.fillStyle = `rgba(255,252,245,${a * 0.85})`;
    g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 8;
    g.font = `300 ${Math.round(Math.min(W, H) * 0.045)}px Georgia, "Times New Roman", serif`;
    g.textAlign = 'left';
    g.fillText(`${NUMERALS[n]}. ${cur.text}`, W * 0.06, H * 0.12);
    g.shadowBlur = 0;
  }

  // ------------------------------------------------------------ render

  function render(t) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cyc = cycleOf(progress);
    const season = SEASONS[cyc % SEASONS.length];
    const local = progress - cyc * CYCLE_LEN;
    const ch = chapterAt(local);
    const u = local - ch.start;
    setPathSeed(cyc + 1);

    if (ch.key === 'meadow') {
      drawMeadow(season, smooth(u / ch.len), u * 40, t);
    } else if (ch.key === 'horse') {
      drawHorseChapter(u, t, season);
    } else if (ch.key === 'tunnel') {
      drawTunnel(u, t);
      if (u < 0.6) { g.fillStyle = rgb(SECTIONS[0].fog, 1 - smooth(u / 0.6)); g.fillRect(0, 0, W, H); }
      const toWhite = smooth((u - (TUNNEL_LEN - 2)) / 2);
      if (toWhite > 0) { g.fillStyle = `rgba(255,248,230,${toWhite})`; g.fillRect(0, 0, W, H); }
    } else {
      drawReturn(u, t, season);
      const out = smooth((u - (ch.len - 1)) / 1);
      if (out > 0) { g.fillStyle = `rgba(30,35,60,${out * 0.6})`; g.fillRect(0, 0, W, H); }
    }

    // Vignette.
    const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = vg; g.fillRect(0, 0, W, H);

    drawTitle(local, t);
    return { cyc, season, ch, u, local };
  }

  // ------------------------------------------------------------ inputs: demo beat

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const kit = new Kit(ctx);
  let demoOn = false, demoTimer = null, demoNext = 0, demoStep = 0;
  const pendingKicks = [];
  const DEMO_BPM = 104;
  // 16-step patterns; the bass and bell are sparse and a little sad.
  const PAT = {
    kick: 'x...x...x...x...',
    snare: '....x.......x...',
    hat: '..x...x...x...x.',
    rim: '.......x......x.',
  };
  const BASS = [45, null, null, null, 45, null, 43, null, 41, null, null, null, 40, null, 43, null];
  const BELL = [[0, 69], [6, 72], [10, 67], [14, 64]];
  let demoBar = 0;

  function demoSchedule() {
    const stepDur = 60 / DEMO_BPM / 4;
    while (demoNext < ctx.currentTime + 0.12) {
      const st = demoStep % 16;
      for (const [name, pat] of Object.entries(PAT)) {
        if (pat[st] !== 'x') continue;
        kit.play(name, demoNext, { gain: name === 'kick' ? 0.95 : name === 'hat' ? 0.35 : 0.5 });
        if (name === 'kick') pendingKicks.push(demoNext);
      }
      if (BASS[st] != null && demoBar % 4 !== 3) kit.play('bass', demoNext, { midi: BASS[st] - (demoBar % 4 === 2 ? 2 : 0), gain: 0.55 });
      for (const [bs, note] of BELL) if (bs === st && demoBar % 2 === 1) kit.play('bell', demoNext, { midi: note, gain: 0.25, pan: 0.3 });
      demoNext += stepDur;
      demoStep++;
      if (demoStep % 16 === 0) demoBar++;
    }
  }

  function setDemo(on) {
    demoOn = on;
    clearInterval(demoTimer);
    if (on) {
      ctx.resume();
      demoNext = ctx.currentTime + 0.1;
      demoStep = 0;
      demoTimer = setInterval(demoSchedule, 25);
    } else {
      pendingKicks.length = 0;
    }
  }

  // ------------------------------------------------------------ inputs: microphone

  let mic = null; // {analyser, data, prevE, mean, var, last}
  let sensitivity = 2.2;
  let micLevel = 0;

  async function setMic(on) {
    if (!on) {
      if (mic) mic.stream.getTracks().forEach((tr) => tr.stop());
      mic = null;
      return;
    }
    try {
      await ctx.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      src.connect(analyser);
      mic = { stream, analyser, data: new Float32Array(analyser.frequencyBinCount), prevE: -100, mean: 0, var: 1, last: 0 };
    } catch (e) {
      mic = null;
      micError = e.name || 'error';
    }
  }
  let micError = '';

  // Kick onset: rise in low-band (35-150 Hz) energy beyond an adaptive threshold.
  function pollMic() {
    if (!mic) return;
    mic.analyser.getFloatFrequencyData(mic.data);
    const binHz = ctx.sampleRate / mic.analyser.fftSize;
    const lo = Math.max(1, Math.floor(35 / binHz)), hi = Math.ceil(150 / binHz);
    let e = 0;
    for (let i = lo; i <= hi; i++) e += Math.pow(10, mic.data[i] / 10);
    const E = 10 * Math.log10(e + 1e-12);
    micLevel = clamp((E + 90) / 70, 0, 1);
    const flux = Math.max(0, E - mic.prevE);
    mic.prevE = E;
    const sd = Math.sqrt(mic.var);
    const t = ctx.currentTime;
    if (flux > mic.mean + sensitivity * sd + 3 && E > -65 && t - mic.last > 0.14) {
      mic.last = t;
      kick('mic');
    }
    mic.mean = lerp(mic.mean, flux, 0.05);
    mic.var = lerp(mic.var, (flux - mic.mean) ** 2, 0.05);
  }

  // ------------------------------------------------------------ inputs: MIDI

  let midiState = 'off', midiAnyNote = false;
  function setupMidi() {
    if (!navigator.requestMIDIAccess) { midiState = 'unsupported'; return; }
    navigator.requestMIDIAccess().then((access) => {
      const hook = () => {
        let n = 0;
        access.inputs.forEach((inp) => { inp.onmidimessage = onMidi; n++; });
        midiState = n ? `${n} input${n > 1 ? 's' : ''}` : 'no inputs';
      };
      hook();
      access.onstatechange = hook;
    }, () => { midiState = 'denied'; });
  }
  function onMidi(e) {
    const [st, note, vel] = e.data;
    if ((st & 0xf0) === 0x90 && vel > 0 && (midiAnyNote || note === 35 || note === 36)) kick('midi');
  }

  // ------------------------------------------------------------ loop

  const hud = document.getElementById('hud');
  const overlay = document.getElementById('overlay');
  let lastFrame = nowS();
  let paused = false;

  function unlock() { ctx.resume().then(() => { if (ctx.state === 'running') overlay.hidden = true; }); }
  if (ctx.state === 'running') overlay.hidden = true;
  overlay.addEventListener('click', unlock);
  window.addEventListener('keydown', unlock, { once: true });
  window.addEventListener('pointerdown', unlock, { once: true });
  canvas.addEventListener('pointerdown', () => { kick('tap'); kit.play('kick', ctx.currentTime, { gain: 0.8 }); });

  function handleInput() {
    Input.update();
    if (Input.pressed('a')) { kick('pad'); kit.play('kick', ctx.currentTime, { gain: 0.9 }); unlock(); }
    if (Input.pressed('start')) { unlock(); setDemo(!demoOn); }
    if (Input.pressed('x')) { unlock(); setMic(!mic); }
    if (Input.pressed('y')) midiAnyNote = !midiAnyNote;
    if (Input.pressed('b')) hudVisible = !hudVisible;
    if (Input.pressed('select')) jumpTo(0);
    if (Input.pressed('lb')) sensitivity = clamp(sensitivity + 0.2, 0.4, 5);
    if (Input.pressed('rb')) sensitivity = clamp(sensitivity - 0.2, 0.4, 5);
    // Scrub between titled parts.
    if (Input.pressed('right') || Input.pressed('left')) {
      const d = Input.pressed('right') ? 1 : -1;
      const marks = [];
      for (let c = 0; c <= cycleOf(kicks) + 1; c++) {
        for (const ch of CHAPTERS) {
          if (ch.key === 'tunnel') for (const sec of SECTIONS) marks.push(c * CYCLE_LEN + ch.start + sec.start);
          else marks.push(c * CYCLE_LEN + ch.start);
        }
      }
      const target = d > 0 ? marks.find((m) => m > kicks) : [...marks].reverse().find((m) => m < kicks);
      if (target != null) jumpTo(target);
    }
    if (Input.pressed('up')) { kicks += 1; }
  }

  function updateHud(info) {
    hudTimer += 1 / 60;
    const show = hudVisible && (hudTimer < 4 || !demoOn && !mic);
    hud.style.opacity = show ? 1 : 0;
    const pad = Input.padName();
    hud.innerHTML =
      `<div><b>${kicks}</b> kicks · ${info.season.name} · ${info.ch.key === 'tunnel' ? SECTIONS[sectionAt(info.u)].title : info.ch.title}</div>`
      + `<div>${demoOn ? '● ' : '○ '}demo beat <span class="k">Start/Enter</span></div>`
      + `<div>${mic ? '● ' : '○ '}microphone <span class="k">X/C</span> ${mic ? `<span class="meter"><i style="width:${(micLevel * 100) | 0}%"></i></span> sens ${sensitivity.toFixed(1)} <span class="k">LB/RB</span>` : micError ? `(${micError})` : ''}</div>`
      + `<div>MIDI: ${midiState}, ${midiAnyNote ? 'any note' : 'notes 35/36'} <span class="k">Y/V</span></div>`
      + `<div>kick <span class="k">A/Space/click</span> · skip part <span class="k">◀ ▶</span> · restart <span class="k">Select/Tab</span> · hide <span class="k">B/X</span></div>`
      + `<div class="pad">${pad ? '🎮 ' + pad.replace(/\(.*\)/, '').trim().slice(0, 40) : 'no gamepad'}</div>`;
  }

  function frame() {
    const t = nowS();
    const dt = Math.min(0.1, t - lastFrame);
    lastFrame = t;
    handleInput();
    pollMic();
    while (pendingKicks.length && pendingKicks[0] <= ctx.currentTime) { pendingKicks.shift(); kick('demo'); }
    // Ease toward the kick count: each kick is a lurch forward.
    progress += (kicks - progress) * (1 - Math.exp(-dt * 7));
    if (Math.abs(kicks - progress) < 1e-4) progress = kicks;
    if (W === 0) resize();
    const info = render(t);
    updateHud(info);
    if (!paused) requestAnimationFrame(frame);
  }

  setupMidi();
  resize();
  requestAnimationFrame(frame);

  // Test hook for headless rendering.
  window.__endo = {
    kick, jumpTo, CYCLE_LEN, CHAPTERS, SECTIONS,
    renderAt(k) { paused = true; jumpTo(k); lastKickTime = -10; titleTime = -10; render(nowS()); },
  };
})();
