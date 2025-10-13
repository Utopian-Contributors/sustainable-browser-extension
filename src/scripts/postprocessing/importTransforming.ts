import * as fs from "fs";
import * as path from "path";

interface Manifest {
  dependencies: { [esmUrl: string]: string }; // Maps esm.sh URL -> local file path
  relativeImports: {
    [depNameVersion: string]: NestedRelativeImports;
  }; // Maps dependency name+version -> nested relative imports
}

interface NestedRelativeImports {
  [pathSegment: string]: NestedRelativeImports | string; // Nested structure where final values are URLs
}

export class DependencyImportProcessor {
  private manifest: Manifest;
  private outputDir: string;

  constructor(
    manifestPath: string = "./dependencies/manifest.json",
    outputDir: string = "./dependencies"
  ) {
    this.outputDir = outputDir;

    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Manifest file not found: ${manifestPath}`);
    }

    this.manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  }

  processAllDependencies(): void {
    console.log("🔧 Starting dependency postprocessing...\n");

    const files = fs.readdirSync(this.outputDir);
    const jsFiles = files.filter((f) => f.endsWith(".js"));

    let totalFiles = 0;
    let filesWithImports = 0;
    let totalReplacements = 0;

    for (const filename of jsFiles) {
      totalFiles++;
      const filePath = path.join(this.outputDir, filename);
      let content = fs.readFileSync(filePath, "utf8");
      const originalImports = this.extractRawImports(content);

      if (originalImports.length === 0) continue;

      filesWithImports++;
      console.log(`📄 ${filename} (${originalImports.length} imports):`);

      // Extract dependency name+version from filename to find the correct relative imports group
      const depNameVersion = this.extractDepNameVersionFromFilename(filename);

      let modified = false;

      for (const originalImport of originalImports) {
        let newImport: string | null = null;

        if (originalImport.startsWith("/dependencies")) {
          continue;
        }

        if (originalImport.startsWith("https://esm.sh/")) {
          // Replace absolute esm.sh imports with local dependency files
          if (this.manifest.dependencies[originalImport]) {
            const filename = this.manifest.dependencies[originalImport];
            newImport = `/dependencies/${filename}`;
            console.log(`  - esm.sh: "${originalImport}" → "${newImport}"`);
          }
        } else if (originalImport.startsWith("/")) {
          // Replace absolute paths with local dependency files
          // Find the best matching URL in manifest and use its filename
          let matchingUrl: string | null = null;

          // First try exact match
          for (const url of Object.keys(this.manifest.dependencies)) {
            if (url.includes(originalImport)) {
              matchingUrl = url;
              break;
            }
          }

          // If no exact match, try equivalent import matching (with version constraint handling)
          if (!matchingUrl) {
            matchingUrl = Object.keys(this.manifest.dependencies).find(
              (url) => this.isEquivalentImport(originalImport, url)
            ) || null;
          }

          if (matchingUrl && this.manifest.dependencies[matchingUrl]) {
            const filename = this.manifest.dependencies[matchingUrl];
            newImport = `/dependencies/${filename}`;
            console.log(`  - absolute: "${originalImport}" → "${newImport}"`);
          } else {
            console.log(`  - absolute: "${originalImport}" (no mapping found)`);
          }
        } else if (
          originalImport.startsWith("./") ||
          originalImport.startsWith("../")
        ) {
          // Replace relative imports with dependency paths using manifest
          let absoluteUrl: string | null = null;

          // Look up relative import in the nested dependency structure
          if (depNameVersion && this.manifest.relativeImports[depNameVersion]) {
            try {
              absoluteUrl = this.getNestedImportPath(
                originalImport,
                this.manifest.relativeImports[depNameVersion],
                filename
              );
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              console.log(`  🔍 Failed to resolve: ${errorMessage}`);
            }
          }

          if (absoluteUrl && this.manifest.dependencies[absoluteUrl]) {
            const targetFilename = this.manifest.dependencies[absoluteUrl];
            newImport = `/dependencies/${targetFilename}`;
            console.log(`  - relative: "${originalImport}" → "${newImport}"`);
          } else {
            console.log(
              `  - relative: "${originalImport}" (no mapping found${
                depNameVersion ? ` for ${depNameVersion}` : ""
              })`
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
    }

    console.log(`Total files processed: ${totalFiles}`);
    console.log(`Files with imports: ${filesWithImports}`);
    console.log(`Total replacements made: ${totalReplacements}`);

    const totalRelativeMappings = this.countNestedMappings(
      this.manifest.relativeImports
    );
    console.log(
      `Relative import mappings available: ${totalRelativeMappings} across ${
        Object.keys(this.manifest.relativeImports).length
      } dependencies`
    );
  }

  private extractRawImports(content: string): string[] {
    // Match both absolute URLs and relative paths - handle minified code with no spaces
    // Standard import/export statements with proper spacing - handle multi-line imports
    const importRegex = /(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g;
    // Dynamic imports
    const dynamicImportRegex = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
    // Bare import statements without 'from'
    const bareImportRegex = /import\s*["']([^"']+)["'];?/g;

    const imports: string[] = [];
    let match;

    // Extract from import/export statements
    while ((match = importRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }

    // Extract from dynamic imports
    while ((match = dynamicImportRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }

    // Extract bare imports
    while ((match = bareImportRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }

    // Filter out template literals and invalid imports
    const validImports = imports.filter((importPath) => {
      // Skip template literals and invalid imports
      if (
        importPath.includes("${") ||
        importPath.includes("`") ||
        importPath.includes("\\")
      ) {
        return false;
      }
      // Skip URLs with query parameters ONLY if they don't look like esm.sh imports with version constraints or target parameters
      if (
        importPath.includes("?") &&
        !importPath.includes(".mjs") &&
        !importPath.includes(".js") &&
        !importPath.match(/^\/[\w@-]+@[\^~]?[\d.]+/) && // Allow version-constrained imports like /react@^19.1.1
        !importPath.match(/^\/@[\w-]+\/[\w-]+(@[\^~]?[\d.]+)?\?/) // Allow scoped esm.sh imports with query params, with or without version
      ) {
        return false;
      }
      return true;
    });

    return [...new Set(validImports)]; // Remove duplicates
  }

  private hasVersionConstraint(importPath: string): boolean {
    // Check if import has version constraint like ^11.16.4 or ~2.3.4
    // Handle both "/motion-utils@^12.23.6" and "motion-utils@^12.23.6" patterns
    // Also handle scoped packages like "/@emotion/is-prop-valid@^1.4.0"
    return /^\/(?:@[^/]+\/)?[^/]+@[\^~][\d.]+/.test(importPath);
  }

  private getPackageNameFromConstraint(importPath: string): string | null {
    // Extract package name from "/motion-dom@^11.16.4?target=es2022" -> "motion-dom"
    // Also handle scoped packages like "/@emotion/is-prop-valid@^1.4.0" -> "@emotion/is-prop-valid"
    let match;
    if (importPath.startsWith("/@")) {
      // Scoped package like "/@emotion/is-prop-valid@^1.4.0"
      match = importPath.match(/^\/(@[^/]+\/[^@]+)@/);
    } else {
      // Regular package like "/motion-dom@^11.16.4"
      match = importPath.match(/^\/([^@/]+)@/);
    }
    return match ? match[1] : null;
  }

  private extractDepNameVersionFromFilename(filename: string): string | null {
    // Extract dependency name+version from filename like "react@19.2.0_165279c2.js"
    // Format is: packagename@version_hash.js
    const match = filename.match(/^(.+@[^_]+)_[^.]+\.js$/);
    return match ? match[1] : null;
  }

  private isEquivalentImport(importPath: string, manifestUrl: string): boolean {
    // Check if an import path like "/react@^19.1.1?target=es2022" or "/motion-utils@^12.23.6?target=es2022"
    // matches a manifest URL like "https://esm.sh/react@19.2.0" or "https://esm.sh/motion-utils@12.23.6"

    // Extract package name from import path
    let importPackageName: string;

    // Handle version constraints like "/motion-utils@^12.23.6?target=es2022"
    // Also handle version constraints with sub-paths like "/react@^19.1.1/jsx-runtime?target=es2022"
    if (this.hasVersionConstraint(importPath)) {
      importPackageName = this.getPackageNameFromConstraint(importPath) || "";
    } else {
      // Handle other absolute paths like "/react@19.2.0/es2022/react.mjs" or "/motion-utils@12.23.6?target=es2022"
      // Also handle scoped packages like "/@emotion/is-prop-valid?target=es2022"
      let match;
      if (importPath.startsWith("/@")) {
        // Scoped package like "/@emotion/is-prop-valid?target=es2022"
        match = importPath.match(/^\/(@[^/]+\/[^@/?]+)(?:@[^/?]*)?(?:[?/].*)?/);
        importPackageName = match ? match[1] : "";
      } else {
        // Regular package like "/react?target=es2022" or "/motion-utils?target=es2022"
        match = importPath.match(/^\/([^@/?]+)(?:@[^/?]*)?(?:[?/].*)?/);
        importPackageName = match ? match[1] : "";
      }
    }

    if (!importPackageName) return false;

    // Check if the manifest URL contains this package
    try {
      const urlObj = new URL(manifestUrl);
      const pathParts = urlObj.pathname.split("/").filter((p) => p);

      if (urlObj.hostname === "esm.sh" && pathParts.length > 0) {
        const firstPart = pathParts[0];
        if (firstPart.startsWith("@")) {
          // Scoped package like @types/node
          if (pathParts.length > 1) {
            const scopeAndPackage = `${firstPart}/${
              pathParts[1].split("@")[0]
            }`;
            if (scopeAndPackage === importPackageName) {
              return true;
            }
          }
        } else {
          // Regular package like react, motion-utils, etc.
          const packageName = firstPart.split("@")[0];
          if (packageName === importPackageName) {
            return true;
          }
        }
      }
    } catch (e) {
      throw new Error(`Could not find package name in URL: ${manifestUrl}`);
    }

    return false;
  }

  private getNestedImportPath(
    relativePath: string,
    nestedImports: NestedRelativeImports,
    currentFilename: string
  ): string | null {
    try {
      // Step 1: Find the current file's ESM URL from the manifest
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

      // Step 3: Extract package-relative path from the absolute URL
      const depNameVersion =
        this.extractDepNameVersionFromFilename(currentFilename);
      if (!depNameVersion) {
        throw new Error(
          `Cannot extract dependency name+version from filename ${currentFilename}`
        );
      }

      const packageName = depNameVersion.split("@")[0];
      const packagePath = this.extractPackagePathFromUrl(
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
      this.manifest.dependencies
    )) {
      if (localFilename === filename) {
        return esmUrl;
      }
    }
    return null;
  }

  private extractPackagePathFromUrl(
    absoluteUrl: string,
    packageName: string
  ): string | null {
    try {
      const urlObj = new URL(absoluteUrl);

      // For esm.sh URLs like "https://esm.sh/framer-motion@10.17.11/es2022/dist/es/easing/cubic-bezier.mjs"
      // Extract the path after the package name and version
      if (urlObj.hostname === "esm.sh") {
        const pathParts = urlObj.pathname.split("/").filter((p) => p);

        // Find the package part (e.g., "framer-motion@10.17.11")
        if (pathParts.length > 0) {
          const packagePart = pathParts[0];

          // Handle scoped packages like @emotion/is-prop-valid@1.4.0
          let expectedPrefix: string;
          if (packageName.startsWith("@")) {
            // For scoped packages, expect @scope/name@version
            expectedPrefix = packageName;
          } else {
            // For regular packages, expect name@version
            expectedPrefix = packageName;
          }

          if (packagePart.startsWith(expectedPrefix)) {
            // Get everything after the package@version part
            const remainingParts = pathParts.slice(1);

            // Skip the target part (e.g., "es2022") if present
            if (
              remainingParts.length > 0 &&
              remainingParts[0].match(/^es\d{4}$/)
            ) {
              remainingParts.shift();
            }

            // The remaining path is the package-relative path
            return remainingParts.join("/");
          }
        }
      }

      return null;
    } catch (e) {
      return null;
    }
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
