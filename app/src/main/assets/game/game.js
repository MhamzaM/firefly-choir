/*
 * Firefly Choir
 * Each firefly is a pulse-coupled oscillator: an internal clock that flashes when it reaches 1.
 * Seeing a flash nudges a firefly's clock forward, which is how real swarms fall into sync.
 * The player's lantern is a strong flash; timing it with a group pulls stragglers in.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const cvs = $("c");
  const ctx = cvs.getContext("2d");
  const DEBUG = /debug/.test(location.hash);

  // ---------------------------------------------------------------- tuning

  const T = {
    basePeriod: 2.2,        // seconds between flashes
    groupWindow: 0.14,      // flashes this close together count as one group
    refractory: 0.25,       // a firefly ignores flashes right after its own
    neighbourRadius: 82,    // design units
    neighbourKick: 0.065,
    tapRadius: 128,
    tapKick: 0.34,
    attractTime: 1.6,
    maxCharges: 5,
    rechargeTime: 1.15,     // seconds per lantern charge
    mimicRadius: 100,
    mimicKick: 0.24,
    shooRadius: 52,
  };

  const NOTES = [293.66, 329.63, 369.99, 440.0, 493.88, 587.33, 659.25, 739.99, 880.0, 987.77];

  function nightParams(n) {
    const count = Math.min(8 + (n - 1) * 3, 34);
    return {
      count,
      goal: count <= 10 ? count : Math.ceil(count * 0.9),
      detune: Math.min(0.025 + 0.022 * (n - 1), 0.17),
      duration: Math.max(28, Math.round(44 + count * 1.1 - (n - 1) * 4)),
      wind: n >= 3,
      mimics: n >= 4 ? Math.min(1 + Math.floor((n - 4) / 2), 3) : 0,
    };
  }

  // ---------------------------------------------------------------- helpers

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem("fc:" + k);
        return v === null ? d : JSON.parse(v);
      } catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem("fc:" + k, JSON.stringify(v)); } catch (e) {}
    },
  };

  const native = window.FireflyNative || null;
  function vibrate(ms) {
    try {
      if (native && native.vibrate) native.vibrate(ms);
      else if (navigator.vibrate) navigator.vibrate(ms);
    } catch (e) {}
  }
  // The Android app pushes the screen-cutout insets (in CSS px) so the HUD clears the camera notch.
  window.setInsets = function (top, bottom) {
    document.documentElement.style.setProperty("--inset-top", top + "px");
    document.documentElement.style.setProperty("--inset-bottom", bottom + "px");
  };

  const rnd = (a, b) => (b === undefined ? Math.random() * (a === undefined ? 1 : a) : a + Math.random() * (b - a));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const fmt = new Intl.NumberFormat("en");

  // ---------------------------------------------------------------- sound (all synthesised, no files)

  const Sound = {
    ac: null, out: null, wet: null, voices: 0,
    enabled: store.get("sound", true),

    ensure() {
      if (this.ac) {
        if (this.ac.state === "suspended") this.ac.resume();
        return true;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      const ac = (this.ac = new AC());
      const comp = ac.createDynamicsCompressor();
      comp.connect(ac.destination);
      this.out = ac.createGain();
      this.out.gain.value = this.enabled ? 0.7 : 0;
      this.out.connect(comp);
      const conv = ac.createConvolver();
      conv.buffer = this.impulse(2.8);
      this.wet = ac.createGain();
      this.wet.gain.value = 0.5;
      this.wet.connect(conv);
      conv.connect(this.out);
      return true;
    },

    impulse(sec) {
      const ac = this.ac, len = Math.floor(ac.sampleRate * sec);
      const buf = ac.createBuffer(2, len, ac.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
      }
      return buf;
    },

    setEnabled(on) {
      this.enabled = on;
      store.set("sound", on);
      if (this.out) this.out.gain.setTargetAtTime(on ? 0.7 : 0, this.ac.currentTime, 0.05);
    },

    bell(freq, vol, dur, when) {
      if (!this.ac || !this.enabled || this.voices > 16) return;
      const ac = this.ac, t = ac.currentTime + (when || 0);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const o1 = ac.createOscillator();
      o1.frequency.value = freq;
      const o2 = ac.createOscillator();
      o2.frequency.value = freq * 2.76; // bell-like overtone
      const g2 = ac.createGain();
      g2.gain.value = 0.1;
      o1.connect(g);
      o2.connect(g2);
      g2.connect(g);
      g.connect(this.out);
      g.connect(this.wet);
      o1.start(t); o2.start(t);
      o1.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
      this.voices++;
      o1.onended = () => { this.voices--; };
    },

    noise(dur, filterType, f0, f1, vol) {
      if (!this.ac || !this.enabled) return;
      const ac = this.ac, t = ac.currentTime;
      const len = Math.floor(ac.sampleRate * dur);
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ac.createBufferSource();
      src.buffer = buf;
      const f = ac.createBiquadFilter();
      f.type = filterType;
      f.frequency.setValueAtTime(f0, t);
      f.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.6);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.25);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f); f.connect(g); g.connect(this.out); g.connect(this.wet);
      src.start(t);
    },

    lantern() {
      this.noise(0.35, "lowpass", 1400, 300, 0.12);
      this.bell(146.83, 0.08, 0.6);
    },
    empty() { this.bell(110, 0.06, 0.25); },
    gust() { this.noise(2.2, "bandpass", 280, 1100, 0.09); },
    mimic() {
      this.bell(311.13, 0.07, 0.7);
      this.bell(415.3, 0.05, 0.6, 0.03);
    },
    chorus(freqs) {
      freqs.slice(0, 8).forEach((f, i) => this.bell(f, 0.12, 3.4, i * 0.07));
      this.bell(73.42, 0.16, 4.0);
    },
  };

  // ---------------------------------------------------------------- layout

  let W = 0, H = 0, DPR = 1, U = 1;
  const field = { x0: 0, y0: 0, x1: 0, y1: 0 };
  let scenery = null;
  let stars = [];
  let grass = [];
  let sprite = null, mimicSprite = null;

  function resize() {
    const oldW = W || window.innerWidth, oldH = H || window.innerHeight;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    cvs.width = Math.round(W * DPR);
    cvs.height = Math.round(H * DPR);
    U = clamp(Math.min(W, H * 0.62) / 400, 0.75, 2.2);
    field.x0 = 22 * U;
    field.x1 = W - 22 * U;
    field.y0 = H * 0.16;
    field.y1 = H * 0.8;
    for (const f of flies.concat(mimics)) {
      f.x = clamp((f.x / oldW) * W, field.x0, field.x1);
      f.y = clamp((f.y / oldH) * H, field.y0, field.y1);
    }
    buildScenery();
  }

  function makeSprite(core, mid, outer) {
    const s = document.createElement("canvas");
    const n = 128;
    s.width = s.height = n;
    const g = s.getContext("2d");
    const grd = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    grd.addColorStop(0, core);
    grd.addColorStop(0.1, mid);
    grd.addColorStop(0.32, outer);
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, n, n);
    return s;
  }

  function buildScenery() {
    sprite = sprite || makeSprite("rgba(255,248,214,1)", "rgba(255,211,107,0.6)", "rgba(255,180,70,0.16)");
    mimicSprite = mimicSprite || makeSprite("rgba(255,214,196,1)", "rgba(255,84,64,0.8)", "rgba(225,40,40,0.28)");

    stars = [];
    const nStars = Math.round((W * H) / 5200);
    for (let i = 0; i < nStars; i++) {
      stars.push({ x: rnd(W), y: rnd(H * 0.72), r: rnd(0.4, 1.3) * U, a: rnd(0.25, 0.9), tw: rnd(0.5, 2.2), ph: rnd(6.28) });
    }

    grass = [];
    const nBlades = Math.round(W / (5 * U));
    for (let i = 0; i < nBlades; i++) {
      grass.push({ x: (i / nBlades) * W + rnd(-2, 2) * U, h: rnd(16, 48) * U, w: rnd(3, 6) * U, ph: rnd(6.28) });
    }

    scenery = document.createElement("canvas");
    scenery.width = cvs.width;
    scenery.height = cvs.height;
    const g = scenery.getContext("2d");
    g.scale(DPR, DPR);

    // far hills
    g.fillStyle = "#1f1848";
    g.beginPath();
    g.moveTo(0, H);
    g.lineTo(0, H * 0.79);
    for (let x = 0; x <= W; x += 8) {
      g.lineTo(x, H * 0.79 - Math.sin(x / W * 3.1 + 0.6) * 22 * U - Math.sin(x / W * 9.4) * 6 * U);
    }
    g.lineTo(W, H);
    g.fill();

    // trees at the edges: soft rounded canopies
    const tree = (x, base, h, r) => {
      g.fillStyle = "#120d2c";
      g.fillRect(x - 2.5 * U, base - h, 5 * U, h);
      g.beginPath();
      const blobs = [[0, -h, r], [-r * 0.55, -h + r * 0.35, r * 0.75], [r * 0.55, -h + r * 0.4, r * 0.7], [0, -h - r * 0.45, r * 0.7]];
      for (const [dx, dy, rr] of blobs) {
        g.moveTo(x + dx + rr, base + dy);
        g.arc(x + dx, base + dy, rr, 0, Math.PI * 2);
      }
      g.fill();
    };
    tree(W * 0.06, H * 0.86, 120 * U, 40 * U);
    tree(W * 0.17, H * 0.87, 80 * U, 28 * U);
    tree(W * 0.93, H * 0.86, 140 * U, 46 * U);

    // near ground
    g.fillStyle = "#0b0820";
    g.beginPath();
    g.moveTo(0, H);
    g.lineTo(0, H * 0.87);
    for (let x = 0; x <= W; x += 8) g.lineTo(x, H * 0.87 - Math.sin(x / W * 2.2 + 1.4) * 10 * U);
    g.lineTo(W, H);
    g.fill();
  }

  // ---------------------------------------------------------------- state

  let state = "title";   // title | play | chorus | over
  let paused = false;
  let now = 0;
  let flies = [];
  let mimics = [];
  let queue = [];
  let group = null;
  let lanterns = [];
  let pops = [];
  let night = 1, P = nightParams(1), nightT = 0, nightBest = 0;
  let score = 0, best = store.get("best", 0);
  let charges = T.maxCharges;
  let wind = null, nextGust = 0;
  let stats = { groups: 0, biggest: 0, nights: 0 };
  let hintQueue = [], hintTimer = 0, flags = store.get("flags", {});
  let chorusT = 0;

  function makeFly(i, detune, demo) {
    return {
      x: rnd(field.x0, field.x1), y: rnd(field.y0, field.y1),
      vx: 0, vy: 0, heading: rnd(6.28), speed: rnd(6, 12),
      phase: rnd(), period: T.basePeriod * (1 + detune * (rnd() * 2 - 1)),
      glow: 0, lastFlash: -9, note: NOTES[(i * 3 + Math.floor(rnd(3))) % NOTES.length],
      attract: 0, tx: 0, ty: 0, demo: !!demo,
    };
  }

  function makeMimic() {
    const side = rnd() < 0.5 ? -1 : 1;
    return {
      x: side < 0 ? field.x0 : field.x1, y: rnd(field.y0, field.y1),
      vx: 0, vy: 0, heading: rnd(6.28), speed: rnd(22, 30),
      phase: rnd(), period: rnd(1.3, 2.1), glow: 0,
      away: 0, gone: false, exitX: 0, exitY: 0,
    };
  }

  function populateDemo() {
    flies = [];
    mimics = [];
    for (let i = 0; i < 14; i++) flies.push(makeFly(i, 0.03, true));
  }

  // ---------------------------------------------------------------- phase physics

  // Neighbour flashes only pull a clock forward. The lantern is stronger: a firefly that flashed
  // just before it (early in its cycle) is pulled back to match it, as real fireflies do.
  function kick(f, eps, resets) {
    if (now - f.lastFlash < T.refractory && !resets) return;
    if (resets && f.phase < 0.25) {
      f.phase *= Math.max(0, 1 - eps * 2.0);
      return;
    }
    f.phase += eps * (0.35 + f.phase);
    if (f.phase >= 1 && !f.queued) {
      f.queued = true;
      queue.push(f);
    }
  }

  function fire(f) {
    f.queued = false;
    if (f.lastFlash === now) return;
    f.phase = 0;
    f.lastFlash = now;
    f.glow = 1;

    if (!group || now - group.t0 > T.groupWindow) {
      finalizeGroup();
      group = { t0: now, members: [], sx: 0, sy: 0 };
    }
    group.members.push(f);
    group.sx += f.x;
    group.sy += f.y;
    Sound.bell(f.note, 0.15 / Math.sqrt(group.members.length), 1.7);

    const R = T.neighbourRadius * U;
    const k = f.demo ? 0.11 : T.neighbourKick;
    for (const g of flies) {
      if (g === f) continue;
      const d = Math.hypot(g.x - f.x, g.y - f.y);
      if (d < R) kick(g, k * (1 - d / R));
    }
  }

  function processQueue() {
    let guard = 0;
    while (queue.length && guard++ < 500) fire(queue.shift());
  }

  function finalizeGroup() {
    if (!group) return;
    const g = group;
    group = null;
    const n = g.members.length;
    if (state !== "play" || n < 1) return;
    const cx = g.sx / n, cy = g.sy / n;
    if (n > nightBest) {
      nightBest = n;
      updateGoal();
    }
    stats.biggest = Math.max(stats.biggest, n);
    if (n >= 3) {
      const pts = n * n;
      score += pts;
      stats.groups++;
      pops.push({ x: cx, y: cy - 18 * U, text: "+" + pts, t: 0, life: 1.3, size: 15 + Math.min(n, 14) * 1.6, halo: 26 * Math.sqrt(n) });
      if (n >= 5) addCharge(1);
      if (n >= 4 && !flags.firstGroup) {
        flags.firstGroup = true;
        saveFlags();
        showHint("That's it. Bigger groups pull in their neighbours.", 4.5, true);
      }
    }
    if (n >= P.goal) chorus(n);
  }

  // ---------------------------------------------------------------- player

  function tap(x, y) {
    if (state !== "play" || paused) return;
    if (charges < 1) {
      Sound.empty();
      const el = $("charges");
      el.classList.remove("empty");
      void el.offsetWidth;
      el.classList.add("empty");
      return;
    }
    charges -= 1;
    lanterns.push({ x, y, t: 0 });
    Sound.lantern();
    vibrate(8);

    for (const m of mimics) {
      if (!m.gone && Math.hypot(m.x - x, m.y - y) < T.shooRadius * U) shoo(m);
    }

    const R = T.tapRadius * U;
    for (const f of flies) {
      const d = Math.hypot(f.x - x, f.y - y);
      if (d < R) {
        const k = 1 - (d / R) * (d / R);
        kick(f, T.tapKick * k, true);
        f.attract = T.attractTime;
        f.tx = x + rnd(-24, 24) * U;
        f.ty = y + rnd(-24, 24) * U;
      }
    }
    processQueue();
  }

  function addCharge(n) {
    charges = Math.min(T.maxCharges, charges + n);
  }

  function shoo(m) {
    m.gone = true;
    m.away = 14;
    m.exitX = m.x < W / 2 ? -60 * U : W + 60 * U;
    m.exitY = m.y + rnd(-80, 80) * U;
    pops.push({ x: m.x, y: m.y - 16 * U, text: "Shoo!", t: 0, life: 1.0, size: 15, halo: 0, red: true });
  }

  // ---------------------------------------------------------------- game flow

  function startGame() {
    Sound.ensure();
    score = 0;
    stats = { groups: 0, biggest: 0, nights: 0 };
    night = 1;
    showScreen(null);
    $("hud").classList.remove("hidden");
    state = "play";
    paused = false;
    startNight();
  }

  function startNight() {
    P = nightParams(night);
    flies = [];
    for (let i = 0; i < P.count; i++) flies.push(makeFly(i, P.detune, false));
    mimics = [];
    for (let i = 0; i < P.mimics; i++) mimics.push(makeMimic());
    queue = [];
    group = null;
    nightT = 0;
    nightBest = 0;
    charges = T.maxCharges;
    wind = null;
    nextGust = rnd(9, 13);
    lanterns = [];
    $("nightLabel").textContent = "Night " + night;
    updateGoal();
    hintQueue = [];
    hideHint();

    if (night === 1 && !flags.tutorial) {
      queueHint(1.0, "Each firefly glows brighter just before it flashes.", 5);
      queueHint(7.0, "Tap right as a group flashes. Fireflies nearby flash sooner and fly to your light.", 8);
      queueHint(22, () => (nightBest < P.goal ? "Get all " + P.goal + " flashing at once before dawn." : null), 5);
    } else if (night === 1) {
      queueHint(0.8, "Get all " + P.goal + " fireflies flashing at once before dawn.", 4);
    }
    if (P.mimics && !flags.mimic) {
      queueHint(1.5, "A red mimic flashes out of turn and scatters the rhythm. Tap it to chase it away.", 6);
      flags.mimic = true;
      saveFlags();
    }
  }

  function chorus(n) {
    state = "chorus";
    const remaining = Math.max(0, P.duration - nightT);
    const bonus = 50 * n + Math.round(remaining) * 10;
    score += bonus;
    stats.nights++;
    for (const f of flies) f.glow = 1;
    Sound.chorus(flies.map((f) => f.note).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b));
    vibrate(70);
    if (night === 1) {
      flags.tutorial = true;
      saveFlags();
    }
    hideHint();
    $("nightDoneTitle").textContent = "The meadow sang as one";
    $("nightDoneText").textContent = n + " fireflies flashed together. Bonus +" + fmt.format(bonus) + ".";
    showScreen("nightDone");
    chorusT = 3.2;
  }

  function nextNight() {
      night++;
      showScreen(null);
      state = "play";
      startNight();
      const p = nightParams(night);
      let extra = "";
      if (p.wind && !flags.wind) extra = " Watch out for the wind.";
      showHint("Night " + night + ": " + p.count + " fireflies." + extra, 3.5, true);
  }

  function gameOver() {
    state = "over";
    finalizeGroup();
    const isBest = score > best;
    if (isBest) {
      best = score;
      store.set("best", best);
    }
    if (night === 1) {
      flags.tutorial = true;
      saveFlags();
    }
    $("finalScore").textContent = fmt.format(score);
    const nights = stats.nights === 1 ? "one night" : stats.nights + " nights";
    let text;
    if (stats.nights === 0) {
      text = nightBest < P.goal / 2
        ? "Tip: tap between scattered fireflies to gather them, then flash with a group."
        : "So close. " + nightBest + " of " + P.goal + " flashed together.";
    } else {
      text = "You led the choir through " + nights + ".";
    }
    if (isBest && score > 0) text = "New best! " + text;
    else text += " Best: " + fmt.format(best) + ".";
    $("overText").textContent = text;
    hideHint();
    $("hud").classList.add("hidden");
    showScreen("over");
  }

  function toTitle() {
    state = "title";
    paused = false;
    $("hud").classList.add("hidden");
    hideHint();
    populateDemo();
    updateBest();
    showScreen("title");
  }

  function pause() {
    if (state !== "play" || paused) return;
    paused = true;
    showScreen("pause");
  }
  function resume() {
    if (!paused) return;
    paused = false;
    showScreen(null);
  }

  // ---------------------------------------------------------------- hints

  function saveFlags() { store.set("flags", flags); }

  function queueHint(at, text, dur) { hintQueue.push({ at, text, dur }); }

  function showHint(text, dur, urgent) {
    const el = $("hint");
    el.textContent = text;
    el.classList.add("show");
    hintTimer = dur;
    if (urgent) hintQueue = hintQueue.filter((h) => h.at > nightT + dur);
  }
  function hideHint() {
    $("hint").classList.remove("show");
    hintTimer = 0;
  }

  function updateHints(dt) {
    if (hintTimer > 0) {
      hintTimer -= dt;
      if (hintTimer <= 0) hideHint();
      return;
    }
    if (hintQueue.length && nightT >= hintQueue[0].at) {
      const h = hintQueue.shift();
      const text = typeof h.text === "function" ? h.text() : h.text;
      if (text) showHint(text, h.dur);
    }
  }

  // ---------------------------------------------------------------- update

  function update(dt) {
    now += dt;
    const playing = state === "play";

    // fireflies
    for (const f of flies) {
      f.phase += dt / f.period;
      if (f.phase >= 1 && !f.queued) {
        f.queued = true;
        queue.push(f);
      }
      f.glow *= Math.exp(-dt * 4.2);
      moveFly(f, dt);
    }
    // mimics
    for (const m of mimics) updateMimic(m, dt, playing);
    processQueue();
    if (group && now - group.t0 > T.groupWindow) finalizeGroup();

    if (playing) {
      nightT += dt;
      if (charges < T.maxCharges) charges = Math.min(T.maxCharges, charges + dt / T.rechargeTime);
      if (P.wind) updateWind(dt);
      updateHints(dt);
      if (nightT >= P.duration) gameOver();
    } else if (state === "chorus") {
      if (wind) updateWind(dt);
      chorusT -= dt;
      if (chorusT <= 0) nextNight();
    }

    for (const l of lanterns) l.t += dt;
    lanterns = lanterns.filter((l) => l.t < 1.1);
    for (const p of pops) p.t += dt;
    pops = pops.filter((p) => p.t < p.life);
  }

  function moveFly(f, dt) {
    f.heading += (Math.random() - 0.5) * 2.4 * dt * 2;
    let tvx = Math.cos(f.heading) * f.speed * U;
    let tvy = Math.sin(f.heading) * f.speed * U * 0.7;

    if (f.attract > 0) {
      f.attract -= dt;
      const dx = f.tx - f.x, dy = f.ty - f.y, d = Math.hypot(dx, dy);
      if (d > 36 * U) {
        const s = Math.min(70 * U, d * 1.6);
        tvx = (dx / d) * s;
        tvy = (dy / d) * s;
      }
    }

    // stay inside the meadow
    const m = 30 * U;
    if (f.x < field.x0 + m) tvx += (field.x0 + m - f.x) * 2;
    if (f.x > field.x1 - m) tvx -= (f.x - (field.x1 - m)) * 2;
    if (f.y < field.y0 + m) tvy += (field.y0 + m - f.y) * 2;
    if (f.y > field.y1 - m) tvy -= (f.y - (field.y1 - m)) * 2;

    const space = 30 * U;
    for (const g of flies) {
      if (g === f) continue;
      const dx = f.x - g.x, dy = f.y - g.y;
      if (Math.abs(dx) > space || Math.abs(dy) > space) continue;
      const d = Math.hypot(dx, dy);
      if (d > 0.01 && d < space) {
        const push = ((space - d) / space) * 90 * U;
        tvx += (dx / d) * push;
        tvy += (dy / d) * push;
      }
    }

    f.vx += (tvx - f.vx) * Math.min(1, dt * 2.2);
    f.vy += (tvy - f.vy) * Math.min(1, dt * 2.2);

    if (wind && wind.stage === "blow" && Math.abs(f.y - wind.y) < wind.h / 2) {
      f.vx += wind.dir * 140 * U * dt;
    }

    f.x += f.vx * dt;
    f.y += f.vy * dt;
    f.x = clamp(f.x, field.x0 - 40 * U, field.x1 + 40 * U);
    f.y = clamp(f.y, field.y0 - 40 * U, field.y1 + 40 * U);
  }

  function updateMimic(m, dt, playing) {
    if (m.gone) {
      if (m.x > -50 * U && m.x < W + 50 * U) {
        const dx = m.exitX - m.x, dy = m.exitY - m.y, d = Math.hypot(dx, dy) || 1;
        m.x += (dx / d) * 260 * U * dt;
        m.y += (dy / d) * 260 * U * dt;
      }
      if (playing) {
        m.away -= dt;
        if (m.away <= 0) {
          Object.assign(m, makeMimic());
        }
      }
      m.glow *= Math.exp(-dt * 4);
      return;
    }
    m.heading += (Math.random() - 0.5) * 5 * dt;
    let tvx = Math.cos(m.heading) * m.speed * U, tvy = Math.sin(m.heading) * m.speed * U;
    // mimics are drawn to the swarm
    if (flies.length) {
      let cx = 0, cy = 0;
      for (const f of flies) { cx += f.x; cy += f.y; }
      cx /= flies.length; cy /= flies.length;
      const dx = cx - m.x, dy = cy - m.y, d = Math.hypot(dx, dy) || 1;
      if (d > 40 * U) { tvx += (dx / d) * 16 * U; tvy += (dy / d) * 16 * U; }
    }
    const mg = 30 * U;
    if (m.x < field.x0 + mg) tvx += 60 * U;
    if (m.x > field.x1 - mg) tvx -= 60 * U;
    if (m.y < field.y0 + mg) tvy += 60 * U;
    if (m.y > field.y1 - mg) tvy -= 60 * U;
    m.vx += (tvx - m.vx) * Math.min(1, dt * 3);
    m.vy += (tvy - m.vy) * Math.min(1, dt * 3);
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    m.glow *= Math.exp(-dt * 4);
    m.phase += dt / m.period;
    if (m.phase >= 1) {
      m.phase = 0;
      m.period = rnd(1.25, 2.1); // irregular on purpose
      m.glow = 1;
      if (playing) Sound.mimic();
      const R = T.mimicRadius * U;
      for (const f of flies) {
        const d = Math.hypot(f.x - m.x, f.y - m.y);
        if (d < R) kick(f, T.mimicKick * (1 - d / R));
      }
    }
  }

  function updateWind(dt) {
    if (!wind) {
      nextGust -= dt;
      if (nextGust <= 0) {
        const fh = field.y1 - field.y0;
        wind = { stage: "warn", t: 0, dir: rnd() < 0.5 ? -1 : 1, y: rnd(field.y0 + fh * 0.25, field.y1 - fh * 0.25), h: fh * 0.42 };
        Sound.gust();
        if (!flags.wind) {
          flags.wind = true;
          saveFlags();
          showHint("A gust scatters the rhythm of every firefly it reaches.", 4.5, true);
        }
      }
      return;
    }
    wind.t += dt;
    if (wind.stage === "warn" && wind.t > 1.0) {
      wind.stage = "blow";
      wind.t = 0;
      for (const f of flies) {
        if (Math.abs(f.y - wind.y) < wind.h / 2) {
          f.phase = (f.phase + rnd(-0.38, 0.38) + 1) % 1;
        }
      }
    } else if (wind.stage === "blow" && wind.t > 1.3) {
      wind = null;
      nextGust = rnd(Math.max(5, 9 - night * 0.3), Math.max(7, 13 - night * 0.3));
    }
  }

  // ---------------------------------------------------------------- render

  const NIGHT = [[21, 18, 58], [42, 33, 96], [64, 45, 112]];
  const DAWN = [[64, 84, 150], [205, 126, 152], [255, 196, 146]];
  const mix = (a, b, t) => "rgb(" + a.map((v, i) => Math.round(lerp(v, b[i], t))).join(",") + ")";

  function render() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const p = state === "play" || state === "chorus" || state === "over" ? clamp(nightT / P.duration, 0, 1) : 0.08;
    const dawn = smooth(0.42, 1, p);

    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, H * 0.85);
    sky.addColorStop(0, mix(NIGHT[0], DAWN[0], dawn));
    sky.addColorStop(0.55, mix(NIGHT[1], DAWN[1], dawn));
    sky.addColorStop(1, mix(NIGHT[2], DAWN[2], dawn));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // stars
    const starA = 1 - dawn;
    if (starA > 0.02) {
      ctx.fillStyle = "#fff6e0";
      for (const s of stars) {
        ctx.globalAlpha = s.a * starA * (0.65 + 0.35 * Math.sin(now * s.tw + s.ph));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, 6.283);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // moon sets as dawn approaches
    const mx = lerp(0.78, 0.22, p) * W, my = H * (0.1 + 0.62 * p * p);
    const mr = 17 * U;
    const mg = ctx.createRadialGradient(mx, my, mr * 0.6, mx, my, mr * 4.2);
    mg.addColorStop(0, "rgba(255,244,220," + (0.22 * (1 - dawn * 0.7)) + ")");
    mg.addColorStop(1, "rgba(255,244,220,0)");
    ctx.fillStyle = mg;
    ctx.fillRect(mx - mr * 4.2, my - mr * 4.2, mr * 8.4, mr * 8.4);
    ctx.fillStyle = "rgba(250,243,226," + (1 - dawn * 0.45) + ")";
    ctx.beginPath();
    ctx.arc(mx, my, mr, 0, 6.283);
    ctx.fill();

    // hills and trees
    ctx.drawImage(scenery, 0, 0, W, H);
    if (dawn > 0) {
      ctx.fillStyle = "rgba(255,170,140," + dawn * 0.1 + ")";
      ctx.fillRect(0, H * 0.75, W, H * 0.25);
    }

    // wind streaks
    if (wind) {
      const a = wind.stage === "warn" ? wind.t * 0.25 : 0.25 * (1 - wind.t / 1.3);
      ctx.strokeStyle = "rgba(220,210,255," + clamp(a, 0, 0.3) + ")";
      ctx.lineWidth = 1.2 * U;
      for (let i = 0; i < 9; i++) {
        const yy = wind.y - wind.h / 2 + (i + 0.5) * (wind.h / 9);
        const prog = ((now * 1.7 + i * 0.37) % 1);
        const xx = wind.dir > 0 ? prog * W : W - prog * W;
        ctx.beginPath();
        ctx.moveTo(xx, yy);
        ctx.lineTo(xx - wind.dir * 60 * U, yy + Math.sin(i) * 4 * U);
        ctx.stroke();
      }
    }

    // lantern flashes
    for (const l of lanterns) {
      const k = l.t / 1.1;
      const r = T.tapRadius * U * (0.25 + 0.75 * Math.sqrt(k));
      const glow = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, r);
      glow.addColorStop(0, "rgba(255,226,150," + 0.35 * (1 - k) + ")");
      glow.addColorStop(1, "rgba(255,226,150,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(l.x, l.y, r, 0, 6.283);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,220,140," + 0.55 * (1 - k) + ")";
      ctx.lineWidth = 2 * U;
      ctx.beginPath();
      ctx.arc(l.x, l.y, r, 0, 6.283);
      ctx.stroke();
    }

    // group halos
    ctx.globalCompositeOperation = "lighter";
    for (const p2 of pops) {
      if (!p2.halo) continue;
      const k = p2.t / p2.life;
      const r = p2.halo * U * (0.8 + k * 0.6);
      const hg = ctx.createRadialGradient(p2.x, p2.y + 18 * U, 0, p2.x, p2.y + 18 * U, r);
      hg.addColorStop(0, "rgba(255,210,120," + 0.22 * (1 - k) + ")");
      hg.addColorStop(1, "rgba(255,210,120,0)");
      ctx.fillStyle = hg;
      ctx.beginPath();
      ctx.arc(p2.x, p2.y + 18 * U, r, 0, 6.283);
      ctx.fill();
    }

    // fireflies: idle ember grows with the internal clock, then a bright flash
    for (const f of flies) {
      const ember = 0.26 + 0.5 * Math.pow(f.phase, 5);
      const b = Math.max(f.glow, ember);
      const s = (18 + 60 * b) * U;
      ctx.globalAlpha = clamp(0.45 + b, 0, 1);
      ctx.drawImage(sprite, f.x - s / 2, f.y - s / 2, s, s);
    }
    for (const m of mimics) {
      if (m.x < -40 * U || m.x > W + 40 * U) continue;
      const b = Math.max(m.glow, 0.42 + 0.14 * Math.sin(now * 9 + m.period * 7)); // restless flicker
      const s = (22 + 58 * b) * U;
      ctx.globalAlpha = clamp(0.4 + b, 0, 1);
      ctx.drawImage(mimicSprite, m.x - s / 2, m.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    // grass in front
    const lean = wind ? (wind.stage === "warn" ? wind.t : 1 - wind.t / 1.3) * wind.dir * 12 * U : 0;
    ctx.fillStyle = "#07051a";
    ctx.beginPath();
    for (const g of grass) {
      const sway = Math.sin(now * 1.3 + g.ph) * 3 * U + lean;
      ctx.moveTo(g.x - g.w / 2, H);
      ctx.quadraticCurveTo(g.x + sway * 0.3, H - g.h * 0.6, g.x + sway, H - g.h);
      ctx.quadraticCurveTo(g.x + sway * 0.3 + g.w * 0.3, H - g.h * 0.5, g.x + g.w / 2, H);
    }
    ctx.fill();

    // score pops
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const p2 of pops) {
      const k = p2.t / p2.life;
      ctx.globalAlpha = 1 - k * k;
      ctx.font = "600 " + Math.round(p2.size * U) + "px Fraunces, Georgia, serif";
      ctx.fillStyle = p2.red ? "#ffb39a" : "#ffe7a8";
      ctx.fillText(p2.text, p2.x, p2.y - k * 26 * U);
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- HUD + screens

  let hudTick = 0;
  function updateHud(dt) {
    hudTick -= dt;
    if (hudTick > 0) return;
    hudTick = 0.08;
    $("score").textContent = fmt.format(score);
    const el = $("charges");
    if (el.children.length !== T.maxCharges) {
      el.innerHTML = "";
      for (let i = 0; i < T.maxCharges; i++) {
        const c = document.createElement("div");
        c.className = "charge";
        c.appendChild(document.createElement("i"));
        el.appendChild(c);
      }
    }
    for (let i = 0; i < T.maxCharges; i++) {
      const fill = clamp(charges - i, 0, 1);
      el.children[i].firstChild.style.height = fill * 100 + "%";
      el.children[i].style.opacity = fill >= 1 ? 1 : 0.6;
    }
  }

  function updateGoal() {
    $("goal").innerHTML = "Most at once: <b>" + nightBest + "</b> of " + P.goal;
  }

  function updateBest() {
    $("bestLabel").textContent = best > 0 ? "Best score: " + fmt.format(best) : "";
  }

  const screens = ["title", "how", "pause", "nightDone", "over"];
  function showScreen(id) {
    for (const s of screens) $(s).classList.toggle("hidden", s !== id);
  }

  function updateSoundLabels() {
    const t = "Sound: " + (Sound.enabled ? "on" : "off");
    $("soundBtn").textContent = t;
    $("soundBtn2").textContent = t;
  }

  // ---------------------------------------------------------------- input

  cvs.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    Sound.ensure();
    tap(e.clientX, e.clientY);
  });

  $("playBtn").addEventListener("click", startGame);
  $("howPlayBtn").addEventListener("click", startGame);
  $("againBtn").addEventListener("click", startGame);
  $("howBtn").addEventListener("click", () => { Sound.ensure(); showScreen("how"); });
  $("howBackBtn").addEventListener("click", () => showScreen("title"));
  $("menuBtn").addEventListener("click", toTitle);
  $("pauseBtn").addEventListener("click", pause);
  $("resumeBtn").addEventListener("click", resume);
  $("quitBtn").addEventListener("click", () => { finalizeGroup(); toTitle(); });
  const toggleSound = () => { Sound.ensure(); Sound.setEnabled(!Sound.enabled); updateSoundLabels(); };
  $("soundBtn").addEventListener("click", toggleSound);
  $("soundBtn2").addEventListener("click", toggleSound);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      pause();
      if (Sound.ac) Sound.ac.suspend();
    } else if (Sound.ac && Sound.enabled) {
      Sound.ac.resume();
    }
  });

  // Android back button: returns true if the game handled it
  window.onAndroidBack = function () {
    if (state === "play" && !paused) { pause(); return true; }
    if (paused) { resume(); return true; }
    if (!$("how").classList.contains("hidden")) { showScreen("title"); return true; }
    if (state === "over") { toTitle(); return true; }
    return false;
  };

  // Called by the Android app when it goes to the background / comes back.
  window.onAndroidPause = function () {
    pause();
    if (Sound.ac) Sound.ac.suspend();
  };
  window.onAndroidResume = function () {
    if (Sound.ac && Sound.enabled) Sound.ac.resume();
  };

  window.addEventListener("resize", resize);

  // ---------------------------------------------------------------- loop

  let last = performance.now();
  function loop(ts) {
    const dt = Math.min(0.05, Math.max(0, (ts - last) / 1000));
    last = ts;
    if (!paused && !DEBUG_FROZEN) update(dt);
    if (state === "play" || state === "chorus") updateHud(dt);
    render();
    requestAnimationFrame(loop);
  }

  let DEBUG_FROZEN = false;
  if (DEBUG) {
    window.__fc = {
      freeze(v) { DEBUG_FROZEN = v; },
      step(dt, n) { for (let i = 0; i < (n || 1); i++) update(dt); },
      tap,
      start: startGame,
      jump(n) { night = n; startNight(); },
      get s() {
        return { state, night, nightT, nightBest, score, charges, P, flies, mimics, now, U, W, H, group, stats };
      },
    };
  }

  resize();
  populateDemo();
  updateBest();
  updateSoundLabels();
  showScreen("title");
  requestAnimationFrame(loop);
})();
