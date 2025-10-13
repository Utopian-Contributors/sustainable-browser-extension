declare const browser: any;

/**
 * Background Service Worker
 * Manages declarativeNetRequest rules for dependency redirection
 */
class NetworkInterceptor {
  private isFirefox: boolean;

  constructor() {
    this.isFirefox = typeof browser !== "undefined";
    console.log(`🚀 Sustainable Browser Extension started on ${this.isFirefox ? "Firefox" : "Chrome"}`);
    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      console.log("✅ Extension loaded successfully");
      console.log("✅ declarativeNetRequest will handle all esm.sh redirects");
      console.log("✅ Dependencies are web-accessible in /dependencies folder");
      
      // Log the number of active rules
      if (this.isFirefox && typeof browser !== "undefined" && browser.declarativeNetRequest) {
        browser.declarativeNetRequest.getDynamicRules((rules: (unknown)[]) => {
          console.log(`📊 Active redirect rules: ${rules.length}`);
        });
      } else if (!this.isFirefox && typeof chrome !== "undefined" && chrome.declarativeNetRequest) {
        chrome.declarativeNetRequest.getDynamicRules((rules) => {
          console.log(`📊 Active redirect rules: ${rules.length}`);
        });
      }
    } catch (error) {
      console.error("❌ Failed to initialize:", error);
    }
  }

  public getStats() {
    return {
      message: "Extension uses declarativeNetRequest for automatic redirects",
      status: "active"
    };
  }
}

const networkInterceptor = new NetworkInterceptor();

// Message handlers for popup communication
if (typeof chrome !== "undefined" && chrome.runtime) {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getStats") {
      sendResponse(networkInterceptor.getStats());
      return true;
    }
  });
} else if (typeof browser !== "undefined" && browser.runtime) {
  browser.runtime.onMessage.addListener((request: any, sender: any, sendResponse: any) => {
    if (request.action === "getStats") {
      sendResponse(networkInterceptor.getStats());
      return true;
    }
  });
}
