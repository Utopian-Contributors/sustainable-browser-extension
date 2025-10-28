interface BandwidthStats {
  totalBytesSaved: number;
  sessionsCount: number;
  lastUpdated: number;
}

// Format bytes to human-readable format
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

// Update UI with stats
function updateUI(stats: BandwidthStats, currentPageData?: { regularSize: number; miniSize: number; domain: string }) {
  const loadingEl = document.getElementById('loading');
  const statsEl = document.getElementById('stats');
  const emptyStateEl = document.getElementById('empty-state');
  
  if (!loadingEl || !statsEl || !emptyStateEl) return;
  
  loadingEl.style.display = 'none';
  
  // Show empty state if no data
  if (stats.totalBytesSaved === 0 && stats.sessionsCount === 0) {
    emptyStateEl.style.display = 'block';
    statsEl.style.display = 'none';
    return;
  }
  
  // Show stats
  emptyStateEl.style.display = 'none';
  statsEl.style.display = 'block';
  
  // Update values
  const totalSavedEl = document.getElementById('total-saved');
  const sessionsCountEl = document.getElementById('sessions-count');
  const currentPageSavedEl = document.getElementById('current-page-saved');
  
  if (totalSavedEl) {
    totalSavedEl.textContent = formatBytes(stats.totalBytesSaved);
  }
  
  if (sessionsCountEl) {
    sessionsCountEl.textContent = stats.sessionsCount.toString();
  }
  
  if (currentPageSavedEl) {
    if (currentPageData && currentPageData.regularSize && currentPageData.miniSize) {
      const bytesSaved = currentPageData.regularSize - currentPageData.miniSize;
      const percentSaved = (bytesSaved / currentPageData.regularSize) * 100;
      currentPageSavedEl.textContent = `${percentSaved.toFixed(1)}%`;
    } else {
      currentPageSavedEl.textContent = 'N/A';
    }
  }
}

// Get current tab domain
async function getCurrentTabDomain(): Promise<string | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.url) {
      const url = new URL(tabs[0].url);
      return url.origin;
    }
  } catch (error) {
    console.error('Error getting current tab:', error);
  }
  return null;
}

// Load and display stats
async function loadStats() {
  // Get bandwidth stats
  chrome.runtime.sendMessage({ type: 'GET_BANDWIDTH_STATS' }, async (stats: BandwidthStats) => {
    if (chrome.runtime.lastError) {
      console.error('Error loading stats:', chrome.runtime.lastError);
      const loadingEl = document.getElementById('loading');
      if (loadingEl) {
        loadingEl.textContent = 'Error loading stats';
      }
      return;
    }
    
    // Get current page data
    const currentDomain = await getCurrentTabDomain();
    let currentPageData: { regularSize: number; miniSize: number; domain: string } | undefined;
    
    if (currentDomain) {
      chrome.runtime.sendMessage({ type: 'GET_BUILD_CACHE' }, (cache: Record<string, { regularSize?: number; miniSize?: number; timestamp: number }>) => {
        if (!chrome.runtime.lastError && cache[currentDomain]) {
          const domainCache = cache[currentDomain];
          if (domainCache.regularSize && domainCache.miniSize) {
            currentPageData = {
              regularSize: domainCache.regularSize,
              miniSize: domainCache.miniSize,
              domain: currentDomain
            };
          }
        }
        
        // Update UI with all data
        updateUI(stats, currentPageData);
      });
    } else {
      // Update UI without current page data
      updateUI(stats);
    }
  });
}

// Reset stats
function resetStats() {
  if (!confirm('Are you sure you want to reset all bandwidth statistics?')) {
    return;
  }
  
  chrome.runtime.sendMessage({ type: 'RESET_BANDWIDTH_STATS' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error resetting stats:', chrome.runtime.lastError);
      alert('Failed to reset stats');
      return;
    }
    
    // Reload stats after reset
    loadStats();
  });
}

// Initialize popup
document.addEventListener('DOMContentLoaded', () => {
  // Load stats on popup open
  loadStats();
  
  // Set up button listeners
  const resetBtn = document.getElementById('reset-btn');
  
  if (resetBtn) {
    resetBtn.addEventListener('click', resetStats);
  }
  
  // Auto-refresh: Listen for storage changes and update UI automatically
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.bandwidthStats) {
      // Automatically update UI when bandwidth stats change
      updateUI(changes.bandwidthStats.newValue);
    }
  });
});