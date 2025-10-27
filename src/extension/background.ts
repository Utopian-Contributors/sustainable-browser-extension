// Background script for tracking bandwidth savings

// Ensure chrome APIs are available
if (typeof chrome === 'undefined' || !chrome.storage) {
  throw new Error('Chrome APIs not available. This script must run as a Chrome extension.');
}

interface BandwidthStats {
  totalBytesSaved: number;
  sessionsCount: number;
  lastUpdated: number;
}

interface BuildSizeCache {
  [domain: string]: {
    regularSize?: number;
    miniSize?: number;
    timestamp: number;
  };
}

// Storage keys
const STORAGE_KEYS = {
  BANDWIDTH_STATS: 'bandwidthStats',
  BUILD_SIZE_CACHE: 'buildSizeCache',
} as const;

// Cache for tracking which domains we're currently checking
const pendingChecks = new Map<string, Set<string>>();

/**
 * Get bandwidth stats from storage
 */
async function getBandwidthStats(): Promise<BandwidthStats> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.BANDWIDTH_STATS);
  return result[STORAGE_KEYS.BANDWIDTH_STATS] || {
    totalBytesSaved: 0,
    sessionsCount: 0,
    lastUpdated: Date.now(),
  };
}

/**
 * Update bandwidth stats in storage
 */
async function updateBandwidthStats(bytesSaved: number): Promise<void> {
  const stats = await getBandwidthStats();
  stats.totalBytesSaved += bytesSaved;
  stats.sessionsCount += 1;
  stats.lastUpdated = Date.now();
  
  await chrome.storage.local.set({
    [STORAGE_KEYS.BANDWIDTH_STATS]: stats,
  });
  
  console.log(`📊 Bandwidth saved: ${(bytesSaved / 1024).toFixed(2)} KB. Total: ${(stats.totalBytesSaved / 1024).toFixed(2)} KB`);
}

/**
 * Get build size cache from storage
 */
async function getBuildSizeCache(): Promise<BuildSizeCache> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.BUILD_SIZE_CACHE);
  return result[STORAGE_KEYS.BUILD_SIZE_CACHE] || {};
}

/**
 * Update build size cache in storage
 */
async function updateBuildSizeCache(domain: string, sizes: { regularSize?: number; miniSize?: number }): Promise<void> {
  const cache = await getBuildSizeCache();
  
  if (!cache[domain]) {
    cache[domain] = { timestamp: Date.now() };
  }
  
  if (sizes.regularSize !== undefined) {
    cache[domain].regularSize = sizes.regularSize;
  }
  if (sizes.miniSize !== undefined) {
    cache[domain].miniSize = sizes.miniSize;
  }
  cache[domain].timestamp = Date.now();
  
  await chrome.storage.local.set({
    [STORAGE_KEYS.BUILD_SIZE_CACHE]: cache,
  });
}

/**
 * Fetch the size of a resource
 */
async function fetchResourceSize(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) {
      return null;
    }
    
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      return parseInt(contentLength, 10);
    }
    
    // If HEAD doesn't provide content-length, try GET
    const getResponse = await fetch(url);
    if (!getResponse.ok) {
      return null;
    }
    
    const blob = await getResponse.blob();
    return blob.size;
  } catch (error) {
    console.error(`Failed to fetch resource size for ${url}:`, error);
    return null;
  }
}

/**
 * Parse HTML to find the regular build entrypoint
 */
