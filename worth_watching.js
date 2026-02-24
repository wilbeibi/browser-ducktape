// ==UserScript==
// @name         Video Watch Confirmation
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Asks whether a video is worth watching during work hours on YouTube and Bilibili, with background blur
// @author       You
// @match        https://www.youtube.com/*
// @match        https://youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://www.bilibili.com/video/*
// @match        https://bilibili.com/video/*
// @match        https://m.bilibili.com/video/*
// @grant        window.close
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const PROMPTS = [
        'Was this video part of your plan today?',
        'What was the task you were working on?',
        'Will this help you finish what you set out to do?',
        'Is this a detour or a destination?',
        'How did you get here — search or rabbit hole?',
        'If you skip this, will you even notice tonight?',
        'Are you here on purpose or did a link bring you?',
        'What would you tell your morning self about this?',
        'Does this move the needle on anything you care about?',
        'You had momentum — is this worth breaking it?',
        'Close your eyes: what were you doing 2 minutes ago?',
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

    const isConfirmed = () =>
        sessionStorage.getItem('videoConfirmed:' + window.location.href) === '1';

    const markConfirmed = () =>
        sessionStorage.setItem('videoConfirmed:' + window.location.href, '1');

    let activeOverlay = null;
    let playBlocker = null;

    function cleanup() {
        if (activeOverlay) { activeOverlay.remove(); activeOverlay = null; }
        const blur = document.getElementById('video-confirm-blur');
        if (blur) blur.remove();
        if (playBlocker) { document.removeEventListener('play', playBlocker, true); playBlocker = null; }
    }

    function showConfirmation() {
        if (!isWithinWorkingHours() || !isVideoPage() || isConfirmed()) return;
        cleanup();

        // Block video playback via capture-phase listener
        playBlocker = (e) => { e.target.pause(); e.target.currentTime = 0; };
        document.addEventListener('play', playBlocker, true);
        // Pause anything already playing
        document.querySelectorAll('video').forEach(v => { v.pause(); v.currentTime = 0; });

        // Blur
        const blurStyle = document.createElement('style');
        blurStyle.id = 'video-confirm-blur';
        blurStyle.textContent = `
            body > *:not(#video-confirm-overlay) {
                filter: blur(8px);
                transition: filter 0.3s ease-in-out;
            }
            @keyframes slideIn {
                from { transform: translateY(-20px); opacity: 0; }
                to   { transform: translateY(0);     opacity: 1; }
            }
        `;
        (document.head || document.documentElement).appendChild(blurStyle);

        // Overlay
        const overlay = document.createElement('div');
        overlay.id = 'video-confirm-overlay';
        activeOverlay = overlay;
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0, 0, 0, 0.4); z-index: 999999;
            display: flex; align-items: center; justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        `;

        // Dialog
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: white; border-radius: 12px; padding: 32px;
            box-shadow: 0 10px 50px rgba(0, 0, 0, 0.3);
            text-align: center; max-width: 400px; animation: slideIn 0.3s ease-out;
        `;

        // Random prompt
        const question = document.createElement('h2');
        question.textContent = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
        question.style.cssText = `
            margin: 0 0 24px 0; color: #333;
            font-size: 20px; font-weight: 600; line-height: 1.4;
        `;

        // Buttons
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; gap: 12px; justify-content: center;';

        const COUNTDOWN_SECONDS = 10;
        let remaining = COUNTDOWN_SECONDS;

        const yesButton = document.createElement('button');
        yesButton.textContent = `Yes (${COUNTDOWN_SECONDS})`;
        yesButton.disabled = true;
        yesButton.style.cssText = `
            padding: 10px 28px; background: #A5D6A7; color: white; border: none;
            border-radius: 6px; font-size: 16px; font-weight: 500;
            cursor: not-allowed; transition: background 0.2s; min-width: 100px; opacity: 0.6;
        `;
        yesButton.onmouseover = () => { if (!yesButton.disabled) yesButton.style.background = '#45a049'; };
        yesButton.onmouseout = () => { yesButton.style.background = yesButton.disabled ? '#A5D6A7' : '#4CAF50'; };

        const noButton = document.createElement('button');
        noButton.textContent = 'No';
        noButton.style.cssText = `
            padding: 10px 28px; background: #f44336; color: white; border: none;
            border-radius: 6px; font-size: 16px; font-weight: 500;
            cursor: pointer; transition: background 0.2s; min-width: 100px;
        `;
        noButton.onmouseover = () => noButton.style.background = '#da190b';
        noButton.onmouseout = () => noButton.style.background = '#f44336';

        // Countdown bar
        const countdownTrack = document.createElement('div');
        countdownTrack.style.cssText = `
            width: 100%; height: 6px; background: rgba(76, 175, 80, 0.2);
            border-radius: 999px; margin-bottom: 20px; overflow: hidden;
        `;
        const countdownFill = document.createElement('div');
        countdownFill.style.cssText = `
            height: 100%; width: 100%; background: rgba(76, 175, 80, 0.8);
            transition: width 1s linear;
        `;
        countdownTrack.appendChild(countdownFill);

        const countdownTimer = setInterval(() => {
            remaining -= 1;
            if (remaining > 0) {
                yesButton.textContent = `Yes (${remaining})`;
                countdownFill.style.width = `${(remaining / COUNTDOWN_SECONDS) * 100}%`;
                return;
            }
            clearInterval(countdownTimer);
            yesButton.disabled = false;
            yesButton.style.opacity = '1';
            yesButton.style.cursor = 'pointer';
            yesButton.textContent = 'Yes';
            yesButton.style.background = '#4CAF50';
            countdownTrack.style.display = 'none';
        }, 1000);

        const dismiss = (confirmed) => {
            clearInterval(countdownTimer);
            if (confirmed) {
                markConfirmed();
                cleanup();
            } else {
                cleanup();
                if (window.history.length > 1) window.history.back();
                else window.close();
            }
        };

        yesButton.onclick = () => dismiss(true);
        noButton.onclick = () => dismiss(false);

        // Study shortcut — skips countdown, still requires conscious click
        const studyLink = document.createElement('a');
        studyLink.textContent = 'This is for study/learning';
        studyLink.href = '#';
        studyLink.style.cssText = `
            display: block; margin-top: 16px; font-size: 13px;
            color: #888; text-decoration: underline; cursor: pointer;
        `;
        studyLink.onclick = (e) => { e.preventDefault(); dismiss(true); };

        // Assemble
        buttonContainer.appendChild(yesButton);
        buttonContainer.appendChild(noButton);
        dialog.appendChild(question);
        dialog.appendChild(countdownTrack);
        dialog.appendChild(buttonContainer);
        dialog.appendChild(studyLink);
        overlay.appendChild(dialog);

        if (document.body) {
            document.body.appendChild(overlay);
        } else {
            const obs = new MutationObserver(() => {
                if (document.body) { document.body.appendChild(overlay); obs.disconnect(); }
            });
            obs.observe(document.documentElement, { childList: true, subtree: true });
        }
    }

    // --- Entry points ---

    // Initial page load
    const tryShow = () => {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', showConfirmation);
        } else {
            showConfirmation();
        }
    };
    tryShow();

    // YouTube SPA navigation
    let lastUrl = location.href;
    const onNavigate = () => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            showConfirmation();
        }
    };
    window.addEventListener('yt-navigate-finish', onNavigate);
    window.addEventListener('popstate', onNavigate);

})();
