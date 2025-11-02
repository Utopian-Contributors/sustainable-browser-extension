import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import * as semver from "semver";

export interface SubpathConfig {
  name: string;
  fromVersion?: string; // Semver constraint - only include for versions matching this
}

interface CDNMapping {
  packages: { [key: string]: string };
  standaloneSubpaths?: {
    [packageName: string]: (string | SubpathConfig)[];
  };
  sameVersionRequired: string[][];
}

interface PeerDependencies {
  [packageName: string]: string;
}

interface PackageInfo {
  name: string;
  version: string;
  peerDependencies?: PeerDependencies;
  hasManagedImports: boolean;
}

export interface AnalyzedDependency {
  name: string;
  version: string;
  url: string;
  downloaded: boolean;
  transformed: boolean;
  peerContext?: { [peerName: string]: string };
  peerDependencies?: PeerDependencies;
  depth: number; // For sorting by dependency order
}

interface DependencyAnalysisResult {
  packages: AnalyzedDependency[]; // Packages to download with their peer context
  urlToFile: { [url: string]: string }; // Will be populated during download
  availableVersions: { [packageName: string]: string[] };
  standaloneSubpaths?: { [packageName: string]: (string | SubpathConfig)[] };
}

export class DependencyAnalyzer {
  private cdnMappings: CDNMapping;
  private outputPath: string;
  private packageInfoCache: Map<string, PackageInfo[]> = new Map();
  private availableVersions: Map<string, string[]> = new Map();
  private existingAnalysis: DependencyAnalysisResult | null = null;
  private existingPackageKeys: Set<string> = new Set();

  constructor(
    mappingsPath: string,
    outputPath: string = "./dependencies/index.lookup.json"
  ) {
    this.cdnMappings = JSON.parse(fs.readFileSync(mappingsPath, "utf8"));
    this.outputPath = outputPath;
  }

  async analyzeDependencies(): Promise<void> {
    console.log("🔍 Starting incremental dependency analysis...\n");

    // Step 0: Load existing analysis if it exists
    console.log("📖 Loading existing analysis...");
    this.loadExistingAnalysis();

    // Step 1: Gather package information including peer dependencies
    console.log("📦 Gathering package information and peer dependencies...");
    await this.gatherPackageInfo();

    // Step 2: Generate dependency graph with peer contexts
    console.log("\n🔗 Generating dependency graph with peer contexts...");
    const dependencyGraph = this.generateDependencyGraph();

    // Step 3: Sort dependencies by depth (peers first, then dependents)
    console.log("📊 Sorting dependencies by depth...");
    const sortedDependencies = this.sortDependenciesByDepth(dependencyGraph);

    // Step 4: Save to index.lookup.json
    console.log("\n💾 Saving dependency analysis...");
    this.saveDependencyAnalysis(sortedDependencies);

    console.log("\n✅ Dependency analysis complete!");
    console.log(
      `📊 Total dependencies: ${sortedDependencies.length} (${
        this.existingPackageKeys.size
      } existing, ${
        sortedDependencies.length
          ? sortedDependencies.length - this.existingPackageKeys.size
          : 0
      } new)`
    );
  }

  private loadExistingAnalysis(): void {
    if (fs.existsSync(this.outputPath)) {
      try {
        const content = fs.readFileSync(this.outputPath, "utf8");
        this.existingAnalysis = JSON.parse(content);

        // Build a set of existing package keys for quick lookup
        for (const pkg of this.existingAnalysis!.packages) {
          const key = this.makePackageKey(pkg);
          this.existingPackageKeys.add(key);
        }

        // Load existing availableVersions
        if (this.existingAnalysis!.availableVersions) {
          for (const [pkgName, versions] of Object.entries(
            this.existingAnalysis!.availableVersions
          )) {
            this.availableVersions.set(pkgName, versions);
          }
        }

        console.log(
          `  ✅ Loaded existing analysis with ${
            this.existingAnalysis!.packages.length
          } packages`
        );
      } catch (error) {
        console.log(`  ⚠️  Failed to load existing analysis: ${error}`);
        this.existingAnalysis = null;
      }
    } else {
      console.log("  ℹ️  No existing analysis found, will create new one");
    }
  }

