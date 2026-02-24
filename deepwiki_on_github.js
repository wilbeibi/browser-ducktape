// ==UserScript==
// @name         GitHub to DeepWiki Link
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Adds a button to GitHub repository pages that links to the corresponding DeepWiki page
// @author       You
// @match        https://github.com/*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    let lastUrl = location.href;

    function onPageChange() {
        const currentUrl = location.href;
        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            const old = document.querySelector('[aria-label="View on DeepWiki"]');
            if (old) {
                const li = old.closest('li');
                if (li) li.remove(); else old.remove();
            }
        }
        addDeepWikiButton();
    }

    let debounceTimer;
    const observer = new MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(onPageChange, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(onPageChange, 500));
    } else {
        setTimeout(onPageChange, 500);
    }

    function addDeepWikiButton() {
        // Run only on repository pages, not on other GitHub pages
        if (!isRepoPage()) return;
        if (document.querySelector('[aria-label="View on DeepWiki"]')) return;

        // Extract username and repo name from URL
        const pathParts = window.location.pathname.split('/').filter(part => part);
        if (pathParts.length < 2) return;

        const username = pathParts[0];
        const repo = pathParts[1];

        // Create DeepWiki URL
        const deepwikiUrl = `https://deepwiki.com/${username}/${repo}`;

        // Create button
        const button = createDeepWikiButton(deepwikiUrl);

        // Try to insert button into the GitHub UI
        insertButton(button);
    }

    // Helper function to check if current page is a repo page
    function isRepoPage() {
        // More sophisticated check
        const pathParts = window.location.pathname.split('/').filter(part => part);

        // Must have at least username/repo in the path
        if (pathParts.length < 2) return false;

        // If it has more parts, check if it's a known non-repo section
        if (pathParts.length > 2) {
            const nonRepoSections = ['issues', 'pull', 'actions', 'projects', 'wiki', 'security', 'pulse', 'settings'];
            if (nonRepoSections.includes(pathParts[2])) return false;

            // Could be a file path within the repo, which is still a repo page
            return true;
        }

        return true;
    }

    // Helper function to create the DeepWiki button
    function createDeepWikiButton(url) {
        const button = document.createElement('a');
        button.href = url;
        button.target = '_blank'; // Open in new tab
        button.rel = 'noopener noreferrer'; // Security best practice for _blank links
        button.className = 'btn btn-sm';
        button.style.marginLeft = '4px';
        button.setAttribute('aria-label', 'View on DeepWiki');

        // Add icon and text
        button.innerHTML = `
            <svg aria-hidden="true" height="16" viewBox="0 0 16 16" version="1.1" width="16" class="octicon octicon-book">
                <path fill-rule="evenodd" d="M0 1.75A.75.75 0 01.75 1h4.253c1.227 0 2.317.59 3 1.501A3.744 3.744 0 0111.006 1h4.245a.75.75 0 01.75.75v10.5a.75.75 0 01-.75.75h-4.507a2.25 2.25 0 00-1.591.659l-.622.621a.75.75 0 01-1.06 0l-.622-.621A2.25 2.25 0 005.258 13H.75a.75.75 0 01-.75-.75V1.75zm8.755 3a2.25 2.25 0 012.25-2.25H14.5v9h-3.757c-.71 0-1.4.201-1.992.572l.004-7.322zm-1.504 7.324l.004-5.073-.002-2.253A2.25 2.25 0 005.003 2.5H1.5v9h3.757a3.75 3.75 0 011.994.574z"></path>
            </svg>
            DeepWiki
        `;

        return button;
    }

    // Helper function to insert the button into the GitHub UI
    function insertButton(button) {
        // Try multiple possible insertion points in order of preference

        // 1. Try the repository navigation bar (UnderlineNav)
        const repoNav = document.querySelector('ul.UnderlineNav-body');
        if (repoNav) {
            const listItem = document.createElement('li');
            listItem.className = 'ml-3';
            listItem.appendChild(button);
            repoNav.appendChild(listItem);
            return true;
        }

        // 2. Try the repository header actions
        const headerActions = document.querySelector('.file-navigation');
        if (headerActions) {
            headerActions.appendChild(button);
            return true;
        }

        // 3. Try the pagehead actions
        const pagehead = document.querySelector('.pagehead-actions');
        if (pagehead) {
            const listItem = document.createElement('li');
            listItem.appendChild(button);
            pagehead.prepend(listItem);
            return true;
        }

        // 4. Try the repository details area
        const repoDetails = document.querySelector('#repository-details-container');
        if (repoDetails) {
            repoDetails.appendChild(button);
            return true;
        }

        // 5. Last resort: try to find any navigation element
        const anyNav = document.querySelector('nav.js-repo-nav');
        if (anyNav) {
            anyNav.appendChild(button);
            return true;
        }

        console.log('GitHub to DeepWiki Link: Could not find a suitable location to insert the button');
        return false;
    }
})();
