// ==UserScript==
// @name         YouTube Transcript Downloader
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Download button appears in transcript panel after user opens it
// @author       You
// @match        https://www.youtube.com/watch*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const BTN_ID = 'yt-transcript-dl-btn';
    const PANEL_SEL = 'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';
    const SEGMENT_SEL = 'ytd-transcript-segment-renderer';

    const styleSheet = document.createElement("style");
    styleSheet.textContent = `
        #${BTN_ID} {
            background-color: #065fd4;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 18px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            margin: 8px 16px;
            transition: background-color 0.3s;
        }
        #${BTN_ID}:hover { background-color: #0847a8; }
    `;
    document.head.appendChild(styleSheet);

    function getVideoTitle() {
        const el = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
        return el
            ? el.textContent.trim().replace(/[^a-z0-9]/gi, '_').toLowerCase()
            : 'youtube_transcript';
    }

    function extractTranscript() {
        const segments = document.querySelectorAll(SEGMENT_SEL);
        if (segments.length === 0) return null;

        const videoId = new URL(window.location.href).searchParams.get('v');
        const canonicalUrl = videoId
            ? `https://www.youtube.com/watch?v=${videoId}`
            : window.location.href;
        let text = `Original video: ${canonicalUrl}\n\n`;

        segments.forEach(segment => {
            const timestamp = (segment.querySelector('.segment-timestamp') ||
                               segment.querySelector('[class*="timestamp"]'))
                               ?.textContent.trim() ?? '';
            const content = (segment.querySelector('.segment-text') ||
                             segment.querySelector('yt-formatted-string.segment-text') ||
                             segment.querySelector('[class*="segment-text"]'))
                             ?.textContent.trim() ?? '';
            text += `[${timestamp}] ${content}\n\n`;
        });

        return text;
    }

    function downloadFile(text, filename) {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function addDownloadButton() {
        if (document.getElementById(BTN_ID)) return;
        const panel = document.querySelector(PANEL_SEL);
        if (!panel) return;

        const header = panel.querySelector('ytd-engagement-panel-title-header-renderer');
        if (!header) return;

        const btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.textContent = 'Download Transcript';
        btn.addEventListener('click', () => {
            const transcript = extractTranscript();
            if (transcript) {
                downloadFile(transcript, `${getVideoTitle()}_transcript.txt`);
            } else {
                alert('No transcript segments found. Wait for it to load.');
            }
        });
        header.parentNode.insertBefore(btn, header.nextSibling);
    }

    // Watch for transcript panel to appear
    const observer = new MutationObserver(() => {
        const panel = document.querySelector(PANEL_SEL);
        if (panel && panel.querySelector(SEGMENT_SEL)) {
            addDownloadButton();
        }
    });

    function startObserver() {
        const target = document.querySelector('#panels') || document.body;
        observer.observe(target, { childList: true, subtree: true });
    }

    window.addEventListener('yt-navigate-finish', () => {
        document.getElementById(BTN_ID)?.remove();
        startObserver();
    });

    startObserver();
})();
