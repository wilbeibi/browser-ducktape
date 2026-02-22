// ==UserScript==
// @name         YouTube Transcript Downloader
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Download YouTube transcript when transcript panel is open
// @author       You
// @match        https://www.youtube.com/watch*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Create download button styles
    const styles = `
        .transcript-download-btn {
            background-color: #065fd4;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 18px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            margin: 10px;
            transition: background-color 0.3s;
        }
        .transcript-download-btn:hover {
            background-color: #0847a8;
        }
    `;

    // Add styles to page
    const styleSheet = document.createElement("style");
    styleSheet.textContent = styles;
    document.head.appendChild(styleSheet);

    // Function to extract transcript text
    function extractTranscript() {
        const transcriptSegments = document.querySelectorAll('ytd-transcript-segment-renderer');

        if (transcriptSegments.length === 0) {
            alert('No transcript found. Please make sure the transcript panel is open.');
            return null;
        }

        // Include canonical video URL at the top for context when transcript is shared standalone
        const url = new URL(window.location.href);
        const canonicalVideoUrl = url.searchParams.get('v')
            ? `${url.origin}${url.pathname}?v=${url.searchParams.get('v')}`
            : window.location.href;
        let transcriptText = `Original video: ${canonicalVideoUrl}\n\n`;

        transcriptSegments.forEach(segment => {
            // Get timestamp
            const timestampElement = segment.querySelector('.segment-timestamp');
            const timestamp = timestampElement ? timestampElement.textContent.trim() : '';

            // Get text
            const textElement = segment.querySelector('.segment-text');
            const text = textElement ? textElement.textContent.trim() : '';

            // Format as [timestamp] text
            transcriptText += `[${timestamp}] ${text}\n\n`;
        });

        return transcriptText;
    }

    // Function to download text as file
    function downloadTranscript(text, filename) {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // Function to get video title for filename
    function getVideoTitle() {
        const titleElement = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
        if (titleElement) {
            // Clean filename - remove special characters
            return titleElement.textContent.trim().replace(/[^a-z0-9]/gi, '_').toLowerCase();
        }
        return 'youtube_transcript';
    }

    // Function to add download button
    function addDownloadButton() {
        // Check if transcript panel exists
        const transcriptPanel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]');

        if (transcriptPanel && !transcriptPanel.querySelector('.transcript-download-btn')) {
            // Find the header area
            const headerArea = transcriptPanel.querySelector('ytd-engagement-panel-title-header-renderer');

            if (headerArea) {
                // Create download button
                const downloadBtn = document.createElement('button');
                downloadBtn.className = 'transcript-download-btn';
                downloadBtn.textContent = '📥 Download Transcript';

                downloadBtn.addEventListener('click', () => {
                    const transcript = extractTranscript();
                    if (transcript) {
                        const filename = `${getVideoTitle()}_transcript.txt`;
                        downloadTranscript(transcript, filename);
                    }
                });

                // Insert button after header
                headerArea.parentNode.insertBefore(downloadBtn, headerArea.nextSibling);
            }
        }
    }

    // Watch for transcript panel opening
    const observer = new MutationObserver((mutations) => {
        // Check if transcript panel is present
        if (document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]')) {
            addDownloadButton();
        }
    });

    // Start observing
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Also check immediately in case transcript is already open
    setTimeout(addDownloadButton, 2000);

})();
