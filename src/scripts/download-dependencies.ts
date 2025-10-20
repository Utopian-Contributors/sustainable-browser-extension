import axios from "axios";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { DependencyUtils } from "./utils";

interface AnalyzedDependency {
  name: string;
  version: string;
  url: string;
  peerContext?: { [peerName: string]: string };
  peerDependencies?: { [packageName: string]: string };
  depth: number;
}

interface DependencyAnalysisResult {
  packages: AnalyzedDependency[]; // Packages to download with their peer context
  urlToFile: { [url: string]: string }; // URL -> filename mapping
  availableVersions: { [packageName: string]: string[] };
}

interface DependencyInfo {
  name: string;
  version: string;
  url: string;
  content: string;
  imports: string[];
  isLeaf: boolean;
  peerContext?: { [peerName: string]: string };
}

interface DependencyLookup {
  [esmUrlWithPeerContext: string]: string;
}

export class DependencyDownloader {
  private downloadedDeps: Map<string, DependencyInfo> = new Map();
  private dependencyLookup: DependencyLookup = {};
  private outputDir: string;
  private analysisPath: string;
  private dependencyAnalysis: DependencyAnalysisResult | null = null;
  // Track subpaths of managed packages separately (e.g., react/jsx-runtime)
  // Key: base package name (e.g., "react"), Value: Set of subpaths (e.g., "/jsx-runtime")
  private managedSubpaths: Map<string, Set<string>> = new Map();

  constructor(
    outputDir: string = "./dependencies",
    analysisPath: string = "./dependencies/index.lookup.json"
  ) {
    this.outputDir = outputDir;
    this.analysisPath = analysisPath;
    this.ensureOutputDir();
  }