async function findRegularBuildUrl(domain: string): Promise<string | null> {
  try {
    // Fetch the HTML page
    const response = await fetch(domain);
    if (!response.ok) {
      return null;
    }
    
    const html = await response.text();
    
    // Look for script tags that import from /assets/index*.js
    // Pattern: await import("/assets/index-HASH.js")
    const importMatch = html.match(/await\s+import\s*\(\s*["']([^"']*\/assets\/index[^"']*\.js)["']\s*\)/);
    if (importMatch && importMatch[1]) {
      const path = importMatch[1];
      // If it's a relative path, make it absolute
      if (path.startsWith('/')) {
        return new URL(path, domain).href;
      }
      return path;
    }
    
    // Alternative pattern: <script src="/assets/index-HASH.js">
    const scriptMatch = html.match(/<script[^>]+src=["']([^"']*\/assets\/index[^"']*\.js)["']/);
    if (scriptMatch && scriptMatch[1]) {
      const path = scriptMatch[1];
      if (path.startsWith('/')) {
        return new URL(path, domain).href;
      }
      return path;
    }
    
    return null;
  } catch (error) {
    console.error(`Failed to parse HTML from ${domain}:`, error);
    return null;
  }
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.origin;
  } catch {
    return '';
  }
}

/**
 * Check if a URL is for a build entrypoint
 */
function isBuildEntrypoint(url: string): { isMini: boolean; isRegular: boolean; domain: string } {
  const domain = extractDomain(url);
  const isMini = url.includes('/mini/index') && url.endsWith('.js');
  const isRegular = url.includes('/assets/index') && url.endsWith('.js') && !url.includes('/mini/');
  
  return { isMini, isRegular, domain };
}

/**
 * Handle when a build is detected
 */
async function handleBuildDetection(url: string, size: number, isMini: boolean): Promise<void> {
  const domain = extractDomain(url);
  if (!domain) return;
  
  // Get or initialize pending checks for this domain
  if (!pendingChecks.has(domain)) {
    pendingChecks.set(domain, new Set());
  }
  const domainChecks = pendingChecks.get(domain)!;
  
  // Avoid duplicate checks
  const checkKey = isMini ? 'mini' : 'regular';
  if (domainChecks.has(checkKey)) {
    return;
  }
  domainChecks.add(checkKey);
  
  console.log(`🔍 Detected ${isMini ? 'mini' : 'regular'} build on ${domain}: ${(size / 1024).toFixed(2)} KB`);
  
  // Update cache with the detected size
  const updateObj = isMini ? { miniSize: size } : { regularSize: size };
  await updateBuildSizeCache(domain, updateObj);
  
  // If mini build was detected, try to fetch the regular build size for comparison
  if (isMini) {
    const cache = await getBuildSizeCache();
    const cachedData = cache[domain];
    
    let regularSize = cachedData?.regularSize;
    
    // If we don't have the regular size cached, try to fetch it
    if (!regularSize) {
      // Parse the HTML to find the actual regular build entrypoint URL
      console.log(`📡 Parsing HTML from ${domain} to find regular build entrypoint`);
      const regularUrl = await findRegularBuildUrl(domain);
      
      if (regularUrl) {
        console.log(`📡 Found regular build URL: ${regularUrl}`);
        const fetchedSize = await fetchResourceSize(regularUrl);
        
        if (fetchedSize) {
          regularSize = fetchedSize;
          console.log(`📥 Fetched regular build size: ${(regularSize / 1024).toFixed(2)} KB`);
          await updateBuildSizeCache(domain, { regularSize });
        }
      } else {
        console.warn(`⚠️ Could not find regular build URL in HTML for ${domain}`);
      }
    }
    
    // Calculate and record savings if we have both sizes
    if (regularSize && size < regularSize) {
      const bytesSaved = regularSize - size;
      await updateBandwidthStats(bytesSaved);
      console.log(`✅ Saved ${(bytesSaved / 1024).toFixed(2)} KB on ${domain}`);
    }
  }
  
  // Clean up after a short delay
  setTimeout(() => {
    domainChecks.delete(checkKey);
    if (domainChecks.size === 0) {
      pendingChecks.delete(domain);
    }
  }, 5000);
}

/**
 * Handle messages from content script or popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'BUILD_DETECTED') {
    const { url, size, isMini } = message.payload;
    handleBuildDetection(url, size, isMini).then(() => {
      sendResponse({ success: true });
    });
    return true; // Indicates async response
  }
  
  if (message.type === 'GET_BANDWIDTH_STATS') {
    getBandwidthStats().then(stats => sendResponse(stats));
    return true; // Indicates async response
  }
  
  if (message.type === 'RESET_BANDWIDTH_STATS') {
    chrome.storage.local.set({
      [STORAGE_KEYS.BANDWIDTH_STATS]: {
        totalBytesSaved: 0,
        sessionsCount: 0,
        lastUpdated: Date.now(),
      },
    }).then(() => sendResponse({ success: true }));
    return true;
  }
  
  if (message.type === 'GET_BUILD_CACHE') {
    getBuildSizeCache().then(cache => sendResponse(cache));
    return true;
  }
});

console.log('🌿 Sustainable Browser background script loaded');