  private makePackageKey(pkg: AnalyzedDependency): string {
    // Create a unique key for a package including peer context
    const peerContextSuffix = pkg.peerContext
      ? "_" +
        Object.entries(pkg.peerContext)
          .map(([n, v]) => `${n}-${v}`)
          .sort()
          .join("_")
      : "";
    return `${pkg.name}@${pkg.version}${peerContextSuffix}`;
  }

  private async gatherPackageInfo(): Promise<void> {
    for (const [depName, urlTemplate] of Object.entries(
      this.cdnMappings.packages
    )) {
      try {
        // Skip if this is a standalone subpath entry (will be handled with parent)
        if (this.isStandaloneSubpath(depName)) {
          console.log(
            `  ⏭️  Skipping ${depName} (standalone subpath, will be handled with parent)`
          );
          continue;
        }

        console.log(`  🔍 Analyzing ${depName}...`);

        // Get existing versions for this package
        const existingVersions = this.availableVersions.get(depName) || [];

        // Fetch available versions from npm
        const foundVersions = await this.getMultipleVersions(depName);
        const versions = (
          await Promise.all(
            foundVersions.map(async (v) =>
              (await this.verifyEsmVersionExists(depName, v)) ? v : false
            )
          )
        ).filter(Boolean) as string[];

        // Merge with existing versions (union of both sets)
        const allVersions = [
          ...new Set([...existingVersions, ...versions]),
        ].sort((a, b) => semver.rcompare(a, b));
        this.availableVersions.set(depName, allVersions);

        // Identify new versions that need analysis
        const newVersions = versions.filter(
          (v) => !existingVersions.includes(v)
        );
        if (newVersions.length > 0) {
          console.log(
            `    🆕 Found ${
              newVersions.length
            } new version(s): ${newVersions.join(", ")}`
          );
        } else {
          console.log(
            `    ✅ All versions already analyzed (${existingVersions.length} total)`
          );
          continue;
        }

        const packageInfoList: PackageInfo[] = [];

        // Only analyze new versions, not already analyzed ones
        const versionsToAnalyze =
          newVersions.length > 0 ? newVersions : versions;

        for (const version of versionsToAnalyze) {
          // Get peer dependencies from npm registry
          const peerDeps = await this.getPeerDependencies(depName, version);

          // Check if this package has managed peer dependencies
          const hasManagedImports = await this.checkForManagedDependencyImports(
            peerDeps
          );

          packageInfoList.push({
            name: depName,
            version,
            peerDependencies: peerDeps,
            hasManagedImports: hasManagedImports,
          });

          // Filter out wildcard peer dependencies for accurate counting
          const validPeerDeps = Object.fromEntries(
            Object.entries(peerDeps).filter(
              ([_, constraint]) => constraint !== "*"
            )
          );

          // Calculate how many permutations would be created for this specific package
          let permutationCount = 0;
          if (Object.keys(validPeerDeps).length > 0) {
            try {
              permutationCount = this.calculatePermutationCount(
                peerDeps,
                depName
              );
            } catch (error) {
              permutationCount = 0;
            }
          }

          console.log(
            `    📦 ${depName}@${version}: ${
              Object.keys(validPeerDeps).length
            } peer deps, managed imports: ${hasManagedImports}, permutations: ${permutationCount}`
          );
        }

        // Only store package info if we have new versions to analyze
        if (packageInfoList.length > 0) {
          this.packageInfoCache.set(depName, packageInfoList);
        }

        // Handle standalone subpaths for this package (only for new versions)
        if (newVersions.length > 0) {
          await this.handleStandaloneSubpaths(depName, newVersions);
        }
      } catch (error) {
        console.error(`❌ Failed to analyze ${depName}:`, error);
      }
    }
  }

