// ==UserScript==
// @name         Video Watch Confirmation
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Asks "Is this video really important to you?" before watching videos on YouTube and Bilibili, with background blur
// @author       You
// @match        https://www.youtube.com/watch*
// @match        https://youtube.com/watch*
// @match        https://m.youtube.com/watch*
// @match        https://www.bilibili.com/video/*
// @match        https://bilibili.com/video/*
// @match        https://m.bilibili.com/video/*
// @grant        window.close
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // Limit prompts to local weekdays 09:00-18:00 (inclusive start, exclusive end).
    const isWithinWorkingHours = () => {
        const WORK_START_MINUTES = 9 * 60;
        const WORK_END_MINUTES = 18 * 60;
        const now = new Date();
        const day = now.getDay(); // 0 = Sunday, 6 = Saturday
        if (day === 0 || day === 6) {
            return false;
        }
        const minutes = now.getHours() * 60 + now.getMinutes();
        return minutes >= WORK_START_MINUTES && minutes < WORK_END_MINUTES;
    };

    if (!isWithinWorkingHours()) {
        return;
    }

    // Check if we've already shown the dialog for this page load
    if (sessionStorage.getItem('videoConfirmed') === window.location.href) {
        return;
    }

    // Function to create and show the confirmation dialog
    function showConfirmation() {
        if (!isWithinWorkingHours()) {
            return;
        }

        // Apply blur to the entire page
        const blurStyle = document.createElement('style');
        blurStyle.id = 'video-confirm-blur';
        blurStyle.textContent = `
            body > *:not(#video-confirm-overlay) {
                filter: blur(8px);
                transition: filter 0.3s ease-in-out;
            }
        `;
        document.head.appendChild(blurStyle);

        // Create overlay
        const overlay = document.createElement('div');
        overlay.id = 'video-confirm-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.4);
            z-index: 999999;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        `;

        // Create dialog box
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: white;
            border-radius: 12px;
            padding: 32px;
            box-shadow: 0 10px 50px rgba(0, 0, 0, 0.3);
            text-align: center;
            max-width: 400px;
            animation: slideIn 0.3s ease-out;
        `;

        // Add animation keyframes
        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideIn {
                from {
                    transform: translateY(-20px);
                    opacity: 0;
                }
                to {
                    transform: translateY(0);
                    opacity: 1;
                }
            }
        `;
        document.head.appendChild(style);

        // Create question text
        const question = document.createElement('h2');
        question.textContent = 'Is this video really important to you?';
        question.style.cssText = `
            margin: 0 0 24px 0;
            color: #333;
            font-size: 20px;
            font-weight: 600;
            line-height: 1.4;
        `;

        // Create button container
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
            display: flex;
            gap: 12px;
            justify-content: center;
        `;

        // Create Yes button
        const yesButton = document.createElement('button');
        const initialYesText = 'Yes';
        const COUNTDOWN_SECONDS = 10;
        let remainingSeconds = COUNTDOWN_SECONDS;
        yesButton.textContent = `${initialYesText} (${COUNTDOWN_SECONDS})`;
        yesButton.style.cssText = `
            padding: 10px 28px;
            background: #A5D6A7;
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.2s;
            min-width: 100px;
        `;
        yesButton.disabled = true;
        yesButton.style.opacity = '0.6';
        yesButton.style.cursor = 'not-allowed';
        yesButton.onmouseover = () => {
            if (yesButton.disabled) {
                return;
            }
            yesButton.style.background = '#45a049';
        };
        yesButton.onmouseout = () => {
            yesButton.style.background = yesButton.disabled ? '#A5D6A7' : '#4CAF50';
        };

        // Create No button
        const noButton = document.createElement('button');
        noButton.textContent = 'No';
        noButton.style.cssText = `
            padding: 10px 28px;
            background: #f44336;
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.2s;
            min-width: 100px;
        `;
        noButton.onmouseover = () => noButton.style.background = '#da190b';
        noButton.onmouseout = () => noButton.style.background = '#f44336';

        // Countdown indicator bar
        const countdownTrack = document.createElement('div');
        countdownTrack.style.cssText = `
            width: 100%;
            height: 6px;
            background: rgba(76, 175, 80, 0.2);
            border-radius: 999px;
            margin-bottom: 20px;
            overflow: hidden;
        `;

        const countdownFill = document.createElement('div');
        countdownFill.style.cssText = `
            height: 100%;
            width: 100%;
            background: rgba(76, 175, 80, 0.8);
            transition: width 1s linear;
        `;
        countdownTrack.appendChild(countdownFill);

        // Start countdown to enable the Yes button
        const countdownTimer = setInterval(() => {
            remainingSeconds -= 1;
            if (remainingSeconds > 0) {
                yesButton.textContent = `${initialYesText} (${remainingSeconds})`;
                const progressWidth = (remainingSeconds / COUNTDOWN_SECONDS) * 100;
                countdownFill.style.width = `${progressWidth}%`;
                return;
            }

            clearInterval(countdownTimer);
            yesButton.disabled = false;
            yesButton.style.opacity = '1';
            yesButton.style.cursor = 'pointer';
            yesButton.textContent = initialYesText;
            yesButton.style.background = '#4CAF50';
            countdownTrack.style.display = 'none';
        }, 1000);

        // Add click handlers
        yesButton.onclick = () => {
            // Store confirmation for this URL to prevent re-asking on same page
            sessionStorage.setItem('videoConfirmed', window.location.href);
            // Remove blur effect
            const blurStyle = document.getElementById('video-confirm-blur');
            if (blurStyle) blurStyle.remove();
            overlay.remove();
            clearInterval(countdownTimer);
            countdownTrack.style.display = 'none';
        };

        noButton.onclick = () => {
            // Try different methods to close the tab
            try {
                window.close();
            } catch(e) {
                // If window.close() doesn't work, try navigating away
                if (window.history.length > 1) {
                    window.history.back();
                } else {
                    // As a fallback, navigate to a blank page
                    window.location.href = 'about:blank';
                }
            }
        };
        noButton.addEventListener('click', () => clearInterval(countdownTimer));
        noButton.addEventListener('click', () => countdownTrack.style.display = 'none');

        // Assemble the dialog
        buttonContainer.appendChild(yesButton);
        buttonContainer.appendChild(noButton);
        dialog.appendChild(question);
        dialog.appendChild(countdownTrack);
        dialog.appendChild(buttonContainer);
        overlay.appendChild(dialog);

        // Add to page
        if (document.body) {
            document.body.appendChild(overlay);
        } else {
            // If body doesn't exist yet, wait for it
            const observer = new MutationObserver((mutations, obs) => {
                if (document.body) {
                    document.body.appendChild(overlay);
                    obs.disconnect();
                }
            });
            observer.observe(document.documentElement, {childList: true, subtree: true});
        }

        // Stop video from auto-playing while dialog is shown
        const stopVideo = () => {
            const videos = document.querySelectorAll('video');
            videos.forEach(video => {
                video.pause();
                video.currentTime = 0;
            });
        };

        // Try to stop video immediately and periodically
        stopVideo();
        const stopInterval = setInterval(stopVideo, 100);
        
        // Clear interval when dialog is dismissed
        yesButton.addEventListener('click', () => clearInterval(stopInterval));
        noButton.addEventListener('click', () => clearInterval(stopInterval));
    }

    // Show the dialog as soon as possible
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', showConfirmation);
    } else {
        showConfirmation();
    }

})();
