// ==UserScript==
// @name         Video Watch Confirmation
// @version      2.1
// @description  Adds an intentionality pause before work-hours video watching on YouTube and Bilibili, with watch-later substitution, escalating friction, self-monitoring stats, and a timebox check-in.
// @author       wilbeibi
// @namespace    https://github.com/wilbeibi/browser-ducktape
// @license      MIT
// @homepageURL  https://github.com/wilbeibi/browser-ducktape
// @supportURL   https://github.com/wilbeibi/browser-ducktape/issues
// @downloadURL  https://raw.githubusercontent.com/wilbeibi/browser-ducktape/main/worth_watching.user.js
// @updateURL    https://raw.githubusercontent.com/wilbeibi/browser-ducktape/main/worth_watching.user.js
// @match        https://www.youtube.com/*
// @match        https://youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://www.bilibili.com/video/*
// @match        https://bilibili.com/video/*
// @match        https://m.bilibili.com/video/*
// @grant        window.close
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const MIN_INTENTION_CHARS = 8;
    // Where "Leave" sends you — anywhere but the recommendation feed
    const LEAVE_URL = 'about:blank';
    // Countdown escalates with each video continued today; index = videos already watched
    const COUNTDOWN_STEPS = [5, 10, 20];
    const COUNTDOWN_MAX = 30;
    const DEFAULT_TIMEBOX_MINUTES = 15;
    const SNOOZE_MINUTES = 5;
    const LOG_KEY = 'vc:log';
    const WATCH_LATER_KEY = 'vc:watchLater';
    const LOG_LIMIT = 50;

    const PROMPTS = [
        'What job is this video helping you finish?',
        'What will be different after watching this?',
        'What is the next task this video supports?',
        'What question are you trying to answer?',
        'What would make this worth the time?',
        'How will you know when you have enough?',
        'What were you doing before this opened?',
        'If you watch, what is the timebox?',
        'Is this planned learning or a pleasant detour?',
        'What would future-you want you to do here?',
        'What is the smallest useful part to watch?',
    ];

    const isWithinWorkingHours = () => {
        const WORK_START_MINUTES = 9 * 60;
        const WORK_END_MINUTES = 18 * 60;
        const now = new Date();
        const day = now.getDay();
        if (day === 0 || day === 6) return false;
        const minutes = now.getHours() * 60 + now.getMinutes();
        return minutes >= WORK_START_MINUTES && minutes < WORK_END_MINUTES;
    };

    const isVideoPage = () => {
        const href = window.location.href;
        return /youtube\.com\/watch/.test(href) || /bilibili\.com\/video\//.test(href);
    };

    // Key by video ID so timestamp/playlist param changes don't re-trigger
    const videoKey = () => {
        const href = window.location.href;
        const yt = href.match(/[?&]v=([\w-]+)/);
        if (yt) return 'yt:' + yt[1];
        const bili = href.match(/bilibili\.com\/video\/((?:BV|av)\w+)/i);
        if (bili) return 'bili:' + bili[1];
        return href;
    };

    const isConfirmed = () =>
        sessionStorage.getItem('videoConfirmed:' + videoKey()) === '1';

    const markConfirmed = () =>
        sessionStorage.setItem('videoConfirmed:' + videoKey(), '1');

    // --- Decision log (self-monitoring) ---

    const readJSON = (storage, key, fallback) => {
        try {
            const parsed = JSON.parse(storage.getItem(key));
            return parsed === null || parsed === undefined ? fallback : parsed;
        } catch {
            return fallback;
        }
    };

    const writeJSON = (storage, key, value) =>
        storage.setItem(key, JSON.stringify(value));

    const readLog = () => readJSON(localStorage, LOG_KEY, []);

    // action: 'watched' | 'left' | 'saved' | 'done'
    const logDecision = (action, intention) => {
        const log = readLog();
        log.push({ t: Date.now(), key: videoKey(), action, intention: intention || '' });
        writeJSON(localStorage, LOG_KEY, log.slice(-LOG_LIMIT));
    };

    const isSameLocalDay = (ts) => {
        const a = new Date(ts);
        const b = new Date();
        return a.getFullYear() === b.getFullYear() &&
               a.getMonth() === b.getMonth() &&
               a.getDate() === b.getDate();
    };

    const todayStats = () => {
        const log = readLog();
        const today = log.filter(e => isSameLocalDay(e.t));
        const watchedToday = today.filter(e => e.action === 'watched').length;
        const recent = log.slice(-3);
        const recentLeft = recent.filter(e => e.action !== 'watched').length;
        let leaveStreak = 0;
        for (let i = log.length - 1; i >= 0; i--) {
            if (log[i].action === 'watched') break;
            leaveStreak++;
        }
        return { promptNumber: today.length + 1, watchedToday, recent, recentLeft, leaveStreak };
    };

    const countdownFor = (watchedToday) =>
        COUNTDOWN_STEPS[watchedToday] !== undefined ? COUNTDOWN_STEPS[watchedToday] : COUNTDOWN_MAX;

    // Reject copy-paste / keyboard-mash intentions: must differ from the last
    // few entries and contain some variety
    const normalizeIntention = (s) =>
        (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

    const intentionProblem = (text) => {
        if (text.trim().length < MIN_INTENTION_CHARS) return 'too-short';
        const normalized = normalizeIntention(text);
        if (new Set(normalized).size < 3) return 'low-effort';
        const recent = readLog().slice(-5).map(e => normalizeIntention(e.intention));
        if (recent.includes(normalized)) return 'repeated';
        return null;
    };

    // Pull a stated timebox out of the intention text ("watch 10 min for...").
    // Require an explicit unit: a bare number is almost always incidental
    // ("reviewing 3 PRs"), and reading it as a 3-minute timebox is worse than
    // falling back to the default.
    const timeboxMinutes = (intention) => {
        const m = (intention || '').match(/(\d+)\s*(?:m\b|min\b|mins\b|minutes?\b|分钟|分)/i);
        if (!m) return DEFAULT_TIMEBOX_MINUTES;
        return Math.min(60, Math.max(5, parseInt(m[1], 10)));
    };

    const checkinKey = () => 'vc:checkin:' + videoKey();

    const saveForLater = (intention) => {
        const list = readJSON(localStorage, WATCH_LATER_KEY, []);
        if (!list.some(e => e.url === window.location.href)) {
            list.push({ url: window.location.href, title: document.title, intention: intention || '', t: Date.now() });
            writeJSON(localStorage, WATCH_LATER_KEY, list);
        }
    };

    const leavePage = () => {
        try {
            window.location.replace(LEAVE_URL);
        } catch {
            if (window.history.length > 1) window.history.back();
            else window.close();
        }
    };

    let activeOverlay = null;
    let playBlocker = null;
    let countdownTimer = null;
    let visibilityHandler = null;
    let bodyObserver = null;
    let checkinTimer = null;

    function cleanup() {
        if (activeOverlay) { activeOverlay.remove(); activeOverlay = null; }
        const style = document.getElementById('video-confirm-style');
        if (style) style.remove();
        if (playBlocker) { document.removeEventListener('play', playBlocker, true); playBlocker = null; }
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        if (visibilityHandler) { document.removeEventListener('visibilitychange', visibilityHandler); visibilityHandler = null; }
        if (bodyObserver) { bodyObserver.disconnect(); bodyObserver = null; }
    }

    function clearCheckinTimer() {
        if (checkinTimer) { clearTimeout(checkinTimer); checkinTimer = null; }
    }

    function injectStyle() {
        if (document.getElementById('video-confirm-style')) return;
        // GM_addStyle is mediated by the manager and so is not subject to the page's
        // style-src CSP; a hand-appended <style> is. Keep the manual path as a fallback
        // for managers that do not expose it. cleanup() finds this node by id either way.
        const style = document.createElement('style');
        style.id = 'video-confirm-style';
        style.textContent = `
            body > *:not(#video-confirm-overlay) {
                filter: blur(8px);
                transition: filter 0.3s ease-in-out;
            }
            #video-confirm-overlay {
                position: fixed;
                inset: 0;
                z-index: 999999;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
                background: rgba(14, 16, 20, 0.52);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                box-sizing: border-box;
            }
            #video-confirm-overlay * {
                box-sizing: border-box;
            }
            .vc-dialog {
                width: min(440px, 100%);
                padding: 28px;
                border: 1px solid rgba(15, 23, 42, 0.08);
                border-radius: 10px;
                background: #fff;
                color: #1f2937;
                box-shadow: 0 18px 60px rgba(0, 0, 0, 0.28);
                animation: slideIn 0.24s ease-out;
            }
            .vc-kicker {
                margin: 0 0 8px;
                color: #6b7280;
                font-size: 12px;
                font-weight: 700;
                letter-spacing: 0.08em;
                text-transform: uppercase;
            }
            .vc-question {
                margin: 0 0 10px;
                color: #111827;
                font-size: 22px;
                font-weight: 650;
                line-height: 1.3;
            }
            .vc-helper {
                margin: 0 0 12px;
                color: #4b5563;
                font-size: 14px;
                line-height: 1.5;
            }
            .vc-stats {
                margin: 0 0 18px;
                color: #6b7280;
                font-size: 13px;
                line-height: 1.5;
            }
            .vc-stats strong {
                color: #166534;
                font-weight: 650;
            }
            .vc-label {
                display: block;
                margin-bottom: 6px;
                color: #374151;
                font-size: 13px;
                font-weight: 600;
            }
            .vc-input {
                width: 100%;
                min-height: 72px;
                margin-bottom: 6px;
                padding: 10px 12px;
                resize: vertical;
                border: 1px solid #d1d5db;
                border-radius: 8px;
                color: #111827;
                font: inherit;
                line-height: 1.4;
            }
            .vc-input:focus {
                border-color: #2563eb;
                box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14);
                outline: none;
            }
            .vc-input-hint {
                min-height: 18px;
                margin: 0 0 10px;
                color: #b91c1c;
                font-size: 12px;
                line-height: 1.4;
            }
            .vc-countdown-track {
                width: 100%;
                height: 6px;
                margin-bottom: 18px;
                overflow: hidden;
                border-radius: 999px;
                background: #e5e7eb;
            }
            .vc-countdown-fill {
                height: 100%;
                width: 100%;
                background: #f59e0b;
                transition: width 1s linear;
            }
            .vc-actions {
                display: flex;
                gap: 10px;
                justify-content: flex-end;
                flex-wrap: wrap;
            }
            .vc-button {
                min-width: 132px;
                padding: 10px 16px;
                border-radius: 8px;
                border: 1px solid transparent;
                font-size: 15px;
                font-weight: 650;
                cursor: pointer;
                transition: background 0.16s, border-color 0.16s, color 0.16s, opacity 0.16s;
            }
            .vc-leave {
                background: #166534;
                color: #fff;
            }
            .vc-leave:hover {
                background: #14532d;
            }
            .vc-save {
                background: #fffbeb;
                border-color: #f59e0b;
                color: #92400e;
            }
            .vc-save:hover {
                background: #fef3c7;
            }
            .vc-continue {
                background: #fff;
                border-color: #d1d5db;
                color: #374151;
            }
            .vc-continue:not(:disabled):hover {
                background: #f9fafb;
                border-color: #9ca3af;
            }
            .vc-continue:disabled {
                opacity: 0.48;
                cursor: not-allowed;
            }
            @keyframes slideIn {
                from { transform: translateY(-20px); opacity: 0; }
                to   { transform: translateY(0);     opacity: 1; }
            }
            .vc-list {
                margin: 0 0 16px;
                padding: 0;
                list-style: none;
                max-height: 45vh;
                overflow-y: auto;
            }
            .vc-list li {
                display: flex;
                align-items: baseline;
                gap: 8px;
                padding: 8px 0;
                border-bottom: 1px solid #e5e7eb;
            }
            .vc-list .vc-item-main { flex: 1; min-width: 0; }
            .vc-list a {
                color: #1d4ed8;
                font-size: 14px;
                font-weight: 600;
                text-decoration: none;
                overflow-wrap: anywhere;
            }
            .vc-list a:hover { text-decoration: underline; }
            .vc-why {
                margin: 2px 0 0;
                color: #6b7280;
                font-size: 12px;
            }
            .vc-remove {
                border: none;
                background: none;
                color: #9ca3af;
                font-size: 14px;
                cursor: pointer;
                padding: 2px 6px;
            }
            .vc-remove:hover { color: #b91c1c; }
            @media (max-width: 480px) {
                .vc-dialog {
                    padding: 22px;
                }
                .vc-actions {
                    flex-direction: column;
                }
                .vc-button {
                    width: 100%;
                }
            }
        `;
        if (typeof GM_addStyle === 'function') {
            const node = GM_addStyle(style.textContent);
            if (node && node.nodeType === 1) { node.id = 'video-confirm-style'; return; }
        }
        (document.head || document.documentElement).appendChild(style);
    }

    function mountOverlay(overlay) {
        activeOverlay = overlay;
        if (document.body) {
            document.body.appendChild(overlay);
        } else {
            bodyObserver = new MutationObserver(() => {
                if (document.body) {
                    document.body.appendChild(overlay);
                    bodyObserver.disconnect();
                    bodyObserver = null;
                }
            });
            bodyObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
    }

    function showConfirmation() {
        // Block video playback via capture-phase listener
        playBlocker = (e) => {
            if (e.target && typeof e.target.pause === 'function') {
                e.target.pause();
                e.target.currentTime = 0;
            }
        };
        document.addEventListener('play', playBlocker, true);
        // Pause anything already playing
        document.querySelectorAll('video').forEach(v => { v.pause(); v.currentTime = 0; });

        injectStyle();

        const stats = todayStats();
        const countdownSeconds = countdownFor(stats.watchedToday);

        // Overlay
        const overlay = document.createElement('div');
        overlay.id = 'video-confirm-overlay';

        // Dialog
        const dialog = document.createElement('div');
        dialog.className = 'vc-dialog';

        const kicker = document.createElement('p');
        kicker.className = 'vc-kicker';
        kicker.textContent = 'Intentional pause';

        const question = document.createElement('h2');
        question.className = 'vc-question';
        question.textContent = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];

        const helper = document.createElement('p');
        helper.className = 'vc-helper';
        helper.textContent = 'Leave, save it for tonight, or name the concrete reason for continuing.';

        const statsLine = document.createElement('p');
        statsLine.className = 'vc-stats';
        const parts = [`Work-hours video #${stats.promptNumber} today`];
        if (stats.recent.length > 0) {
            parts.push(`walked away from ${stats.recentLeft} of the last ${stats.recent.length}`);
        }
        statsLine.textContent = parts.join(' · ');
        if (stats.leaveStreak >= 2) {
            const streak = document.createElement('strong');
            streak.textContent = ` You've left ${stats.leaveStreak} in a row.`;
            statsLine.appendChild(streak);
        }
        if (stats.watchedToday > 0) {
            statsLine.appendChild(document.createTextNode(
                ` The pause grows with each video (now ${countdownSeconds}s).`));
        }

        const intentionLabel = document.createElement('label');
        intentionLabel.className = 'vc-label';
        intentionLabel.htmlFor = 'video-confirm-intention';
        intentionLabel.textContent = 'I am watching this to...';

        const intentionInput = document.createElement('textarea');
        intentionInput.id = 'video-confirm-intention';
        intentionInput.className = 'vc-input';
        intentionInput.autocomplete = 'off';
        intentionInput.placeholder = 'finish a task, answer a question... include minutes (e.g. "10 min") to set your timebox';

        const inputHint = document.createElement('p');
        inputHint.className = 'vc-input-hint';

        // Buttons
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'vc-actions';

        const leaveButton = document.createElement('button');
        leaveButton.type = 'button';
        leaveButton.className = 'vc-button vc-leave';
        leaveButton.textContent = 'Leave now';

        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.className = 'vc-button vc-save';
        saveButton.textContent = 'Save for tonight';

        const continueButton = document.createElement('button');
        continueButton.type = 'button';
        continueButton.className = 'vc-button vc-continue';
        continueButton.disabled = true;

        // Countdown bar — hidden until the intention is valid, so the wait
        // can't run in parallel with the typing
        const countdownTrack = document.createElement('div');
        countdownTrack.className = 'vc-countdown-track';
        countdownTrack.style.display = 'none';
        const countdownFill = document.createElement('div');
        countdownFill.className = 'vc-countdown-fill';
        countdownTrack.appendChild(countdownFill);

        let remaining = countdownSeconds;
        let countdownStarted = false;

        const updateContinueState = () => {
            const problem = intentionProblem(intentionInput.value);
            inputHint.textContent =
                problem === 'repeated'  ? 'You’ve used this reason before — be specific to this video.' :
                problem === 'low-effort' ? 'That doesn’t look like a real reason.' : '';

            if (!countdownStarted) {
                if (problem === null) {
                    countdownStarted = true;
                    countdownTrack.style.display = '';
                    countdownTimer = setInterval(tick, 1000);
                } else {
                    continueButton.disabled = true;
                    continueButton.textContent = 'Continue';
                    return;
                }
            }
            continueButton.disabled = !(remaining <= 0 && problem === null);
            continueButton.textContent = remaining > 0 ? `Continue (${remaining})` : 'Continue intentionally';
        };

        const tick = () => {
            if (document.hidden) return;
            remaining -= 1;
            if (remaining > 0) {
                countdownFill.style.width = `${(remaining / countdownSeconds) * 100}%`;
                updateContinueState();
                return;
            }
            clearInterval(countdownTimer);
            countdownTimer = null;
            remaining = 0;
            countdownTrack.style.display = 'none';
            updateContinueState();
        };
        // Switching away resets the timer — no waiting it out in another tab
        visibilityHandler = () => {
            if (!document.hidden && countdownTimer) {
                remaining = countdownSeconds;
                countdownFill.style.width = '100%';
                updateContinueState();
            }
        };
        document.addEventListener('visibilitychange', visibilityHandler);
        intentionInput.addEventListener('input', updateContinueState);
        updateContinueState();

        leaveButton.onclick = () => {
            logDecision('left', intentionInput.value.trim());
            cleanup();
            leavePage();
        };
        saveButton.onclick = () => {
            saveForLater(intentionInput.value.trim());
            logDecision('saved', intentionInput.value.trim());
            cleanup();
            leavePage();
        };
        continueButton.onclick = () => {
            if (continueButton.disabled) return;
            const intention = intentionInput.value.trim();
            markConfirmed();
            logDecision('watched', intention);
            writeJSON(sessionStorage, checkinKey(), {
                intention,
                due: Date.now() + timeboxMinutes(intention) * 60 * 1000,
            });
            cleanup();
            scheduleCheckin();
        };

        // Assemble
        buttonContainer.appendChild(leaveButton);
        buttonContainer.appendChild(saveButton);
        buttonContainer.appendChild(continueButton);
        dialog.appendChild(kicker);
        dialog.appendChild(question);
        dialog.appendChild(helper);
        dialog.appendChild(statsLine);
        dialog.appendChild(intentionLabel);
        dialog.appendChild(intentionInput);
        dialog.appendChild(inputHint);
        dialog.appendChild(countdownTrack);
        dialog.appendChild(buttonContainer);
        overlay.appendChild(dialog);

        mountOverlay(overlay);
    }

    // --- Timebox check-in: the stated intention comes back to collect ---

    function scheduleCheckin() {
        clearCheckinTimer();
        const entry = readJSON(sessionStorage, checkinKey(), null);
        if (!entry || !entry.due) return;
        const delay = Math.max(0, entry.due - Date.now());
        checkinTimer = setTimeout(showCheckin, delay);
    }

    function showCheckin() {
        const entry = readJSON(sessionStorage, checkinKey(), null);
        if (!entry || !isVideoPage()) return;
        cleanup();

        document.querySelectorAll('video').forEach(v => v.pause());
        injectStyle();

        const overlay = document.createElement('div');
        overlay.id = 'video-confirm-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'vc-dialog';

        const kicker = document.createElement('p');
        kicker.className = 'vc-kicker';
        kicker.textContent = 'Timebox check-in';

        const question = document.createElement('h2');
        question.className = 'vc-question';
        question.textContent = 'Did you get what you came for?';

        const helper = document.createElement('p');
        helper.className = 'vc-helper';
        helper.textContent = entry.intention
            ? `You said: “${entry.intention}”`
            : 'Your timebox is up.';

        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'vc-actions';

        const doneButton = document.createElement('button');
        doneButton.type = 'button';
        doneButton.className = 'vc-button vc-leave';
        doneButton.textContent = 'Done — leave';
        doneButton.onclick = () => {
            sessionStorage.removeItem(checkinKey());
            logDecision('done', entry.intention);
            cleanup();
            leavePage();
        };

        const moreButton = document.createElement('button');
        moreButton.type = 'button';
        moreButton.className = 'vc-button vc-continue';
        moreButton.textContent = `${SNOOZE_MINUTES} more minutes`;
        moreButton.onclick = () => {
            writeJSON(sessionStorage, checkinKey(), {
                intention: entry.intention,
                due: Date.now() + SNOOZE_MINUTES * 60 * 1000,
            });
            cleanup();
            scheduleCheckin();
        };

        buttonContainer.appendChild(doneButton);
        buttonContainer.appendChild(moreButton);
        dialog.appendChild(kicker);
        dialog.appendChild(question);
        dialog.appendChild(helper);
        dialog.appendChild(buttonContainer);
        overlay.appendChild(dialog);

        mountOverlay(overlay);
    }

    // --- Watch-later list viewer ---
    // The counterpart of "Save for tonight": browse, open, or drop saved
    // videos. Reachable from the userscript menu on YouTube/Bilibili pages.

    function showWatchLater() {
        cleanup();
        injectStyle();

        const overlay = document.createElement('div');
        overlay.id = 'video-confirm-overlay';
        const dialog = document.createElement('div');
        dialog.className = 'vc-dialog';

        const kicker = document.createElement('p');
        kicker.className = 'vc-kicker';
        kicker.textContent = 'Saved for later';
        dialog.appendChild(kicker);

        const entries = readJSON(localStorage, WATCH_LATER_KEY, []);
        const question = document.createElement('h2');
        question.className = 'vc-question';
        question.textContent = entries.length
            ? `${entries.length} video${entries.length > 1 ? 's' : ''} waiting`
            : 'Nothing saved';
        dialog.appendChild(question);

        if (entries.length) {
            const list = document.createElement('ul');
            list.className = 'vc-list';
            entries.slice().reverse().forEach((entry) => {
                const li = document.createElement('li');
                const main = document.createElement('div');
                main.className = 'vc-item-main';
                const link = document.createElement('a');
                link.href = entry.url;
                link.textContent = entry.title || entry.url;
                main.appendChild(link);
                if (entry.intention) {
                    const why = document.createElement('p');
                    why.className = 'vc-why';
                    why.textContent = '“' + entry.intention + '” · ' + new Date(entry.t).toLocaleDateString();
                    main.appendChild(why);
                }
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'vc-remove';
                remove.textContent = '✕';
                remove.title = 'Remove from list';
                remove.onclick = () => {
                    const rest = readJSON(localStorage, WATCH_LATER_KEY, []).filter(e => e.url !== entry.url);
                    writeJSON(localStorage, WATCH_LATER_KEY, rest);
                    li.remove();
                    question.textContent = rest.length
                        ? `${rest.length} video${rest.length > 1 ? 's' : ''} waiting`
                        : 'Nothing saved';
                };
                li.appendChild(main);
                li.appendChild(remove);
                list.appendChild(li);
            });
            dialog.appendChild(list);
        } else {
            const helper = document.createElement('p');
            helper.className = 'vc-helper';
            helper.textContent = '“Save for tonight” during work hours puts videos here.';
            dialog.appendChild(helper);
        }

        const actions = document.createElement('div');
        actions.className = 'vc-actions';
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'vc-button vc-continue';
        closeButton.textContent = 'Close';
        closeButton.onclick = cleanup;
        actions.appendChild(closeButton);
        dialog.appendChild(actions);

        overlay.appendChild(dialog);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
        mountOverlay(overlay);
    }

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Watch-later list', showWatchLater);
    }

    // --- Entry points ---

    function onPageSettled() {
        // cleanup() either way — an overlay from a previous video must not
        // survive SPA navigation to a page that doesn't need one
        cleanup();
        clearCheckinTimer();
        if (!isVideoPage()) return;
        if (isWithinWorkingHours() && !isConfirmed()) {
            showConfirmation();
            return;
        }
        // Already confirmed (or off-hours): a pending timebox may still be due
        scheduleCheckin();
    }

    // Initial page load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onPageSettled);
    } else {
        onPageSettled();
    }

    // YouTube SPA navigation
    let lastUrl = location.href;
    const onNavigate = () => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            onPageSettled();
        }
    };
    window.addEventListener('yt-navigate-finish', onNavigate);
    window.addEventListener('popstate', onNavigate);

})();
