#!/usr/bin/env ts-node

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Cross-Browser Build Script for Sustainable Browser Extension
 *
 * This script creates optimized builds for both Chrome and Firefox
 * - Chrome: Uses Manifest V3 with service worker
 * - Firefox: Uses Manifest V2 with background scripts
 * - Both: Include all dependencies and proper web_accessible_resources
 *
 * Options:
 * --webstore: Also create a web store package (ZIP file)
 */

const PROJECT_ROOT = path.join(__dirname, "..");
const DIST_DIR = path.join(PROJECT_ROOT, "dist");
const CHROME_DIR = path.join(DIST_DIR, "chrome");
const FIREFOX_DIR = path.join(DIST_DIR, "firefox");

// Check if webstore flag is passed
const createWebstorePackage = process.argv.includes("--webstore");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyFile(src: string, dest: string) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  // Individual file copy logging removed for cleaner output
}

function generateDeclarativeNetRequestRules(): any[] {
  console.log(
    "🔧 Generating declarativeNetRequest rules from index.lookup.json..."
  );

  const lookupIndexPath = path.join(PROJECT_ROOT, "dependencies", "index.lookup.json");

  if (!fs.existsSync(lookupIndexPath)) {
    console.warn(
      "⚠️  No dependencies/index.lookup.json found. Skipping rule generation."
    );
    return [];
  }

  const lookupIndex = JSON.parse(fs.readFileSync(lookupIndexPath, "utf8"));
  const rules: any[] = [];

  // Extract dependencies from the nested structure
  const urls = lookupIndex.urlToFile || {};

  let ruleId = 1;
  for (const [esmUrl, localFilename] of Object.entries(urls)) {
    // Create a redirect rule for each esm.sh URL -> local file
    rules.push({
      id: ruleId++,
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          extensionPath: `/dependencies/${localFilename}`,
        },
      },
      condition: {
        urlFilter: esmUrl,
        resourceTypes: ["script", "xmlhttprequest"],
      },
    });
  }

  console.log(`  ✅ Generated ${rules.length} redirect rules`);
  return rules;
}

function createChromeManifest() {
  const baseManifest = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "manifest.json"), "utf8")
  );

  // Chrome Manifest V3 configuration
  const chromeManifest = {
    ...baseManifest,
    manifest_version: 3,
    background: {
      service_worker: "background.js",
      type: "module",
    },
    permissions: [
      "declarativeNetRequest",
      "declarativeNetRequestFeedback", // For debugging intercepted requests
    ],
    host_permissions: [
      "<all_urls>", // Allow extension to work on all websites
    ],
    web_accessible_resources: [
      {
        resources: ["injected.js", "dependencies/*"], // All dependency files must be web-accessible for redirects
        matches: ["<all_urls>"],
      },
    ],
    declarative_net_request: {
      rule_resources: [
        {
          id: "ruleset_1",
          enabled: true,
          path: "rules.json",
        },
      ],
    },
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["content.js"],
        run_at: "document_start",
        all_frames: false,
      },
    ],
  };

  return chromeManifest;
}

function createFirefoxManifest() {
  const baseManifest = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "manifest.json"), "utf8")
  );
  delete baseManifest.action; // Remove Chrome-specific action key

  // Firefox Manifest V3 configuration (Firefox 109+ supports MV3)
  const firefoxManifest = {
    ...baseManifest,
    manifest_version: 3,
    background: {
      scripts: ["background.js"],
      type: "module",
    },
    action: {
      default_popup: "popup.html",
      default_title: "Sustainable Browser",
    },
    permissions: [
      "declarativeNetRequest",
      "declarativeNetRequestFeedback",
    ],
    host_permissions: [
      "<all_urls>", // Allow extension to work on all websites
    ],
    web_accessible_resources: [
      {
        resources: ["dependencies/*"], // All dependency files must be web-accessible for redirects
        matches: ["<all_urls>"],
      },
    ],
    // Firefox supports declarativeNetRequest since v113
    declarative_net_request: {
      rule_resources: [
        {
          id: "ruleset_1",
          enabled: true,
          path: "rules.json",
        },
      ],
    },
    browser_specific_settings: {
      gecko: {
        id: "sustainable-browser@example.com",
        strict_min_version: "113.0", // Updated for declarativeNetRequest support
      },
    },
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["content.js"],
        run_at: "document_start",
        all_frames: false,
      },
    ],
  };

  return firefoxManifest;
}

