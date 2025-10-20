import fs from "fs";
import path from "path";
import { URL } from "url";
import { DependencyUtils } from "../utils";

interface DependencyInfo {
  name: string;
  version: string;
  url: string;
  content: string;
  imports: string[];
  isLeaf: boolean;
  peerContext?: { [peerName: string]: string };
}

interface LeafManifest {
  [esmUrlWithPeerContext: string]: string;
}

interface RelativeImportMapping {
  [depNameVersion: string]: NestedRelativeImports;
}

interface NestedRelativeImports {
  [pathSegment: string]: NestedRelativeImports | string;
}

interface AnalyzedDependency {
  name: string;
  version: string;
  url: string;
  peerContext?: { [peerName: string]: string };
  peerDependencies?: { [packageName: string]: string };
  depth: number;
}

interface CompleteManifest {
  packages: AnalyzedDependency[];
  urlToFile: LeafManifest;
  relativeImports: RelativeImportMapping;
  availableVersions: { [packageName: string]: string[] };
}

export class RelativeImportProcessor {
  private downloadedDeps: Map<string, DependencyInfo> = new Map();
  private relativeImportMappings: RelativeImportMapping = {};
  private baseUrlToContextualUrls: Map<string, string[]> = new Map();
  private manifestPath: string;
  private cdnMappingsPath: string;
  private sameVersionRequired: string[][] = [];

  constructor(
    manifestPath: string = "./dependencies/index.lookup.json",
    cdnMappingsPath: string = "./cdn-mappings.json"
  ) {
    this.manifestPath = manifestPath;
    this.cdnMappingsPath = cdnMappingsPath;
  }

  async processRelativeImports(): Promise<void> {
    console.log("🔗 Processing relative import mappings...");

    // Load existing manifest
    const manifest = this.loadManifest();
    const cdnMappings = this.loadCdnMappings();
    this.sameVersionRequired = cdnMappings.sameVersionRequired || [];

    // Rebuild downloadedDeps from the files
    console.log("📚 Rebuilding dependency information from files...");
    await this.rebuildDependencyInfo();

    // Build fast lookup for wrapper mappings
    console.log("📚 Building URL lookup index...");
    this.buildUrlLookupIndex();

    // Generate mappings for relative imports
    console.log("🔗 Generating relative import mappings...");
    this.generateRelativeImportMappings();

    // Update manifest with new relative import mappings
    manifest.relativeImports = this.relativeImportMappings;
    this.saveManifest(manifest);

    console.log("✅ Relative import processing complete!");
  }

  private loadManifest(): CompleteManifest {
    if (!fs.existsSync(this.manifestPath)) {
      throw new Error(`Manifest not found at ${this.manifestPath}`);
    }

    const manifestContent = fs.readFileSync(this.manifestPath, "utf8");
    return JSON.parse(manifestContent);
  }

  private loadCdnMappings(): { sameVersionRequired: string[][] } {
    if (!fs.existsSync(this.cdnMappingsPath)) {
      throw new Error(`CDN mappings not found at ${this.cdnMappingsPath}`);
    }

    const cdnContent = fs.readFileSync(this.cdnMappingsPath, "utf8");
    return JSON.parse(cdnContent);
  }

  private async rebuildDependencyInfo(): Promise<void> {
    const manifest = this.loadManifest();
    const dependenciesDir = path.dirname(this.manifestPath);

    // Iterate through all urlToFile entries to load all downloaded files
    for (const [esmUrl, filename] of Object.entries(manifest.urlToFile)) {
      const filePath = path.join(dependenciesDir, filename);

      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf8");

        // Extract package name and version from URL
        const name = DependencyUtils.extractPackageNameFromUrl(esmUrl);
        const version =
          DependencyUtils.extractVersionFromUrl(esmUrl) || "latest";

        // Extract peer context from URL query parameters
        const peerContext = this.extractPeerContextFromUrl(esmUrl);

        // Extract all imports from this file
        const rawImports = DependencyUtils.extractRawImportsWithBabel(content);

        const depInfo: DependencyInfo = {
          name,
          version,
          url: esmUrl,
          content,
          imports: rawImports,
          isLeaf: !DependencyUtils.hasEsmShExports(content),
          peerContext,
        };

        this.downloadedDeps.set(esmUrl, depInfo);
        console.log(`  📄 Loaded: ${name}@${version} (${filename})`);
      } else {
        console.warn(`  ⚠️  File not found: ${filePath}`);
      }
    }

