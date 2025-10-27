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
function updateUI(stats: BandwidthStats) {
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
  const avgSavedEl = document.getElementById('avg-saved');
  
  if (totalSavedEl) {
    totalSavedEl.textContent = formatBytes(stats.totalBytesSaved);
  }
  
  if (sessionsCountEl) {
    sessionsCountEl.textContent = stats.sessionsCount.toString();
  }
  
  if (avgSavedEl) {
    const avg = stats.sessionsCount > 0 
      ? stats.totalBytesSaved / stats.sessionsCount 
      : 0;
    avgSavedEl.textContent = formatBytes(avg);
  }
}

// Load and display stats
function loadStats() {
  chrome.runtime.sendMessage({ type: 'GET_BANDWIDTH_STATS' }, (stats: BandwidthStats) => {
    if (chrome.runtime.lastError) {
      console.error('Error loading stats:', chrome.runtime.lastError);
      const loadingEl = document.getElementById('loading');
      if (loadingEl) {
        loadingEl.textContent = 'Error loading stats';
      }
      return;
    }
    
    updateUI(stats);
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