function copyCommonFiles(targetDir: string) {
  console.log(
    `📁 Copying common files to ${path.relative(PROJECT_ROOT, targetDir)}...`
  );

  // Copy HTML files
  copyFile(
    path.join(PROJECT_ROOT, "src", "extension", "popup.html"),
    path.join(targetDir, "popup.html")
  );

  // Generate and save declarativeNetRequest rules from dependencies/index.lookup.json
  console.log("  📋 Generating declarativeNetRequest rules...");
  const rules = generateDeclarativeNetRequestRules();
  const rulesPath = path.join(targetDir, "rules.json");
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2));
  console.log(`  ✅ Saved ${rules.length} rules to rules.json`);

  // Copy dependencies folder (containing leaf dependencies)
  const depsSourceDir = path.join(PROJECT_ROOT, "dependencies");
  const depsTargetDir = path.join(targetDir, "dependencies");

  if (fs.existsSync(depsSourceDir)) {
    console.log("  📦 Copying dependencies folder...");
    copyDirectory(depsSourceDir, depsTargetDir);

    // Count files (excluding index.lookup.json)
    const depFiles = fs
      .readdirSync(depsTargetDir)
      .filter((f) => f !== "index.lookup.json");
    console.log(`  ✅ Copied ${depFiles.length} dependency files`);
  } else {
    console.warn(
      "  ⚠️  No dependencies folder found. Run yarn download-deps first."
    );
  }

  // Copy icons folder
  const iconsSourceDir = path.join(PROJECT_ROOT, "icons");
  const iconsTargetDir = path.join(targetDir, "icons");
  copyDirectory(iconsSourceDir, iconsTargetDir);
}

function copyDirectory(source: string, target: string) {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }

  const files = fs.readdirSync(source);

  for (const file of files) {
    const sourcePath = path.join(source, file);
    const targetPath = path.join(target, file);

    const stat = fs.statSync(sourcePath);

    if (stat.isDirectory()) {
      continue;
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function generateBuildInfo(targetDir: string, browser: string) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")
  );

  const buildInfo = {
    name: packageJson.name,
    version: packageJson.version,
    browser: browser,
    buildTime: new Date().toISOString(),
    description: packageJson.description,
    manifestVersion: 3, // Both Chrome and Firefox now use Manifest V3
  };

  fs.writeFileSync(
    path.join(targetDir, "build-info.json"),
    JSON.stringify(buildInfo, null, 2)
  );
}

function buildChrome() {
  console.log("🌐 Building for Chrome (Manifest V3)...");
  ensureDir(CHROME_DIR);

  // Compile TypeScript
  console.log("🔨 Compiling TypeScript for Chrome...");
  try {
    execSync(
      `npx tsc --project tsconfig.chrome.production.json --outDir ${CHROME_DIR}`,
      {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
      }
    );

    // Move compiled files from extension/ subfolder to root
    const extensionDir = path.join(CHROME_DIR, "extension");
    if (fs.existsSync(extensionDir)) {
      const files = fs.readdirSync(extensionDir);
      for (const file of files) {
        fs.renameSync(
          path.join(extensionDir, file),
          path.join(CHROME_DIR, file)
        );
      }
      fs.rmdirSync(extensionDir);
    }
  } catch (error) {
    console.error("❌ TypeScript compilation failed");
    process.exit(1);
  }

  // Copy common files
  copyCommonFiles(CHROME_DIR);

  // Copy injected script
  fs.copyFileSync(
    path.join(PROJECT_ROOT, "src", "extension", "injected.js"),
    path.join(CHROME_DIR, "injected.js")
  );

  // Generate Chrome manifest
  const chromeManifest = createChromeManifest();
  fs.writeFileSync(
    path.join(CHROME_DIR, "manifest.json"),
    JSON.stringify(chromeManifest, null, 2)
  );
  console.log("  ✓ Generated Chrome manifest.json");

  // Generate build info
  generateBuildInfo(CHROME_DIR, "chrome");
  console.log("  ✓ Generated build-info.json");
}

function buildFirefox() {
  console.log("🦊 Building for Firefox (Manifest V3)...");
  ensureDir(FIREFOX_DIR);

  // Compile TypeScript
  console.log("🔨 Compiling TypeScript for Firefox...");
  try {
    execSync(
      `npx tsc --project tsconfig.firefox.production.json --outDir ${FIREFOX_DIR}`,
      {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
      }
    );

    // Move compiled files from extension/ subfolder to root
    const extensionDir = path.join(FIREFOX_DIR, "extension");
    if (fs.existsSync(extensionDir)) {
      const files = fs.readdirSync(extensionDir);
      for (const file of files) {
        fs.renameSync(
          path.join(extensionDir, file),
          path.join(FIREFOX_DIR, file)
        );
      }
      fs.rmdirSync(extensionDir);
    }
  } catch (error) {
    console.error("❌ TypeScript compilation failed");
    process.exit(1);
  }

  // Copy common files
  copyCommonFiles(FIREFOX_DIR);

  // Copy injected script
  fs.copyFileSync(
    path.join(PROJECT_ROOT, "src", "extension", "injected.js"),
    path.join(FIREFOX_DIR, "injected.js")
  );

  // Generate Firefox manifest
  const firefoxManifest = createFirefoxManifest();
  fs.writeFileSync(
    path.join(FIREFOX_DIR, "manifest.json"),
    JSON.stringify(firefoxManifest, null, 2)
  );
  console.log("  ✓ Generated Firefox manifest.json");

  // Generate build info
  generateBuildInfo(FIREFOX_DIR, "firefox");
  console.log("  ✓ Generated build-info.json");
}

