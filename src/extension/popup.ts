interface PopupStats {
  cached: number;
  intercepted: number;
  rulesCreated: number;
  browser: string;
  recentIntercepts: Array<{
    url: string;
    timestamp: number;
  }>;
}

class PopupController {
  private stats: PopupStats = {
    cached: 0,
    intercepted: 0,
    rulesCreated: 0,
    browser: "unknown",
    recentIntercepts: [],
  };

  constructor() {
    this.initializePopup();
    this.setupEventListeners();
    this.loadStats();
  }

  private initializePopup(): void {
    this.updateStatsDisplay();
  }

  private setupEventListeners(): void {
    document
      .getElementById("view-debug")
      ?.addEventListener("click", this.handleViewDebug.bind(this));
  }

  private async loadStats(): Promise<void> {
    try {
      // Use browser API for Firefox, chrome API for Chrome
      const runtimeAPI = (globalThis as any).browser?.runtime || chrome.runtime;

      // Get stats from background script
      const response = await runtimeAPI.sendMessage({ action: "getStats" });
      if (response && response.stats) {
        this.stats = response.stats;
        this.updateStatsDisplay();
      }
    } catch (error) {
      console.error("Failed to load stats:", error);
    }
  }

  private updateStatsDisplay(): void {
    const cachedElement = document.getElementById("cached-count");
    const interceptedElement = document.getElementById("intercepted-count");
    const rulesElement = document.getElementById("rules-count");
    const browserElement = document.getElementById("browser-info");

    if (cachedElement) cachedElement.textContent = this.stats.cached.toString();
    if (interceptedElement)
      interceptedElement.textContent = this.stats.intercepted.toString();
    if (rulesElement)
      rulesElement.textContent = this.stats.rulesCreated.toString();
    if (browserElement)
      browserElement.textContent = `${this.stats.browser}`;

    this.updateRecentIntercepts();
  }

  private updateRecentIntercepts(): void {
    const interceptListElement = document.getElementById("intercept-list");
    if (!interceptListElement) return;

    if (this.stats.recentIntercepts.length === 0) {
      interceptListElement.innerHTML = `
        <div class="intercept-item">
          <div class="intercept-url">No recent intercepts</div>
        </div>
      `;
      return;
    }

    interceptListElement.innerHTML = this.stats.recentIntercepts
      .slice(0, 5) // Show only the 5 most recent
      .map(
        (intercept) => `
        <div class="intercept-item" onClick="window.open('${intercept.url}', '_blank')">
          <div class="intercept-url">${this.truncateUrl(intercept.url)}</div>
          <div style="font-size: 10px; color: #999; margin-top: 2px;">
            ${this.formatTime(intercept.timestamp)}
          </div>
        </div>
      `
      )
      .join("");
  }

  private handleViewDebug(): void {
    const debugSection = document.getElementById("debug-section");
    const debugInfo = document.getElementById("debug-info");
    
    if (!debugSection || !debugInfo) return;
    
    if (debugSection.style.display === "none") {
      debugSection.style.display = "block";
      this.loadDebugInfo();
    } else {
      debugSection.style.display = "none";
    }
  }

  private async loadDebugInfo(): Promise<void> {
    try {
      const runtimeAPI = (globalThis as any).browser?.runtime || chrome.runtime;
      const response = await runtimeAPI.sendMessage({ action: "getDebugInfo" });
      
      if (response && response.debugInfo) {
        const debugInfo = document.getElementById("debug-info");
        if (debugInfo) {
          debugInfo.textContent = JSON.stringify(response.debugInfo, null, 2);
        }
      }
    } catch (error) {
      console.error("Failed to load debug info:", error);
      const debugInfo = document.getElementById("debug-info");
      if (debugInfo) {
        debugInfo.textContent = `Error loading debug info: ${error}`;
      }
    }
  }

  private formatBandwidth(bytes: number): string {
    if ((bytes ?? 0) < 1024) return `${bytes ?? 0} B`;
    if ((bytes ?? 0) < 1024 * 1024)
      return `${((bytes ?? 0) / 1024).toFixed(1)} KB`;
    return `${((bytes ?? 0) / (1024 * 1024)).toFixed(1)} MB`;
  }

  private truncateUrl(url: string): string {
    if (url.length <= 35) return url;
    return url.substring(0, 32) + "...";
  }

  private formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMinutes = Math.floor(
      (now.getTime() - date.getTime()) / (1000 * 60)
    );

    if (diffMinutes < 1) return "Just now";
    if (diffMinutes < 60) return `${diffMinutes}m ago`;

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h ago`;

    return date.toLocaleDateString();
  }
}

// Initialize the popup when the DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  new PopupController();
});
