import * as fs from "fs";

interface CompleteManifest {
  dependencies: { [esmUrl: string]: string };
  relativeImports: any;
  availableVersions: { [packageName: string]: string[] };
}

export class DependencyExporter {
  private manifestPath: string;
  private outputPath: string;

  constructor(
    manifestPath: string = "./dependencies/index.lookup.json",
    outputPath: string = "./manifest.export.json"
  ) {
    this.manifestPath = manifestPath;
    this.outputPath = outputPath;
  }

  exportAvailableVersions(): void {
    console.log("📦 Exporting available versions...");

    // Step 1: Open index.lookup.json
    if (!fs.existsSync(this.manifestPath)) {
      throw new Error(`Manifest file not found: ${this.manifestPath}`);
    }

    const manifestContent = fs.readFileSync(this.manifestPath, "utf8");
    const manifest: CompleteManifest = JSON.parse(manifestContent);

    // Step 2: Read the "availableVersions" key
    const availableVersions = manifest.availableVersions || {};

    console.log(
      `📊 Found ${Object.keys(availableVersions).length} packages with available versions`
    );

    // Step 3: Write to manifest.export.json
    const exportContent = JSON.stringify(availableVersions, null, 2);
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
