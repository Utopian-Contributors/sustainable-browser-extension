import * as fs from "fs";
import * as path from "path";
import { AnalyzedDependency, LookupIndex, NestedRelativeImports } from "../interfaces";
import { buildDepNameVersionKeyWithPeerContext, DependencyUtils, parseDepFilename } from "../utils";

export class DependencyImportProcessor {
  private lookupIndex: LookupIndex;
  private outputDir: string;
  private lookupIndexPath: string;
  private processedPackages: Set<AnalyzedDependency> = new Set();

  constructor(
    lookupIndexPath: string = "./dependencies/index.lookup.json",
    outputDir: string = "./dependencies"
  ) {
    this.outputDir = outputDir;
    this.lookupIndexPath = lookupIndexPath;

    if (!fs.existsSync(lookupIndexPath)) {
      throw new Error(`LookupIndex file not found: ${lookupIndexPath}`);
    }

    this.lookupIndex = JSON.parse(fs.readFileSync(lookupIndexPath, "utf8"));
  }

  processAllDependencies(): void {
    console.log("🔧 Starting incremental dependency postprocessing...\n");

    const files = fs.readdirSync(this.outputDir);
    const jsFiles = files.filter((f) => f.endsWith(".js"));

    let totalFiles = 0;
    let skippedFiles = 0;
    let processedFiles = 0;
    let filesWithImports = 0;
    let totalReplacements = 0;

    // We'll resolve package entries directly from filenames when needed
    // (keeps logic simple and avoids building a large map)

    for (const filename of jsFiles) {
      totalFiles++;
      
      // Resolve package entry for this filename (by parsing the filename)
      let pkg;
      const parsed = parseDepFilename(filename);
      if (parsed) {
        const baseDepNameVersion = parsed.baseDepNameVersion;
        const atIdx = baseDepNameVersion.lastIndexOf("@");
        if (atIdx > 0) {
          const pkgName = baseDepNameVersion.substring(0, atIdx);
          const pkgVersion = baseDepNameVersion.substring(atIdx + 1);
          pkg = this.lookupIndex.packages.find(
            (p) => p.name === pkgName && p.version === pkgVersion
          );
        }
      }

      if (pkg && pkg.transformed) {
        skippedFiles++;
        continue;
      }

      const filePath = path.join(this.outputDir, filename);
      let content = fs.readFileSync(filePath, "utf8");
      const originalImports =
        DependencyUtils.extractRawImportsWithBabel(content);

      if (originalImports.length === 0) {
        // Track this package for marking as transformed later
        if (pkg) {
          this.processedPackages.add(pkg);
        }
        continue;
      }

      filesWithImports++;
      processedFiles++;
      console.log(`📄 ${filename} (${originalImports.length} imports):`);

      // Extract dependency name+version and peer context from filename to find the correct relative imports group
      const depFilenameInfo = parseDepFilename(filename);
      const baseDepNameVersion = depFilenameInfo ? depFilenameInfo.baseDepNameVersion : null;
      const peerContext = depFilenameInfo ? depFilenameInfo.peerContext : [];

      // Build the full key including peer context for looking up in relativeImports
      const depNameVersionKey = baseDepNameVersion
        ? buildDepNameVersionKeyWithPeerContext(
            baseDepNameVersion,
            peerContext
          )
        : null;

      let modified = false;

      for (const originalImport of originalImports) {
        let newImport: string | null = null;

        if (originalImport.startsWith("/dependencies")) {
          continue;
        }

        if (originalImport.startsWith("https://esm.sh/")) {
          // Replace absolute esm.sh imports with local dependency files
          if (this.lookupIndex.urlToFile[originalImport]) {
            const filename = this.lookupIndex.urlToFile[originalImport];
            newImport = `/dependencies/${filename}`;
            console.log(`  - esm.sh: "${originalImport}" → "${newImport}"`);
          }
        } else if (originalImport.startsWith("/")) {
          // Replace absolute paths with local dependency files
          // Find the best matching URL in lookup index and use its filename
          let matchingUrl: string | null = null;

          // First try exact match
          for (const url of Object.keys(this.lookupIndex.urlToFile)) {
            if (url.includes(originalImport)) {
              matchingUrl = url;
              break;
            }
          }

          // If no exact match, try equivalent import matching (with version constraint handling)
          if (!matchingUrl) {
            matchingUrl = this.findBestMatchingUrl(originalImport);
          }

          if (matchingUrl && this.lookupIndex.urlToFile[matchingUrl]) {
            const filename = this.lookupIndex.urlToFile[matchingUrl];
            newImport = `/dependencies/${filename}`;
            console.log(`  - absolute: "${originalImport}" → "${newImport}"`);
          } else {
            console.log(`  - absolute: "${originalImport}" (no mapping found)`);
            throw new Error(
              `No mapping found for absolute import: ${originalImport}`
            );
          }
          if (originalImport.includes("jsx-runtime")) {
            console.debug(
              `Debugging special case for react jsx-runtime import ${JSON.stringify(
                {
                  originalImport,
                  matchingUrl,
                  newImport,
                }
              )}`
            );
          }
        } else if (
          originalImport.startsWith("./") ||
          originalImport.startsWith("../")
        ) {
          // Replace relative imports with dependency paths using lookup index
          let absoluteUrl: string | null = null;

          console.debug(
            filename,
            depNameVersionKey,
            originalImport,
            baseDepNameVersion
          );

          // Look up relative import in the nested dependency structure using the full key with peer context
          if (
            depNameVersionKey &&
            this.lookupIndex.relativeImports[depNameVersionKey]
          ) {
            try {
              absoluteUrl = this.getNestedImportPath(
                originalImport,
                this.lookupIndex.relativeImports[depNameVersionKey],
                filename
              );
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              console.log(`  🔍 Failed to resolve: ${errorMessage}`);
              throw error; // Re-throw to fail fast and help with debugging
            }
          }

          if (absoluteUrl && this.lookupIndex.urlToFile[absoluteUrl]) {
            const targetFilename = this.lookupIndex.urlToFile[absoluteUrl];
            newImport = `/dependencies/${targetFilename}`;
            console.log(`  - relative: "${originalImport}" → "${newImport}"`);
          } else {
            console.log(
              `  - relative: "${originalImport}" (no mapping found${
                depNameVersionKey ? ` for ${depNameVersionKey}` : ""
              })`
            );
            throw new Error(
              `No mapping found for relative import: ${originalImport}`
            );
          }
        }

        if (newImport && newImport !== originalImport) {
          // Replace the import in the content
          const importRegex = new RegExp(
            `((?:import|export).*?from\\s*["'])${this.escapeRegExp(
              originalImport
            )}(["'])`,
            "g"
          );
          const dynamicImportRegex = new RegExp(
            `(import\\s*\\(\\s*["'])${this.escapeRegExp(
              originalImport
            )}(["']\\s*\\))`,
            "g"
          );
          const bareImportRegex = new RegExp(
            `(import\\s*["'])${this.escapeRegExp(originalImport)}(["'];?)`,
            "g"
          );
          const minifiedImportRegex = new RegExp(
            `((?:import|export).*?from["'])${this.escapeRegExp(
              originalImport
            )}(["'])`,
            "g"
          );

          const beforeLength = content.length;
          content = content.replace(importRegex, `$1${newImport}$2`);
          content = content.replace(dynamicImportRegex, `$1${newImport}$2`);
          content = content.replace(bareImportRegex, `$1${newImport}$2`);
          content = content.replace(minifiedImportRegex, `$1${newImport}$2`);
          const afterLength = content.length;

          if (beforeLength !== afterLength) {
            modified = true;
            totalReplacements++;
          }
        }
      }

      if (modified) {
        fs.writeFileSync(filePath, content);
      }

      // Track this package for marking as transformed later
      if (pkg) {
        this.processedPackages.add(pkg);
      }
    }

    console.log(`\n📊 Transformation summary:`);
    console.log(`   Total files: ${totalFiles}`);
    console.log(`   Skipped (already transformed): ${skippedFiles}`);
    console.log(`   Processed: ${processedFiles}`);
    console.log(`   Files with imports: ${filesWithImports}`);
    console.log(`   Total replacements made: ${totalReplacements}`);

    // Mark all processed packages as transformed
    if (this.processedPackages.size > 0) {
      console.log(`\n✅ Marking ${this.processedPackages.size} packages as transformed...`);
      for (const pkg of this.processedPackages) {
        pkg.transformed = true;
      }
      this.saveLookupIndex();
      console.log(`   Saved lookup index: ${this.lookupIndexPath}`);
    }

    const totalRelativeMappings = this.countNestedMappings(
      this.lookupIndex.relativeImports
    );
    console.log(
      `\nℹ️  Relative import mappings available: ${totalRelativeMappings} across ${
        Object.keys(this.lookupIndex.relativeImports).length
      } dependencies`
    );
  }