  private isStandaloneSubpath(packageName: string): boolean {
    // Check if this package name is actually a subpath (contains /)
    // and is defined as a standalone subpath in cdn-mappings
    if (!packageName.includes("/")) return false;

    const [parentPkg, ...subpathParts] = packageName.split("/");
    const subpath = subpathParts.join("/");

    const standaloneSubpaths = this.cdnMappings.standaloneSubpaths || {};
    const subpathConfigs = standaloneSubpaths[parentPkg];

    if (!subpathConfigs) return false;

    return subpathConfigs.some((config) => {
      const name = typeof config === "string" ? config : config.name;
      return name === subpath;
    });
  }

  private async handleStandaloneSubpaths(
    parentPackage: string,
    versions: string[]
  ): Promise<void> {
    const standaloneSubpaths = this.cdnMappings.standaloneSubpaths || {};
    const subpathConfigs = standaloneSubpaths[parentPackage];

    if (!subpathConfigs || subpathConfigs.length === 0) return;

    console.log(
      `    🔗 Found ${subpathConfigs.length} standalone subpath(s) for ${parentPackage}`
    );

    for (const subpathConfig of subpathConfigs) {
      // Handle both string and SubpathConfig formats
      const subpathName =
        typeof subpathConfig === "string" ? subpathConfig : subpathConfig.name;
      const fromVersion =
        typeof subpathConfig === "string"
          ? undefined
          : subpathConfig.fromVersion;

      const fullSubpathName = `${parentPackage}/${subpathName}`;

      // Check if the subpath has its own entry in packages
      if (!this.cdnMappings.packages[fullSubpathName]) {
        console.warn(
          `    ⚠️  Subpath ${fullSubpathName} not found in packages mapping`
        );
        continue;
      }

      // Filter versions based on fromVersion constraint if specified
      let applicableVersions = versions;
      if (fromVersion) {
        applicableVersions = versions.filter((version) => {
          try {
            return semver.satisfies(version, fromVersion);
          } catch (error) {
            console.warn(
              `    ⚠️  Invalid version or constraint: ${version} vs ${fromVersion}`
            );
            return false;
          }
        });

        if (applicableVersions.length === 0) {
          console.log(
            `    ⏭️  Skipping ${fullSubpathName}: no versions match constraint ${fromVersion}`
          );
          continue;
        }

        console.log(
          `    🔍 Filtered ${fullSubpathName} to ${applicableVersions.length}/${versions.length} versions matching ${fromVersion}`
        );
      }

      // Store the filtered versions for this subpath
      this.availableVersions.set(fullSubpathName, applicableVersions);

      const packageInfoList: PackageInfo[] = [];
      for (const version of applicableVersions) {
        // Subpaths inherit peer dependencies from parent package
        const parentInfo = this.packageInfoCache
          .get(parentPackage)
          ?.find((p) => p.version === version);

        packageInfoList.push({
          name: fullSubpathName,
          version,
          peerDependencies: parentInfo?.peerDependencies || {},
          hasManagedImports: false, // Subpaths don't have their own managed imports
        });

        console.log(
          `      📎 ${fullSubpathName}@${version} (inherits from ${parentPackage})`
        );
      }

      this.packageInfoCache.set(fullSubpathName, packageInfoList);
    }
  }

