import * as fs from "fs";
import { AnalyzedDependency, SubpathConfig } from "./interfaces";

interface CompleteIndexLookup {
  dependencies: { [esmUrl: string]: string };
  relativeImports: any;
  availableVersions: { [packageName: string]: string[] };
  standaloneSubpaths?: { [packageName: string]: (string | SubpathConfig)[] };
  packages: AnalyzedDependency[];
}

export class DependencyExporter {
  private lookupIndexPath: string;
  private outputPath: string;

  constructor(
    lookupIndexPath: string = "./dependencies/index.lookup.json",
    outputPath: string = "./cdn-exports.json"
  ) {
    this.lookupIndexPath = lookupIndexPath;
    this.outputPath = outputPath;
  }

  exportAvailableVersions(): void {
    console.log("📦 Exporting available versions...");

    // Step 1: Open index.lookup.json
    if (!fs.existsSync(this.lookupIndexPath)) {
      throw new Error(`Manifest file not found: ${this.lookupIndexPath}`);
    }

    const lookupIndexContent = fs.readFileSync(this.lookupIndexPath, "utf8");
    const lookupIndex: CompleteIndexLookup = JSON.parse(lookupIndexContent);

    // Step 2: Read the "availableVersions" key
    const availableVersions = lookupIndex.availableVersions || {};
    const standaloneSubpaths = lookupIndex.standaloneSubpaths || {};
    const packages = lookupIndex.packages.map((pkg) => {
      const { depth, peerDependencies, ...rest } = pkg;
      return rest;
    });

    console.log(
      `📊 Found ${
        Object.keys(availableVersions).length
      } packages with available versions`
    );

    // Step 3: Write to cdn-exports.json
    const exportContent = JSON.stringify(
      { availableVersions, standaloneSubpaths, packages },
      null,
      2
    );
    fs.writeFileSync(this.outputPath, exportContent);

    console.log(`✅ Exported to: ${this.outputPath}`);
  }
}

// CLI usage
if (require.main === module) {
  const exporter = new DependencyExporter();
  try {
    exporter.exportAvailableVersions();
  } catch (error) {
    console.error("❌ Export failed:", error);
    process.exit(1);
  }
}
