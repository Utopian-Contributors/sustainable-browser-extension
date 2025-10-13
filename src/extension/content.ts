// content.js - Runs BEFORE page loads
const script = document.createElement('script');
script.src = chrome.runtime.getURL('injected.js');
(document.head || document.documentElement).prepend(script);
script.onload = () => script.remove(); // Clean up
