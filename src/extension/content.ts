// content.js - Runs BEFORE page loads
(function() {
  // Set attribute on documentElement (always exists)
  document.documentElement.setAttribute('sustainable-extension-loaded', 'true');
  console.debug('🌿 Sustainable Browser extension loaded.');

  // Track script loads to detect build entrypoints
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const resourceEntry = entry as PerformanceResourceTiming;
      if (entry.entryType === 'resource' && resourceEntry.initiatorType === 'script') {
        const url = entry.name;
        
        // Check if this is a build entrypoint
        const isMini = url.includes('/mini/index') && url.endsWith('.js');
        const isRegular = url.includes('/assets/index') && url.endsWith('.js') && !url.includes('/mini/');
        
        if (isMini || isRegular) {
          // Get the size from the transfer size (actual bytes transferred)
          const size = resourceEntry.transferSize || 
                       resourceEntry.encodedBodySize ||
                       resourceEntry.decodedBodySize;
          
          if (size && size > 0) {
            // Send message to background script
            chrome.runtime.sendMessage({
              type: 'BUILD_DETECTED',
              payload: { url, size, isMini }
            }).catch(err => {
              console.debug('Failed to send build detection message:', err);
            });
          }
        }
      }
    }
  });

  // Start observing resource timing
  try {
    observer.observe({ entryTypes: ['resource'] });
  } catch (e) {
    console.debug('Performance observer not supported:', e);
  }
})();