  private ensureOutputDir(): void {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  async downloadAllDependencies(): Promise<void> {
    console.log("🚀 Starting dependency download...");

    // Step 1: Load dependency analysis
    console.log("📖 Loading dependency analysis from index.lookup.json...");
    this.loadDependencyAnalysis();

    // Step 2: Download all dependencies in order (sorted by depth)
    console.log("⬇️  Downloading dependencies...\n");
    await this.downloadFromAnalysis();

    // Step 3: Download managed subpaths for all versions
    console.log("\n📦 Downloading managed subpaths...");
    await this.downloadManagedSubpaths();

    // Step 4: Cleanup base dependencies that should not be saved
    this.cleanupBaseVersions();

    // Step 5: Save index
    console.log("\n📄 Saving lookup index...");
    this.saveIndexLookup(); // Save updated index.lookup.json with urlToFile

    console.log("\n✅ Dependency download complete!");
    console.log(
      `📊 Total dependencies downloaded: ${this.downloadedDeps.size}`
    );
    console.log(`📁 Files saved: ${Object.keys(this.dependencyLookup).length}`);
  }

  private loadDependencyAnalysis(): void {
    if (!fs.existsSync(this.analysisPath)) {
      throw new Error(
        `Dependency analysis file not found: ${this.analysisPath}\nPlease run 'yarn analyze:deps' first.`
      );
    }

    const analysisContent = fs.readFileSync(this.analysisPath, "utf8");
    this.dependencyAnalysis = JSON.parse(analysisContent);

    console.log(
      `  ✅ Loaded ${
        this.dependencyAnalysis!.packages.length
      } packages to download`
    );
  }

  private async downloadFromAnalysis(): Promise<void> {
    if (!this.dependencyAnalysis) {
      throw new Error("Dependency analysis not loaded");
    }

    const { packages } = this.dependencyAnalysis;

    // Packages are already sorted by depth in the analysis
    for (const pkg of packages) {
      const pkgKey = pkg.peerContext
        ? `${pkg.name}@${pkg.version} (depth ${
            pkg.depth
          }, peer context: ${JSON.stringify(pkg.peerContext)})`
        : `${pkg.name}@${pkg.version} (depth ${pkg.depth})`;

      console.log(`  📦 ${pkgKey}`);

      try {
        // Download the base URL (without peer context query params)
        const baseUrl = pkg.url.split("?")[0];
        const depInfo = await this.downloadDependency(baseUrl);

        // If package has peer context, create the peer context copy
        if (pkg.peerContext && Object.keys(pkg.peerContext).length > 0) {
          await this.createPeerContextCopy(depInfo, pkg.peerContext);
        }
      } catch (error) {
        console.error(`    ❌ Failed to download ${pkg.url}:`, error);
        throw error;
      }
    }
  }

  private async createPeerContextCopy(
    baseDepInfo: DependencyInfo,
    peerContext: { [peerName: string]: string }
  ): Promise<void> {
    // Create a unique key that includes peer context
    const peerContextKey = Object.entries(peerContext)
      .map(([name, version]) => `${name}=${version}`)
      .join("&");
    const contextualUrl = `${baseDepInfo.url}?${peerContextKey}`;

    // Check if already created
    if (this.downloadedDeps.has(contextualUrl)) {
      return;
    }

    // Create a copy of the dependency info with peer context
    const depInfoWithContext: DependencyInfo = {
      ...baseDepInfo,
      url: contextualUrl,
      peerContext: { ...peerContext },
    };

    // Store in the map
    this.downloadedDeps.set(contextualUrl, depInfoWithContext);

    // Save the file with peer context suffix
    this.saveDependency(depInfoWithContext);

    // Recursively create peer context copies for all nested dependencies
    for (const importUrl of baseDepInfo.imports) {
      // Only process esm.sh dependencies (skip external CDNs)
      if (importUrl.startsWith("https://esm.sh/")) {
        // Check if this is a subpath of a managed package
        const subpathInfo = this.extractSubpathInfo(importUrl);
        if (subpathInfo) {
          // Track this subpath for later downloading
          if (!this.managedSubpaths.has(subpathInfo.packageName)) {
            this.managedSubpaths.set(subpathInfo.packageName, new Set());
          }
          this.managedSubpaths
            .get(subpathInfo.packageName)!
            .add(subpathInfo.subpath);
          console.log(
            `    📌 Tracked subpath: ${subpathInfo.packageName}${subpathInfo.subpath}`
          );
          continue; // Don't create peer context copy for subpaths
        }

        // Get the base version of the nested dependency (it should already be downloaded)
        const nestedBaseDepInfo = this.downloadedDeps.get(importUrl);
        if (nestedBaseDepInfo) {
          // Recursively create a peer context copy for this nested dependency
          await this.createPeerContextCopy(nestedBaseDepInfo, peerContext);
        }
      }
    }
  }

  private async downloadDependency(
    url: string,
    retries: number = 3,
    retryDelay: number = 1000
  ): Promise<DependencyInfo> {
    // Check if already downloaded
    if (this.downloadedDeps.has(url)) {
      return this.downloadedDeps.get(url)!;
    }

    let lastError: Error | null = null;

    // Retry logic for network failures
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await axios.get(url, {
          timeout: 30000, // 30 second timeout
        });
        const content = response.data;

        // Extract package name and version from URL
        const name = DependencyUtils.extractPackageNameFromUrl(url);
        const version = DependencyUtils.extractVersionFromUrl(url);

        // Extract all imports from this file
        const allImports = this.extractImports(content, url);

        // Resolve relative imports to absolute URLs
        const absoluteImports = allImports.map((imp) =>
          DependencyUtils.resolveImportUrl(imp, url)
        );

        const depInfo: DependencyInfo = {
          name,
          version,
          url,
          content,
          imports: absoluteImports,
          isLeaf: false, // Will be determined later
        };

        // Store this dependency
        this.downloadedDeps.set(url, depInfo);

        // Recursively download nested dependencies
        for (const importUrl of absoluteImports) {
          // Only download esm.sh dependencies (skip external CDNs)
          if (
            importUrl.startsWith("https://esm.sh/") &&
            !this.downloadedDeps.has(importUrl)
          ) {
            try {
              await this.downloadDependency(importUrl, retries, retryDelay);
            } catch (error) {
              console.warn(`      ⚠️  Failed to download nested: ${importUrl}`);
            }
          }
        }

        // Save this dependency immediately after downloading
        this.saveDependency(depInfo);

        return depInfo;
      } catch (error: any) {
        lastError = error;

        // Check if it's a network error that we should retry
        const isRetryableError =
          error.code === "ETIMEDOUT" ||
          error.code === "ECONNRESET" ||
          error.code === "ENOTFOUND" ||
          error.code === "ECONNREFUSED" ||
          (error.response && error.response.status >= 500);

        if (isRetryableError && attempt < retries) {
          const delay = retryDelay * attempt; // Exponential backoff
          console.warn(
            `      ⚠️  Attempt ${attempt}/${retries} failed for ${url}, retrying in ${delay}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // If not retryable or out of retries, throw
        break;
      }
    }

    throw new Error(
      `Failed to download ${url} after ${retries} attempts: ${lastError}`
    );
  }

  private extractImports(content: string, baseUrl?: string): string[] {
    const rawImports = DependencyUtils.extractRawImportsWithBabel(content);

    // If we have a baseUrl, resolve relative imports to absolute URLs
    if (baseUrl) {
      return rawImports.map((imp) => DependencyUtils.resolveImportUrl(imp, baseUrl));
    }

    return rawImports;
  }

  private saveDependency(depInfo: DependencyInfo): void {
    const hasEsmShExports = DependencyUtils.hasEsmShExports(depInfo.content);
    depInfo.isLeaf = !hasEsmShExports;

    const hash = crypto
      .createHash("md5")
      .update(depInfo.url)
      .digest("hex")
      .substring(0, 8);

    const sanitizedName = depInfo.name.replace(/\//g, "-"); // Sanitize subpath modules
    const lockedVersion = DependencyUtils.cleanPackageVersion(depInfo.version); // Lock version

    let filename: string;

    // Find if this package is part of a sameVersionRequired group
    const sameVersionGroup = this.dependencyAnalysis?.availableVersions
      ? (() => {
          // Load cdn-mappings.json to get sameVersionRequired
          const cdnMappingsPath = path.join(process.cwd(), "cdn-mappings.json");
          if (fs.existsSync(cdnMappingsPath)) {
            const cdnMappings = JSON.parse(
              fs.readFileSync(cdnMappingsPath, "utf8")
            );
            return cdnMappings.sameVersionRequired?.find((group: string[]) =>
              group.includes(depInfo.name)
            );
          }
          return null;
        })()
      : null;

    // Filter peer context to exclude:
    // 1. The package itself
    // 2. Any packages in the same sameVersionRequired group
    const uniqueFilenamePeerContext = Object.entries(depInfo.peerContext ?? {})
      .map(([name, version]) => {
        // Exclude if it's the package itself
        if (name === depInfo.name) {
          return false;
        }
        // Exclude if it's in the same sameVersionRequired group
        if (sameVersionGroup && sameVersionGroup.includes(name)) {
          return false;
        }
        return `${name}-${version}`;
      })
      .filter(Boolean);

    const uniqueQueryPeerContext = Object.entries(depInfo.peerContext ?? {})
      .map(([name, version]) => {
        // Exclude if it's the package itself
        if (name === depInfo.name) {
          return false;
        }
        // Exclude if it's in the same sameVersionRequired group
        if (sameVersionGroup && sameVersionGroup.includes(name)) {
          return false;
        }
        return `${name}=${version}`;
      })
      .filter(Boolean);

    if (uniqueFilenamePeerContext.length > 0) {
      const peerContextSuffix = uniqueFilenamePeerContext.join("_");
      filename = `${sanitizedName}@${lockedVersion}_${peerContextSuffix}_${hash}.js`;
    } else {
      filename = `${sanitizedName}@${lockedVersion}_${hash}.js`;
    }

    // Create index entry (for index.lookup.json)
    let indexKey: string;
    if (uniqueQueryPeerContext && uniqueQueryPeerContext.length > 0) {
      const originalUrl = depInfo.url.split("?")[0];
      const peerQuery = uniqueQueryPeerContext.join("&");
      indexKey = peerQuery ? `${originalUrl}?${peerQuery}` : originalUrl;
    } else {
      indexKey = depInfo.url.split("?")[0];
    }

    if (!this.dependencyLookup[indexKey]) {
      this.dependencyLookup[indexKey] = filename;
      const filePath = path.join(this.outputDir, filename);
      fs.writeFileSync(filePath, depInfo.content);
      console.log(`    💾 ${filename} ${indexKey}`);
    }

    // Also add to urlToFile in the analysis (for index.lookup.json)
    if (!this.dependencyAnalysis!.urlToFile[indexKey]) {
      this.dependencyAnalysis!.urlToFile[indexKey] = filename;
    }
  }

  private saveIndexLookup(): void {
    if (!this.dependencyAnalysis) {
      console.warn("⚠️  No dependency analysis to save");
      return;
    }

    const indexContent = JSON.stringify(this.dependencyAnalysis, null, 2);
    fs.writeFileSync(this.analysisPath, indexContent);

    console.log(`📄 Index lookup saved: ${this.analysisPath}`);
    console.log(
      `   Contains ${this.dependencyAnalysis.packages.length} packages`
    );
    console.log(
      `   Contains ${
        Object.keys(this.dependencyAnalysis.urlToFile).length
      } URL -> file mappings`
    );
  }

  private cleanupBaseVersions() {
    // Read files in ./dependencies
    this.dependencyAnalysis?.packages.forEach((pck) => {
      if (pck && pck.peerContext && Object.keys(pck.peerContext).length > 0) {
        // Loop through dependency folder and delete base versions
        const dependencies = fs.readdirSync(this.outputDir);
        dependencies.forEach((file) => {
          const isBaseVersionFilename =
            Object.keys(pck.peerContext ?? {})
              .map((peer) => {
                return file.includes(peer);
              })
              .filter(Boolean).length !==
            Object.keys(pck.peerContext ?? {}).length;
          if (file.includes(pck.name) && isBaseVersionFilename) {
            console.debug("Removing base version of " + file);
            fs.rmSync(path.join(this.outputDir, file));
            Object.keys(this.dependencyAnalysis?.urlToFile ?? {}).forEach(
              (url) => {
                if (this.dependencyAnalysis?.urlToFile[url] === file) {
                  delete this.dependencyAnalysis.urlToFile[url];
                }
              }
            );
          }
        });
      }
    });
  }

  private extractSubpathInfo(
    url: string
  ): { packageName: string; version: string; subpath: string } | null {
    if (!this.dependencyAnalysis) {
      return null;
    }

    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;

      // Match patterns like: /react@19.0.0/jsx-runtime or /@emotion/is-prop-valid@1.4.0/some/subpath
      let match;
      let packageName: string;
      let version: string;
      let subpath: string;

      if (pathname.startsWith("/@")) {
        // Scoped package: /@scope/package@version/subpath
        match = pathname.match(/^\/@([^/]+)\/([^@/]+)@([^/]+)(\/[^?]+)?/);
        if (match) {
          packageName = `@${match[1]}/${match[2]}`;
          version = match[3];
          subpath = match[4] || "";
        } else {
          return null;
        }
      } else {
        // Regular package: /package@version/subpath
        match = pathname.match(/^\/([^@/]+)@([^/]+)(\/[^?]+)?/);
        if (match) {
          packageName = match[1];
          version = match[2];
          subpath = match[3] || "";
        } else {
          return null;
        }
      }

      // Check if this is actually a subpath (not a build artifact like /es2022/file.mjs)
      if (!subpath || this.isBuildArtifact(subpath)) {
        return null;
      }

      // Check if the base package is in our managed packages
      const isManaged = this.dependencyAnalysis.packages.some(
        (pkg) => pkg.name === packageName
      );

      if (isManaged) {
        return { packageName, version, subpath };
      }

      return null;
    } catch {
      return null;
    }
  }

  private isBuildArtifact(subpath: string): boolean {
    // Build artifacts typically have:
    // - File extensions: .js, .mjs, .cjs
    // - Build target folders: /es2022/, /es2020/, /dist/, /cjs/, /esm/
    return (
      subpath.endsWith(".js") ||
      subpath.endsWith(".mjs") ||
      subpath.endsWith(".cjs")
    );
  }

  private async downloadManagedSubpaths(): Promise<void> {
    if (!this.dependencyAnalysis) {
      return;
    }

    // For each tracked subpath, download it for all versions of the base package
    for (const [packageName, subpaths] of this.managedSubpaths.entries()) {
      console.log(`\n  📦 Processing subpaths for ${packageName}...`);

      // Get all versions of this package that we're managing
      const packageVersions = this.dependencyAnalysis.packages
        .filter((pkg) => pkg.name === packageName && !pkg.peerContext)
        .map((pkg) => pkg.version);

      // Remove duplicates
      const uniqueVersions = [...new Set(packageVersions)];

      for (const subpath of subpaths) {
        console.log(`    📄 Subpath: ${subpath}`);

        for (const version of uniqueVersions) {
          const subpathUrl = `https://esm.sh/${packageName}@${version}${subpath}`;

          try {
            // Check if already downloaded
            if (!this.downloadedDeps.has(subpathUrl)) {
              console.log(
                `      ⬇️  Downloading ${packageName}@${version}${subpath}`
              );
              await this.downloadDependency(subpathUrl);
            }
          } catch (error) {
            console.warn(`      ⚠️  Failed to download ${subpathUrl}:`, error);
            // Continue with other versions
          }
        }
      }
    }
  }
}

// CLI usage
if (require.main === module) {
  const downloader = new DependencyDownloader();
  downloader
    .downloadAllDependencies()
    .then(() => {
      console.log("All dependencies downloaded successfully!");
    })
    .catch((error) => {
      console.error("Download failed:", error);
      process.exit(1);
    });
}
