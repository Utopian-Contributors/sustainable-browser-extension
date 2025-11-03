import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";

export const DependencyUtils = {
  extractPackageNameFromUrl(url: string): string {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split("/").filter((p) => p);

    if (urlObj.hostname === "esm.sh") {
      if (pathParts.length > 0) {
        const packagePart = pathParts[0];

        // Handle scoped packages like @emotion/is-prop-valid@1.4.0
        if (packagePart.startsWith("@") && pathParts.length > 1) {
          const scopePart = packagePart;
          const namePart = pathParts[1];

          // Extract just the package name without version
          const nameWithoutVersion = namePart.split("@")[0];
          return `${scopePart}/${nameWithoutVersion}`;
        } else {
          // Handle regular packages like react@19.2.0
          const nameWithoutVersion = packagePart.split("@")[0];
          return nameWithoutVersion;
        }
      }
    }

    throw new Error(`Cannot extract package name from URL: ${url}`);
  },
  extractVersionFromUrl(url: string): string {
    const scopedMatch = url.match(/@[^/]+\/[^@/]+@([^/?#]+)/);
    if (scopedMatch) {
      return scopedMatch[1];
    }

    if (!url.includes("/@")) {
      const regularMatch = url.match(/\/([^/@]+)@([^/?#]+)/);
      if (regularMatch) {
        return regularMatch[2];
      }
    }

    return "latest";
  },
  resolveImportUrl(importPath: string, baseUrl: string): string {
    if (importPath.startsWith("http://") || importPath.startsWith("https://")) {
      return importPath;
    }

    const baseUrlObj = new URL(baseUrl);

    if (importPath.startsWith("/")) {
      if (this.isPackageImport(importPath)) {
        const cleanedPath = this.cleanPackageVersion(importPath);
        return `${baseUrlObj.origin}${cleanedPath}`;
      }
      return `${baseUrlObj.origin}${importPath}`;
    } else if (importPath.startsWith("./") || importPath.startsWith("../")) {
      const basePathParts = baseUrlObj.pathname.split("/");
      basePathParts.pop();

      const importParts = importPath.split("/");

      for (const part of importParts) {
        if (part === ".") {
          continue;
        } else if (part === "..") {
          basePathParts.pop();
        } else {
          basePathParts.push(part);
        }
      }

      return `${baseUrlObj.origin}${basePathParts.join("/")}`;
    } else {
      return importPath;
    }
  },
  isPackageImport(importPath: string): boolean {
    return /^\/[^/]+@[\^~]?[\d.]+/.test(importPath);
  },
  cleanPackageVersion(importPath: string): string {
    return importPath.replace(/@[\^~]/, "@");
  },
  hasEsmShExports(content: string): boolean {
    const exportFromRegex = /export\s+.*?\s+from\s+["']([^"']+)["']/g;
    let match;

    while ((match = exportFromRegex.exec(content)) !== null) {
      const exportPath = match[1];
      if (exportPath.startsWith("/") || exportPath.includes("esm.sh")) {
        return true;
      }
    }

    return false;
  },
  extractPackagePathFromUrl(
    absoluteUrl: string,
    packageName: string
  ): string | null {
    try {
      const urlObj = new URL(absoluteUrl);

      if (urlObj.hostname === "esm.sh") {
        const pathParts = urlObj.pathname.split("/").filter((p) => p);

        if (pathParts.length > 0) {
          // Handle scoped packages like @noble/hashes
          if (packageName.startsWith("@")) {
            // For scoped packages, the URL structure is: /@scope/package@version/path
            // pathParts = ["@scope", "package@version", "es2022", "crypto.mjs"]
            // packageName = "@scope/package"

            if (pathParts.length >= 2) {
              const scope = pathParts[0]; // "@scope"
              const packageWithVersion = pathParts[1]; // "package@version"
              const packageNameOnly = packageWithVersion.split("@")[0]; // "package"
              const fullPackageName = `${scope}/${packageNameOnly}`; // "@scope/package"

              if (fullPackageName === packageName) {
                // Return everything after the package@version part
                const finalParts = pathParts.slice(2);
                return finalParts.join("/");
              }
            }
          } else {
            // Handle regular packages like react
            // For regular packages, the URL structure is: /package@version/path
            // pathParts = ["package@version", "es2022", "react.mjs"]
            // packageName = "package"

            const packageWithVersion = pathParts[0];
            const packageNameOnly = packageWithVersion.split("@")[0];

            if (packageNameOnly === packageName) {
              // Return everything after the package@version part
              const finalParts = pathParts.slice(1);
              return finalParts.join("/");
            }
          }
        }
      }

      return null;
    } catch (e) {
      return null;
    }
  },
  extractRawImportsWithBabel(content: string): string[] {
    const imports: string[] = [];

    try {
      // Parse the code into an AST
      const ast = parser.parse(content, {
        sourceType: "module",
        plugins: [
          "jsx",
          "typescript",
          "decorators-legacy",
          "classProperties",
          "exportDefaultFrom",
          "exportNamespaceFrom",
          "dynamicImport",
          "importMeta",
        ],
      });

      // Traverse the AST to find import/export declarations
      traverse(ast, {
        // Static imports: import foo from "bar"
        ImportDeclaration(path) {
          imports.push(path.node.source.value);
        },

        // Dynamic imports: import("bar")
        Import(path) {
          const parent = path.parent;
          if (t.isCallExpression(parent) && parent.arguments.length > 0) {
            const arg = parent.arguments[0];
            if (t.isStringLiteral(arg)) {
              imports.push(arg.value);
            }
          }
        },

        // Export from: export { foo } from "bar"
        ExportNamedDeclaration(path) {
          if (path.node.source && t.isStringLiteral(path.node.source)) {
            imports.push(path.node.source.value);
          }
        },

        // Export all: export * from "bar"
        ExportAllDeclaration(path) {
          if (t.isStringLiteral(path.node.source)) {
            imports.push(path.node.source.value);
          }
        },
      });
    } catch (error) {
      console.warn(
        `Failed to parse file with Babel, falling back to regex: ${error}`
      );
      // Fall back to regex-based extraction if Babel fails
      return this.extractRawImports(content);
    }

    // Filter out invalid imports
    return imports.filter((imp) => {
      return (
        !imp.startsWith("data:") &&
        !imp.startsWith("blob:") &&
        !imp.startsWith("chrome-extension:")
      );
    });
  },
  extractRawImports(content: string): string[] {
    // Match both absolute URLs and relative paths - use \s* to handle minified code with no spaces
    // Use negative lookbehind to avoid matching imports inside string literals like "'import' is not allowed"
    // Also avoid matching imports inside template literals (backticks)
    const importRegex =
      /(?<!["'`])(?:import|export).*?from\s*["']([^"']+)["']/g;
    const dynamicImportRegex = /(?<!["'`])import\s*\(\s*["']([^"']+)["']\s*\)/g;
    // Also match bare import statements without 'from'
    const bareImportRegex = /^(?<!["'`])import\s+["']([^"']+)["'];?$/gm;

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
      // Skip template literals, data URLs, and other non-file imports
      return (
        !importPath.includes("${") &&
        !importPath.startsWith("data:") &&
        !importPath.startsWith("blob:") &&
        !importPath.startsWith("chrome-extension:") &&
        importPath.trim().length > 0
      );
    });

    return [...new Set(validImports)]; // Remove duplicates
  },
};

// Stateless helpers for filename -> package parsing and key building
export function parseDepFilename(
  filename: string
): { baseDepNameVersion: string; peerContext: string[] } | null {
  // Reuse the same filename parsing rules used elsewhere in the project.
  let packageNameVersion: string;
  let peerContextPart: string = "";
  let match: RegExpMatchArray | null;

  if (filename.startsWith("@")) {
    // Scoped package: @scope-package@version...
    match = filename.match(/^(@[^-]+-[^@]+@[^_]+)_(.*?)_([^_]+)\.js$/);
  } else {
    match = filename.match(/^([^@]+@[^_]+)_(.*?)_([^_]+)\.js$/);
  }

  if (match) {
    packageNameVersion = match[1];
    peerContextPart = match[2];
  } else {
    if (filename.startsWith("@")) {
      match = filename.match(/^(@[^-]+-[^@]+@[^_]+)_([^_]+)\.js$/);
    } else {
      match = filename.match(/^([^@]+@[^_]+)_([^_]+)\.js$/);
    }

    if (!match) return null;

    packageNameVersion = match[1];
    peerContextPart = "";
  }

  // Convert filename package format back to package name format
  if (packageNameVersion.startsWith("@")) {
    const firstDashIndex = packageNameVersion.indexOf("-");
    if (firstDashIndex !== -1) {
      packageNameVersion =
        packageNameVersion.substring(0, firstDashIndex) +
        "/" +
        packageNameVersion.substring(firstDashIndex + 1);
    }
  }

  const peerDependencies: string[] = [];
  if (peerContextPart) {
    const parts = peerContextPart.split("_");
    for (const part of parts) {
      const atMatch = part.match(/^(.+)-([\d.]+)$/);
      if (atMatch) {
        let pkgName = atMatch[1];
        const version = atMatch[2];
        if (pkgName.startsWith("@")) {
          const firstDashIndex = pkgName.indexOf("-", 1);
          if (firstDashIndex !== -1) {
            pkgName = pkgName.substring(0, firstDashIndex) + "/" + pkgName.substring(firstDashIndex + 1);
          }
        }
        peerDependencies.push(`${pkgName}@${version}`);
      }
    }
  }

  return { baseDepNameVersion: packageNameVersion, peerContext: peerDependencies };
}

export function buildDepNameVersionKeyWithPeerContext(
  baseDepNameVersion: string,
  peerContext: string[]
): string {
  if (!peerContext || peerContext.length === 0) return baseDepNameVersion;

  const peerSuffix = peerContext
    .map((peer) => peer.replace("@", "-").replace("/", "-"))
    .join("_");

  return `${baseDepNameVersion}_${peerSuffix}`;
}