  private generateDependencyGraph(): AnalyzedDependency[] {
    const packages: AnalyzedDependency[] = [];
    const processedPackages = new Set<string>();

    for (const [depName, packageInfoList] of this.packageInfoCache.entries()) {
      const urlTemplate = this.cdnMappings.packages[depName];

      // Check if part of sameVersionRequired group
      const sameVersionGroup = this.cdnMappings.sameVersionRequired.find(
        (group) => group.includes(depName)
      );

      for (const packageInfo of packageInfoList) {
        const url = urlTemplate.replace("{version}", packageInfo.version);

        // Get external peer dependencies (not within the same sameVersionRequired group)
        const externalPeerDeps = this.getExternalPeerDependencies(
          packageInfo.peerDependencies || {},
          sameVersionGroup
        );
        const hasExternalPeerDeps = Object.keys(externalPeerDeps).length > 0;

        // Only add base dependency if it has NO external peer dependencies
        // (packages with external peer dependencies will only be added with their peer context)
        if (!hasExternalPeerDeps) {
          const baseDep: AnalyzedDependency = {
            name: depName,
            version: packageInfo.version,
            url,
            peerDependencies: packageInfo.peerDependencies || {},
            depth: 0,
            downloaded: false,
            transformed: false,
          };
          packages.push(baseDep);
        }

        // Create peer context permutations if needed
        if (hasExternalPeerDeps) {
          const peerPermutations = this.createPeerPermutations(
            externalPeerDeps,
            depName
          );

          for (const peerContext of peerPermutations) {
            if (Object.keys(peerContext).length > 0) {
              // Create entry with peer context
              const peerContextKey = Object.entries(peerContext)
                .map(([name, version]) => `${name}=${version}`)
                .join("&");

              packages.push({
                name: depName,
                version: packageInfo.version,
                url: `${url}?${peerContextKey}`,
                downloaded: false,
                transformed: false,
                peerContext,
                peerDependencies: packageInfo.peerDependencies,
                depth: 0, // Will be calculated
              });
            }
          }
        }
      }
    }

    return packages;
  }

  private getExternalPeerDependencies(
    peerDependencies: PeerDependencies,
    sameVersionGroup: string[] | undefined
  ): PeerDependencies {
    // Filter out peer dependencies that are within the same sameVersionRequired group
    // These are "internal" peer dependencies and shouldn't require permutations
    const externalPeerDeps: PeerDependencies = {};

    for (const [peerName, constraint] of Object.entries(peerDependencies)) {
      // Skip wildcard constraints
      if (constraint === "*") {
        continue;
      }

      // Check if this peer is in the same group
      const isInternalPeer =
        sameVersionGroup && sameVersionGroup.includes(peerName);

      // Only include if it's NOT an internal peer
      if (!isInternalPeer) {
        externalPeerDeps[peerName] = constraint;
      }
    }

    return externalPeerDeps;
  }

  private sortDependenciesByDepth(
    dependencies: AnalyzedDependency[]
  ): AnalyzedDependency[] {
    // Calculate depth for each dependency
    // Depth 0: No peer dependencies (or is itself a peer dependency)
    // Depth 1+: Has peer dependencies

    const depthMap = new Map<string, number>();

    // First pass: Identify packages with no peer dependencies (depth 0)
    for (const dep of dependencies) {
      const key = `${dep.name}@${dep.version}${
        dep.peerContext
          ? "_" +
            Object.entries(dep.peerContext)
              .map(([n, v]) => `${n}-${v}`)
              .join("_")
          : ""
      }`;

      if (!dep.peerContext || Object.keys(dep.peerContext).length === 0) {
        // No peer context means this is either:
        // 1. A base version (will be cleaned up)
        // 2. A package with no peer dependencies
        depthMap.set(key, 0);
      } else {
        // Has peer context, needs to be downloaded after its peers
        // Calculate depth based on peer dependencies
        let maxPeerDepth = 0;
        for (const [peerName, peerVersion] of Object.entries(dep.peerContext)) {
          const peerKey = `${peerName}@${peerVersion}`;
          const peerDepth = depthMap.get(peerKey) ?? 0;
          maxPeerDepth = Math.max(maxPeerDepth, peerDepth);
        }
        depthMap.set(key, maxPeerDepth + 1);
      }
    }

    // Update depths in dependencies
    for (const dep of dependencies) {
      const key = `${dep.name}@${dep.version}${
        dep.peerContext
          ? "_" +
            Object.entries(dep.peerContext)
              .map(([n, v]) => `${n}-${v}`)
              .join("_")
          : ""
      }`;
      dep.depth = depthMap.get(key) ?? 0;
    }

    // Sort by depth (ascending), then by name
    return dependencies.sort((a, b) => {
      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      return a.name.localeCompare(b.name);
    });
  }

