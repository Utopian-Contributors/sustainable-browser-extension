import axios from "axios";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as semver from "semver";

interface CDNMapping {
  packages: { [key: string]: string };
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

interface DependencyInfo {
  name: string;
  version: string;
  url: string;
  content: string;
  imports: string[]; // URLs of imported dependencies
  isLeaf: boolean; // True if this has no esm.sh imports
  peerContext?: { [peerName: string]: string }; // For peer dependency permutations
}

interface DependencyManifest {
  [esmUrlWithPeerContext: string]: string; // Maps esm.sh URL with peer context -> local file path
}

interface RelativeImportMapping {
  [depNameVersion: string]: NestedRelativeImports; // Maps dependency name+version -> nested relative imports
}

interface NestedRelativeImports {
  [pathSegment: string]: NestedRelativeImports | string; // Nested structure where final values are URLs
}

interface CompleteManifest {
  dependencies: DependencyManifest;
  relativeImports: RelativeImportMapping;
  availableVersions: { [packageName: string]: string[] };
}

export class DependencyDownloader {
  private cdnMappings: CDNMapping;
  private downloadedDeps: Map<string, DependencyInfo> = new Map();
  private dependencyManifest: DependencyManifest = {};
  private relativeImportMappings: RelativeImportMapping = {};
  private outputDir: string;
  private manifestPath: string;
  private packageInfoCache: Map<string, PackageInfo[]> = new Map(); // Cache for package versions and peer deps
  private availableVersions: Map<string, string[]> = new Map(); // Maps package name -> list of versions we're downloading

  constructor(mappingsPath: string, outputDir: string = "./dependencies") {
    this.cdnMappings = JSON.parse(fs.readFileSync(mappingsPath, "utf8"));
    this.outputDir = outputDir;
    this.manifestPath = path.join(outputDir, "manifest.json");
    this.ensureOutputDir();
  }

  private ensureOutputDir(): void {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  async downloadAllDependencies(): Promise<void> {
    console.log("🚀 Starting dependency download...");
    console.log("📦 Strategy: Download with peer dependency permutations\n");

    // Step 1: Gather package information including peer dependencies
    console.log("🔍 Gathering package information and peer dependencies...");
    await this.gatherPackageInfo();

    // Step 2: Create peer dependency permutations (files are saved as they are downloaded)
    console.log("🔄 Creating peer dependency permutations...");
    await this.downloadWithPeerPermutations();

    // Save manifest
    console.log("\n📄 Saving final manifest...");
    this.saveManifest();

    console.log("\n✅ Dependency download complete!");
    console.log(`📊 Total dependencies analyzed: ${this.downloadedDeps.size}`);
    console.log(
      `🍃 Leaf dependencies saved: ${
        Object.keys(this.dependencyManifest).length
      }`
    );
  }

  private async gatherPackageInfo(): Promise<void> {
    for (const [depName, urlTemplate] of Object.entries(
      this.cdnMappings.packages
    )) {
      try {
        console.log(`  🔍 Analyzing ${depName}...`);
        const versions = await this.getMultipleVersions(depName);
        this.availableVersions.set(depName, versions); // Store available versions
        const packageInfoList: PackageInfo[] = [];

        for (const version of versions) {
          // Get peer dependencies from npm registry
          const peerDeps = await this.getPeerDependencies(depName, version);

          // Check if this package has managed peer dependencies
          const hasManagedImports = await this.checkForManagedDependencyImports(
            depName,
            version
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
              permutationCount = 0; // If permutation calculation fails
            }
          }

          console.log(
            `    📦 ${depName}@${version}: ${
              Object.keys(validPeerDeps).length
            } peer deps, managed imports: ${hasManagedImports}, permutations: ${permutationCount}`
          );
        }

        this.packageInfoCache.set(depName, packageInfoList);
      } catch (error) {
        console.error(`❌ Failed to analyze ${depName}:`, error);
      }
    }
  }

