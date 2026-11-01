// PC health page: live readings from the PanCafe PC Health agent on each customer PC, and a
// plain-words explanation of every unexpected shutdown, blue screen and hardware error.
// index.html calls PCHealth.init(ctx) once and PCHealth.render() whenever the page is shown.
window.PCHealth = (() => {
  let X = null;                 // helpers from index.html
  let pcs = [], events = [], lastm = [], sessions = [], pclog = [], loadedAt = 0, selected = null, showAll = false, timer = 0;
  const DAY = 86400000, MIN = 60000;
  const ONLINE_MS = 150000;     // the agent reports every 30 s

  // ---------- plain-words knowledge ----------
  // Blue-screen codes seen most often on gaming PCs: what they usually mean and what to try.
  const BUGCHECK = {
    0x124: ["WHEA_UNCORRECTABLE_ERROR", "The processor reported a hardware fault.", "Usually heat, an unstable overclock or XMP memory profile, or a weak power supply. Check CPU cooling, set the BIOS to default speeds, then test another power supply."],
    0x116: ["VIDEO_TDR_FAILURE", "The graphics card stopped responding and could not be restarted.", "Reinstall the graphics driver cleanly, check the GPU temperature and fans, and make sure both GPU power cables are firmly connected."],
    0x117: ["VIDEO_TDR_TIMEOUT", "The graphics card stopped responding.", "Reinstall the graphics driver cleanly, check GPU cooling and its power cables."],
    0x119: ["VIDEO_SCHEDULER_INTERNAL_ERROR", "The graphics driver crashed.", "Reinstall or roll back the graphics driver."],
    0x10e: ["VIDEO_MEMORY_MANAGEMENT_INTERNAL", "The graphics driver crashed.", "Reinstall or roll back the graphics driver."],
    0xea: ["THREAD_STUCK_IN_DEVICE_DRIVER", "The graphics card froze.", "Reinstall the graphics driver, check GPU cooling and power cables."],
    0x1a: ["MEMORY_MANAGEMENT", "Windows found damaged data in memory (RAM).", "Turn off XMP/overclock in the BIOS, reseat the RAM sticks, and test them one at a time (Windows Memory Diagnostic or MemTest86)."],
    0x50: ["PAGE_FAULT_IN_NONPAGED_AREA", "A program or driver read memory that wasn't there; often faulty RAM.", "Test the RAM, and update graphics, network and anti-cheat drivers."],
    0x4e: ["PFN_LIST_CORRUPT", "Memory bookkeeping was damaged; usually faulty RAM.", "Test and reseat the RAM; turn off XMP."],
    0x139: ["KERNEL_SECURITY_CHECK_FAILURE", "A driver corrupted memory; sometimes faulty RAM.", "Update drivers (graphics, network, anti-cheat) and test the RAM."],
    0x3b: ["SYSTEM_SERVICE_EXCEPTION", "A driver crashed.", "Update the graphics driver and Windows; a game's anti-cheat driver can also cause this."],
    0x0a: ["IRQL_NOT_LESS_OR_EQUAL", "A driver crashed.", "Update drivers (network and graphics first) and test the RAM."],
    0xd1: ["DRIVER_IRQL_NOT_LESS_OR_EQUAL", "A driver crashed, often the network or graphics driver.", "Update the network and graphics drivers."],
    0x7e: ["SYSTEM_THREAD_EXCEPTION_NOT_HANDLED", "A driver crashed.", "Update the graphics driver and Windows."],
    0x1e: ["KMODE_EXCEPTION_NOT_HANDLED", "A driver crashed.", "Update drivers and test the RAM."],
    0xc2: ["BAD_POOL_CALLER", "A driver misused memory.", "Update drivers and test the RAM."],
    0x19: ["BAD_POOL_HEADER", "Memory was damaged by a driver or faulty RAM.", "Update drivers and test the RAM."],
    0x133: ["DPC_WATCHDOG_VIOLATION", "A driver, often the SSD/storage driver, hung for too long.", "Update the SSD firmware and storage (chipset) driver; check the drive's health below."],
    0x101: ["CLOCK_WATCHDOG_TIMEOUT", "One processor core stopped responding.", "Remove any CPU overclock, check CPU cooling, update the BIOS."],
    0x7a: ["KERNEL_DATA_INPAGE_ERROR", "Windows couldn't read data back from the drive.", "Check the drive's health and its cable; back up and replace the drive if errors repeat."],
    0x77: ["KERNEL_STACK_INPAGE_ERROR", "Windows couldn't read data back from the drive.", "Check the drive's health and cable."],
    0xf4: ["CRITICAL_OBJECT_TERMINATION", "A core Windows process died, often because the drive stopped responding.", "Check the drive's health and cable."],
    0xef: ["CRITICAL_PROCESS_DIED", "A core Windows process died.", "Run 'sfc /scannow' and check the drive's health."],
    0x9f: ["DRIVER_POWER_STATE_FAILURE", "A driver failed while the PC was sleeping or waking.", "Update drivers, or turn off sleep on cafe PCs."],
    0xc000021a: ["STATUS_SYSTEM_PROCESS_TERMINATED", "A core Windows process died.", "Run 'sfc /scannow'; check the drive."],
  };
  const KIND = {
    unexpected_shutdown: "Turned off without shutting down", dirty_shutdown: "Previous shutdown was unexpected",
    planned_shutdown: "Shut down on purpose", bsod: "Blue screen (Windows crash)",
    whea: "Hardware error, corrected", whea_fatal: "Hardware error, fatal", cpu_throttled: "Processor slowed down by the motherboard",
    gpu_reset: "Graphics driver stopped responding and recovered", gpu_error: "Graphics driver error",
    disk_error: "Drive error", disk_reset: "Drive stopped responding and was reset", low_memory: "Windows ran out of memory",
    app_crash: "Program crashed", app_hang: "Program froze",
  };

  // ---------- helpers ----------
  const t = (d) => new Date(d).getTime();
  const num = (v) => v === null || v === undefined || v === "" ? null : Number(v);
  const deg = (v) => v == null ? "–" : Math.round(v) + "°C";
  const pct = (v) => v == null ? "–" : Math.round(v) + "%";
  const mbps = (v) => v == null ? "–" : (v < 10 ? (Math.round(v * 10) / 10) : Math.round(v)) + "";
  // PanCafe's style: 23.24 Kbps, 7.88 Mbps; 710.67 MB, 3.00 GB
  const spd = (mb) => mb == null ? "–" : mb < 1 ? (mb * 1000).toFixed(2) + " Kbps" : mb.toFixed(2) + " Mbps";
  const spdS = (mb) => mb == null ? "–" : mb < 1 ? Math.round(mb * 1000) + " Kbps" : (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + " Mbps";
  const vol = (b) => b == null ? "–" : b < 1e9 ? (b / 1048576).toFixed(2) + " MB" : (b / 1073741824).toFixed(2) + " GB";
  const ms = (v) => v == null ? "–" : Math.round(v) + " ms";
  const ago = (ms) => ms < 90000 ? "just now" : ms < 3600000 ? Math.round(ms / MIN) + " min ago" : ms < 2 * DAY ? Math.round(ms / 3600000) + " h ago" : Math.round(ms / DAY) + " days ago";
  const dur = (ms) => ms < 3600000 ? Math.round(ms / MIN) + " min" : ms < 2 * DAY ? Math.floor(ms / 3600000) + " h " + Math.round(ms % 3600000 / MIN) + " min" : Math.round(ms / DAY) + " days";
  const when = (d) => { const l = X.local(d); return X.fmtDay(l.toISOString().slice(0, 10), { weekday: "short", month: "short", day: "numeric" }) + " " + X.hhmm(d); };
  const hex = (n) => "0x" + Number(n).toString(16).toUpperCase().padStart(8, "0");
  const nameSort = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const online = (p) => p && X.nowMs() - t(p.last_seen) < ONLINE_MS;
  const appName = (a) => a ? String(a).replace(/\.exe$/i, "") : "";
  function bugcheckOf(e) {
    const d = e.data || {};
    const raw = d.bugcheck || d.BugcheckCode || d.param1 || (String(e.message || "").match(/0x[0-9a-f]{8}/i) || [])[0];
    if (raw == null) return 0;
    const n = /^0x/i.test(raw) ? parseInt(String(raw).slice(0, 10), 16) : parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  }

  // ---------- incidents: one per time a PC went off unexpectedly or blue-screened ----------
  function buildIncidents() {
    const byPc = {};
    for (const e of events) (byPc[e.pc] ||= []).push(e);
    const out = [];
    for (const [pc, list] of Object.entries(byPc)) {
      list.sort((a, b) => t(a.at) - t(b.at));
      const used = new Set();
      const near = (e, kinds, ms) => list.filter((x) => kinds.includes(x.kind) && Math.abs(t(x.at) - t(e.at)) <= ms);
      for (const e of list) {
        if (used.has(e) || !["unexpected_shutdown", "dirty_shutdown", "bsod", "planned_shutdown"].includes(e.kind)) continue;
        if (e.kind === "planned_shutdown") {
          used.add(e);
          const lm = lastm.find((m) => m.pc === pc && Math.abs(t(m.ended_at) - t(e.at)) < 3 * MIN);
          out.push({ pc, kind: "planned", at: e.at, wentOff: e.at, ev: e, lm });
          continue;
        }
        // Kernel-Power 41, EventLog 6008 and the blue-screen record are all written on the next start-up.
        const group = near(e, ["unexpected_shutdown", "dirty_shutdown", "bsod"], 10 * MIN).filter((x) => !used.has(x));
        group.forEach((x) => used.add(x));
        const k41 = group.find((x) => x.kind === "unexpected_shutdown");
        const bs = group.find((x) => x.kind === "bsod");
        const foundAt = t(group[0].at);
        const lm = lastm.find((m) => m.pc === pc && m.next_boot_at && t(m.next_boot_at) <= foundAt + 2 * MIN && foundAt - t(m.next_boot_at) < 20 * MIN);
        let code = bs ? bugcheckOf(bs) : 0;
        if (!code && k41) code = bugcheckOf(k41);
        const button = k41 && Number((k41.data || {}).PowerButtonTimestamp || 0) > 0;
        const wentOff = lm ? lm.ended_at : null;
        out.push({ pc, kind: code ? "bsod" : button ? "button" : "power", at: wentOff || group[0].at, foundAt: group[0].at, wentOff, code, lm, ev: k41 || bs || group[0], events: group });
      }
    }
    // A restart with no Windows record of why (diskless PCs start from a clean image, so Windows can't
    // log the crash or power loss): the black box shows the PC simply stopped, with no normal shutdown.
    const usedLm = new Set(out.map((i) => i.lm).filter(Boolean));
    for (const m of lastm) {
      if (usedLm.has(m) || !m.ended_at) continue;
      const planned = events.some((e) => e.pc === m.pc && e.kind === "planned_shutdown" && Math.abs(t(e.at) - t(m.ended_at)) < 3 * MIN);
      if (planned) continue;
      out.push({ pc: m.pc, kind: "power", at: m.ended_at, foundAt: m.next_boot_at || m.ended_at, wentOff: m.ended_at, code: 0, lm: m, ev: null, events: [], noRecord: true });
    }
    // power cuts that hit several PCs at once
    const power = out.filter((i) => i.kind === "power" && i.wentOff);
    for (const i of power) i.together = power.filter((o) => o !== i && Math.abs(t(o.wentOff) - t(i.wentOff)) < 3 * MIN).map((o) => o.pc);
    for (const i of out) fromPcLog(i);
    for (const i of out) fromPanCafe(i, out);
    for (const i of out) diagnose(i);
    return out.sort((a, b) => t(b.at) - t(a.at));
  }

  // The server turns PCs off when a customer's time ends. Those shutdowns often leave no Windows
  // record, so PanCafe's own sessions decide: a PC that went off quietly, with no customer on it and
  // nothing heavy running, was turned off on purpose.
  // PanCafe logs "off" when a PC's client closes because Windows is shutting down or restarting
  // normally. A crash or power loss never gets one: the PC just shows up again with a new "on".
  // So where PanCafe's log covers the time, it settles diskless shutdowns that Windows didn't record.
  function fromPcLog(i) {
    if (i.kind !== "power" || !i.noRecord || !pclog.length) return;
    const T = t(i.wentOff || i.at), mine = pclog.filter((x) => pcName(x.pc) === i.pc);
    if (!mine.some((x) => Math.abs(t(x.at) - T) < 12 * 3600000)) return;   // log doesn't cover this time
    const off = mine.find((x) => x.event === "off" && Math.abs(t(x.at) - T) <= 2 * MIN);
    if (!off) { i.unclean = true; return; }
    const T2 = t(off.at), ended = sessions.filter((s) => pcName(s.terminal_name) === i.pc && t(s.end_at) <= T2 + MIN && T2 - t(s.end_at) <= 20 * MIN).sort((a, b) => t(b.end_at) - t(a.end_at))[0];
    i.kind = "planned"; i.pancafe = { clean: off.at, end: ended ? ended.end_at : null };
  }

  function fromPanCafe(i, out) {
    if (i.kind !== "power" || i.unclean || !sessions.length) return;       // a held power button stays "forced off"
    const T = t(i.wentOff || i.at), mine = sessions.filter((s) => pcName(s.terminal_name) === i.pc);
    // several PCs went off together and one of them was in use: that is a power cut, not the server
    const group = (i.together || []).map((pc) => out.find((o) => o.pc === pc && o.together && o.together.includes(i.pc))).filter(Boolean);
    if (inUse(i, T) || group.some((o) => inUse(o, t(o.wentOff || o.at)))) return;
    const ended = mine.filter((s) => t(s.end_at) <= T + MIN && T - t(s.end_at) <= 20 * MIN).sort((a, b) => t(b.end_at) - t(a.end_at))[0];
    i.kind = "planned"; i.pancafe = ended ? { end: ended.end_at } : { idle: true };
  }
  const pcName = (n) => { n = String(n || "").trim().toUpperCase(); const m = n.match(/^PC[-_ ]?0*(\d{1,3})$/); return m ? "PC" + m[1].padStart(2, "0") : n; };
  function inUse(i, T) {
    const m = lastMinute(i.lm);
    if (m && m.gpu != null && m.gpu >= 60) return true;       // a game was running
    if (sessions.some((s) => pcName(s.terminal_name) === i.pc && t(s.start_at) < T - MIN && t(s.end_at) > T + MIN)) return true;
    const now = (X.terminals() || []).find((x) => pcName(x.name) === i.pc);
    return !!(now && now.status !== 1 && now.status !== 0 && now.start_at && t(now.start_at) < T - MIN);   // session still open
  }

  // What the black box shows for the last minute before the PC went off.
  function lastMinute(lm) {
    const s = (lm && lm.samples || []).map((x) => ({ t: t(x.t), cpu: num(x.cpu), gpu: num(x.gpu), ram: num(x.ram), ct: num(x.ct), gt: num(x.gt), gw: num(x.gw), app: x.app }));
    if (!s.length) return null;
    const end = s[s.length - 1].t, last = s.filter((x) => end - x.t <= 60000), win2 = s.filter((x) => end - x.t <= 120000);
    const max = (arr, k) => { const v = arr.map((x) => x[k]).filter((x) => x != null); return v.length ? Math.max(...v) : null; };
    const avg = (arr, k) => { const v = arr.map((x) => x[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    return { n: s.length, gpu: avg(last, "gpu"), cpu: avg(last, "cpu"), ram: max(last, "ram"), ct: max(win2, "ct"), gt: max(win2, "gt"), gw: max(last, "gw"), app: appName([...s].reverse().find((x) => x.app)?.app) };
  }
  const before = (i, kinds, ms) => events.filter((e) => e.pc === i.pc && kinds.includes(e.kind) && t(e.at) <= t(i.foundAt || i.at) && t(i.at) - t(e.at) <= ms);

  function diagnose(i) {
    const m = lastMinute(i.lm), ev = [];
    const gaming = m && m.gpu != null && m.gpu >= 60;
    if (m) {
      ev.push(`Last reading${m.app ? " with " + esc(m.app) + " running" : ""}: GPU ${pct(m.gpu)} at ${deg(m.gt)}${m.gw ? ", " + Math.round(m.gw) + " W" : ""} · CPU ${pct(m.cpu)} at ${deg(m.ct)} · RAM ${pct(m.ram)}`);
    }
    const whea = before(i, ["whea", "whea_fatal"], 30 * MIN), gpuR = before(i, ["gpu_reset", "gpu_error"], 30 * MIN),
      thr = before(i, ["cpu_throttled"], 30 * MIN), disk = before(i, ["disk_error", "disk_reset"], 30 * MIN), hang = before(i, ["app_hang"], 10 * MIN);
    if (whea.length) ev.push(`${whea.length} hardware error report${whea.length > 1 ? "s" : ""} in the 30 minutes before`);
    if (gpuR.length) ev.push(`Graphics driver stopped responding ${gpuR.length} time${gpuR.length > 1 ? "s" : ""} in the 30 minutes before`);
    if (thr.length) ev.push("The motherboard was slowing the processor down just before (heat or power limit)");
    if (disk.length) ev.push(`${disk.length} drive error${disk.length > 1 ? "s" : ""} just before`);
    const hot = m && ((m.ct != null && m.ct >= 95) || (m.gt != null && m.gt >= 90));
    let what, cause, advice, level = "bad", conf = "likely";

    if (i.kind === "planned" && i.pancafe && i.pancafe.clean) {
      const game = gaming ? ` while ${m.app ? esc(m.app) : "a game"} was running` : "";
      what = (i.pancafe.end ? "Turned off after use" : "Shut down normally") + game;
      cause = `PanCafe recorded the PC closing normally at ${X.hhmm(i.pancafe.clean)}, so Windows shut down properly (from the PanCafe server, staff or the customer), not a crash.` +
        (i.pancafe.end ? ` The customer's session ended at ${X.hhmm(i.pancafe.end)}.` : "");
      advice = gaming && !i.pancafe.end ? "Not a fault. If a customer says they were kicked off mid-game, check who sent the shut-down." : "Not a fault.";
      level = "ok"; conf = "pancafe";
    } else if (i.kind === "planned" && i.pancafe) {
      what = "Turned off after use";
      cause = i.pancafe.end ? `The customer's PanCafe session ended at ${X.hhmm(i.pancafe.end)} and the PC was turned off soon after, with nothing heavy running.` : "Nobody was using it in PanCafe and nothing heavy was running, so staff or PanCafe most likely turned it off.";
      advice = "Not a fault."; level = "ok"; conf = "pancafe";
    } else if (i.kind === "planned") {
      const d = i.ev.data || {}, proc = String(d.param1 || d.p0 || ""), user = String(d.param7 || d.p6 || ""), reason = String(d.param3 || d.p2 || "");
      const base = proc.split("\\").pop().replace(/\s*\(.*$/, "");
      what = "Shut down on purpose" + (gaming ? ` while ${m.app ? esc(m.app) : "a game"} was running` : "");
      if (/pancafe|pnc|panclient/i.test(proc)) { cause = "PanCafe turned it off: the session time ran out, or staff sent a shut-down from the server."; advice = "Not a fault. If customers say they still had time, compare with the PC's session on the PCs page."; }
      else if (/TrustedInstaller|wuauclt|MoUsoCoreWorker|UsoClient|svchost/i.test(proc) || /update|service pack/i.test(reason)) { cause = "Windows Update restarted it to install updates."; advice = "Set Active hours in Windows Update, or pause updates on cafe PCs, so it doesn't restart during play."; }
      else if (/winlogon|explorer|shutdown\.exe/i.test(proc)) { cause = `Someone chose Shut down or Restart${user && !/SYSTEM/i.test(user) ? " (signed in as " + esc(user.split("\\").pop()) + ")" : ""}.`; advice = "Not a fault."; }
      else { cause = `The program ${esc(base || "unknown")} asked Windows to shut down.`; advice = "Not a hardware fault. Check whether that program should be able to turn PCs off."; }
      level = gaming ? "warn" : "ok"; conf = "certain";
    } else if (i.kind === "bsod") {
      const b = BUGCHECK[i.code] || BUGCHECK[i.code >>> 0];
      what = `Blue screen ${b ? b[0] : ""} (${hex(i.code)})`;
      cause = b ? b[1] : "Windows crashed with an error code that isn't in this guide.";
      advice = b ? b[2] : "Update the graphics driver and Windows, and test the RAM. Search the code online for more.";
      if (hot) { cause += ` It was also running hot (${deg(m.ct)} CPU, ${deg(m.gt)} GPU).`; }
      if (whea.length) cause += " Hardware error reports came just before, which points at hardware rather than software.";
      conf = "certain";
    } else if (i.kind === "button") {
      what = "Power button held down";
      cause = "Someone held the power button to force it off, usually because the PC had frozen.";
      if (gpuR.length || hang.length) cause += gpuR.length ? " The graphics driver had stopped responding just before, so the freeze was most likely the graphics card." : ` ${esc(appName(hang[0].data?.p0) || "A program")} had frozen just before.`;
      advice = gpuR.length ? "Reinstall the graphics driver and check GPU temperature and power cables." : "If it keeps freezing, check the temperatures and events below.";
      level = "warn";
    } else {
      what = (i.noRecord ? "Went off without shutting down" : "Lost power suddenly") + (gaming ? ` during ${m.app ? esc(m.app) : "a game"}` : "");
      if (i.together?.length >= 2) {
        cause = `Power cut or tripped breaker: ${i.together.join(", ")} went off within the same few minutes.`;
        advice = "Check the circuit breaker, outlets and UPS for that row of PCs. Not a fault in this PC."; conf = "very likely";
      } else if (hot) {
        cause = `Overheating: it was at ${m.ct != null && m.ct >= 95 ? "CPU " + deg(m.ct) : "GPU " + deg(m.gt)} just before it went off, so it protected itself by cutting power.`;
        advice = "Clean the dust out, check every fan spins, and replace the CPU thermal paste. Make sure hot air can leave the case.";
      } else if (whea.some((w) => w.kind === "whea_fatal") || whea.length >= 3) {
        cause = "Hardware fault: the processor reported hardware errors right before it went off.";
        advice = "Set the BIOS to default speeds (no overclock or XMP), reseat RAM and the graphics card, and test another power supply.";
      } else if (gaming) {
        cause = `Power supply most likely: the graphics card was working hard (${pct(m.gpu)}${m.gw ? ", " + Math.round(m.gw) + " W" : ""}) and power was cut with no crash or error first. That is the classic sign of a power supply that can't keep up with gaming load.`;
        advice = "Swap in a known-good power supply (same or higher wattage, good brand) for a few days. Also check the GPU power cables and the power strip.";
      } else if (gpuR.length) {
        cause = "Graphics card trouble: the graphics driver had stopped responding before it lost power.";
        advice = "Check GPU power cables, temperature, and reinstall the driver.";
      } else if (m) {
        cause = "Lost power with no warning while not under heavy load: most often a loose power cable, a faulty outlet, power strip or UPS, or a failing power supply.";
        advice = "Reseat the power cable at both ends, try a different outlet, then try another power supply."; conf = "possible";
      } else {
        cause = "Lost power with no warning. There are no readings from just before (the health agent wasn't running yet, or this happened before it was installed).";
        advice = "If it happens again with the agent running, this page will show what the PC was doing."; conf = "unknown";
      }
    }
    if (i.kind !== "planned" && !i.wentOff) ev.push(`Noticed when Windows started again at ${when(i.foundAt)}`);
    if (i.pancafe?.clean) ev.push(`PanCafe log: closed normally at ${when(i.pancafe.clean)}`);
    else if (i.pancafe) ev.push(i.pancafe.end ? `PanCafe session ended at ${when(i.pancafe.end)}` : "No PanCafe session on this PC at the time");
    if (i.unclean) ev.push("PanCafe log: the PC dropped off without closing, which happens with a crash or power loss, not a normal shutdown");
    if (i.noRecord && !i.pancafe) { ev.push(`Started again at ${when(i.foundAt)}`); ev.push("Windows kept no record of why (normal on diskless PCs), so a blue screen can't be ruled out"); }
    Object.assign(i, { what, cause, advice, level, conf, evidence: ev, gaming });
  }

  // ---------- per-PC health right now ----------
  function issuesOf(p, incidents) {
    const out = [], n = p.now || {}, add = (level, text) => out.push({ level, text });
    if (online(p)) {
      const ct = num(n.cpu_temp), gt = num(n.gpu_temp);
      if (ct != null && ct >= 90) add("bad", `CPU very hot: ${deg(ct)}`); else if (ct != null && ct >= 80) add("warn", `CPU running warm: ${deg(ct)}`);
      if (gt != null && gt >= 88) add("bad", `Graphics card very hot: ${deg(gt)}`); else if (gt != null && gt >= 80) add("warn", `Graphics card running warm: ${deg(gt)}`);
      const thr = n.throttle || [];
      if (thr.some((x) => /hot/.test(x))) add("bad", "Graphics card is slowing itself down because it is too hot");
      if (thr.includes("power brake")) add("warn", "Graphics card power brake is on (power supply signal)");
      if (num(n.ram) >= 92) add("warn", `Memory almost full: ${pct(n.ram)}`);
      const net = n.net || {};
      if (net.error) add("warn", "No network connection");
      if (num(net.loss) >= 20) add("bad", `Internet dropping out: ${pct(net.loss)} of pings lost in the last 5 minutes`); else if (num(net.loss) >= 5) add("warn", `Internet unsteady: ${pct(net.loss)} of pings lost in the last 5 minutes`);
      if (num(net.ping) >= 150) add("warn", `Slow internet: ping ${ms(net.ping)}`);
      if (num(net.router_ping) >= 20) add("warn", `Slow link to the router: ${ms(net.router_ping)} (check the cable and switch)`);
      if (num(net.link) > 0 && num(net.link) <= 100) add("warn", `Network card connected at only ${net.link} Mbps: check the cable and switch port`);
    }
    const d = p.disks || {};
    for (const x of d.physical || []) {
      if (x.health && x.health !== "Healthy") add("bad", `Drive ${x.name} reports "${x.health}": back it up and replace it`);
      if (num(x.wear) >= 90) add("bad", `SSD ${x.name} is ${x.wear}% worn out`); else if (num(x.wear) >= 70) add("warn", `SSD ${x.name} is ${x.wear}% worn`);
      if (num(x.read_errors) > 0) add("warn", `Drive ${x.name} has ${x.read_errors} unreadable read${x.read_errors > 1 ? "s" : ""}`);
      if (num(x.temp) >= 60) add("warn", `Drive ${x.name} is hot: ${deg(x.temp)}`);
    }
    if (d.smart_failing > 0) add("bad", "A drive predicts it is about to fail: back it up and replace it");
    for (const v of d.volumes || []) if (v.drive === "C:" && v.free_pct < 8) add("warn", `Drive C: almost full (${v.free_gb} GB free)`);
    const wk = X.nowMs() - 7 * DAY, mine = incidents.filter((i) => i.pc === p.pc && t(i.at) >= wk);
    const off = mine.filter((i) => (i.kind === "power" && !(i.together?.length >= 2)) || i.kind === "button").length, bs = mine.filter((i) => i.kind === "bsod").length;
    if (off) add(off >= 3 ? "bad" : "warn", `${off} unexpected shutdown${off > 1 ? "s" : ""} this week`);
    if (bs) add(bs >= 3 ? "bad" : "warn", `${bs} blue screen${bs > 1 ? "s" : ""} this week`);
    const recent = (k) => events.filter((e) => e.pc === p.pc && k.includes(e.kind) && t(e.at) >= wk).length;
    const gr = recent(["gpu_reset", "gpu_error"]); if (gr) add("warn", `Graphics driver stopped responding ${gr} time${gr > 1 ? "s" : ""} this week`);
    const wh = recent(["whea", "whea_fatal"]); if (wh >= 5) add("warn", `${wh} hardware error reports this week`);
    const de = recent(["disk_error", "disk_reset"]); if (de) add("warn", `${de} drive error${de > 1 ? "s" : ""} this week`);
    return out;
  }
  const worst = (iss) => iss.some((i) => i.level === "bad") ? "bad" : iss.length ? "warn" : "ok";

  // ---------- data ----------
  async function load() {
    const since = new Date(X.nowMs() - 30 * DAY).toISOString();
    if (X.demo) {
      const d = await (await fetch("demo-health.json")).json();
      [pcs, events, lastm, sessions, pclog] = [d.pchealth_pcs || [], d.pchealth_events || [], d.pchealth_lastmoments || [], d.pancafe_sessions || [], d.pancafe_pc_log || []];
    } else {
      [pcs, events, lastm, sessions, pclog] = await Promise.all([
        X.q("pchealth_pcs", (q) => q.select("*")),
        X.q("pchealth_events", (q) => q.select("pc,log,record_id,at,provider,event_id,kind,message,data").gte("at", since).order("at")),
        X.q("pchealth_lastmoments", (q) => q.select("*").gte("ended_at", since).order("ended_at")),
        X.sessionsSince ? X.sessionsSince(since) : X.q("pancafe_sessions", (q) => q.select("id,terminal_name,start_at,end_at").gte("end_at", since).order("id")).catch(() => []),
        X.q("pancafe_pc_log", (q) => q.select("pc,at,event").gte("at", since).order("at")).catch(() => []),
      ]);
    }
    loadedAt = Date.now();
  }
  async function loadSamples(pc) {
    if (X.demo) { const d = await (await fetch("demo-health.json")).json(); return (d.pchealth_samples || []).filter((s) => s.pc === pc); }
    const since = new Date(X.nowMs() - DAY).toISOString();
    return X.q("pchealth_samples", (q) => q.select("at,cpu,gpu,ram,cpu_temp,gpu_temp,gpu_power,app").eq("pc", pc).gte("at", since).order("at"));
  }

  // ---------- render ----------
  const esc = (s) => X.esc(s);
  const LV = { ok: ["OK", "var(--good)", "var(--good-bg)"], warn: ["Check", "var(--warn)", "var(--warn-bg)"], bad: ["Problem", "var(--bad)", "var(--bad-bg)"], off: ["Off", "var(--ink-3)", "var(--surface-2)"], none: ["No agent", "var(--ink-3)", "var(--surface-2)"] };
  const chip = (lv, label) => `<span class="ph-chip" style="color:${LV[lv][1]};background:${LV[lv][2]}">${esc(label || LV[lv][0])}</span>`;

  function render() {
    const root = document.getElementById("healthRoot"); if (!root) return;
    clearInterval(timer);
    timer = setInterval(() => { if (!root.closest("[hidden]")) refresh(); else clearInterval(timer); }, 30000);
    if (!loadedAt || Date.now() - loadedAt > 25000) return refresh();
    draw();
  }
  async function refresh() {
    try { await load(); draw(); }
    catch (err) {
      const msg = /pchealth|relation|schema cache|does not exist/i.test(err.message || "") ? "PC health isn't set up yet: run supabase/pchealth.sql in Supabase, then install the agent on the customer PCs." : "Can't load PC health: " + (err.message || err);
      document.getElementById("healthRoot").innerHTML = `<div class="card"><p class="empty">${esc(msg)}</p></div>`;
    }
  }

  function draw() {
    const root = document.getElementById("healthRoot");
    const incidents = buildIncidents();
    const terms = (X.terminals() || []).map((x) => pcName(x.name));
    const names = [...new Set([...terms, ...pcs.map((p) => p.pc)])].sort(nameSort);
    const byPc = Object.fromEntries(pcs.map((p) => [p.pc, p]));
    const rows = names.map((n) => {
      const p = byPc[n];
      if (!p) return { name: n, lv: "none", iss: [] };
      const iss = issuesOf(p, incidents);
      return { name: n, p, iss, lv: online(p) ? worst(iss) : "off", hw: worst(iss) };
    });
    const reporting = rows.filter((r) => r.p), on = rows.filter((r) => r.p && online(r.p));
    const attention = rows.filter((r) => r.p && r.hw !== "ok");
    const wk = X.nowMs() - 7 * DAY, unexpected = incidents.filter((i) => i.kind !== "planned" && t(i.at) >= wk);
    const hottest = on.map((r) => ({ r, v: Math.max(num(r.p.now?.gpu_temp) ?? -1, num(r.p.now?.cpu_temp) ?? -1) })).sort((a, b) => b.v - a.v)[0];

    const nets = on.map((r) => r.p.now?.net || {});
    const med = (a) => { a = a.filter((v) => v != null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
    const pingMed = med(nets.map((x) => num(x.ping))), testMed = med(nets.map((x) => num(x.test_down)));
    const worstPing = on.map((r) => ({ r, v: num(r.p.now?.net?.ping) })).filter((x) => x.v != null).sort((a, b) => b.v - a.v)[0];
    const kpis = [
      { lbl: "PCs reporting", val: `${on.length}<small> / ${names.length}</small>`, sub: reporting.length < names.length ? `${names.length - reporting.length} without the health agent` : "all PCs have the agent" },
      { lbl: "Need a look", val: attention.length, sub: attention.slice(0, 4).map((r) => r.name).join(", ") || "nothing to fix", lv: attention.some((r) => r.hw === "bad") ? "bad" : attention.length ? "warn" : null },
      { lbl: "Unexpected shutdowns", val: unexpected.length, sub: "last 7 days" + (unexpected.length ? " · " + [...new Set(unexpected.map((i) => i.pc))].sort(nameSort).slice(0, 4).join(", ") : ""), lv: unexpected.length ? "warn" : null },
      { lbl: "Hottest right now", val: hottest && hottest.v >= 0 ? deg(hottest.v) : "–", sub: hottest && hottest.v >= 0 ? hottest.r.name + (appName(hottest.r.p.now?.app) ? " · " + esc(appName(hottest.r.p.now.app)) : "") : "no temperature readings yet" },
      { lbl: "Internet ping", val: pingMed != null ? ms(pingMed) : "–", sub: pingMed == null ? "no network readings yet" : `typical${testMed != null ? ` · download ${mbps(testMed)} Mbps` : ""}${worstPing && worstPing.v >= 2 * pingMed && worstPing.v >= 60 ? ` · worst ${worstPing.r.name} ${ms(worstPing.v)}` : ""}`, lv: pingMed != null && pingMed >= 150 ? "warn" : null },
    ];

    const tile = (r) => {
      if (!r.p) return `<button type="button" class="ph-tile none" data-pc="${esc(r.name)}"><div class="nm">${esc(r.name)}${chip("none")}</div><div class="ph-off">Health agent not installed</div></button>`;
      const n = r.p.now || {}, isOn = online(r.p);
      const body = isOn ? `<div class="ph-rows">
          <span>CPU</span><b>${pct(n.cpu)}</b><b class="${tc(n.cpu_temp, 80, 90)}">${deg(n.cpu_temp)}</b>
          <span>GPU</span><b>${pct(n.gpu)}</b><b class="${tc(n.gpu_temp, 80, 88)}">${deg(n.gpu_temp)}</b>
          <span>RAM</span><b>${pct(n.ram)}</b><b></b>
          ${n.net && !n.net.error ? `<span>UP</span><b class="ph-net" title="Upload speed now">${spdS(num(n.net.up))}</b><b class="${tc(n.net.ping, 100, 150)}" title="Ping to the internet">${n.net.ping_blocked ? "–" : ms(n.net.ping)}</b>
          <span>DOWN</span><b class="ph-net" title="Download speed now">${spdS(num(n.net.down))}</b><b></b>` : ""}</div>
          <div class="ph-ex">${appName(n.app) ? esc(appName(n.app)) + " · " : ""}up ${dur(X.nowMs() - t(r.p.boot_at))}</div>`
        : `<div class="ph-off">Off or not reporting since ${esc(ago(X.nowMs() - t(r.p.last_seen)))}</div>`;
      const issue = r.iss[0] ? `<div class="ph-iss ${r.iss[0].level}">${esc(r.iss[0].text)}${r.iss.length > 1 ? ` <small>+${r.iss.length - 1}</small>` : ""}</div>` : "";
      return `<button type="button" class="ph-tile ${r.lv} ${selected === r.name ? "sel" : ""}" data-pc="${esc(r.name)}"><div class="nm">${esc(r.name)}${chip(r.lv)}</div>${body}${issue}</button>`;
    };

    const list = incidents.filter((i) => showAll || i.kind !== "planned" || i.gaming);
    const plannedHidden = incidents.filter((i) => i.kind === "planned" && !i.gaming).length;
    const incRow = (i) => `<tr class="ph-inc" data-pc="${esc(i.pc)}">
        <td class="mono muted nowrap">${esc(when(i.at))}</td><td><b>${esc(i.pc)}</b></td>
        <td>${chip(i.level === "ok" ? "ok" : i.level, i.kind === "planned" ? "On purpose" : i.kind === "bsod" ? "Crash" : i.kind === "button" ? "Forced off" : i.noRecord ? "Went off" : "Power lost")} ${i.what}</td>
        <td><div>${i.cause}</div><div class="ph-adv">${esc(i.advice)}</div>${i.evidence.length ? `<ul class="ph-evi">${i.evidence.map((x) => `<li>${x}</li>`).join("")}</ul>` : ""}<div class="ph-conf">${esc(confText(i.conf))}</div></td></tr>`;

    root.innerHTML = `
      <div class="kpis" style="--kpi-n:5">${kpis.map((k) => `<div class="card kpi"><div class="lbl">${k.lv ? `<i style="background:${LV[k.lv][1]}"></i>` : ""}${k.lbl}</div><div class="val">${k.val}</div><div class="ph-sub">${k.sub}</div></div>`).join("")}</div>
      <div class="card" style="margin-top:16px">
        <div class="card-h"><h2>Customer PCs right now</h2><span class="sub">tap a PC for details · updates every 30 s</span></div>
        <div class="ph-grid" id="phGrid">${rows.map(tile).join("") || '<div class="empty">No PCs yet.</div>'}</div>
      </div>
      ${patternsHtml(incidents)}
      <div id="phDetail"></div>
      <div class="card" style="margin-top:16px">
        <div class="card-h"><h2>Shutdowns and crashes</h2><span class="sub">last 30 days, newest first</span>
          <label class="right ph-toggle"><input type="checkbox" id="phAll" ${showAll ? "checked" : ""}> show normal shutdowns${plannedHidden && !showAll ? ` (${plannedHidden} hidden)` : ""}</label></div>
        <div class="tbl-wrap"><table class="ph-tbl"><thead><tr><th>When it went off</th><th>PC</th><th>What happened</th><th>Most likely cause and what to do</th></tr></thead>
        <tbody>${list.map(incRow).join("") || `<tr><td colspan="4" class="empty">${pcs.length ? "No unexpected shutdowns or crashes in the last 30 days." : "Nothing yet. Install the health agent on the customer PCs."}</td></tr>`}</tbody></table></div>
      </div>`;
    root.querySelector("#phGrid").onclick = (e) => { const b = e.target.closest("[data-pc]"); if (b) select(b.dataset.pc); };
    root.querySelector("#phAll").onchange = (e) => { showAll = e.target.checked; draw(); };
    root.querySelectorAll(".ph-inc").forEach((tr) => tr.onclick = () => select(tr.dataset.pc));
    if (selected) drawDetail(rows.find((r) => r.name === selected), incidents);
  }
  const tc = (v, w, b) => v == null ? "muted" : v >= b ? "ph-bad" : v >= w ? "ph-warn" : "";
  const confText = (c) => ({ certain: "Windows recorded this directly.", "very likely": "Very likely, from what several PCs recorded.", likely: "Most likely cause, from the readings just before.", possible: "Possible cause; the readings don't point at one part.", unknown: "Not enough readings to tell.", pancafe: "Matched with PanCafe's records." }[c] || "");

  // Repeat offenders: a PC that keeps going off for the same reason.
  function patternsHtml(incidents) {
    const by = {};
    for (const i of incidents.filter((i) => i.kind !== "planned")) (by[i.pc] ||= []).push(i);
    const lines = Object.entries(by).filter(([, l]) => l.length >= 2).sort((a, b) => b[1].length - a[1].length).map(([pc, l]) => {
      const tally = {}; for (const i of l) { const k = i.cause.split(":")[0].split(".")[0]; tally[k] = (tally[k] || 0) + 1; }
      const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
      const g = l.filter((i) => i.gaming).length;
      return `<li><b>${esc(pc)}</b>: went off ${l.length} times in 30 days${g ? `, ${g} of them during a game` : ""}. Most common reason: <b>${esc(top[0])}</b>${top[1] > 1 ? ` (${top[1]} times)` : ""}. ${esc(l.find((i) => i.cause.startsWith(top[0]))?.advice || "")}</li>`;
    });
    const groups = incidents.filter((i) => i.together?.length >= 2);
    if (groups.length) lines.unshift(`<li><b>Power cuts</b>: ${new Set(groups.map((i) => Math.round(t(i.wentOff) / (5 * MIN)))).size} time(s) several PCs lost power together. Check the breaker, outlets and UPS.</li>`);
    if (!lines.length) return "";
    return `<div class="card ph-pat" style="margin-top:16px"><div class="card-h"><h2>What keeps happening</h2><span class="sub">PCs that went off more than once</span></div><ul>${lines.join("")}</ul></div>`;
  }

  function select(pc) {
    selected = selected === pc ? null : pc;
    draw();
    if (selected) document.getElementById("phDetail")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function netHtml(x, on) {
    if (!x) return `<p class="ph-adv">No network readings yet. They come with agent 1.2.0.</p>`;
    if (!on) return `<p class="ph-adv">Not reporting right now.</p>`;
    if (x.error) return `<p class="ph-adv">No network connection.</p>`;
    const rows = [["Internet ping", x.ping_blocked ? "no answer (ping may be blocked)" : `${ms(x.ping)}${x.loss != null ? ` · ${pct(x.loss)} lost in the last 5 min` : ""}`],
      ["Router ping", x.router_ping != null ? ms(x.router_ping) : "no answer"],
      ["Upload speed", spd(num(x.up))], ["Download speed", spd(num(x.down))],
      ["Total UL / DL", `${vol(num(x.total_up))} / ${vol(num(x.total_down))} since the PC started`],
      ...(x.test_down != null || x.test_error ? [["Speed test", x.test_down != null ? `${mbps(x.test_down)} Mbps download · ${ago(X.nowMs() - t(x.test_at))}` : "failed: " + x.test_error]] : []),
      ["Network card", `${x.adapter || ""}${x.link ? ` · connected at ${x.link >= 1000 ? x.link / 1000 + " Gbps" : x.link + " Mbps"}` : ""}`]];
    return `<dl class="ph-dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl><p class="ph-adv">On diskless PCs the speeds and totals include Windows loading from the server.</p>`;
  }

  async function drawDetail(r, incidents) {
    const el = document.getElementById("phDetail"); if (!el || !r) return;
    if (!r.p) {
      el.innerHTML = `<div class="card" style="margin-top:16px"><div class="card-h"><h2>${esc(r.name)}</h2></div><p class="ph-adv">This PC hasn't sent any health readings. Copy the PCHealth-Setup folder to it and run INSTALL.bat (it asks which PanCafe PC it is: type ${esc(r.name)}).</p></div>`;
      return;
    }
    const p = r.p, i = p.info || {}, n = p.now || {}, d = p.disks || {};
    const evs = events.filter((e) => e.pc === p.pc && !["planned_shutdown"].includes(e.kind)).slice(-40).reverse();
    const hw = [["Processor", i.cpu], ["Graphics", i.gpu && `${i.gpu}${i.vram_gb ? ` (${i.vram_gb} GB)` : ""}${i.gpu_driver ? ` · driver ${i.gpu_driver}` : ""}`], ["Memory", i.ram_gb && `${i.ram_gb} GB${i.ram_sticks?.length ? " · " + i.ram_sticks.join(", ") : ""}`],
      ["Motherboard", i.board && `${i.board}${i.bios ? " · BIOS " + i.bios : ""}`], ["Windows", i.os], ["Running since", p.boot_at && `${when(p.boot_at)} (${dur(X.nowMs() - t(p.boot_at))})`],
      ["Sensors", tempSrc(i.temp_source || n.temp_source, i.gpu_sensor)], ["Agent", `${p.version || ""} · ${p.host || ""} · last report ${ago(X.nowMs() - t(p.last_seen))}`]].filter((x) => x[1]);
    el.innerHTML = `<div class="card" style="margin-top:16px">
      <div class="card-h"><h2>${esc(p.pc)}</h2>${chip(r.lv)}<span class="sub">${online(p) ? `now: CPU ${pct(n.cpu)} ${deg(n.cpu_temp)} · GPU ${pct(n.gpu)} ${deg(n.gpu_temp)}${n.gpu_power ? " " + Math.round(n.gpu_power) + " W" : ""}${n.fan != null ? " · GPU fan " + pct(n.fan) : ""} · RAM ${pct(n.ram)}` : "not reporting"}</span>
        <button type="button" class="right ph-close" id="phClose">Close</button></div>
      ${r.iss.length ? `<ul class="ph-issues">${r.iss.map((x) => `<li class="${x.level}">${esc(x.text)}</li>`).join("")}</ul>` : `<p class="ph-adv">No problems found right now.</p>`}
      <div class="grid" style="margin-top:12px">
        <div class="c6"><h3 class="ph-h3">Temperature, last 24 hours</h3><div class="chart-box"><canvas id="phTemp"></canvas></div></div>
        <div class="c6"><h3 class="ph-h3">Load, last 24 hours</h3><div class="chart-box"><canvas id="phLoad"></canvas></div></div>
        <div class="c6"><h3 class="ph-h3">Hardware</h3><dl class="ph-dl">${hw.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl></div>
        <div class="c6"><h3 class="ph-h3">Drives</h3>${disksHtml(d)}</div>
        <div class="c6"><h3 class="ph-h3">Network</h3>${netHtml(n.net, online(p))}</div>
        <div class="c12"><h3 class="ph-h3">Windows log, last 30 days</h3><div class="tbl-wrap ph-log"><table><tbody>${evs.map((e) => `<tr><td class="mono muted nowrap">${esc(when(e.at))}</td><td>${esc(eventText(e))}</td></tr>`).join("") || '<tr><td class="empty">Nothing unusual recorded.</td></tr>'}</tbody></table></div></div>
      </div></div>`;
    document.getElementById("phClose").onclick = () => select(p.pc);
    const s = await loadSamples(p.pc);
    if (selected !== p.pc) return;
    const labels = s.map((x) => X.hhmm(x.at));
    const line = (label, data, color, dash) => ({ type: "line", label, data, borderColor: color, backgroundColor: color, borderWidth: 1.6, pointRadius: 0, tension: 0.25, spanGaps: 3, borderDash: dash ? [4, 3] : undefined });
    const opts = (unit, max) => {
      const o = X.baseOpts();
      return X.baseOpts({ plugins: { legend: { display: true, labels: { color: X.css("--ink-2"), boxWidth: 10, boxHeight: 10, font: { family: "IBM Plex Sans", size: 11 } } },
          tooltip: { ...o.plugins.tooltip, callbacks: { label: (c) => ` ${c.dataset.label}: ${c.parsed.y == null ? "–" : Math.round(c.parsed.y) + unit}`, afterBody: (c) => s[c[0].dataIndex]?.app ? "Running: " + appName(s[c[0].dataIndex].app) : "" } } },
        scales: { x: { ...o.scales.x, stacked: false, ticks: { ...o.scales.x.ticks, maxTicksLimit: 8 } }, y: { ...o.scales.y, stacked: false, beginAtZero: unit === "%", max, ticks: { ...o.scales.y.ticks, callback: (v) => v + unit } } } });
    };
    if (!s.some((x) => x.cpu_temp != null || x.gpu_temp != null)) {
      const box = document.getElementById("phTemp")?.parentElement, i = p.info || {};
      if (box) box.outerHTML = `<p class="ph-adv">This PC isn't sending temperatures.
        ${i.gpu_sensor ? "" : "GPU: the agent couldn't find NVIDIA's nvidia-smi tool (it comes with the NVIDIA driver; agent 1.2.1 also looks in the driver store). AMD and Intel graphics aren't read yet."}
        CPU: Windows has no built-in CPU temperature sensor, so this only works where the motherboard reports one or Core Temp (or LibreHardwareMonitor) is running. PanCafe shows N/A for CPU temperature too.</p>`;
    } else X.chart("phTemp", { data: { labels, datasets: [line("CPU °C", s.map((x) => x.cpu_temp), X.css("--s2")), line("GPU °C", s.map((x) => x.gpu_temp), X.css("--s1"))] }, options: opts("°", undefined) });
    X.chart("phLoad", { data: { labels, datasets: [line("CPU", s.map((x) => x.cpu), X.css("--s2")), line("GPU", s.map((x) => x.gpu), X.css("--s1")), line("RAM", s.map((x) => x.ram), X.css("--s5"), true)] }, options: opts("%", 100) });
  }
  const tempSrc = (src, gpu) => [src === "LibreHardwareMonitor" || src === "OpenHardwareMonitor" ? "CPU temperature from " + src : src === "coretemp" ? "CPU temperature from Core Temp" : src === "acpi" ? "CPU temperature from the motherboard (approximate)" : "No CPU temperature sensor (run Core Temp to add one)", gpu ? "GPU from " + gpu : ""].filter(Boolean).join(" · ");
  function disksHtml(d) {
    const ph = d.physical || [], vol = d.volumes || [];
    if (!ph.length && !vol.length) return '<p class="ph-adv">No drive readings yet.</p>';
    return `<table class="ph-mini"><tbody>${ph.map((x) => `<tr><td><b>${esc(x.name)}</b><br><span class="muted">${esc([x.media, x.bus, x.size_gb && x.size_gb + " GB"].filter((v) => v && v !== "Unspecified").join(" · "))}</span></td>
      <td>${chip(x.health === "Healthy" ? "ok" : x.health ? "bad" : "off", x.health || "unknown")}</td>
      <td class="r muted">${[x.temp != null && deg(x.temp), x.wear != null && x.wear + "% worn", x.hours != null && Math.round(x.hours / 24) + " days on"].filter(Boolean).join("<br>")}</td></tr>`).join("")}
      ${vol.map((v) => `<tr><td>${esc(v.drive)}</td><td colspan="2" class="r muted">${v.free_gb} GB free of ${v.size_gb} GB (${v.free_pct}%)</td></tr>`).join("")}</tbody></table>`;
  }
  function eventText(e) {
    const d = e.data || {};
    const base = KIND[e.kind] || e.provider + " " + e.event_id;
    if (e.kind === "app_crash" || e.kind === "app_hang") return `${base}: ${appName(d.p0 || d.AppName) || "unknown"}`;
    if (e.kind === "bsod") { const c = bugcheckOf(e); return `${base}: ${(BUGCHECK[c] || [hex(c)])[0]}`; }
    if (e.kind === "unexpected_shutdown") { const c = bugcheckOf(e); return base + (c ? ` (blue screen ${hex(c)})` : Number(d.PowerButtonTimestamp) > 0 ? " (power button held)" : " (power lost)"); }
    if (e.kind === "planned_shutdown") return `${base} by ${String(d.param1 || d.p0 || "").split("\\").pop()}`;
    return base;
  }

  // ---------- styles ----------
  const style = document.createElement("style");
  style.textContent = `
    .ph-sub { font-size: 12px; color: var(--ink-3); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .kpi .val small { font-size: 16px; color: var(--ink-3); font-weight: 500; }
    .ph-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
    .ph-tile { text-align: left; cursor: pointer; border-radius: 10px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--good); display: flex; flex-direction: column; gap: 4px; min-width: 0; min-height: 112px; }
    .ph-tile:hover { border-color: var(--line-2); }
    .ph-tile.sel { outline: 2px solid var(--accent); outline-offset: 1px; }
    .ph-tile.warn { border-left-color: var(--warn); } .ph-tile.bad { border-left-color: var(--bad); }
    .ph-tile.off, .ph-tile.none { background: var(--surface-2); border-left-color: var(--line-2); }
    .ph-tile.none { border-style: dashed; border-left-style: solid; }
    .ph-tile .nm { display: flex; justify-content: space-between; align-items: center; font: 700 15px var(--f-body); }
    .ph-chip { font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; padding: 2px 6px; border-radius: 4px; white-space: nowrap; }
    .ph-rows { display: grid; grid-template-columns: auto 1fr auto; gap: 0 10px; font-size: 12px; align-items: baseline; }
    .ph-rows span { color: var(--ink-3); font-weight: 600; font-size: 11px; }
    .ph-rows b { font: 600 14px var(--f-num); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
    .ph-rows b.ph-net { font-size: 12px; white-space: nowrap; }
    .ph-warn { color: var(--warn); } .ph-bad { color: var(--bad); }
    .ph-ex, .ph-off { font-size: 11px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ph-off { margin-top: auto; white-space: normal; }
    .ph-iss { font-size: 11px; font-weight: 600; margin-top: auto; line-height: 1.3; }
    .ph-iss.warn { color: var(--warn); } .ph-iss.bad { color: var(--bad); }
    .ph-iss small { color: var(--ink-3); font-weight: 500; }
    .ph-tbl td { vertical-align: top; } .ph-inc { cursor: pointer; } .nowrap { white-space: nowrap; }
    .ph-adv { color: var(--ink-2); margin: 4px 0 0; font-size: 13px; }
    .ph-evi { margin: 6px 0 0; padding-left: 18px; font-size: 12px; color: var(--ink-3); }
    .ph-conf { font-size: 11px; color: var(--ink-3); margin-top: 4px; font-style: italic; }
    .ph-toggle { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
    .ph-pat ul, .ph-issues { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
    .ph-issues li.bad { color: var(--bad); } .ph-issues li.warn { color: var(--warn); }
    .ph-h3 { font: 600 13px var(--f-body); color: var(--ink-2); margin: 4px 0 8px; }
    .ph-dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; font-size: 13px; }
    .ph-dl dt { color: var(--ink-3); } .ph-dl dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .ph-mini { width: 100%; font-size: 12px; } .ph-mini td { padding: 6px 4px; border-bottom: 1px solid var(--line); vertical-align: top; }
    .ph-log { max-height: 320px; overflow: auto; } .ph-log td:first-child, .ph-tbl td:first-child { width: 1%; }
    .ph-close { border: 1px solid var(--line); background: var(--surface-2); border-radius: 8px; padding: 3px 10px; cursor: pointer; font-size: 12px; }
    #healthRoot .c6 { grid-column: span 6; } #healthRoot .c12 { grid-column: span 12; } #healthRoot .c6, #healthRoot .c12 { min-width: 0; }
    @media (max-width: 1000px) { #healthRoot .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } #healthRoot .c6 { grid-column: span 12; } }
    @media (max-width: 560px) { .ph-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; } .ph-tbl thead { display: none; } .ph-tbl tr { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; padding: 8px 0; border-bottom: 1px solid var(--line); } .ph-tbl td { border: 0; padding: 0; } .ph-tbl td:nth-child(n+3) { grid-column: 1 / -1; } }
  `;
  document.head.appendChild(style);

  return { init: (ctx) => { X = ctx; }, render, _test: { buildIncidents, set: (p, e, l) => { pcs = p; events = e; lastm = l; } } };
})();