  private saveDependencyAnalysis(newPackages: AnalyzedDependency[]): void {
    // Convert availableVersions Map to object
    const availableVersionsObject: { [packageName: string]: string[] } = {};
    for (const [packageName, versions] of this.availableVersions.entries()) {
      availableVersionsObject[packageName] = versions;
    }

    // Get all managed package names to identify which are peers
    const managedPackageNames = Object.keys(this.cdnMappings.packages);

    // Filter out base versions that should have peer context
    // Keep only:
    // 1. Packages with peer context (these are the ones we want)
    // 2. Packages without peer dependencies (these don't need peer context)
    // 3. Packages whose peer dependencies are all internal (within sameVersionRequired group)
    const filteredNewPackages = newPackages.filter((dep) => {
      // If has peer context, keep it
      if (dep.peerContext && Object.keys(dep.peerContext).length > 0) {
        return true;
      }

      // If has no peer dependencies at all, keep it
      if (
        !dep.peerDependencies ||
        Object.keys(dep.peerDependencies).length === 0
      ) {
        return true;
      }

      // Check if this package is part of a sameVersionRequired group
      const sameVersionGroup = this.cdnMappings.sameVersionRequired.find(
        (group) => group.includes(dep.name)
      );

      // Check if any of its peer dependencies are managed packages OUTSIDE its sameVersionRequired group
      const hasExternalManagedPeers = Object.keys(dep.peerDependencies).some(
        (peerName) => {
          const isManaged =
            managedPackageNames.includes(peerName) &&
            dep.peerDependencies![peerName] !== "*";
          const isInternal =
            sameVersionGroup && sameVersionGroup.includes(peerName);
          return isManaged && !isInternal;
        }
      );

      // If has EXTERNAL managed peer dependencies but no peer context, filter it out (base version)
      // If all peers are internal (within sameVersionRequired), keep it
      return !hasExternalManagedPeers;
    });

    // Merge with existing packages
    let allPackages: AnalyzedDependency[];
    if (this.existingAnalysis && this.existingAnalysis.packages.length > 0) {
      // Create a map of new packages by their key
      const newPackageMap = new Map<string, AnalyzedDependency>();
      for (const pkg of filteredNewPackages) {
        newPackageMap.set(this.makePackageKey(pkg), pkg);
      }

      // Keep all existing packages, replace with new version if exists
      allPackages = this.existingAnalysis.packages.map((existingPkg) => {
        const key = this.makePackageKey(existingPkg);
        return newPackageMap.get(key) || existingPkg;
      });

      // Add truly new packages (not replacements)
      for (const [key, pkg] of newPackageMap.entries()) {
        if (!this.existingPackageKeys.has(key)) {
          allPackages.push(pkg);
        }
      }
    } else {
      allPackages = filteredNewPackages;
    }

    // Sort by depth to ensure proper download order (peers first, then dependents)
    const sortedDeps = allPackages.sort((a, b) => {
      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      return a.name.localeCompare(b.name);
    });

    const analysis: DependencyAnalysisResult = {
      packages: sortedDeps,
      urlToFile: this.existingAnalysis?.urlToFile || {}, // Preserve existing urlToFile mappings
      availableVersions: availableVersionsObject,
      standaloneSubpaths: this.cdnMappings.standaloneSubpaths || {},
    };

    const outputDir = path.dirname(this.outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(this.outputPath, JSON.stringify(analysis, null, 2));

    const newCount = filteredNewPackages.length;
    const existingCount = this.existingAnalysis?.packages.length || 0;

    console.log(`📄 Analysis saved: ${this.outputPath}`);
    console.log(
      `   ${
        sortedDeps.length
      } total dependencies (${existingCount} existing, ${newCount} new) across ${
        Object.keys(availableVersionsObject).length
      } packages`
    );
    console.log(
      `   (Filtered out ${
        newPackages.length - filteredNewPackages.length
      } base versions from new packages)`
    );

    // Print depth distribution
    const depthDistribution = new Map<number, number>();
    for (const dep of sortedDeps) {
      depthDistribution.set(
        dep.depth,
        (depthDistribution.get(dep.depth) ?? 0) + 1
      );
    }

    console.log("\n   Depth distribution:");
    for (const [depth, count] of Array.from(depthDistribution.entries()).sort(
      (a, b) => a[0] - b[0]
    )) {
      console.log(`     Depth ${depth}: ${count} dependencies`);
    }
  }

  private async getPeerDependencies(
    packageName: string,
    version: string
  ): Promise<PeerDependencies> {
    try {
      const response = await axios.get(
        `https://registry.npmjs.org/${packageName}/${version}`
      );
      return response.data.peerDependencies || {};
    } catch (error) {
      throw new Error(
        `Could not fetch peer dependencies for ${packageName}@${version}`
      );
    }
  }

  private async checkForManagedDependencyImports(
    peerDependencies: PeerDependencies
  ): Promise<boolean> {
    const managedPackages = Object.keys(this.cdnMappings.packages);
    const primaryPeersOnly = new Set<string>();

    for (const sameVersionGroup of this.cdnMappings.sameVersionRequired) {
      const primaryPeer = sameVersionGroup[0];
      if (managedPackages.includes(primaryPeer)) {
        primaryPeersOnly.add(primaryPeer);
      }
    }

    for (const managedPkg of managedPackages) {
      const isInGroup = this.cdnMappings.sameVersionRequired.some((group) =>
        group.includes(managedPkg)
      );
      if (!isInGroup) {
        primaryPeersOnly.add(managedPkg);
      }
    }

    for (const [peerName, constraint] of Object.entries(peerDependencies)) {
      if (constraint !== "*" && primaryPeersOnly.has(peerName)) {
        return true;
      }
    }

    return false;
  }

  private createPeerPermutations(
    peerDeps: PeerDependencies,
    currentPackageName?: string
  ): { [peerName: string]: string }[] {
    const managedPackages = Object.keys(this.cdnMappings.packages);
    const validPeerDeps = Object.fromEntries(
      Object.entries(peerDeps).filter(
        ([peerName, constraint]) =>
          constraint !== "*" &&
          managedPackages.includes(peerName) &&
          peerName !== currentPackageName // Don't include the package itself as its own peer
      )
    );

    if (Object.keys(validPeerDeps).length === 0) {
      return [];
    }

    const sameVersionGroups: string[][] = [];
    const independentPeers: string[] = [];

    for (const peerName of Object.keys(validPeerDeps)) {
      let foundInGroup = false;
      for (const sameVersionGroup of this.cdnMappings.sameVersionRequired) {
        if (sameVersionGroup.includes(peerName)) {
          const existingGroup = sameVersionGroups.find((group) =>
            group.some((name) => sameVersionGroup.includes(name))
          );
          if (!existingGroup) {
            const relevantPeers = sameVersionGroup.filter(
              (name) => validPeerDeps[name]
            );
            if (relevantPeers.length > 0) {
              sameVersionGroups.push(relevantPeers);
            }
          }
          foundInGroup = true;
          break;
        }
      }
      if (!foundInGroup) {
        independentPeers.push(peerName);
      }
    }

    const groupVersions: string[][] = [];
    const independentVersions: string[][] = [];

    for (const group of sameVersionGroups) {
      const primaryPeer = group[0];
      const constraint = validPeerDeps[primaryPeer];
      const allVersions = this.availableVersions.get(primaryPeer) || [];
      const compatibleVersions = this.filterVersionsByConstraint(
        allVersions,
        constraint
      );

      if (compatibleVersions.length > 0) {
        groupVersions.push(compatibleVersions);
      }
    }

    for (const peerName of independentPeers) {
      const constraint = validPeerDeps[peerName];
      const allVersions = this.availableVersions.get(peerName) || [];
      const compatibleVersions = this.filterVersionsByConstraint(
        allVersions,
        constraint
      );

      if (compatibleVersions.length > 0) {
        independentVersions.push(compatibleVersions);
      }
    }

    const allVersionCombinations = this.generateCartesianProduct([
      ...groupVersions,
      ...independentVersions,
    ]);

    const permutations: { [peerName: string]: string }[] = [];

    for (const versionCombination of allVersionCombinations) {
      const peerContext: { [peerName: string]: string } = {};
      let versionIndex = 0;

      for (
        let groupIndex = 0;
        groupIndex < sameVersionGroups.length;
        groupIndex++
      ) {
        const group = sameVersionGroups[groupIndex];
        const version = versionCombination[versionIndex++];

        for (const peerName of group) {
          peerContext[peerName] = version;
        }
      }

      for (
        let peerIndex = 0;
        peerIndex < independentPeers.length;
        peerIndex++
      ) {
        const peerName = independentPeers[peerIndex];
        const version = versionCombination[versionIndex++];
        peerContext[peerName] = version;
      }

      permutations.push(peerContext);
    }

    return permutations.length > 0 ? permutations : [];
  }

  private calculatePermutationCount(
    peerDeps: PeerDependencies,
    currentPackageName?: string
  ): number {
    const managedPackages = Object.keys(this.cdnMappings.packages);
    const validPeerDeps = Object.fromEntries(
      Object.entries(peerDeps).filter(
        ([peerName, constraint]) =>
          constraint !== "*" && managedPackages.includes(peerName)
      )
    );

    if (currentPackageName) {
      for (const sameVersionGroup of this.cdnMappings.sameVersionRequired) {
        if (sameVersionGroup.includes(currentPackageName)) {
          return 0;
        }
      }
    }

    if (Object.keys(validPeerDeps).length === 0) {
      return 1;
    }

    const sameVersionGroups: string[][] = [];
    const independentPeers: string[] = [];

    for (const peerName of Object.keys(validPeerDeps)) {
      let foundInGroup = false;
      for (const sameVersionGroup of this.cdnMappings.sameVersionRequired) {
        if (sameVersionGroup.includes(peerName)) {
          const existingGroup = sameVersionGroups.find((group) =>
            group.some((name) => sameVersionGroup.includes(name))
          );
          if (!existingGroup) {
            const relevantPeers = sameVersionGroup.filter(
              (name) => validPeerDeps[name]
            );
            if (relevantPeers.length > 0) {
              sameVersionGroups.push(relevantPeers);
            }
          }
          foundInGroup = true;
          break;
        }
      }
      if (!foundInGroup) {
        independentPeers.push(peerName);
      }
    }

    let totalPermutations = 1;

    for (const group of sameVersionGroups) {
      const primaryPeer = group[0];
      const constraint = validPeerDeps[primaryPeer];
      const allVersions = this.availableVersions.get(primaryPeer) || [];
      const compatibleVersions = this.filterVersionsByConstraint(
        allVersions,
        constraint
      );

      if (compatibleVersions.length > 0) {
        totalPermutations *= compatibleVersions.length;
      } else {
        return 0;
      }
    }

    for (const peerName of independentPeers) {
      const constraint = validPeerDeps[peerName];
      const allVersions = this.availableVersions.get(peerName) || [];
      const compatibleVersions = this.filterVersionsByConstraint(
        allVersions,
        constraint
      );

      if (compatibleVersions.length > 0) {
        totalPermutations *= compatibleVersions.length;
      } else {
        return 0;
      }
    }

    return totalPermutations;
  }

  private generateCartesianProduct(arrays: string[][]): string[][] {
    if (arrays.length === 0) return [[]];
    if (arrays.length === 1) return arrays[0].map((item) => [item]);

    const result: string[][] = [];
    const firstArray = arrays[0];
    const remainingProduct = this.generateCartesianProduct(arrays.slice(1));

    for (const item of firstArray) {
      for (const combination of remainingProduct) {
        result.push([item, ...combination]);
      }
    }

    return result;
  }

  private filterVersionsByConstraint(
    versions: string[],
    constraint: string
  ): string[] {
    try {
      return versions.filter((version) => {
        const cleanVersion = semver.clean(version);
        if (!cleanVersion) {
          throw new Error(`Invalid version format: ${version}`);
        }
        return semver.satisfies(cleanVersion, constraint);
      });
    } catch (error) {
      throw new Error(
        `Unable to parse semver constraint: ${constraint}, using all available versions.`
      );
    }
  }

  private async getMultipleVersions(packageName: string): Promise<string[]> {
    try {
      console.log(`  🔍 Fetching version history for ${packageName}...`);
      const response = await axios.get(
        `https://registry.npmjs.org/${packageName}`
      );
      const versions = Object.keys(response.data.versions || {});

      const validVersions = versions
        .filter((version) => {
          const cleanVersion = semver.valid(version);
          return cleanVersion && !semver.prerelease(cleanVersion);
        })
        .sort((a, b) => semver.rcompare(a, b));

      if (validVersions.length === 0) {
        return [await this.getLatestVersion(packageName)];
      }

      const majorMinorMap = new Map<string, string[]>();

      for (const version of validVersions) {
        const major = semver.major(version);
        const minor = semver.minor(version);
        const majorMinorKey = `${major}.${minor}`;

        if (!majorMinorMap.has(majorMinorKey)) {
          majorMinorMap.set(majorMinorKey, []);
        }
        majorMinorMap.get(majorMinorKey)!.push(version);
      }

      const majorVersions = Array.from(
        new Set(validVersions.map((v) => semver.major(v)))
      ).slice(0, 3);

      const selectedVersions: string[] = [];

      for (const major of majorVersions) {
        const minorVersionsForMajor = Array.from(majorMinorMap.keys())
          .filter((key) => key.startsWith(`${major}.`))
          .sort((a, b) => {
            const minorA = parseInt(a.split(".")[1]);
            const minorB = parseInt(b.split(".")[1]);
            return minorB - minorA;
          })
          .slice(0, 3);

        for (const majorMinorKey of minorVersionsForMajor) {
          const versionsForMinor = majorMinorMap.get(majorMinorKey)!;
          versionsForMinor.sort((a, b) => semver.rcompare(a, b));
          selectedVersions.push(versionsForMinor[0]);
        }
      }

      if (selectedVersions.length > 0) {
        return selectedVersions;
      } else {
        throw new Error("No valid versions found");
      }
    } catch (error) {
      throw new Error(`Failed to fetch versions for ${packageName}: ${error}`);
    }
  }

  private async verifyEsmVersionExists(
    packageName: string,
    version: string
  ): Promise<boolean> {
    const url = `https://esm.sh/${packageName}@${version}`;
    try {
      const response = await axios.head(url);
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }

  private async getLatestVersion(packageName: string): Promise<string> {
    try {
      const response = await axios.get(
        `https://registry.npmjs.org/${packageName}`
      );
      const versions = Object.keys(response.data.versions || {});

      const sortedVersions = versions.sort((a, b) => {
        const aParts = a.split(".").map(Number);
        const bParts = b.split(".").map(Number);

        for (let i = 0; i < 3; i++) {
          if (aParts[i] !== bParts[i]) {
            return bParts[i] - aParts[i];
          }
        }
        return 0;
      });

      return sortedVersions[0] || "latest";
    } catch (error) {
      throw new Error(
        `Could not fetch version for ${packageName}, using 'latest'`
      );
    }
  }
}

// CLI usage
if (require.main === module) {
  const analyzer = new DependencyAnalyzer("./cdn-mappings.json");
  analyzer
    .analyzeDependencies()
    .then(() => {
      console.log("✅ Dependency analysis completed successfully!");
    })
    .catch((error) => {
      console.error("❌ Analysis failed:", error);
      process.exit(1);
    });
}