  private async downloadWithPeerPermutations(): Promise<void> {
    // Track which packages we've already processed via sameVersionRequired groups
    const processedPackages = new Set<string>();

    // Track base versions we've downloaded (without peer context)
    const baseVersionsDownloaded = new Map<string, DependencyInfo>();

    for (const [depName, packageInfoList] of this.packageInfoCache.entries()) {
      // Skip if this package was already processed as part of a sameVersionRequired group
      if (processedPackages.has(depName)) {
        console.log(
          `  ⏭️  Skipping ${depName} (already processed via sameVersionRequired group)`
        );
        continue;
      }

      const urlTemplate = this.cdnMappings.packages[depName];

      // Check if this package is part of a sameVersionRequired group
      const sameVersionGroup = this.cdnMappings.sameVersionRequired.find(
        (group) => group.includes(depName)
      );

      if (sameVersionGroup) {
        // Mark all packages in this group as processed
        sameVersionGroup.forEach((pkg) => processedPackages.add(pkg));
        console.log(
          `  👥 Processing sameVersionRequired group: [${sameVersionGroup.join(
            ", "
          )}] via primary package: ${depName}`
        );
      } else {
        // Mark this individual package as processed
        processedPackages.add(depName);
      }

      for (const packageInfo of packageInfoList) {
        const url = urlTemplate.replace("{version}", packageInfo.version);
        const versionKey = `${depName}@${packageInfo.version}`;

        // Step 1: Download the base version once (without peer context)
        console.log(
          `  Downloading base version for ${depName}@${packageInfo.version}...`
        );
        const baseDepInfo = await this.downloadDependency(url);
        baseVersionsDownloaded.set(versionKey, baseDepInfo);

        // If this package is part of a sameVersionRequired group,
        // also download the other packages in the group
        const groupDependencies: { [memberName: string]: DependencyInfo } = {};
        if (sameVersionGroup && sameVersionGroup.length > 1) {
          for (const groupMember of sameVersionGroup) {
            if (
              groupMember !== depName &&
              this.cdnMappings.packages[groupMember]
            ) {
              const groupMemberTemplate =
                this.cdnMappings.packages[groupMember];
              const groupMemberUrl = groupMemberTemplate.replace(
                "{version}",
                packageInfo.version
              );
              console.log(
                `    🔗 Also downloading group member: ${groupMember}@${packageInfo.version}`
              );
              const groupMemberDepInfo = await this.downloadDependency(
                groupMemberUrl
              );
              groupDependencies[groupMember] = groupMemberDepInfo;
              const groupMemberKey = `${groupMember}@${packageInfo.version}`;
              baseVersionsDownloaded.set(groupMemberKey, groupMemberDepInfo);
            }
          }
        }

        // Step 2: Create peer context permutations if needed
        if (
          packageInfo.peerDependencies &&
          Object.keys(packageInfo.peerDependencies).length > 0
        ) {
          const peerPermutations = this.createPeerPermutations(
            packageInfo.peerDependencies
          );

          console.log(
            `  Creating ${peerPermutations.length} permutations for ${depName}@${packageInfo.version}`
          );

          for (const peerContext of peerPermutations) {
            if (Object.keys(peerContext).length > 0) {
              // Create a copy of the base dependency with peer context
              await this.createPeerContextCopy(baseDepInfo, peerContext);

              // Also create copies for group members
              for (const [groupMember, groupMemberDepInfo] of Object.entries(
                groupDependencies
              )) {
                await this.createPeerContextCopy(
                  groupMemberDepInfo,
                  peerContext
                );
              }
            }
          }

          console.log("\n🧹 Cleaning up base versions without peer context...");
          this.cleanupBaseVersions(baseVersionsDownloaded);
        }
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

    // Check if this dependency is itself one of the peer dependencies
    // If so, we should not create a peer context copy of it
    const isPeerDependency = Object.keys(peerContext).some((peerName) => {
      // Check if the package name matches any peer dependency
      // Also check sameVersionRequired groups
      const sameVersionGroup = this.cdnMappings.sameVersionRequired.find(
        (group) => group.includes(peerName)
      );

      if (sameVersionGroup) {
        // Check if baseDepInfo.name matches any package in the group
        return sameVersionGroup.includes(baseDepInfo.name);
      } else {
        return baseDepInfo.name === peerName;
      }
    });

    if (isPeerDependency) {
      // This is a peer dependency itself, so we don't create a copy with peer context
      // The correct version was already downloaded by the main loop
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
        // Get the base version of the nested dependency (it should already be downloaded)
        const nestedBaseDepInfo = this.downloadedDeps.get(importUrl);
        if (nestedBaseDepInfo) {
          // Recursively create a peer context copy for this nested dependency
          await this.createPeerContextCopy(nestedBaseDepInfo, peerContext);
        }
      }
    }
  }

  private cleanupBaseVersions(
    baseVersionsDownloaded: Map<string, DependencyInfo>
  ): void {
    let cleanedCount = 0;

    for (const [versionKey, baseDepInfo] of baseVersionsDownloaded.entries()) {
      if (
        baseDepInfo.peerContext &&
        Object.keys(baseDepInfo.peerContext).length > 0
      ) {
        const nonSameVersionPeer = this.findPrimaryPeer(
          baseDepInfo.peerContext || {}
        );
        if (nonSameVersionPeer) {
          console.debug(
            `  🧹 Cleaning up peer context for: ${baseDepInfo.url}`
          );
          // Remove from downloadedDeps
          this.downloadedDeps.delete(baseDepInfo.url);

          // Remove from dependencyManifest if present
          if (this.dependencyManifest[baseDepInfo.url]) {
            const filename = this.dependencyManifest[baseDepInfo.url];
            delete this.dependencyManifest[baseDepInfo.url];

            // Delete the file from disk
            const filePath = path.join(this.outputDir, filename);
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              console.log(`  🗑️  Removed base version: ${filename}`);
              cleanedCount++;
            }
          }
        }
      }
    }

    console.log(`  ✅ Cleaned up ${cleanedCount} base v ersion files`);
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
      console.warn(
        `Could not fetch peer dependencies for ${packageName}@${version}`
      );
      return {};
    }
  }