  private saveLookupIndex(): void {
    const manifestContent = JSON.stringify(this.lookupIndex, null, 2);
    fs.writeFileSync(this.lookupIndexPath, manifestContent);
  }

  private findBestMatchingUrl(importPath: string): string | null {
    // Find the best matching URL for an import path
    // Prioritizes subpath matches over base package matches
    // Example: "/react@^19.2.0/jsx-runtime?target=es2022" should match
    //          "https://esm.sh/react@19.2.0/jsx-runtime" over
    //          "https://esm.sh/react@19.2.0/es2022/react.mjs"

    const allUrls = Object.keys(this.lookupIndex.urlToFile);
    const candidates: Array<{ url: string; score: number }> = [];

    // Extract package name and subpath from import
    const { packageName, subpath } = this.extractPackageAndSubpath(importPath);
    if (!packageName) return null;

    // Score each URL
    for (const url of allUrls) {
      const matchResult = this.matchUrlToImport(url, packageName, subpath);
      if (matchResult.matches) {
        candidates.push({ url, score: matchResult.score });
      }
    }

    if (candidates.length === 0) return null;

    // Sort by score (highest first) and return the best match
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].url;
  }

  private extractPackageAndSubpath(importPath: string): {
    packageName: string;
    subpath: string;
  } {
    // Extract package name and subpath from import path
    // Examples:
    //   "/react@^19.1.1/jsx-runtime?target=es2022" -> { packageName: "react", subpath: "/jsx-runtime" }
    //   "/motion-utils@^12.23.6?target=es2022" -> { packageName: "motion-utils", subpath: "" }
    //   "/@emotion/is-prop-valid@^1.4.0?target=es2022" -> { packageName: "@emotion/is-prop-valid", subpath: "" }
    //   "/react@19.2.0/es2022/react.mjs" -> { packageName: "react", subpath: "/es2022/react.mjs" }

    let packageName = "";
    let subpath = "";

    // Handle scoped packages
    if (importPath.startsWith("/@")) {
      // Scoped package like "/@emotion/is-prop-valid@^1.4.0?target=es2022"
      const match = importPath.match(
        /^\/(@[^/]+\/[^@/?]+)(?:@[^/?]*)?([/?].*)?$/
      );
      if (match) {
        packageName = match[1];
        subpath = match[2] || "";
        // Remove query parameters from subpath
        subpath = subpath.split("?")[0];
      }
    } else {
      // Regular package like "/react@^19.1.1/jsx-runtime?target=es2022"
      const match = importPath.match(/^\/([^@/?]+)(?:@[^/?]*)?([/?].*)?$/);
      if (match) {
        packageName = match[1];
        subpath = match[2] || "";
        // Remove query parameters from subpath
        subpath = subpath.split("?")[0];
      }
    }

    return { packageName, subpath };
  }

  private matchUrlToImport(
    manifestUrl: string,
    packageName: string,
    subpath: string
  ): { matches: boolean; score: number } {
    // Check if a lookup index URL matches the package name and subpath
    // Returns a score where higher = better match
    // Score breakdown:
    //   - Package name match: 1 point
    //   - Exact subpath match: 100 points
    //   - No subpath in import, any URL for package: 1 point

    try {
      const urlObj = new URL(manifestUrl);
      const pathParts = urlObj.pathname.split("/").filter((p) => p);

      if (urlObj.hostname !== "esm.sh" || pathParts.length === 0) {
        return { matches: false, score: 0 };
      }

      const firstPart = pathParts[0];
      let urlPackageName = "";
      let urlSubpath = "";

      if (firstPart.startsWith("@")) {
        // Scoped package like @emotion/is-prop-valid@1.4.0
        if (pathParts.length > 1) {
          urlPackageName = `${firstPart}/${pathParts[1].split("@")[0]}`;
          // Get remaining path after package@version
          const remainingParts = pathParts.slice(1);
          if (remainingParts.length > 0) {
            // Remove version from first part
            const versionRemoved = remainingParts[0].includes("@")
              ? remainingParts.slice(1)
              : remainingParts;
            urlSubpath =
              versionRemoved.length > 0 ? "/" + versionRemoved.join("/") : "";
          }
        }
      } else {
        // Regular package like react@19.2.0/jsx-runtime
        urlPackageName = firstPart.split("@")[0];
        // Get remaining path after package@version
        const remainingParts = pathParts.slice(1);
        urlSubpath =
          remainingParts.length > 0 ? "/" + remainingParts.join("/") : "";
      }

      // Check if package name matches
      if (urlPackageName !== packageName) {
        return { matches: false, score: 0 };
      }

      // Package matches, now check subpath
      if (!subpath || subpath === "/") {
        // No specific subpath requested, any URL for this package is valid
        return { matches: true, score: 1 };
      }

      // Normalize subpaths for comparison (remove leading slash if present)
      const normalizedImportSubpath = subpath.startsWith("/")
        ? subpath.substring(1)
        : subpath;
      const normalizedUrlSubpath = urlSubpath.startsWith("/")
        ? urlSubpath.substring(1)
        : urlSubpath;

      // Check for exact subpath match
      if (normalizedUrlSubpath === normalizedImportSubpath) {
        return { matches: true, score: 100 };
      }

      // Check if URL subpath starts with import subpath (e.g., import wants /jsx-runtime, URL has /jsx-runtime or /es2022/jsx-runtime.mjs)
      if (normalizedUrlSubpath.includes(normalizedImportSubpath)) {
        return { matches: true, score: 50 };
      }

      // Package matches but subpath doesn't - low score
      return { matches: true, score: 1 };
    } catch (e) {
      return { matches: false, score: 0 };
    }
  }

  private getNestedImportPath(
    relativePath: string,
    nestedImports: NestedRelativeImports,
    currentFilename: string
  ): string | null {
    try {
      // Step 1: Find the current file's ESM URL from the lookup index
      const currentFileUrl = this.findCurrentFileUrl(currentFilename);
      if (!currentFileUrl) {
        throw new Error(
          `Cannot find current file URL for ${currentFilename} in dependencies`
        );
      }

      // Step 2: Resolve the relative path to an absolute URL
      // Determine if currentFileUrl points to a file or directory and handle accordingly
      let baseUrl: string;

      if (currentFileUrl.match(/\.(js|mjs|ts|css|json|html|htm)$/i)) {
        // URL has an extension, so it's a file - strip the filename to get directory
        const lastSlashIndex = currentFileUrl.lastIndexOf("/");
        if (lastSlashIndex !== -1) {
          baseUrl = currentFileUrl.substring(0, lastSlashIndex + 1);
        } else {
          baseUrl = currentFileUrl + "/";
        }
      } else {
        // URL doesn't have an extension, so it's a directory - ensure trailing slash
        baseUrl = currentFileUrl.endsWith("/")
          ? currentFileUrl
          : currentFileUrl + "/";
      }

      const absoluteUrl = new URL(relativePath, baseUrl).href;

      // Step 3: Extract package-name from the filename
      const depFilenameInfo = parseDepFilename(currentFilename);
      if (!depFilenameInfo) {
        throw new Error(
          `Cannot extract dependency name+version from filename ${currentFilename}`
        );
      }

      const baseDepNameVersion = depFilenameInfo.baseDepNameVersion;
      // Extract package name correctly for both scoped and regular packages
      // "@antfu/ni@25.0.0" -> "@antfu/ni"
      // "react@19.2.0" -> "react"
      let packageName: string;
      if (baseDepNameVersion.startsWith("@")) {
        // Scoped package: find the second @ and get everything before it
        const secondAtIndex = baseDepNameVersion.indexOf("@", 1);
        packageName = secondAtIndex !== -1 
          ? baseDepNameVersion.substring(0, secondAtIndex)
          : baseDepNameVersion;
      } else {
        // Regular package: get everything before the first @
        packageName = baseDepNameVersion.split("@")[0];
      }
      
      const packagePath = DependencyUtils.extractPackagePathFromUrl(
        absoluteUrl,
        packageName
      );
      if (!packagePath) {
        throw new Error(
          `Cannot extract package path from URL ${absoluteUrl} for package ${packageName}`
        );
      }

      // Step 4: Traverse the nested structure using the package path
      const esmUrl = this.traverseNestedImports(nestedImports, packagePath);
      if (!esmUrl) {
        throw new Error(
          `Cannot find ESM URL for package path "${packagePath}" in nested imports structure`
        );
      }

      return esmUrl;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        `🔴 Failed to resolve relative import "${relativePath}" from ${currentFilename}:`,
        errorMessage
      );
      throw error; // Re-throw to fail fast and help with debugging
    }
  }

  private findCurrentFileUrl(filename: string): string | null {
    // Find the esm.sh URL that maps to this filename
    for (const [esmUrl, localFilename] of Object.entries(
      this.lookupIndex.urlToFile
    )) {
      if (localFilename === filename) {
        return esmUrl;
      }
    }
    return null;
  }

  private traverseNestedImports(
    nestedImports: NestedRelativeImports,
    packagePath: string
  ): string | null {
    const pathSegments = packagePath.split("/").filter((s) => s.length > 0);
    let current: any = nestedImports;

    // Navigate through each path segment
    for (const segment of pathSegments) {
      if (current[segment] !== undefined) {
        if (typeof current[segment] === "string") {
          // Found the final esm.sh URL
          return current[segment];
        } else if (typeof current[segment] === "object") {
          current = current[segment];
        } else {
          return null;
        }
      } else {
        return null;
      }
    }

    // If we've traversed all segments but are still in an object,
    // look for common file patterns or return the first string value
    if (typeof current === "object") {
      const keys = Object.keys(current);
      for (const key of keys) {
        if (typeof current[key] === "string") {
          return current[key];
        }
      }
    }

    return null;
  }

  private countNestedMappings(nestedImports: NestedRelativeImports): number {
    let count = 0;

    const traverse = (obj: any) => {
      for (const key in obj) {
        const value = obj[key];
        if (typeof value === "string") {
          count++;
        } else if (typeof value === "object") {
          traverse(value);
        }
      }
    };

    traverse(nestedImports);
    return count;
  }

  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

// CLI usage
if (require.main === module) {
  const processor = new DependencyImportProcessor();
  processor.processAllDependencies();
}
