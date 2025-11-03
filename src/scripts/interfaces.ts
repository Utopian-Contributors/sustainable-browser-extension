
export interface PeerDependencies {
  [packageName: string]: string;
}

export interface CDNMapping {
  packages: { [key: string]: string };
  standaloneSubpaths?: {
    [packageName: string]: (string | SubpathConfig)[];
  };
  sameVersionRequired: string[][];
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

export interface RelativeImportMapping {
  [depNameVersion: string]: NestedRelativeImports;
}

export interface NestedRelativeImports {
  [pathSegment: string]: NestedRelativeImports | string; // Nested structure where final values are URLs
}

export interface SubpathConfig {
  name: string;
  fromVersion?: string; // Semver constraint - only include for versions matching this
}

export interface LookupIndex {
  packages: AnalyzedDependency[];
  urlToFile: { [esmUrl: string]: string }; // Maps esm.sh URL -> local file path
  relativeImports: {
    [depNameVersion: string]: NestedRelativeImports;
  }; // Maps dependency name+version -> nested relative imports
  availableVersions: { [packageName: string]: string[] };
  standaloneSubpaths?: { [packageName: string]: (string | SubpathConfig)[] };
}