  private async checkForManagedDependencyImports(
    packageName: string,
    version: string
  ): Promise<boolean> {
    try {
      // Get package.json from npm registry to check peerDependencies
      const response = await axios.get(
        `https://registry.npmjs.org/${packageName}/${version}`
      );
      const peerDependencies = response.data.peerDependencies || {};

      // Get list of managed packages (but only primary peers from sameVersionRequired groups)
      const managedPackages = Object.keys(this.cdnMappings.packages);
      const primaryPeersOnly = new Set<string>();

      // Add primary peers from sameVersionRequired groups
      for (const sameVersionGroup of this.cdnMappings.sameVersionRequired) {
        const primaryPeer = sameVersionGroup[0];
        if (managedPackages.includes(primaryPeer)) {
          primaryPeersOnly.add(primaryPeer);
        }
      }

      // Add standalone managed packages (ones not in any sameVersionRequired group)
      for (const managedPkg of managedPackages) {
        const isInGroup = this.cdnMappings.sameVersionRequired.some((group) =>
          group.includes(managedPkg)
        );
        if (!isInGroup) {
          primaryPeersOnly.add(managedPkg);
        }
      }

      // Check if any of the package's peer dependencies match our primary managed packages
      // Exclude wildcard peer dependencies ("*")
      for (const [peerName, constraint] of Object.entries(peerDependencies)) {
        if (constraint !== "*" && primaryPeersOnly.has(peerName)) {
          return true;
        }
      }

      return false;
    } catch (error) {
      console.warn(
        `Could not check managed dependency imports for ${packageName}@${version}`
      );
      return false;
    }
  }