    console.log(`  ✅ Loaded ${this.downloadedDeps.size} dependency files`);
  }

  private extractPeerContextFromUrl(url: string): {
    [peerName: string]: string;
  } {
    try {
      const urlObj = new URL(url);
      const peerContext: { [peerName: string]: string } = {};

      for (const [key, value] of urlObj.searchParams.entries()) {
        peerContext[key] = value;
      }

      return peerContext;
    } catch (error) {
      return {};
    }
  }

  private buildUrlLookupIndex(): void {
    // Build a fast lookup map from base URLs to their contextual URLs
    this.baseUrlToContextualUrls.clear();

    for (const [contextualUrl, depInfo] of this.downloadedDeps.entries()) {
      const baseUrl = contextualUrl.split("?")[0];

      if (!this.baseUrlToContextualUrls.has(baseUrl)) {
        this.baseUrlToContextualUrls.set(baseUrl, []);
      }
      this.baseUrlToContextualUrls.get(baseUrl)!.push(contextualUrl);
    }

    console.log(
      `  📚 Built lookup index for ${this.baseUrlToContextualUrls.size} unique base URLs`
    );
  }

  private generateRelativeImportMappings(): void {
    // Create nested mappings for relative imports to their resolved absolute URLs
    for (const [parentUrl, depInfo] of this.downloadedDeps.entries()) {
      const originalImports = depInfo.imports; // Use the raw imports we extracted

      // Find if this package is part of a sameVersionRequired group
      const sameVersionGroup = (() => {
        // Load cdn-mappings.json to get sameVersionRequired
        return this.sameVersionRequired?.find((group: string[]) =>
          group.includes(depInfo.name)
        );
      })();

      const uniquePeerContext = Object.entries(depInfo.peerContext ?? {})
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

      // Build dep key with peer context if it exists
      let depKey = `${depInfo.name}@${depInfo.version}`;
      if (uniquePeerContext && uniquePeerContext.length > 0) {
        // Add peer context to the key: framer-motion@12.23.23_react-19.2.0
        const peerContextSuffix = uniquePeerContext.join("_");
        depKey = `${depKey}_${peerContextSuffix}`;
      }

      console.log(
        `  🔍 Processing ${depKey} (${originalImports.length} imports)`
      );

      for (const relativeImport of originalImports) {
        // Check if it's a relative import
        if (
          relativeImport.startsWith("./") ||
          relativeImport.startsWith("../")
        ) {
          try {
            // Use the base URL without query parameters for resolving relative imports
            const baseParentUrl = parentUrl.split("?")[0];

            // Resolve to absolute URL
            const absoluteUrl = DependencyUtils.resolveImportUrl(
              relativeImport,
              baseParentUrl
            );

            // Check if we have this URL in our dependencies
            // First try to find with the same peer context as the current file
            let matchedUrl: string | null = null;

            // Extract peer context from the current file URL (parentUrl)
            const currentPeerContext = depInfo.peerContext || {};

            // First try to find a URL with matching peer context
            if (Object.keys(currentPeerContext).length > 0) {
              const targetQuery =
                this.createSimplifiedPeerContextQuery(currentPeerContext);
              const expectedContextualUrl = targetQuery
                ? `${absoluteUrl}?${targetQuery}`
                : absoluteUrl;

              if (this.downloadedDeps.has(expectedContextualUrl)) {
                matchedUrl = expectedContextualUrl;
                console.log(
                  `    ✅ Found contextual match: ${relativeImport} -> ${expectedContextualUrl}`
                );
              }
            }

            // Fallback: try exact match without context
            if (!matchedUrl && this.downloadedDeps.has(absoluteUrl)) {
              matchedUrl = absoluteUrl;
              console.log(
                `    ✅ Found exact match: ${relativeImport} -> ${absoluteUrl}`
              );
            }

            // Fallback: try exact match from baseUrl lookup
            if (!matchedUrl) {
              const baseUrl = absoluteUrl.split("?")[0];
              const availableUrls =
                (this.baseUrlToContextualUrls.get(baseUrl) || []);
              matchedUrl = availableUrls.find((url) => {
                return this.downloadedDeps.has(url) && url === absoluteUrl.split("?")[0];
              }) ?? null;
            }

            if (!matchedUrl) {
              // Fail loudly with detailed error information
              const errorMsg = [
                `❌ No match found for relative import "${relativeImport}"`,
                `   From: ${depInfo.name}@${depInfo.version}`,
                `   Resolved to: ${absoluteUrl}`,
                `   Expected contextual: ${
                  Object.keys(currentPeerContext).length > 0
                    ? absoluteUrl +
                      "?" +
                      this.createSimplifiedPeerContextQuery(currentPeerContext)
                    : "none (no peer context)"
                }`,
                `   Available URLs with same base:`,
              ].join("\n");

              const baseUrl = absoluteUrl.split("?")[0];
              const availableUrls =
                this.baseUrlToContextualUrls.get(baseUrl) || [];
              console.error(errorMsg);
              availableUrls.forEach((url) => {
                console.error(`     - ${url}`);
              });

              throw new Error(
                `Failed to resolve relative import "${relativeImport}" from ${depInfo.name}@${depInfo.version}`
              );
            }

            // Initialize the dependency group if it doesn't exist
            if (!this.relativeImportMappings[depKey]) {
              this.relativeImportMappings[depKey] = {};
            }

            // Convert the resolved absolute URL to a path within the package structure
            const packagePath = DependencyUtils.extractPackagePathFromUrl(
              matchedUrl,
              depInfo.name
            );
            if (!packagePath) {
              throw new Error(
                `Failed to extract package path from "${matchedUrl}" for package "${depInfo.name}"`
              );
            }

            // Create nested structure using the absolute package path
            // Use the matchedUrl (which includes peer context) as the target
            this.setNestedPath(
              this.relativeImportMappings[depKey],
              packagePath,
              matchedUrl
            );
            console.log(
              `    📁 Mapped: ${relativeImport} -> ${packagePath} = ${matchedUrl}`
            );
          } catch (error) {
            // Fail loudly on any error
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            console.error(
              `\n❌ Fatal error processing relative import "${relativeImport}" from ${depInfo.name}@${depInfo.version}:`
            );
            console.error(`   ${errorMsg}\n`);
            throw error;
          }
        }
      }
    }

    const totalMappings = this.countNestedMappings(this.relativeImportMappings);

    console.log(
      `  🔗 Generated ${totalMappings} relative import mappings across ${
        Object.keys(this.relativeImportMappings).length
      } dependencies`
    );
  }

  private createSimplifiedPeerContextQuery(peerContext: {
    [peerName: string]: string;
  }): string {
    // Simple implementation - just join all peer context entries
    return Object.entries(peerContext || {})
      .map(([name, version]) => `${name}=${version}`)
      .join("&");
  }

  private setNestedPath(
    obj: NestedRelativeImports,
    path: string,
    value: string
  ): void {
    // Split the path into segments
    const pathSegments = path.split("/").filter((segment) => segment !== "");

    let current = obj;

    // Navigate to the correct nested level
    for (let i = 0; i < pathSegments.length - 1; i++) {
      const segment = pathSegments[i];
      if (!(segment in current)) {
        current[segment] = {};
      }
      current = current[segment] as NestedRelativeImports;
    }

    // Set the final value
    const finalSegment = pathSegments[pathSegments.length - 1];
    current[finalSegment] = value;
  }

  private countNestedMappings(mappings: RelativeImportMapping): number {
    let count = 0;

    for (const depMappings of Object.values(mappings)) {
      count += this.countNestedValues(depMappings);
    }

    return count;
  }

  private countNestedValues(obj: NestedRelativeImports): number {
    let count = 0;

    for (const value of Object.values(obj)) {
      if (typeof value === "string") {
        count++;
      } else {
        count += this.countNestedValues(value);
      }
    }

    return count;
  }

  private saveManifest(manifest: CompleteManifest): void {
    const manifestContent = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(this.manifestPath, manifestContent);

    console.log(`📄 Updated manifest: ${this.manifestPath}`);

    const totalRelativeMappings = this.countNestedMappings(
      manifest.relativeImports
    );
    console.log(
      `   Contains ${totalRelativeMappings} relative import mappings across ${
        Object.keys(manifest.relativeImports).length
      } dependencies`
    );
  }
}

// CLI usage
if (require.main === module) {
  const processor = new RelativeImportProcessor();
  processor
    .processRelativeImports()
    .then(() => {
      console.log("✅ Relative import processing completed successfully!");
    })
    .catch((error) => {
      console.error("❌ Processing failed:", error);
      process.exit(1);
    });
}
