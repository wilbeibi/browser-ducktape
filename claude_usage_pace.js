// ==UserScript==
// @name         Claude Usage Pace Indicator
// @namespace    https://claude.ai
// @version      1.2
// @description  Shows whether your Claude usage is ahead or behind the week's progress with inline text and a pace marker on the progress bar.
// @match        https://claude.ai/settings/usage
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ── Configuration ──────────────────────────────────────────────────
  const TOLERANCE = 3; // ±% to count as "on pace"
  const POLL_MS = 2000;

  // ── Parse "Resets Thu 3:00 PM" → timePct via absolute day/time ─────
  function weekTimePctAbsolute(text) {
    const m = text.match(
      /Resets?\s+(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i
    );
    if (!m) return null;
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    let hour = parseInt(m[2], 10);
    const ampm = m[4].toUpperCase();
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    const reset = { day: dayMap[m[1]], hour, minute: parseInt(m[3], 10) };
    const now = new Date();
    const nowMins =
      (now.getDay() * 1440 + now.getHours() * 60 + now.getMinutes()) +
      now.getSeconds() / 60;
    const resetMins = reset.day * 1440 + reset.hour * 60 + reset.minute;
    let elapsed = nowMins - resetMins;
    if (elapsed < 0) elapsed += 10080;
    return Math.min(100, Math.max(0, (elapsed / 10080) * 100));
  }

  // ── Parse "Resets in 22 hr 4 min" → timePct via remaining time ─────
  function weekTimePctRelative(text) {
    const m = text.match(/Resets?\s+in\s+(?:(\d+)\s*hr\s*)?(?:(\d+)\s*min)?/i);
    if (!m || (!m[1] && !m[2])) return null;
    const hrs = parseInt(m[1] || '0', 10);
    const mins = parseInt(m[2] || '0', 10);
    const remaining = hrs * 60 + mins;
    const elapsed = 10080 - remaining;
    return Math.min(100, Math.max(0, (elapsed / 10080) * 100));
  }

  function getTimePct(text) {
    return weekTimePctAbsolute(text) ?? weekTimePctRelative(text);
  }

  // ── Pace calculation ───────────────────────────────────────────────
  function pace(usagePct, timePct) {
    const d = usagePct - timePct;
    if (d < -TOLERANCE)
      return { sym: '▼', txt: `${Math.round(-d)}% to spare`, col: '#4ade80' };
    if (d > TOLERANCE)
      return { sym: '▲', txt: `${Math.round(d)}% fast`, col: '#f87171' };
    return { sym: '≈', txt: 'on pace', col: '#60a5fa' };
  }

  // ── Main injection ─────────────────────────────────────────────────
  //
  // DOM structure (from actual page HTML):
  //
  //   <div class="w-full flex flex-row … flex-wrap">        ← ROW
  //     <div class="flex flex-col gap-1.5 …">               ← left col
  //       <div class="flex items-center gap-1.5">
  //         <p class="font-base text-text-100">All models</p>   ← label
  //       </div>
  //       <p class="font-base text-text-400 …">Resets Thu 3:00 PM</p>
  //     </div>
  //     <div class="flex-1 flex items-center gap-3 …">      ← right col
  //       <div class="flex-1 min-w-[200px]">
  //         <div class="w-full bg-bg-000 rounded … h-4 …">  ← bar track
  //           <div class="… bg-accent-secondary-200 …" style="width: 15%;"></div>
  //         </div>
  //       </div>
  //       <p class="… text-text-400 …">15% used</p>
  //     </div>
  //   </div>
  //
  // We find every row that contains both "Resets [Day]" and "% used".

  function inject() {
    // Grab all the flex-row wrappers that hold a usage bar
    const rows = document.querySelectorAll(
      'div.flex.flex-row.flex-wrap'
    );
    let found = 0;

    rows.forEach((row, idx) => {
      const text = row.innerText || '';

      // Must have "X% used" and a parseable reset time
      const usageMatch = text.match(/(\d+)\s*%\s*used/i);
      if (!usageMatch) return;
      const timePct = getTimePct(text);
      if (timePct === null) return;

      // Skip "Current session" row (no day/time anchor, session-scoped)
      const labelP = row.querySelector('p.text-text-100');
      if (labelP && /session/i.test(labelP.textContent)) return;

      const usagePct = parseInt(usageMatch[1], 10);

      const p = pace(usagePct, timePct);
      found++;

      // ── 1. Badge next to the label ─────────────────────────────
      // labelP was already fetched above for the session skip check
      if (labelP) {
        const badgeId = `__pace_badge_${idx}`;
        let badge = document.getElementById(badgeId);
        if (!badge) {
          badge = document.createElement('span');
          badge.id = badgeId;
          badge.style.cssText =
            'margin-left:8px;font-size:0.82em;font-weight:600;vertical-align:middle;white-space:nowrap;';
          labelP.appendChild(badge);
        }
        badge.textContent = `${p.sym} ${p.txt}`;
        badge.style.color = p.col;
      }

      // ── 2. Dashed marker on the bar track ──────────────────────
      // The bar track is: div.bg-bg-000.rounded…h-4
      const barTrack = row.querySelector('div.bg-bg-000');
      if (barTrack) {
        if (getComputedStyle(barTrack).position === 'static') {
          barTrack.style.position = 'relative';
        }

        const markerId = `__pace_marker_${idx}`;
        let marker = document.getElementById(markerId);
        if (!marker) {
          marker = document.createElement('div');
          marker.id = markerId;
          marker.style.cssText = `
            position: absolute;
            top: -3px;
            bottom: -3px;
            width: 0;
            border-left: 2.5px dashed rgba(255,255,255,0.5);
            pointer-events: none;
            z-index: 10;
            transition: left 0.3s ease;
          `;
          barTrack.appendChild(marker);
        }
        marker.style.left = `${timePct}%`;
        marker.title = `Week ${Math.round(timePct)}% elapsed · Usage ${usagePct}%`;
      }
    });

    return found > 0;
  }

  // ── Poll then refresh ──────────────────────────────────────────────
  let attempts = 0;
  function poll() {
    if (inject() || ++attempts >= 30) {
      if (attempts < 30) setInterval(inject, 60_000);
    } else {
      setTimeout(poll, POLL_MS);
    }
  }
  poll();
})();