  private createPeerPermutations(
    peerDeps: PeerDependencies
  ): { [peerName: string]: string }[] {
    const permutations: { [peerName: string]: string }[] = [];

    // Filter out peer dependencies with wildcard constraints ("*") and
    // only include peer dependencies that we manage in cdn-mappings
    const managedPackages = Object.keys(this.cdnMappings.packages);
    const validPeerDeps = Object.fromEntries(
      Object.entries(peerDeps).filter(
        ([peerName, constraint]) =>
          constraint !== "*" && managedPackages.includes(peerName)
      )
    );

    if (Object.keys(validPeerDeps).length === 0) {
      return [{}]; // No valid peer dependencies
    }

    // Group peer dependencies by sameVersionRequired groups
    const sameVersionGroups: string[][] = [];
    const independentPeers: string[] = [];

    for (const peerName of Object.keys(validPeerDeps)) {
      let foundInGroup = false;
      for (const sameVersionGroup of this.cdnMappings.sameVersionRequired) {
        if (sameVersionGroup.includes(peerName)) {
          // Check if we already have this group
          const existingGroup = sameVersionGroups.find((group) =>
            group.some((name) => sameVersionGroup.includes(name))
          );
          if (!existingGroup) {
            // Only include peers that are actually in our peerDeps
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

    // Get available versions for each group/peer
    const groupVersions: string[][] = [];
    const independentVersions: string[][] = [];

    // For sameVersionRequired groups, use the first package's versions filtered by constraint
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

    // For independent peers, get their individual versions filtered by constraint
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

    // Generate all combinations
    const allVersionCombinations = this.generateCartesianProduct([
      ...groupVersions,
      ...independentVersions,
    ]);

    for (const versionCombination of allVersionCombinations) {
      const peerContext: { [peerName: string]: string } = {};
      let versionIndex = 0;

      // Assign versions to sameVersionRequired groups
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

      // Assign versions to independent peers
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

    return permutations.length > 0 ? permutations : [{}];
  }

  private calculatePermutationCount(
    peerDeps: PeerDependencies,
    currentPackageName?: string
  ): number {
    // Filter out peer dependencies with wildcard constraints ("*") and
    // only include peer dependencies that we manage in cdn-mappings
    const managedPackages = Object.keys(this.cdnMappings.packages);
    const validPeerDeps = Object.fromEntries(
      Object.entries(peerDeps).filter(
        ([peerName, constraint]) =>
          constraint !== "*" && managedPackages.includes(peerName)
      )
    );

    // Check if the current package itself is in a sameVersionRequired group
    if (currentPackageName) {
      for (const sameVersionGroup of this.cdnMappings.sameVersionRequired) {
        if (sameVersionGroup.includes(currentPackageName)) {
          // This package is in a sameVersionRequired group, so no permutations needed
          // The peer dependencies will be automatically matched to the same version
          return 0;
        }
      }
    }

    if (Object.keys(validPeerDeps).length === 0) {
      return 1; // One empty permutation
    }

    // Group peer dependencies by sameVersionRequired groups
    const sameVersionGroups: string[][] = [];
    const independentPeers: string[] = [];

    for (const peerName of Object.keys(validPeerDeps)) {
      let foundInGroup = false;
      for (const sameVersionGroup of this.cdnMappings.sameVersionRequired) {
        if (sameVersionGroup.includes(peerName)) {
          // Check if we already have this group
          const existingGroup = sameVersionGroups.find((group) =>
            group.some((name) => sameVersionGroup.includes(name))
          );
          if (!existingGroup) {
            // Only include peers that are actually in our peerDeps
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

    // Calculate available versions count for each group/peer
    let totalPermutations = 1;

    // For sameVersionRequired groups, multiply by compatible versions count
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
        return 0; // No compatible versions means no permutations
      }
    }

    // For independent peers, multiply by their individual compatible versions count
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
        return 0; // No compatible versions means no permutations
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
      // Use semver to filter versions that satisfy the constraint
      return versions.filter((version) => {
        // Clean version string (remove any prefixes or suffixes that might break semver parsing)
        const cleanVersion = semver.clean(version);
        if (!cleanVersion) {
          console.warn(`Invalid version format: ${version}`);
          return false;
        }

        // Check if version satisfies the constraint
        return semver.satisfies(cleanVersion, constraint);
      });
    } catch (error) {
      console.warn(
        `Unable to parse semver constraint: ${constraint}, using all available versions. Error:`,
        error
      );
      return versions;
    }
  }

  private findPrimaryPeer(peerDeps: PeerDependencies): string | null {
    // Simply return the first peer dependency we find
    // The new createPeerPermutations method handles grouping logic
    const peerNames = Object.keys(peerDeps);
    return peerNames.length > 0 ? peerNames[0] : null;
  }

  private createSimplifiedPeerContextSuffix(peerContext: {
    [peerName: string]: string;
  }): string {
    // Only include the primary peer from each sameVersionRequired group
    const includedPeers: string[] = [];
    const processedGroups = new Set<string>();

    for (const [peerName, version] of Object.entries(peerContext)) {
      // Check if this peer is in a sameVersionRequired group
      let foundInGroup = false;
      for (const sameVersionGroup of this.cdnMappings.sameVersionRequired) {
        if (sameVersionGroup.includes(peerName)) {
          // Use the group as a key to avoid processing the same group twice
          const groupKey = sameVersionGroup.join(",");
          if (!processedGroups.has(groupKey)) {
            // Include only the first peer from this group
            const primaryPeer = sameVersionGroup[0];
            if (peerContext[primaryPeer]) {
              includedPeers.push(`${primaryPeer}-${peerContext[primaryPeer]}`);
            }
            processedGroups.add(groupKey);
          }
          foundInGroup = true;
          break;
        }
      }

      // If not in any group, include this peer individually
      if (!foundInGroup) {
        includedPeers.push(`${peerName}-${version}`);
      }
    }

    return includedPeers.join("_");
  }

  private createSimplifiedPeerContextQuery(peerContext: {
    [peerName: string]: string;
  }): string {
    // Only include the primary peer from each sameVersionRequired group
    const includedPeers: string[] = [];
    const processedGroups = new Set<string>();

    for (const [peerName, version] of Object.entries(peerContext)) {
      // Check if this peer is in a sameVersionRequired group
      let foundInGroup = false;
      for (const sameVersionGroup of this.cdnMappings.sameVersionRequired) {
        if (sameVersionGroup.includes(peerName)) {
          // Use the group as a key to avoid processing the same group twice
          const groupKey = sameVersionGroup.join(",");
          if (!processedGroups.has(groupKey)) {
            // Include only the first peer from this group
            const primaryPeer = sameVersionGroup[0];
            if (peerContext[primaryPeer]) {
              includedPeers.push(`${primaryPeer}=${peerContext[primaryPeer]}`);
            }
            processedGroups.add(groupKey);
          }
          foundInGroup = true;
          break;
        }
      }

      // If not in any group, include this peer individually
      if (!foundInGroup) {
        includedPeers.push(`${peerName}=${version}`);
      }
    }

    return includedPeers.join("&");
  }

  private async getLatestVersion(packageName: string): Promise<string> {
    try {
      // Try npm registry first
      const response = await axios.get(
        `https://registry.npmjs.org/${packageName}`
      );
      const versions = Object.keys(response.data.versions || {});

      // Sort versions to get the latest
      const sortedVersions = versions.sort((a, b) => {
        const aParts = a.split(".").map(Number);
        const bParts = b.split(".").map(Number);

        for (let i = 0; i < 3; i++) {
          if (aParts[i] !== bParts[i]) {
            return bParts[i] - aParts[i]; // Descending order
          }
        }
        return 0;
      });

      return sortedVersions[0] || "latest";
    } catch (error) {
      console.warn(
        `Could not fetch version for ${packageName}, using 'latest'`
      );
      return "latest";
    }
  }

  private async getMultipleVersions(packageName: string): Promise<string[]> {
    try {
      console.log(`  🔍 Fetching version history for ${packageName}...`);
      const response = await axios.get(
        `https://registry.npmjs.org/${packageName}`
      );
      const versions = Object.keys(response.data.versions || {});

      // Filter and parse valid versions using semver
      const validVersions = versions
        .filter((version) => {
          // Use semver.valid to check if version is valid and not a pre-release
          const cleanVersion = semver.valid(version);
          return cleanVersion && !semver.prerelease(cleanVersion);
        })
        .sort((a, b) => semver.rcompare(a, b)); // Sort in descending order

      if (validVersions.length === 0) {
        return [await this.getLatestVersion(packageName)];
      }

      // Group versions by major.minor
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

      // Get the last 3 major versions
      const majorVersions = Array.from(
        new Set(validVersions.map((v) => semver.major(v)))
      ).slice(0, 3);

      const selectedVersions: string[] = [];

      for (const major of majorVersions) {
        // Get all major.minor keys for this major version, sorted by minor version descending
        const minorVersionsForMajor = Array.from(majorMinorMap.keys())
          .filter((key) => key.startsWith(`${major}.`))
          .sort((a, b) => {
            const minorA = parseInt(a.split(".")[1]);
            const minorB = parseInt(b.split(".")[1]);
            return minorB - minorA; // Descending order
          })
          .slice(0, 3); // Take last 3 minor versions

        for (const majorMinorKey of minorVersionsForMajor) {
          const versionsForMinor = majorMinorMap.get(majorMinorKey)!;
          // Sort patch versions descending and take the latest (highest patch)
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

  private async downloadDependency(url: string): Promise<DependencyInfo> {
    // Check if already downloaded
    if (this.downloadedDeps.has(url)) {
      return this.downloadedDeps.get(url)!;
    }

    try {
      const response = await axios.get(url);
      const content = response.data;

      // Extract package name and version from URL
      const name = this.extractPackageNameFromUrl(url);
      const version = this.extractVersionFromUrl(url) || "latest";

      // Extract all imports from this file
      const allImports = this.extractImports(content, url);

      // Resolve relative imports to absolute URLs
      const absoluteImports = allImports.map((imp) =>
        this.resolveImportUrl(imp, url)
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
            await this.downloadDependency(importUrl);
          } catch (error) {
            console.warn(`      ⚠️  Failed to download nested: ${importUrl}`);
          }
        }
      }

      // Save this dependency immediately after downloading
      this.saveDependency(depInfo);

      return depInfo;
    } catch (error) {
      throw new Error(`Failed to download ${url}: ${error}`);
    }
  }

  private extractImports(content: string, baseUrl?: string): string[] {
    const rawImports = this.extractRawImports(content);

    // If we have a baseUrl, resolve relative imports to absolute URLs
    if (baseUrl) {
      return rawImports.map((imp) => this.resolveImportUrl(imp, baseUrl));
    }

    return rawImports;
  }

  private extractRawImports(content: string): string[] {
    // Match both absolute URLs and relative paths - use \s* to handle minified code with no spaces
    const importRegex = /(?:import|export).*?from\s*["']([^"']+)["']/g;
    const dynamicImportRegex = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
    // Also match bare import statements without 'from'
    const bareImportRegex = /^import\s+["']([^"']+)["'];?$/gm;

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
      // Only skip query parameters for non-package imports (keep /package@version?params)
      if (
        importPath.includes("?") &&
        !importPath.includes(".mjs") &&
        !importPath.includes(".js") &&
        !importPath.startsWith("/") // Don't skip absolute package paths with query params
      ) {
        return false;
      }
      return true;
    });

    return [...new Set(validImports)]; // Remove duplicates
  }

  private saveDependency(depInfo: DependencyInfo): void {
    const hasEsmShExports = this.hasEsmShExports(depInfo.content);
    depInfo.isLeaf = !hasEsmShExports;

    // Save the file (both leaf and wrapper files)
    const hash = crypto
      .createHash("md5")
      .update(depInfo.url)
      .digest("hex")
      .substring(0, 8);

    // Sanitize the name and version for filesystem compatibility
    const sanitizedName = depInfo.name.replace(/\//g, "-");
    const sanitizedVersion = depInfo.version.replace(/[\^~]/g, "");

    // Create filename with peer context
    let filename: string;
    if (depInfo.peerContext && Object.keys(depInfo.peerContext).length > 0) {
      // Create simplified peer context suffix (only primary peers from sameVersionRequired groups)
      const peerContextSuffix = this.createSimplifiedPeerContextSuffix(
        depInfo.peerContext
      );
      filename = `${sanitizedName}@${sanitizedVersion}_${peerContextSuffix}_${hash}.js`;
    } else {
      filename = `${sanitizedName}@${sanitizedVersion}_${hash}.js`;
    }

    const filePath = path.join(this.outputDir, filename);

    // Save the file
    fs.writeFileSync(filePath, depInfo.content);

    // Create manifest entry with query parameters for peer context
    let manifestKey: string;
    if (depInfo.peerContext && Object.keys(depInfo.peerContext).length > 0) {
      const originalUrl = depInfo.url.split("?")[0]; // Remove existing query params
      const peerQuery = this.createSimplifiedPeerContextQuery(
        depInfo.peerContext
      );
      manifestKey = peerQuery ? `${originalUrl}?${peerQuery}` : originalUrl;
    } else {
      manifestKey = depInfo.url.split("?")[0]; // Clean URL without context
    }

    if (!depInfo.isLeaf) {
      console.debug(depInfo.url); // debugging wrapper files
    }

    // Add to manifest (URL with peer context -> filename mapping)
    this.dependencyManifest[manifestKey] = filename;

    console.log(`    💾 ${filename}`);
  }

  private resolveImportUrl(importPath: string, baseUrl: string): string {
    // If it's already an absolute URL, return as-is
    if (importPath.startsWith("http://") || importPath.startsWith("https://")) {
      return importPath;
    }

    // Handle relative imports
    const baseUrlObj = new URL(baseUrl);

    if (importPath.startsWith("/")) {
      // Handle absolute path imports that look like package dependencies
      // e.g., "/motion-dom@^11.16.4?target=es2022" -> "https://esm.sh/motion-dom@11.16.4?target=es2022"
      if (this.isPackageImport(importPath)) {
        const cleanedPath = this.cleanPackageVersion(importPath);
        return `${baseUrlObj.origin}${cleanedPath}`;
      }

      // Regular absolute path: https://esm.sh/some/path -> https://esm.sh/path
      return `${baseUrlObj.origin}${importPath}`;
    } else if (importPath.startsWith("./") || importPath.startsWith("../")) {
      // Relative path: resolve against base URL
      const basePathParts = baseUrlObj.pathname.split("/");
      basePathParts.pop(); // Remove filename

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
      // Bare import (shouldn't happen in esm.sh but handle it)
      return importPath;
    }
  }

  private hasEsmShExports(content: string): boolean {
    // Check if the content has export statements that reference esm.sh URLs or absolute paths
    const exportFromRegex = /export\s+.*?\s+from\s+["']([^"']+)["']/g;
    let match;

    while ((match = exportFromRegex.exec(content)) !== null) {
      const exportPath = match[1];
      if (exportPath.startsWith("/") || exportPath.includes("esm.sh")) {
        return true;
      }
    }

    return false;
  }

  private adjustUrlForPeerContext(
    url: string,
    peerContext: { [peerName: string]: string }
  ): string {
    if (Object.keys(peerContext).length === 0) {
      return url;
    }

    try {
      const urlObj = new URL(url);

      // Only adjust esm.sh URLs
      if (urlObj.hostname !== "esm.sh") {
        return url;
      }

      // Extract package name from the URL
      const packageName = this.extractPackageNameFromUrl(url);

      // Check if this package is in our peer context
      if (peerContext[packageName]) {
        const requiredVersion = peerContext[packageName];

        // Replace the version in the URL with the version from peer context
        const pathParts = urlObj.pathname.split("/");
        if (pathParts.length > 0) {
          // For URLs like /react@19.2.0/jsx-runtime.mjs, replace with /react@19.1.1/jsx-runtime.mjs
          if (packageName.startsWith("@")) {
            // Scoped package: /@scope/package@version/...
            if (pathParts.length >= 3) {
              const scopedPackagePart = `${pathParts[1]}/${pathParts[2]}`;
              const newPackagePart = scopedPackagePart.replace(
                /@[^/]+/,
                `@${requiredVersion}`
              );
              pathParts[2] = newPackagePart.split("/")[1];
            }
          } else {
            // Regular package: /package@version/...
            if (pathParts.length >= 2) {
              pathParts[1] = pathParts[1].replace(
                /@[^/]+/,
                `@${requiredVersion}`
              );
            }
          }

          // Reconstruct the URL
          const newPath = pathParts.join("/");
          return `${urlObj.origin}${newPath}${urlObj.search}`;
        }
      }

      return url;
    } catch (error) {
      console.warn(`Failed to adjust URL for peer context: ${url}`);
      return url;
    }
  }

  private saveManifest(): void {
    // Convert availableVersions Map to plain object for JSON serialization
    const availableVersionsObject: { [packageName: string]: string[] } = {};
    for (const [packageName, versions] of this.availableVersions.entries()) {
      availableVersionsObject[packageName] = versions;
    }

    const manifest: CompleteManifest = {
      dependencies: this.dependencyManifest,
      relativeImports: this.relativeImportMappings,
      availableVersions: availableVersionsObject,
    };

    const manifestContent = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(this.manifestPath, manifestContent);

    console.log(`\n📄 Manifest saved: ${this.manifestPath}`);
    console.log(
      `   Contains ${Object.keys(this.dependencyManifest).length} URL mappings`
    );

    const totalPackages = Object.keys(availableVersionsObject).length;
    const totalVersions = Object.values(availableVersionsObject).reduce(
      (sum, versions) => sum + versions.length,
      0
    );
    console.log(
      `   Contains ${totalVersions} available versions across ${totalPackages} packages`
    );
  }

  private extractPackageNameFromUrl(url: string): string {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split("/").filter((p) => p);

    if (urlObj.hostname === "esm.sh") {
      // For esm.sh URLs like:
      // https://esm.sh/react@18.2.0
      // https://esm.sh/@types/node@18.0.0
      // https://esm.sh/framer-motion@12.23.22/es2022/dist/es/...

      if (pathParts.length === 0) {
        return "unknown";
      }

      const firstPart = pathParts[0];

      if (firstPart.startsWith("@")) {
        // Scoped package like @types/node@18.0.0
        // The URL structure for scoped packages is /@scope/package@version
        if (pathParts.length > 1) {
          const secondPart = pathParts[1];
          // Remove version from second part
          const packageNamePart = secondPart.split("@")[0];
          return `${firstPart}/${packageNamePart}`;
        }
        return firstPart;
      } else {
        // Regular package like react@18.2.0
        return firstPart.split("@")[0];
      }
    } else if (urlObj.hostname === "cdn.jsdelivr.net") {
      // For jsDelivr URLs like https://cdn.jsdelivr.net/npm/lodash@4.17.21/index.js
      if (pathParts[0] === "npm" && pathParts.length > 1) {
        return pathParts[1].split("@")[0];
      }
    } else if (urlObj.hostname === "unpkg.com") {
      // For unpkg URLs like https://unpkg.com/moment@2.29.4/moment.js
      if (pathParts.length > 0) {
        return pathParts[0].split("@")[0];
      }
    }

    return pathParts[0] || "unknown";
  }

  private extractVersionFromUrl(url: string): string | null {
    // For scoped packages like @emotion/is-prop-valid@1.4.0, match the version after the second @
    // For regular packages like react@19.2.0, match the version after the first @

    // First try to match scoped package pattern: @scope/package@version
    const scopedMatch = url.match(/@[^/]+\/[^@/]+@([^/?#]+)/);
    if (scopedMatch) {
      return scopedMatch[1];
    }

    // Then try regular package pattern: package@version (but not for scoped packages)
    if (!url.includes("/@")) {
      const regularMatch = url.match(/\/([^/@]+)@([^/?#]+)/);
      if (regularMatch) {
        return regularMatch[2];
      }
    }

    return null;
  }

  private isPackageImport(importPath: string): boolean {
    // Check if the import path looks like a package import with version
    // e.g., "/motion-dom@^11.16.4?target=es2022" or "/react@^19.1.1?target=es2022"
    return /^\/[^/]+@[\^~]?[\d.]+/.test(importPath);
  }

  private cleanPackageVersion(importPath: string): string {
    // Remove caret (^) or tilde (~) from version constraints
    // "/motion-dom@^11.16.4?target=es2022" -> "/motion-dom@11.16.4?target=es2022"
    return importPath.replace(/@[\^~]/, "@");
  }
}

// CLI usage
if (require.main === module) {
  const downloader = new DependencyDownloader("./cdn-mappings.json");
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