function validateBuild(targetDir: string, browser: string) {
  const manifestPath = path.join(targetDir, "manifest.json");
  const backgroundPath = path.join(targetDir, "background.js");
  const dependenciesPath = path.join(targetDir, "dependencies");
  const injectedPath = path.join(targetDir, "injected.js");
  const rulesPath = path.join(targetDir, "rules.json");

  const issues = [];

  if (!fs.existsSync(manifestPath)) {
    issues.push("manifest.json missing");
  }

  if (!fs.existsSync(injectedPath)) {
    issues.push("injected.js missing");
  }
  
  if (!fs.existsSync(backgroundPath)) {
    issues.push("background.js missing");
  }

  if (!fs.existsSync(dependenciesPath)) {
    issues.push("dependencies folder missing");
  }

  if (!fs.existsSync(rulesPath)) {
    issues.push("rules.json missing");
  }

  if (issues.length > 0) {
    console.log(`  ❌ ${browser} build issues:`);
    issues.forEach((issue) => console.log(`     - ${issue}`));
    return false;
  }

  console.log(`  ✅ ${browser} build validated successfully`);
  return true;
}

function printInstructions() {
  console.log("\n📋 Testing Instructions:");
  console.log("");
  console.log("🌐 Chrome:");
  console.log("  1. Open chrome://extensions/");
  console.log('  2. Enable "Developer mode"');
  console.log('  3. Click "Load unpacked"');
  console.log(`  4. Select: ${path.relative(PROJECT_ROOT, CHROME_DIR)}`);
  console.log("");
  console.log("🦊 Firefox:");
  console.log("  1. Open about:debugging");
  console.log('  2. Click "This Firefox"');
  console.log('  3. Click "Load Temporary Add-on"');
  console.log(
    `  4. Select: ${path.relative(
      PROJECT_ROOT,
      path.join(FIREFOX_DIR, "index.lookup.json")
    )}`
  );
  console.log("");
  console.log("🚀 Web Store Build:");
  console.log("  Run: yarn build-webstore");
  console.log("");
}

function buildWebstorePackage() {
  console.log("📦 Creating web store package...");

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")
  );
  const zipFileName = `sustainable-browser-extension-v${packageJson.version}.zip`;
  const zipPath = path.join(DIST_DIR, zipFileName);

  // Remove existing ZIP
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
    console.log(`  ✓ Removed previous ZIP: ${zipFileName}`);
  }

  try {
    // Create ZIP from Chrome build
    execSync(`cd "${CHROME_DIR}" && zip -r "../${zipFileName}" .`, {
      stdio: "pipe",
    });

    // Get file size
    const stats = fs.statSync(zipPath);
    const sizeInMB = (stats.size / (1024 * 1024)).toFixed(2);

    console.log(`  ✓ Created web store package: ${zipFileName}`);
    console.log(`  📏 Package size: ${sizeInMB} MB`);
    console.log(`  📍 Location: ${zipPath}`);

    return zipPath;
  } catch (error) {
    console.error(
      "❌ Failed to create web store package:",
      (error as unknown as { message: string }).message
    );
    process.exit(1);
  }
}

function main() {
  console.log(
    "🚀 Building Sustainable Browser Extension for Multiple Browsers...\n"
  );

  // Build for both browsers
  buildChrome();
  buildFirefox();

  // Validate builds
  console.log("🔍 Validating builds...");
  const chromeValid = validateBuild(CHROME_DIR, "Chrome");
  const firefoxValid = validateBuild(FIREFOX_DIR, "Firefox");

  console.log("");
  if (chromeValid && firefoxValid) {
    console.log("✅ Cross-browser build completed successfully!");

    // Create webstore package if requested
    if (createWebstorePackage) {
      buildWebstorePackage();
    }

    printInstructions();
  } else {
    console.log("❌ Build completed with issues. Check the warnings above.");
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildChrome,
  buildFirefox,
  createChromeManifest,
  createFirefoxManifest,
};
